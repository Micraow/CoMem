import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  EmbeddingOptions,
  EmbeddingProvider,
  EmbeddingResult,
} from '../../../src/domain/embedding.js';
import { ComemError } from '../../../src/domain/errors.js';
import type { Logger } from '../../../src/domain/log.js';
import { EmbeddingService } from '../../../src/services/embedding.js';
import type { EmbeddingCachePort } from '../../../src/services/embedding.js';

const DIMENSION = 3;
const MODEL = 'test-embedding';

const CONFIG = {
  dimension: DIMENSION,
  maxBatchSize: 128,
  timeoutMs: 30_000,
};

function createLogger(): Logger {
  const logger: Logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return logger;
}

/** 一次成功的供应商返回：每条输入一个单位向量，token 数等于条数。 */
function vectorsFor(texts: readonly string[]): EmbeddingResult {
  return {
    vectors: texts.map(() => [1, 0, 0]),
    usage: { promptTokens: texts.length, totalTokens: texts.length },
  };
}

interface FakeProvider extends EmbeddingProvider {
  readonly embed: ReturnType<typeof vi.fn>;
}

function createProvider(
  implementation: (texts: readonly string[], options?: EmbeddingOptions) => Promise<EmbeddingResult>,
): FakeProvider {
  return {
    model: MODEL,
    dimension: DIMENSION,
    embed: vi.fn(implementation),
  };
}

