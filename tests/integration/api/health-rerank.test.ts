/**
 * 重排超时的降级可见性（回归用例）。
 *
 * 背景：本地 `Qwen3-Reranker-0.6B` 重排 50 条候选要 8.05 秒 p50 / 9.35 秒 p95
 * （`eval/README.md` 的 105 条基线）。默认 10 秒超时时，105 条里超过一半的查询
 * 在重排返回前被中止、退回融合分，而**没有任何可见提示**——用户以为用了重排，
 * 实际用的是融合分（`AGENTS.md` §1「假实现会让真实缺陷看起来像正常状态」）。
 *
 * 这条用例钉住三件事：
 *
 * 1. 超时仍然返回融合分（检索不失败）；
 * 2. `warn` 日志带 `reason: timeout`、耗时与 `topN`；
 * 3. `GET /health` 的 `rerank.degraded` 为真，且 `status` 变成 `degraded`。
 *
 * 超时值压到 1 秒：这里测的是「超时之后的可见性」，不是「重排有多慢」。
 * `fetch` 替身永远不解析，只在 `AbortSignal` 触发时拒绝——真实 socket 一个都不开。
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createHttpServer } from '../../../src/api/http/server.js';
import { createContainer, type Container } from '../../../src/bootstrap/container.js';
import { Uri } from '../../../src/domain/uri.js';

const ROOT = 'comem://user/local';
const SUBJECT = 'user:local';
const PRINCIPALS: readonly string[] = ['user:local', 'user:*'];
const FILE = `${ROOT}/memories/rerank-timeout.md`;

let dataDir: string;
let container: Container;
let app: FastifyInstance;

beforeEach(async () => {
  // 重排请求挂住不返回，只在超时中止信号到来时拒绝。这样「超时」是真实的
  // AbortController 路径，而不是 mock 出来的错误码。
  //
  // 其它 URL（摘要生成会调 LLM）立即失败：`summary.generator: llm` 是为了让
  // `status` 的初始值不是 degraded，不能让摘要调用把 beforeEach 拖到超时。
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      if (!String(input).includes('/rerank')) {
        throw new TypeError('集成测试只模拟重排请求。');
      }
      const signal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        if (signal === undefined || signal === null) {
          // 没有信号就不会超时，测试会挂住——直接失败比静默通过好。
          reject(new Error('重排请求没有超时信号。'));
          return;
        }
        if (signal.aborted) {
          reject(new Error('aborted'));
          return;
        }
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    },
  );

  dataDir = await mkdtemp(join(tmpdir(), 'comem-health-rerank-'));
  container = await createContainer({
    configPath: join(dataDir, 'config.yaml'),
    env: {
      ...process.env,
      COMEM_DATA_DIR: dataDir,
      // 用 llm 摘要让 `status` 的初始值不是 degraded：这样 `degraded` 只能是
      // 重排失败带来的，断言不会与摘要降级混淆。
      COMEM_SUMMARY_GENERATOR: 'llm',
      COMEM_LOGGING_LEVEL: 'error',
      COMEM_RETRIEVAL_ENGINE: 'fts5',
      COMEM_RETRIEVAL_RERANK_ENABLED: 'true',
      COMEM_PROVIDERS_RERANK_TYPE: 'http',
      COMEM_PROVIDERS_RERANK_BASE_URL: 'http://127.0.0.1:1/v1',
      COMEM_PROVIDERS_RERANK_TIMEOUT_SECONDS: '1',
    },
  });
  await container.services.acl.ensureRootPreset(Uri.parse(ROOT));
  app = await createHttpServer({
    config: container.config,
    logger: container.logger,
    observability: container.observability,
    routes: container.routes,
    mcp: container.mcp,
    resolveIdentity: container.resolveIdentity,
  });

  await container.services.filesystem.write(
    Uri.parse(FILE),
    '# 标题\n\n上下文记忆数据库。',
    PRINCIPALS,
    { frontmatter: { summary: '一句话摘要' } },
  );
  await container.services.indexObserver.drain();
});

afterEach(async () => {
  await container.services.indexObserver.drain();
  await app.close();
  await container.close();
  vi.restoreAllMocks();
  await rm(dataDir, { recursive: true, force: true });
});

function json(response: { readonly body: string }): Record<string, unknown> {
  return JSON.parse(response.body) as Record<string, unknown>;
}

function resultOf(response: { readonly body: string }): Record<string, unknown> {
  const body = json(response);
  expect(body['status']).toBe('ok');
  return body['result'] as Record<string, unknown>;
}

describe('重排超时', () => {
  it('warn 带 reason / 耗时 / topN，检索退回融合分', async () => {
    const warn = vi.spyOn(container.logger, 'warn');

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/search/find',
      headers: { 'x-comem-subject': SUBJECT },
      payload: { query: '上下文' },
    });

    expect(response.statusCode).toBe(200);
    const result = resultOf(response);
    const hits = result['hits'] as readonly Record<string, unknown>[];
    // 退化成融合分：命中仍然返回，检索没有失败。
    expect(hits.length).toBeGreaterThan(0);

    expect(warn).toHaveBeenCalledWith(
      '重排失败，使用融合分',
      expect.objectContaining({
        model: 'BAAI/bge-reranker-v2-m3',
        reason: 'timeout',
        topN: expect.any(Number),
        durationMs: expect.any(Number),
        code: 'PROVIDER_UNAVAILABLE',
      }),
    );
  });

  it('GET /health 暴露 rerank.degraded，status 变成 degraded', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/v1/search/find',
      headers: { 'x-comem-subject': SUBJECT },
      payload: { query: '上下文' },
    });

    const health = resultOf(await app.inject({ method: 'GET', url: '/health' }));

    expect(health['status']).toBe('degraded');
    const rerank = health['rerank'] as Record<string, unknown>;
    expect(rerank['configured']).toBe(true);
    expect(rerank['degraded']).toBe(true);
    expect(rerank['failures']).toBe(1);
    const lastFailure = rerank['lastFailure'] as Record<string, unknown>;
    expect(lastFailure['reason']).toBe('timeout');
    expect(lastFailure['topN']).toEqual(expect.any(Number));
    expect(lastFailure['durationMs']).toEqual(expect.any(Number));
    expect(lastFailure['code']).toBe('PROVIDER_UNAVAILABLE');
    expect(typeof lastFailure['at']).toBe('string');
  });

  it('最近一次重排成功后 degraded 复位，failures 保留历史', async () => {
    // 第一次：超时。
    await app.inject({
      method: 'POST',
      url: '/api/v1/search/find',
      headers: { 'x-comem-subject': SUBJECT },
      payload: { query: '上下文' },
    });

    // 换掉 fetch 替身：让第二次重排返回合法分数，证明「成功一次即复位」。
    vi.mocked(globalThis.fetch).mockImplementation(
      async (): Promise<Response> =>
        new Response(
          JSON.stringify({ results: [{ index: 0, relevance_score: 0.5 }] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );

    await app.inject({
      method: 'POST',
      url: '/api/v1/search/find',
      headers: { 'x-comem-subject': SUBJECT },
      payload: { query: '上下文' },
    });

    const health = resultOf(await app.inject({ method: 'GET', url: '/health' }));
    const rerank = health['rerank'] as Record<string, unknown>;
    // 摘要生成器是 llm、没有降级摘要，所以 `status` 只可能由重排带来；
    // 最近一次重排成功后它必须复位成 ok。
    expect(health['status']).toBe('ok');
    expect(rerank['degraded']).toBe(false);
    expect(rerank['failures']).toBe(1);
    expect(rerank['lastFailure']).toBeNull();
  });
});
