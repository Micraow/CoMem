import { NoObjectGeneratedError, TypeValidationError } from 'ai';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { ComemError, isRetryable, type ComemErrorCode } from '../../../src/domain/errors.js';
import type { Logger } from '../../../src/domain/log.js';

/**
 * 三家的「供应商错误 → 领域失败」对拍表。
 *
 * 目的不是再测一遍各家适配器的细节，而是把**同一个故障在三条链路上的失败码与
 * 重试结论**钉在同一张表里。合并前这三份逻辑是复制的，任何一处改动都可能让
 * 「429 在对话补全里可重试、在嵌入里不可重试」这种漂移悄悄出现而没有任何测试变红。
 *
 * 样本只用仓库里已有的形态：SDK 抛出的错误对象（结构上带 `statusCode`）、
 * `TypeError`、超时定时器、`NoObjectGeneratedError` / `TypeValidationError`。
 * 没有真实供应商的响应 body 样本，所以 body 里的错误码不单独建模——「HTTP 400 +
 * body code」这一条断言的是当前行为：按状态码判为不可重试，body 不参与判定。
 */

const mocks = vi.hoisted(() => {
  const generateText = vi.fn();
  const generateObject = vi.fn();
  const embedMany = vi.fn();
  const createOpenAICompatible = vi.fn(() => {
    const model = vi.fn((modelId: string) => ({ provider: 'openai-compatible', modelId }));
    return Object.assign(model, { chatModel: model, embeddingModel: model });
  });
  const createAnthropic = vi.fn(() => {
    const model = vi.fn((modelId: string) => ({ provider: 'anthropic', modelId }));
    return Object.assign(model, { chatModel: model });
  });
  return {
    generateText,
    generateObject,
    embedMany,
    createOpenAICompatible,
    createAnthropic,
  };
});

vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return {
    ...actual,
    generateText: mocks.generateText,
    generateObject: mocks.generateObject,
    embedMany: mocks.embedMany,
  };
});

vi.mock('@ai-sdk/openai-compatible', () => ({
  createOpenAICompatible: mocks.createOpenAICompatible,
}));

vi.mock('@ai-sdk/anthropic', () => ({ createAnthropic: mocks.createAnthropic }));

const { AiSdkLlmProvider } = await import('../../../src/adapters/llm/ai-sdk-provider.js');
const { AiSdkEmbeddingProvider } = await import(
  '../../../src/adapters/llm/embedding-provider.js'
);
const { HttpRerankProvider } = await import('../../../src/adapters/llm/rerank-provider.js');

const PROMPT = { messages: [{ role: 'user' as const, content: '你好' }] };
const SCHEMA = z.object({ ok: z.boolean() });

function createLogger(): Logger {
  const logger: Logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return logger;
}

function createChatProvider(): InstanceType<typeof AiSdkLlmProvider> {
  return new AiSdkLlmProvider({
    type: 'openai-compatible',
    baseUrl: 'https://example.test/v1',
    model: 'test-model',
    apiKey: 'sk-test',
    maxTokens: 1024,
    timeoutSeconds: 5,
    logger: createLogger(),
  });
}

function createEmbeddingProvider(): InstanceType<typeof AiSdkEmbeddingProvider> {
  return new AiSdkEmbeddingProvider({
    type: 'openai-compatible',
    baseUrl: 'https://example.test/v1',
    model: 'text-embedding-3-small',
    apiKey: 'sk-test',
    dimension: 3,
    timeoutSeconds: 5,
    logger: createLogger(),
  });
}

function createRerankProvider(fetchImpl: typeof fetch): InstanceType<typeof HttpRerankProvider> {
  return new HttpRerankProvider({
    baseUrl: 'https://example.test/v1',
    model: 'BAAI/bge-reranker-v2-m3',
    apiKey: 'sk-test',
    timeoutSeconds: 5,
    logger: createLogger(),
    fetchImpl,
  });
}

type Modality = 'chat' | 'embedding' | 'rerank';

type Failure =
  | { readonly kind: 'status'; readonly status: number; readonly body?: string }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'network' }
  | { readonly kind: 'unknown' }
  | { readonly kind: 'comem'; readonly code: ComemErrorCode }
  | { readonly kind: 'json-parse' }
  | { readonly kind: 'truncated' };

interface Scenario {
  readonly name: string;
  readonly failure: Failure;
  readonly code: ComemErrorCode;
  readonly retryable: boolean;
  /** 只适用于某一条链路时填它（结构化输出只有生成链路有）。 */
  readonly only?: Modality;
}

