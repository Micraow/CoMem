/**
 * `EmbeddingProvider` 契约套件的注册处。
 *
 * 仓库里只有一个真实实现（`AiSdkEmbeddingProvider`），关闭态由
 * `EmbeddingService(provider: null)` 表达而不是另一个 provider。套件按端口契约
 * 注册，第二个实现接进来时只需要在这里加一行。
 *
 * 传输层替身对 `t<N>` 返回首分量为 `N + 1` 的向量，让「输出与入参同序」可以被
 * 断言，而不必绑定某家供应商的响应格式。
 */

import { vi } from 'vitest';

import type { Logger } from '../../src/domain/log.js';
import type { EmbeddingConformanceSubject } from './embedding-provider-suite.js';
import { ComemError } from '../../src/domain/errors.js';

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
  '../../src/adapters/llm/embedding-provider.js'
);
const { describeEmbeddingProviderConformance } = await import('./embedding-provider-suite.js');
const { PASS_THROUGH_MESSAGE } = await import('./conformance.js');

const MODEL = 'contract-embedding';
const DIMENSION = 3;

function createLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function createProvider(
  options: { readonly maxBatchSize?: number } = {},
): InstanceType<typeof AiSdkEmbeddingProvider> {
  return new AiSdkEmbeddingProvider({
    type: 'openai-compatible',
    baseUrl: 'https://example.test/v1',
    model: MODEL,
    apiKey: 'sk-test',
    dimension: DIMENSION,
    timeoutSeconds: 5,
    logger: createLogger(),
    ...options,
  });
}

const batches: string[][] = [];

function installEcho(): void {
  batches.length = 0;
  mocks.embedMany.mockReset();
  mocks.embedMany.mockImplementation(({ values }: { values: readonly string[] }) => {
    batches.push([...values]);
    return Promise.resolve({
      embeddings: values.map((text) => {
        const index = Number(text.slice(1)) + 1;
        return [index, 0, 0];
      }),
      usage: { tokens: values.length },
    });
  });
}

function providerApiError(status: number): Error {
  return Object.assign(new Error(`HTTP ${String(status)}`), { statusCode: status });
}

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

const subject: EmbeddingConformanceSubject = {
  name: 'AiSdkEmbeddingProvider',
  model: MODEL,
  dimension: DIMENSION,
  create: createProvider,
  batches: () => batches,
  reset: installEcho,
  fail: (failure) => {
    if (failure.kind === 'vector-dimension') {
      batches.length = 0;
      mocks.embedMany.mockReset();
      mocks.embedMany.mockResolvedValue({
        embeddings: [
          Array.from({ length: failure.actual }, (_value, index) => (index === 0 ? 1 : 0)),
        ],
        usage: { tokens: 1 },
      });
      return createProvider().embed(['a']);
    }

    batches.length = 0;
    mocks.embedMany.mockReset();
    switch (failure.kind) {
      case 'status':
        mocks.embedMany.mockRejectedValue(providerApiError(failure.status));
        break;
      case 'timeout':
        mocks.embedMany.mockImplementation(hangUntilAbort);
        return createProvider().embed(['a'], { timeoutMs: 5 });
      case 'network':
        mocks.embedMany.mockRejectedValue(new TypeError('fetch failed'));
        break;
      case 'unknown':
        mocks.embedMany.mockRejectedValue(new Error('boom'));
        break;
      case 'comem':
        mocks.embedMany.mockRejectedValue(
          new ComemError('RESOURCE_EXHAUSTED', PASS_THROUGH_MESSAGE),
        );
        break;
    }
    return createProvider().embed(['a']);
  },
};

describeEmbeddingProviderConformance(subject);
