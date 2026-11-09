import { describe, expect, it, vi, beforeEach } from 'vitest';

import { ComemError, isRetryable } from '../../../src/domain/errors.js';
import type { Logger } from '../../../src/domain/log.js';

/**
 * `ai` 与 `@ai-sdk/openai-compatible` 都打桩：测试不调网络。
 *
 * 与 `ai-sdk-provider.test.ts` 同一套手法——`importOriginal` 保留真实的错误类，
 * 只替换 `embedMany` 与 provider 工厂。错误映射要用真类断言，不能自己造同形对象。
 */
const mocks = vi.hoisted(() => {
  const embedMany = vi.fn();
  const embeddingModel = vi.fn((modelId: string) => ({
    provider: 'openai-compatible',
    modelId,
  }));
  const createOpenAICompatible = vi.fn(() => ({ embeddingModel }));
  return { embedMany, embeddingModel, createOpenAICompatible };
});

vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return { ...actual, embedMany: mocks.embedMany };
});

vi.mock('@ai-sdk/openai-compatible', () => ({
  createOpenAICompatible: mocks.createOpenAICompatible,
}));

const { AiSdkEmbeddingProvider } = await import(
  '../../../src/adapters/llm/embedding-provider.js'
);

const DIMENSION = 3;
const MODEL = 'text-embedding-3-small';

function createLogger(): Logger {
  const logger: Logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return logger;
}

function createProvider(
  options: Partial<ConstructorParameters<typeof AiSdkEmbeddingProvider>[0]> = {},
): InstanceType<typeof AiSdkEmbeddingProvider> {
  return new AiSdkEmbeddingProvider({
    type: 'openai-compatible',
    baseUrl: 'https://example.test/v1',
    model: MODEL,
    apiKey: 'sk-test',
    dimension: DIMENSION,
    logger: createLogger(),
    ...options,
  });
}

/** 一次成功的 `embedMany` 返回值。 */
function embedResult(vectors: number[][], tokens = 7): Record<string, unknown> {
  return { embeddings: vectors, usage: { tokens } };
}

/** 让 mock 按输入条数返回等长的单位向量，`usage.tokens` 等于条数。 */
function echoVectors(): void {
  mocks.embedMany.mockImplementation(({ values }: { values: string[] }) =>
    Promise.resolve(embedResult(values.map(() => [1, 0, 0]), values.length)),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  echoVectors();
});

describe('构造', () => {
  it('暴露 model 与 dimension', () => {
    const provider = createProvider();

    expect(provider.model).toBe(MODEL);
    expect(provider.dimension).toBe(DIMENSION);
  });

  it('用 baseUrl / apiKey / model 构造 openai-compatible 的嵌入模型', () => {
    createProvider();

    expect(mocks.createOpenAICompatible).toHaveBeenCalledWith(
      expect.objectContaining({ baseURL: 'https://example.test/v1', apiKey: 'sk-test' }),
    );
    expect(mocks.embeddingModel).toHaveBeenCalledWith(MODEL);
  });

  it('type=anthropic 在构造时抛 INVALID_ARGUMENT', () => {
    expect(
      () =>
        new AiSdkEmbeddingProvider({
          type: 'anthropic',
          model: 'claude',
          apiKey: 'sk-test',
          dimension: DIMENSION,
          logger: createLogger(),
        }),
    ).toThrowError(ComemError);
  });

  it('dimension 必须是正整数', () => {
    for (const dimension of [0, -1, 1.5]) {
      expect(() => createProvider({ dimension })).toThrowError(ComemError);
    }
  });

  it('maxBatchSize 必须是正整数', () => {
    expect(() => createProvider({ maxBatchSize: 0 })).toThrowError(ComemError);
    expect(() => createProvider({ maxBatchSize: 1.5 })).toThrowError(ComemError);
  });
});

