import { describe, expect, it, vi, beforeEach } from 'vitest';
import { APICallError } from 'ai';

import { ComemError } from '../../../src/domain/errors.js';
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

function apiCallError(statusCode: number, message: string): APICallError {
  return new APICallError({
    message,
    url: 'https://example.test/v1/embeddings',
    requestBodyValues: {},
    statusCode,
    responseBody: JSON.stringify({ error: { message } }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  echoVectors();
});

describe('构造', () => {
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

  it('没配 baseUrl 时兜底到 OpenAI 官方地址', () => {
    new AiSdkEmbeddingProvider({
      type: 'openai-compatible',
      model: MODEL,
      apiKey: 'sk-test',
      dimension: DIMENSION,
      logger: createLogger(),
    });

    expect(mocks.createOpenAICompatible).toHaveBeenCalledWith(
      expect.objectContaining({ baseURL: 'https://api.openai.com/v1' }),
    );
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
  it('禁止 SDK 内部重试', async () => {
    const provider = createProvider();

    await provider.embed(['a']);

    expect(mocks.embedMany).toHaveBeenCalledWith(expect.objectContaining({ maxRetries: 0 }));
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

  it('413 只拆分失败的批次，并保持向量顺序与成功调用的 usage', async () => {
    const provider = createProvider({ maxBatchSize: 4 });
    mocks.embedMany.mockImplementation(({ values }: { values: string[] }) => {
      if (values.length === 4) {
        return Promise.reject(apiCallError(413, 'Payload too large'));
      }
      return Promise.resolve(
        embedResult(
          values.map((text) => [text.charCodeAt(0), 0, 0]),
          values.length,
        ),
      );
    });

    const result = await provider.embed(['a', 'b', 'c', 'd']);

    expect(
      mocks.embedMany.mock.calls.map(
        (call) => (call[0] as { values: string[] }).values,
      ),
    ).toEqual([
      ['a', 'b', 'c', 'd'],
      ['a', 'b'],
      ['c', 'd'],
    ]);
    expect(result.vectors.map((vector) => vector[0])).toEqual([97, 98, 99, 100]);
    expect(result.usage).toEqual({ promptTokens: 4, totalTokens: 4 });
  });

  it.each([400, 422])('识别出的单条 %s context-limit 按码点缩短前缀后重试', async (status) => {
    const provider = createProvider();
    mocks.embedMany
      .mockRejectedValueOnce(apiCallError(status, 'Max context reached: 60000 tokens'))
      .mockRejectedValueOnce(apiCallError(status, 'Sequence too long: 30003 > 8192'))
      .mockResolvedValueOnce(embedResult([[1, 0, 0]], 2));

    const result = await provider.embed(['甲😀乙丙丁']);

    expect(
      mocks.embedMany.mock.calls.map(
        (call) => (call[0] as { values: string[] }).values,
      ),
    ).toEqual([['甲😀乙丙丁'], ['甲😀'], ['甲']]);
    expect(result).toEqual({
      vectors: [[1, 0, 0]],
      usage: { promptTokens: 2, totalTokens: 2 },
    });
  });

  it('单条持续超限时缩到 1 后停止，所有尝试共用单批 abortSignal', async () => {
    const provider = createProvider();
    mocks.embedMany.mockRejectedValue(
      apiCallError(400, 'maximum context length exceeded'),
    );

    const error = await provider
      .embed(['甲乙丙丁戊己庚'])
      .catch((caught: unknown) => caught);

    const calls = mocks.embedMany.mock.calls.map(
      (call) => call[0] as { values: string[]; abortSignal: AbortSignal },
    );
    expect(calls.map((call) => call.values)).toEqual([
      ['甲乙丙丁戊己庚'],
      ['甲乙丙'],
      ['甲'],
    ]);
    expect(calls[1]?.abortSignal).toBe(calls[0]?.abortSignal);
    expect(calls[2]?.abortSignal).toBe(calls[0]?.abortSignal);
    expect(error).toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('普通 400 不拆分也不重试', async () => {
    const provider = createProvider({ maxBatchSize: 4 });
    mocks.embedMany.mockRejectedValue(
      apiCallError(400, 'Invalid request body'),
    );

    const error = await provider.embed(['a', 'b']).catch((caught: unknown) => caught);

    expect(mocks.embedMany).toHaveBeenCalledTimes(1);
    expect(error).toMatchObject({
      code: 'INVALID_ARGUMENT',
      details: { statusCode: 400 },
    });
  });

  it('仅提到 context window 但没有超限的 400 不重试', async () => {
    const provider = createProvider();
    mocks.embedMany.mockRejectedValue(
      apiCallError(400, 'This model supports a 60000 token context window'),
    );

    const error = await provider.embed(['a']).catch((caught: unknown) => caught);

    expect(mocks.embedMany).toHaveBeenCalledTimes(1);
    expect(error).toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('拆分后的每个请求都校验向量数量，不能靠另一支补齐', async () => {
    const provider = createProvider({ maxBatchSize: 4 });
    mocks.embedMany.mockImplementation(({ values }: { values: string[] }) => {
      if (values.length === 4) {
        return Promise.reject(apiCallError(413, 'Payload too large'));
      }
      return Promise.resolve(embedResult([[1, 0, 0]], 1));
    });

    const error = await provider.embed(['a', 'b', 'c', 'd']).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: 'INVALID_ARGUMENT',
      details: { expected: 2, actual: 1 },
    });
    expect(mocks.embedMany).toHaveBeenCalledTimes(2);
  });

  it('透传 abortSignal 给 SDK', async () => {
    const provider = createProvider();
    const controller = new AbortController();

    await provider.embed(['a'], { signal: controller.signal });

    const call = mocks.embedMany.mock.calls[0]?.[0] as { abortSignal: AbortSignal };
    expect(call.abortSignal).toBeInstanceOf(AbortSignal);
  });

  it('timeoutMs 只能收紧配置，不能放宽：配置 1 秒 + timeoutMs 12000 实际按 1000 超时', async () => {
    const provider = createProvider({ timeoutSeconds: 1 });
    // 永远不返回，等超时定时器 abort。
    mocks.embedMany.mockImplementation(
      ({ abortSignal }: { abortSignal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          abortSignal.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          });
        }),
    );

    const startedAt = Date.now();
    const error = await provider
      .embed(['a'], { timeoutMs: 12_000 })
      .catch((caught: unknown) => caught);
    const elapsedMs = Date.now() - startedAt;

    // 错误里带的就是**实际生效**的预算：1000 而不是 12000。
    expect(error).toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
      details: { timeoutMs: 1000 },
    });
    expect(elapsedMs).toBeGreaterThanOrEqual(900);
    expect(elapsedMs).toBeLessThan(4_000);
  });
});