const STATUS_CASES: readonly {
  readonly status: number;
  readonly code: ComemErrorCode;
  readonly retryable: boolean;
  readonly note?: string;
}[] = [
  { status: 400, code: 'INVALID_ARGUMENT', retryable: false },
  { status: 401, code: 'UNAUTHENTICATED', retryable: false },
  { status: 403, code: 'UNAUTHENTICATED', retryable: false },
  { status: 404, code: 'INVALID_ARGUMENT', retryable: false },
  {
    status: 413,
    code: 'INVALID_ARGUMENT',
    retryable: false,
    note: '（请求体 / 上下文超限，重发同一份输入仍然超限）',
  },
  { status: 429, code: 'RESOURCE_EXHAUSTED', retryable: true },
  { status: 500, code: 'PROVIDER_UNAVAILABLE', retryable: true },
  { status: 502, code: 'PROVIDER_UNAVAILABLE', retryable: true },
  { status: 503, code: 'PROVIDER_UNAVAILABLE', retryable: true },
  { status: 504, code: 'PROVIDER_UNAVAILABLE', retryable: true },
];

const SCENARIOS: readonly Scenario[] = [
  ...STATUS_CASES.map(
    (testCase): Scenario => ({
      name: `HTTP ${testCase.status}${testCase.note ?? ''}`,
      failure: { kind: 'status', status: testCase.status },
      code: testCase.code,
      retryable: testCase.retryable,
    }),
  ),
  {
    name: 'HTTP 400 + body code=context_length_exceeded（body 不参与判定）',
    failure: {
      kind: 'status',
      status: 400,
      body: JSON.stringify({ error: { code: 'context_length_exceeded' } }),
    },
    code: 'INVALID_ARGUMENT',
    retryable: false,
  },
  {
    name: '超时',
    failure: { kind: 'timeout' },
    code: 'PROVIDER_UNAVAILABLE',
    retryable: true,
  },
  {
    name: '连接中断（TypeError: fetch failed / ECONNRESET）',
    failure: { kind: 'network' },
    code: 'PROVIDER_UNAVAILABLE',
    retryable: true,
  },
  {
    name: '未知异常',
    failure: { kind: 'unknown' },
    code: 'INTERNAL',
    retryable: false,
  },
  {
    name: '已经是 ComemError（不重新映射）',
    failure: { kind: 'comem', code: 'RESOURCE_EXHAUSTED' },
    code: 'RESOURCE_EXHAUSTED',
    retryable: true,
  },
  {
    name: '结构化输出解析失败',
    failure: { kind: 'json-parse' },
    code: 'INVALID_ARGUMENT',
    retryable: false,
    only: 'chat',
  },
  {
    name: '结构化输出被截断',
    failure: { kind: 'truncated' },
    code: 'PROVIDER_UNAVAILABLE',
    retryable: true,
    only: 'chat',
  },
];

/** 按状态码造一个「结构上像 APICallError」的错误；不构造真类，避免依赖 SDK 内部形状。 */
function providerApiError(status: number, body?: string): Error {
  return Object.assign(new Error(`HTTP ${status}`), {
    statusCode: status,
    ...(body === undefined ? {} : { responseBody: body }),
  });
}

/** 永不完成，直到适配器的超时定时器 abort。 */
function hangUntilAbort({ abortSignal }: { abortSignal: AbortSignal }): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (abortSignal.aborted) {
      reject(new DOMException('aborted', 'AbortError'));
      return;
    }
    abortSignal.addEventListener('abort', () => {
      reject(new DOMException('aborted', 'AbortError'));
    });
  });
}

function statusFetch(status: number, body?: string): typeof fetch {
  return async () =>
    new Response(body ?? JSON.stringify({ error: { message: `HTTP ${status}` } }), {
      status,
      headers: { 'content-type': 'application/json' },
    });
}

const hangingFetch: typeof fetch = (_input, init) =>
  new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    if (signal === null || signal === undefined) {
      return;
    }
    if (signal.aborted) {
      reject(new DOMException('aborted', 'AbortError'));
      return;
    }
    signal.addEventListener('abort', () => {
      reject(new DOMException('aborted', 'AbortError'));
    });
  });

function truncatedError(): NoObjectGeneratedError {
  return new NoObjectGeneratedError({
    message: 'truncated',
    cause: new Error('unterminated JSON'),
    text: '{"ok":',
    response: { id: 'r1', modelId: 'test', timestamp: new Date() },
    usage: {
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 2,
      inputTokenDetails: {
        noCacheTokens: undefined,
        cacheReadTokens: undefined,
        cacheWriteTokens: undefined,
      },
      outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
    },
    finishReason: 'length',
  });
}

/** 触发生成链路的一次失败调用；返回适配器拒绝时的原始抛出物。 */
async function failChat(failure: Failure): Promise<unknown> {
  const provider = createChatProvider();
  switch (failure.kind) {
    case 'timeout':
      mocks.generateText.mockImplementation(hangUntilAbort);
      return provider.complete(PROMPT, { timeoutMs: 5 });
    case 'status':
      mocks.generateText.mockRejectedValue(providerApiError(failure.status, failure.body));
      break;
    case 'network':
      mocks.generateText.mockRejectedValue(new TypeError('fetch failed: ECONNRESET'));
      break;
    case 'unknown':
      mocks.generateText.mockRejectedValue(new Error('boom'));
      break;
    case 'comem':
      mocks.generateText.mockRejectedValue(new ComemError(failure.code, '已有领域失败'));
      break;
    case 'json-parse':
      mocks.generateObject.mockRejectedValue(
        new TypeValidationError({ value: 'not-json', cause: new Error('bad schema') }),
      );
      return provider.completeJson(PROMPT, SCHEMA);
    case 'truncated':
      mocks.generateObject.mockRejectedValue(truncatedError());
      return provider.completeJson(PROMPT, SCHEMA);
  }
  return provider.complete(PROMPT);
}

