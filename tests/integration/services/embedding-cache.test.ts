/**
 * 嵌入缓存在服务层的契约（架构文档 §8.1 的 `embedding_cache`、§7 的派生数据原则）。
 *
 * 这一组回答的是**使用者看到的行为**：
 *
 * | 场景 | 期望 |
 * |---|---|
 * | 同一段文本嵌过两次 | 第二次不发请求 |
 * | 换模型 | 未命中，重新请求（缓存不跨模型） |
 * | 部分命中 | 只把未命中的送供应商 |
 * | 缓存读失败 | 当未命中，照常请求 |
 * | 缓存写失败 | 向量照常返回，只记 warn |
 * | 缓存维度与配置不一致 | 当未命中 |
 *
 * 用真实的 `EmbeddingCacheRepository` 配 `:memory:` SQLite：只有真库才能证明
 * 「命中」这件事发生在正确的键上（`(model, content_digest)`）。失败路径用手写
 * 替身——真实仓储的 `put` 在磁盘满之前不会抛。
 */

import type { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { openDatabase, runMigrations } from '../../../src/adapters/sqlite/database.js';
import {
  EmbeddingCacheRepository,
  type EmbeddingCacheEntry,
} from '../../../src/adapters/sqlite/embedding-cache.js';
import type { EmbeddingProvider, EmbeddingResult } from '../../../src/domain/embedding.js';
import { ComemError } from '../../../src/domain/errors.js';
import type { Logger } from '../../../src/domain/log.js';
import { stableDigest } from '../../../src/domain/node.js';
import {
  EmbeddingService,
  type EmbeddingCachePort,
} from '../../../src/services/embedding.js';

const DIMENSION = 3;
const MODEL = 'test-embedding';

let db: DatabaseSync;
let logger: Logger;

function createLogger(): Logger {
  const created: Logger = {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => created,
  };
  return created;
}

interface FakeProvider extends EmbeddingProvider {
  readonly embed: ReturnType<typeof vi.fn>;
}

/** 每次成功返回一个「文本长度」向量，便于断言返回的是哪一条的结果。 */
function createProvider(model = MODEL): FakeProvider {
  return {
    model,
    dimension: DIMENSION,
    embed: vi.fn(
      (texts: readonly string[]): Promise<EmbeddingResult> =>
        Promise.resolve({
          vectors: texts.map((text) => [text.length, 1, 0]),
          usage: { promptTokens: texts.length, totalTokens: texts.length },
        }),
    ),
  };
}

function createCache(maxEntries = 100): EmbeddingCacheRepository {
  return new EmbeddingCacheRepository({ db, logger, maxEntries });
}

function createService(
  provider: EmbeddingProvider | null,
  cache: EmbeddingCachePort | null,
): EmbeddingService {
  return new EmbeddingService({
    provider,
    logger,
    cache,
    config: { dimension: DIMENSION, maxBatchSize: 128, timeoutMs: 30_000 },
  });
}

beforeEach(() => {
  db = openDatabase(':memory:');
  runMigrations(db);
  logger = createLogger();
});

afterEach(() => {
  db.close();
  vi.restoreAllMocks();
});

describe('嵌入缓存', () => {
  it('命中不发请求，返回缓存里的向量', async () => {
    const provider = createProvider();
    const cache = createCache();
    const service = createService(provider, cache);

    const first = await service.embed(['一段记忆']);
    expect(provider.embed).toHaveBeenCalledTimes(1);
    // 第一次的结果写进了缓存。
    expect(cache.count()).toBe(1);

    const second = await service.embed(['一段记忆']);
    expect(provider.embed).toHaveBeenCalledTimes(1);
    expect(second.degraded).toBe(false);
    expect(second.vectors).toEqual(first.vectors);
    // 命中不消耗 token：统计里只有第一次的那一次调用。
    expect(service.stats()).toMatchObject({ calls: 1, tokens: 1 });
  });

  it('未命中发请求', async () => {
    const provider = createProvider();
    const service = createService(provider, createCache());

    await service.embed(['甲']);
    await service.embed(['乙']);

    expect(provider.embed).toHaveBeenCalledTimes(2);
    expect(provider.embed.mock.calls.map(([texts]) => texts)).toEqual([['甲'], ['乙']]);
  });

  it('模型变了未命中：缓存不跨模型', async () => {
    const cache = createCache();
    const first = createProvider('model-a');
    await createService(first, cache).embed(['同一段文本']);
    expect(first.embed).toHaveBeenCalledTimes(1);

    const second = createProvider('model-b');
    await createService(second, cache).embed(['同一段文本']);
    expect(second.embed).toHaveBeenCalledTimes(1);
    // 两个模型各一行，同一个 digest 不互相覆盖。
    expect(cache.count()).toBe(2);
  });

  it('部分命中时只把未命中的送供应商', async () => {
    const provider = createProvider();
    const cache = createCache();
    const service = createService(provider, cache);

    const seeded = await service.embed(['已经嵌过']);
    expect(provider.embed).toHaveBeenCalledTimes(1);

    const outcome = await service.embed(['已经嵌过', '新的一条']);
    expect(provider.embed).toHaveBeenCalledTimes(2);
    // 只送未命中的那一条。
    expect(provider.embed.mock.calls[1]?.[0]).toEqual(['新的一条']);
    // 两条都拿到向量，且第 0 条来自缓存（与第一次调用的结果逐位相同）。
    expect(outcome.degraded).toBe(false);
    expect(outcome.vectors).toHaveLength(2);
    expect(outcome.vectors[0]).toEqual(seeded.vectors[0]);
  });

  it('缓存读失败降级成未命中，仍然打供应商', async () => {
    const provider = createProvider();
    const broken: EmbeddingCachePort = {
      getMany: () => {
        throw new ComemError('INTERNAL', '磁盘坏了。', {});
      },
      put: vi.fn(),
    };
    const service = createService(provider, broken);

    const outcome = await service.embed(['一段记忆']);

    expect(provider.embed).toHaveBeenCalledTimes(1);
    expect(outcome.degraded).toBe(false);
    expect(outcome.vectors).toHaveLength(1);
    expect(logger.warn).toHaveBeenCalledWith(
      '嵌入缓存读取失败，按未命中处理。',
      expect.objectContaining({ model: MODEL }),
    );
  });

  it('缓存写失败降级：向量照常返回，只记 warn', async () => {
    const provider = createProvider();
    const broken: EmbeddingCachePort = {
      getMany: () => new Map(),
      put: () => {
        throw new ComemError('INTERNAL', '磁盘满了。', {});
      },
    };
    const service = createService(provider, broken);

    const outcome = await service.embed(['一段记忆']);

    expect(outcome.degraded).toBe(false);
    expect(outcome.vectors).toHaveLength(1);
    expect(logger.warn).toHaveBeenCalledWith(
      '嵌入缓存写入失败，已忽略。',
      expect.objectContaining({ model: MODEL, count: 1 }),
    );
  });

  it('缓存里维度与配置不一致的行当未命中', async () => {
    const provider = createProvider();
    const cache = createCache();
    // 手工写一行 4 维的（配置是 3 维）：模型名相同，主键命中但长度不对。
    const wrong: EmbeddingCacheEntry = {
      model: MODEL,
      contentDigest: stableDigest('一段记忆'),
      dimension: DIMENSION + 1,
      vector: [1, 0, 0, 0],
    };
    cache.put([wrong]);

    const service = createService(provider, cache);
    const outcome = await service.embed(['一段记忆']);

    expect(provider.embed).toHaveBeenCalledTimes(1);
    expect(outcome.vectors[0]).toHaveLength(DIMENSION);
    expect(logger.warn).toHaveBeenCalledWith(
      '嵌入缓存维度与配置不一致，按未命中处理',
      expect.objectContaining({ expected: DIMENSION }),
    );
  });

  it('全部命中时不推进熔断状态', async () => {
    const provider = createProvider();
    const cache = createCache();
    const service = createService(provider, cache);
    await service.embed(['一段记忆']);
    const before = service.stats();

    // 让供应商挂掉：后续未命中会降级。
    provider.embed.mockRejectedValue(new ComemError('PROVIDER_UNAVAILABLE', '挂了。', {}));
    const hit = await service.embed(['一段记忆']);
    expect(hit.degraded).toBe(false);
    // 命中没有产生新的调用，也没有把降级计数加一。
    expect(service.stats()).toEqual(before);
  });

  it('cache: null 时完全不碰缓存', async () => {
    const provider = createProvider();
    const service = createService(provider, null);

    await service.embed(['甲']);
    await service.embed(['甲']);

    // 没有缓存两次都打网络。
    expect(provider.embed).toHaveBeenCalledTimes(2);
  });
});