function createService(
  provider: EmbeddingProvider | null,
  maxBatchSize = 128,
  cache: EmbeddingCachePort | null = null,
): EmbeddingService {
  return new EmbeddingService({
    provider,
    logger: createLogger(),
    cache,
    config: { ...CONFIG, maxBatchSize },
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-08T00:00:00.000Z'));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('未配置', () => {
  it('available: false，embed 返回降级且不打网络', async () => {
    const service = createService(null);

    expect(service.available).toBe(false);
    await expect(service.embed(['一段记忆'])).resolves.toEqual({
      vectors: [],
      degraded: true,
      reason: '没有配置 providers.embedding',
    });
    expect(service.stats()).toEqual({
      calls: 0,
      failures: 0,
      tokens: 0,
      degradedCalls: 1,
    });
    expect(service.model).toBeNull();
  });

  it('空输入即使没配置也不计降级', async () => {
    const service = createService(null);

    await expect(service.embed([])).resolves.toEqual({
      vectors: [],
      degraded: false,
      reason: null,
    });
    expect(service.stats().degradedCalls).toBe(0);
  });
});

describe('正常嵌入', () => {
  it('返回与入参同序的向量，并统计调用与 token', async () => {
    const provider = createProvider(async (texts) => vectorsFor(texts));
    const service = createService(provider);

    expect(service.available).toBe(true);
    expect(service.model).toBe(MODEL);

    const outcome = await service.embed(['甲', '乙', '丙']);

    expect(outcome.degraded).toBe(false);
    expect(outcome.reason).toBeNull();
    expect(outcome.vectors).toEqual([
      [1, 0, 0],
      [1, 0, 0],
      [1, 0, 0],
    ]);
    expect(provider.embed).toHaveBeenCalledTimes(1);
    expect(service.stats()).toEqual({
      calls: 1,
      failures: 0,
      tokens: 3,
      degradedCalls: 0,
    });
  });

  it('空输入不调供应商', async () => {
    const provider = createProvider(async (texts) => vectorsFor(texts));
    const service = createService(provider);

    await expect(service.embed([])).resolves.toEqual({
      vectors: [],
      degraded: false,
      reason: null,
    });
    expect(provider.embed).not.toHaveBeenCalled();
    expect(service.stats().calls).toBe(0);
  });

  it('按 maxBatchSize 分批，一批评一次调用', async () => {
    const provider = createProvider(async (texts) => vectorsFor(texts));
    const service = createService(provider, 2);

    const outcome = await service.embed(['a', 'b', 'c']);

    expect(outcome.vectors).toHaveLength(3);
    expect(provider.embed).toHaveBeenCalledTimes(2);
    expect(provider.embed.mock.calls.map(([texts]) => (texts as string[]).length)).toEqual([2, 1]);
    expect(service.stats().calls).toBe(2);
  });
});

describe('供应商返回不合法', () => {
  it('条数不一致时降级并计一次失败', async () => {
    const provider = createProvider(async () => ({
      vectors: [[1, 0, 0]],
      usage: { promptTokens: 1, totalTokens: 1 },
    }));
    const service = createService(provider);

    const outcome = await service.embed(['a', 'b']);

    expect(outcome.degraded).toBe(true);
    expect(outcome.vectors).toEqual([]);
    expect(outcome.reason).toContain('条数不一致');
    expect(service.stats().failures).toBe(1);
  });

  it('全零向量时降级（写进索引等于一条死记录）', async () => {
    const provider = createProvider(async () => ({
      vectors: [[0, 0, 0]],
      usage: { promptTokens: 1, totalTokens: 1 },
    }));
    const service = createService(provider);

    const outcome = await service.embed(['a']);

    expect(outcome.degraded).toBe(true);
    expect(outcome.reason).toContain('不合法');
  });

  it('维度不一致时降级', async () => {
    const provider = createProvider(async () => ({
      vectors: [[1, 0]],
      usage: { promptTokens: 1, totalTokens: 1 },
    }));
    const service = createService(provider);

    const outcome = await service.embed(['a']);

    expect(outcome.degraded).toBe(true);
  });
});

describe('熔断', () => {
  it('连续 5 次失败后第 6 次不打网络', async () => {
    const provider = createProvider(async () => {
      throw new Error('down');
    });
    const service = createService(provider);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const outcome = await service.embed(['a']);
      expect(outcome.degraded).toBe(true);
      expect(outcome.reason).toContain('嵌入调用失败');
    }
    expect(provider.embed).toHaveBeenCalledTimes(5);

    const shortCircuited = await service.embed(['a']);

    expect(shortCircuited.degraded).toBe(true);
    expect(shortCircuited.reason).toContain('熔断已打开');
    // 第 6 次直接返回：供应商调用次数没变。
    expect(provider.embed).toHaveBeenCalledTimes(5);
    expect(service.available).toBe(false);
    expect(service.stats()).toMatchObject({ calls: 5, failures: 5, degradedCalls: 6 });
  });

  it('冷却结束后只放一个探测，成功即恢复', async () => {
    const provider = createProvider(async () => {
      throw new Error('down');
    });
    const service = createService(provider);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await service.embed(['a']);
    }
    expect(service.available).toBe(false);

    // 冷却未到：仍然短路。
    vi.setSystemTime(new Date('2026-11-08T00:00:29.000Z'));
    await service.embed(['a']);
    expect(provider.embed).toHaveBeenCalledTimes(5);

    // 冷却结束：放一个探测。
    vi.setSystemTime(new Date('2026-11-08T00:00:30.000Z'));
    expect(service.available).toBe(true);
    provider.embed.mockResolvedValueOnce(vectorsFor(['a']));

    const probe = await service.embed(['a']);

    expect(probe.degraded).toBe(false);
    expect(provider.embed).toHaveBeenCalledTimes(6);
    expect(service.available).toBe(true);
  });

  it('探测失败重新打开并重新计时', async () => {
    const provider = createProvider(async () => {
      throw new Error('down');
    });
    const service = createService(provider);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await service.embed(['a']);
    }

    vi.setSystemTime(new Date('2026-11-08T00:00:30.000Z'));
    provider.embed.mockRejectedValueOnce(new Error('still down'));
    await service.embed(['a']);
    expect(provider.embed).toHaveBeenCalledTimes(6);
    expect(service.available).toBe(false);

    // 重新打开后从新的失败点开始重新计时 30 秒。
    vi.setSystemTime(new Date('2026-11-08T00:00:59.000Z'));
    expect(service.available).toBe(false);
    vi.setSystemTime(new Date('2026-11-08T00:01:00.000Z'));
    expect(service.available).toBe(true);
  });

  it('半开状态下的并发调用不会打出第二个探测', async () => {
    const provider = createProvider(async () => {
      throw new Error('down');
    });
    const service = createService(provider);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await service.embed(['a']);
    }
    vi.setSystemTime(new Date('2026-11-08T00:00:30.000Z'));

    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    provider.embed.mockImplementationOnce(async (texts) => {
      await gate;
      return vectorsFor(texts);
    });

    const probe = service.embed(['a']);
    const rejected = await service.embed(['a']);

    expect(rejected.degraded).toBe(true);
    expect(rejected.reason).toContain('半开');
    release?.();
    await expect(probe).resolves.toMatchObject({ degraded: false });
    expect(provider.embed).toHaveBeenCalledTimes(6);
  });
});

describe('构造校验', () => {
  it('非法的 dimension / maxBatchSize / timeoutMs 抛 INVALID_ARGUMENT', () => {
    const provider = createProvider(async (texts) => vectorsFor(texts));

    for (const config of [
      { ...CONFIG, dimension: 0 },
      { ...CONFIG, maxBatchSize: 0 },
      { ...CONFIG, timeoutMs: 0 },
    ]) {
      expect(
        () => new EmbeddingService({ provider, logger: createLogger(), cache: null, config }),
      ).toThrow(ComemError);
    }
  });
});
