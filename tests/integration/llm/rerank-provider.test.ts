import { createServer, type IncomingHttpHeaders, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HttpRerankProvider } from '../../../src/adapters/llm/rerank-provider.js';
import { ComemError, isRetryable } from '../../../src/domain/errors.js';
import type { Logger } from '../../../src/domain/log.js';

/**
 * 起一个真的 HTTP 服务而不是打桩 `fetch`：请求体形状、状态码、超时取消都是
 * 这层契约的一部分，打桩等于把被测的那部分换成自己的实现。
 */

interface RecordedRequest {
  readonly method: string | undefined;
  readonly url: string;
  readonly headers: IncomingHttpHeaders;
  readonly body: unknown;
}

type Responder = (request: RecordedRequest, response: ServerResponse) => void;

const MODEL = 'BAAI/bge-reranker-v2-m3';
const API_KEY = 'sk-test';

let server: Server;
let baseUrl: string;
let requests: RecordedRequest[];
let responder: Responder;

function createLogger(): Logger {
  const logger: Logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return logger;
}

function createProvider(overrides: Partial<ConstructorParameters<typeof HttpRerankProvider>[0]> = {}) {
  return new HttpRerankProvider({
    baseUrl,
    model: MODEL,
    apiKey: API_KEY,
    timeoutSeconds: 10,
    logger: createLogger(),
    ...overrides,
  });
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

/** 默认响应：按文档顺序返回全部分数。 */
function echoScores(request: RecordedRequest, response: ServerResponse): void {
  const documents = (request.body as { documents: readonly string[] }).documents;
  const results = documents.map((_document, index) => ({
    index,
    relevance_score: 1 - index / 10,
  }));
  sendJson(response, 200, { results, usage: { total_tokens: 42 } });
}

beforeEach(async () => {
  requests = [];
  responder = echoScores;
  server = createServer((request, response) => {
    let raw = '';
    request.on('data', (chunk: Buffer) => {
      raw += chunk.toString('utf8');
    });
    request.on('end', () => {
      const recorded: RecordedRequest = {
        method: request.method,
        url: request.url ?? '',
        headers: request.headers,
        body: raw === '' ? undefined : (JSON.parse(raw) as unknown),
      };
      requests.push(recorded);
      responder(recorded, response);
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}/v1`;
});

afterEach(async () => {
  // 超时用例里连接不会自己关，先强断再等 close，否则 afterEach 会挂住。
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
});

describe('构造', () => {
  it('暴露 model', () => {
    expect(createProvider().model).toBe(MODEL);
  });

  it('baseUrl 为空时抛 INVALID_ARGUMENT', () => {
    expect(() => createProvider({ baseUrl: '' })).toThrowError(
      expect.objectContaining({ code: 'INVALID_ARGUMENT' }),
    );
  });

  it('timeoutSeconds 必须是正数', () => {
    for (const timeoutSeconds of [0, -1, Number.NaN]) {
      expect(() => createProvider({ timeoutSeconds })).toThrowError(
        expect.objectContaining({ code: 'INVALID_ARGUMENT' }),
      );
    }
  });
});

describe('请求形状', () => {
  it('POST /v1/rerank，body 带 model / query / documents / top_n', async () => {
    const provider = createProvider();

    await provider.score('上下文记忆怎么存', ['文档一', '文档二', '文档三']);

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ method: 'POST', url: '/v1/rerank' });
    expect(requests[0]?.body).toEqual({
      model: MODEL,
      query: '上下文记忆怎么存',
      documents: ['文档一', '文档二', '文档三'],
      top_n: 3,
    });
  });

  it('带 API Key 时发 Authorization: Bearer', async () => {
    await createProvider().score('q', ['a']);

    expect(requests[0]?.headers['authorization']).toBe(`Bearer ${API_KEY}`);
    expect(requests[0]?.headers['content-type']).toBe('application/json');
  });

  it('apiKey 为空时不发 Authorization 头', async () => {
    await createProvider({ apiKey: '' }).score('q', ['a']);

    expect(requests[0]?.headers['authorization']).toBeUndefined();
  });

  it('baseUrl 末尾的斜杠不会拼出 `//rerank`', async () => {
    await createProvider({ baseUrl: `${baseUrl}/` }).score('q', ['a']);

    expect(requests[0]?.url).toBe('/v1/rerank');
  });

  it('top_n 等于文档条数（不截断，候选宽度由调用方决定）', async () => {
    await createProvider().score('q', ['a', 'b', 'c', 'd']);

    expect((requests[0]?.body as { top_n: number }).top_n).toBe(4);
  });
});

describe('取消', () => {
  it('上游取消信号中止请求（不重试）', async () => {
    const controller = new AbortController();
    controller.abort();

    const error = await createProvider()
      .score('q', ['a'], { signal: controller.signal })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ComemError);
  });
});

describe('超时', () => {
  it('timeoutMs 只能收紧配置，不能放宽：配置 1 秒 + timeoutMs 12000 实际按 1000 超时', async () => {
    // 永不响应：只有超时定时器能让这次调用结束，所以耗时就是实际生效的超时值。
    responder = () => {
      // 故意不响应
    };

    const startedAt = Date.now();
    const error = await createProvider({ timeoutSeconds: 1 })
      .score('q', ['a'], { timeoutMs: 12_000 })
      .catch((caught: unknown) => caught);
    const elapsedMs = Date.now() - startedAt;

    expect(error).toBeInstanceOf(ComemError);
    // 错误里带的就是**实际生效**的预算：1000 而不是 12000。
    expect((error as ComemError).details).toMatchObject({ timeout: true, timeoutMs: 1000 });
    // 实测等待时间也是 1 秒量级（12 秒会把这条用例拖成超时）。
    expect(elapsedMs).toBeGreaterThanOrEqual(900);
    expect(elapsedMs).toBeLessThan(4_000);
  });

  it('超时抛 PROVIDER_UNAVAILABLE 并带 details.timeout', async () => {
    // 永不响应，等超时定时器取消请求。
    responder = () => {
      // 故意不响应
    };

    const error = await createProvider()
      .score('q', ['a'], { timeoutMs: 30 })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ComemError);
    expect((error as ComemError).code).toBe('PROVIDER_UNAVAILABLE');
    expect((error as ComemError).details).toMatchObject({ timeout: true });
    expect(isRetryable(error as ComemError)).toBe(true);
  });
});