describe('embed', () => {
  it('空输入返回空结果，不调网络', async () => {
    const provider = createProvider();

    const result = await provider.embed([]);

    expect(mocks.embedMany).not.toHaveBeenCalled();
    expect(result).toEqual({ vectors: [], usage: { promptTokens: 0, totalTokens: 0 } });
  });

  it('禁止 SDK 内部重试', async () => {
    const provider = createProvider();

    await provider.embed(['a']);

    expect(mocks.embedMany).toHaveBeenCalledWith(expect.objectContaining({ maxRetries: 0 }));
  });

  it('按 maxBatchSize 分批，保持输入顺序', async () => {
    const provider = createProvider({ maxBatchSize: 2 });
    const texts = ['a', 'b', 'c', 'd', 'e'];

    const result = await provider.embed(texts);

    expect(mocks.embedMany).toHaveBeenCalledTimes(3);
    expect(mocks.embedMany.mock.calls.map((call) => (call[0] as { values: string[] }).values)).toEqual(
      [['a', 'b'], ['c', 'd'], ['e']],
    );
    expect(result.vectors).toHaveLength(5);
  });

  it('默认 maxBatchSize 是 128', async () => {
    const provider = createProvider();
    const texts = new Array<string>(129).fill('x');

    await provider.embed(texts);

    expect(mocks.embedMany).toHaveBeenCalledTimes(2);
    expect(mocks.embedMany.mock.calls.map((call) => (call[0] as { values: string[] }).values.length)).toEqual(
      [128, 1],
    );
  });

  it('usage 累加各批的 token', async () => {
    const provider = createProvider({ maxBatchSize: 1 });
    mocks.embedMany
      .mockResolvedValueOnce(embedResult([[1, 0, 0]], 10))
      .mockResolvedValueOnce(embedResult([[0, 1, 0]], 20));

    const result = await provider.embed(['a', 'b']);

    // 嵌入只有输入 token，promptTokens 与 totalTokens 是同一个数。
    expect(result.usage).toEqual({ promptTokens: 30, totalTokens: 30 });
  });

  it('维度不匹配抛 PROVIDER_UNAVAILABLE，并带 expected / actual', async () => {
    const provider = createProvider();
    mocks.embedMany.mockResolvedValue(embedResult([[1, 0]]));

    const error = await provider.embed(['a']).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ComemError);
    expect((error as ComemError).code).toBe('PROVIDER_UNAVAILABLE');
    expect((error as ComemError).details).toMatchObject({
      expected: DIMENSION,
      actual: 2,
      model: MODEL,
    });
  });

  it('透传 abortSignal 给 SDK', async () => {
    const provider = createProvider();
    const controller = new AbortController();

    await provider.embed(['a'], { signal: controller.signal });

    const call = mocks.embedMany.mock.calls[0]?.[0] as { abortSignal: AbortSignal };
    expect(call.abortSignal).toBeInstanceOf(AbortSignal);
  });

  it('超时抛 PROVIDER_UNAVAILABLE', async () => {
    const provider = createProvider();
    // 永远不返回，等超时定时器 abort。
    mocks.embedMany.mockImplementation(
      ({ abortSignal }: { abortSignal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          abortSignal.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          });
        }),
    );

    const error = await provider.embed(['a'], { timeoutMs: 10 }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    expect((error as Error).message).toContain('超时');
  });
});

describe('错误映射', () => {
  it.each([
    [400, 'INVALID_ARGUMENT', false],
    [404, 'INVALID_ARGUMENT', false],
    [422, 'INVALID_ARGUMENT', false],
    [401, 'UNAUTHENTICATED', false],
    [403, 'UNAUTHENTICATED', false],
    [429, 'RESOURCE_EXHAUSTED', true],
    [500, 'PROVIDER_UNAVAILABLE', true],
    [503, 'PROVIDER_UNAVAILABLE', true],
  ])('HTTP %i 映射成 %s（可重试：%s）', async (statusCode, code, retryable) => {
    const provider = createProvider();
    mocks.embedMany.mockRejectedValue(
      Object.assign(new Error(`HTTP ${statusCode}`), { statusCode }),
    );

    const error = await provider.embed(['a']).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ComemError);
    expect((error as ComemError).code).toBe(code);
    expect(isRetryable(error as ComemError)).toBe(retryable);
    // 适配器自己不发起重试：重试在服务层，它还要看「维度不匹配不重试」这类判断。
    expect(mocks.embedMany).toHaveBeenCalledTimes(1);
  });

  it('网络错误（TypeError）映射成 PROVIDER_UNAVAILABLE', async () => {
    const provider = createProvider();
    mocks.embedMany.mockRejectedValue(new TypeError('fetch failed'));

    await expect(provider.embed(['a'])).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
  });

  it('未知错误映射成 INTERNAL', async () => {
    const provider = createProvider();
    mocks.embedMany.mockRejectedValue(new Error('boom'));

    await expect(provider.embed(['a'])).rejects.toMatchObject({ code: 'INTERNAL' });
  });
});