async function failEmbedding(failure: Failure): Promise<unknown> {
  const provider = createEmbeddingProvider();
  switch (failure.kind) {
    case 'timeout':
      mocks.embedMany.mockImplementation(hangUntilAbort);
      return provider.embed(['a'], { timeoutMs: 5 });
    case 'status':
      mocks.embedMany.mockRejectedValue(providerApiError(failure.status, failure.body));
      break;
    case 'network':
      mocks.embedMany.mockRejectedValue(new TypeError('fetch failed: ECONNRESET'));
      break;
    case 'unknown':
      mocks.embedMany.mockRejectedValue(new Error('boom'));
      break;
    case 'comem':
      mocks.embedMany.mockRejectedValue(new ComemError(failure.code, '已有领域失败'));
      break;
    case 'json-parse':
    case 'truncated':
      // 嵌入没有结构化输出，这两条不会进入本链路（`only: 'chat'`）。
      throw new Error('嵌入链路没有结构化输出');
  }
  return provider.embed(['a']);
}

async function failRerank(failure: Failure): Promise<unknown> {
  switch (failure.kind) {
    case 'timeout':
      return createRerankProvider(hangingFetch).score('q', ['a'], { timeoutMs: 5 });
    case 'status':
      return createRerankProvider(statusFetch(failure.status, failure.body)).score('q', ['a']);
    case 'network':
      return createRerankProvider(async () => {
        throw new TypeError('fetch failed: ECONNRESET');
      }).score('q', ['a']);
    case 'unknown':
      return createRerankProvider(async () => {
        throw new Error('boom');
      }).score('q', ['a']);
    case 'comem':
      return createRerankProvider(async () => {
        throw new ComemError(failure.code, '已有领域失败');
      }).score('q', ['a']);
    case 'json-parse':
    case 'truncated':
      throw new Error('重排链路没有结构化输出');
  }
}

async function failWith(modality: Modality, failure: Failure): Promise<ComemError> {
  const caught = await (modality === 'chat'
    ? failChat(failure)
    : modality === 'embedding'
      ? failEmbedding(failure)
      : failRerank(failure)
  ).catch((error: unknown) => error);

  expect(caught).toBeInstanceOf(ComemError);
  return caught as ComemError;
}

function scenariosFor(modality: Modality): readonly Scenario[] {
  return SCENARIOS.filter((scenario) => scenario.only === undefined || scenario.only === modality);
}

beforeEach(() => {
  vi.clearAllMocks();
});

const MODALITIES: readonly Modality[] = ['chat', 'embedding', 'rerank'];

describe.each(MODALITIES)('%s 链路的供应商错误矩阵', (modality) => {
  it.each(scenariosFor(modality))(
    '$name → $code（isRetryable=$retryable）',
    async (scenario) => {
      const error = await failWith(modality, scenario.failure);

      expect(error.code).toBe(scenario.code);
      expect(isRetryable(error)).toBe(scenario.retryable);
    },
  );
});

describe('映射时的细节约定', () => {
  it('只有重排的超时在 details 里带 timeout: true（服务层据此区分降级原因）', async () => {
    const rerank = await failWith('rerank', { kind: 'timeout' });
    expect(rerank.details).toMatchObject({ timeout: true });

    const chat = await failWith('chat', { kind: 'timeout' });
    expect(chat.details?.['timeout']).toBeUndefined();
    const embedding = await failWith('embedding', { kind: 'timeout' });
    expect(embedding.details?.['timeout']).toBeUndefined();
  });

  it('状态码失败保留 details.statusCode（服务层据此区分 5xx 与网络）', async () => {
    for (const modality of MODALITIES) {
      const error = await failWith(modality, { kind: 'status', status: 503 });
      expect(error.details).toMatchObject({ statusCode: 503 });
    }
  });

  it('结构化输出截断带 truncated 标记，服务层据此跳过重试', async () => {
    const error = await failWith('chat', { kind: 'truncated' });

    // `isRetryable` 只看 code，PROVIDER_UNAVAILABLE 本身在可重试集合里；
    // `services/llm.ts` 先看 `truncated` 标记再决定，不会被误导重试一次同样的上限。
    expect(error.details).toMatchObject({ truncated: true, finishReason: 'length' });
    expect(isRetryable(error)).toBe(true);
  });
});
