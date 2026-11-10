/**
 * `RerankProvider` 契约套件的注册处。
 *
 * 当前只有 `HttpRerankProvider` 一个实现（关闭态是 `undefined`）。套件按端口契约
 * 注册：`score` 的输出与入参同序同长、缺失位置是 `null`，非法响应与传输失败各自
 * 落到固定的领域错误码。
 */

import { vi } from 'vitest';

import { ComemError } from '../../src/domain/errors.js';
import type { RerankConformanceSubject } from './rerank-provider-suite.js';

const { HttpRerankProvider } = await import('../../src/adapters/llm/rerank-provider.js');
const { describeRerankProviderConformance } = await import('./rerank-provider-suite.js');
const { PASS_THROUGH_MESSAGE } = await import('./conformance.js');

const MODEL = 'BAAI/bge-reranker-v2-m3';

let requestCount = 0;

function createLogger(): {
  readonly debug: ReturnType<typeof vi.fn>;
  readonly info: ReturnType<typeof vi.fn>;
  readonly warn: ReturnType<typeof vi.fn>;
  readonly error: ReturnType<typeof vi.fn>;
} {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function createProvider(fetchImpl: typeof fetch): InstanceType<typeof HttpRerankProvider> {
  return new HttpRerankProvider({
    baseUrl: 'https://rerank.example.test/v1',
    model: MODEL,
    apiKey: 'sk-test',
    timeoutSeconds: 10,
    logger: createLogger(),
    fetchImpl,
  });
}

function jsonFetch(body: unknown): typeof fetch {
  return async () => {
    requestCount += 1;
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
}

function statusFetch(status: number): typeof fetch {
  return async () => {
    requestCount += 1;
    return new Response(JSON.stringify({ message: `HTTP ${String(status)}` }), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
}

const hangingFetch: typeof fetch = (_input, init) => {
  requestCount += 1;
  return new Promise<Response>((_resolve, reject) => {
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
};

const subject: RerankConformanceSubject = {
  name: 'HttpRerankProvider',
  model: MODEL,
  create: (results) =>
    createProvider(
      jsonFetch({
        results: results.map((entry) => ({
          index: entry.index,
          relevance_score: entry.score,
        })),
      }),
    ),
  createInvalid: (response) =>
    createProvider(
      response.kind === 'missing-results'
        ? jsonFetch({ data: [] })
        : async () => {
            requestCount += 1;
            return new Response('<html>not a rerank api</html>', {
              status: 200,
              headers: { 'content-type': 'text/html' },
            });
          },
    ),
  requests: () => requestCount,
  reset: () => {
    requestCount = 0;
  },
  fail: (failure) => {
    switch (failure.kind) {
      case 'status':
        return createProvider(statusFetch(failure.status)).score('查询', ['文档一']);
      case 'timeout':
        return createProvider(hangingFetch).score('查询', ['文档一'], { timeoutMs: 5 });
      case 'network':
        return createProvider(async () => {
          requestCount += 1;
          throw new TypeError('fetch failed');
        }).score('查询', ['文档一']);
      case 'unknown':
        return createProvider(async () => {
          requestCount += 1;
          throw new Error('boom');
        }).score('查询', ['文档一']);
      case 'comem':
        return createProvider(async () => {
          requestCount += 1;
          throw new ComemError('RESOURCE_EXHAUSTED', PASS_THROUGH_MESSAGE);
        }).score('查询', ['文档一']);
    }
  },
};

describeRerankProviderConformance(subject);
