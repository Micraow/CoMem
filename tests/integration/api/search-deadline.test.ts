/**
 * HTTP 检索端点的墙上时钟上限（`src/api/deadline.ts`、`src/api/http/routes/search.ts`）。
 *
 * 这一组测试要证明四件事，每件都对应一次真实的「调用方被挂住」：
 *
 * 1. **三个会调模型的端点在预算内返回明确的超时错误**：503 `PROVIDER_UNAVAILABLE`，
 *    带 `details.timeout` 与卡住的上游；不是挂住，也不是 200 + 空结果；
 * 2. **`app.inject()` 与真实监听端口都生效**：上限施加在路由 handler 上，两条
 *    路径都经过它；
 * 3. **正常请求不受影响**：同样的接线在默认上限下照常返回 200（包括一次快速降级的
 *    意图分析）；
 * 4. **上限可测**：预算通过 `createSearchRoutes` 的装配参数注入（与
 *    `ToolRegistry` 的 `deadlineMs` 同一手法），没有用户可调配置项。
 *
 * ## 为什么模型请求用替身而不是真实的慢服务器
 *
 * 这里要证明的是「到点一定返回错误」，不是「供应商的 `timeoutMs` 生效」——后者由
 * `tests/integration/mcp/tool-deadline.test.ts` 用真实的本地慢服务器覆盖。替身是
 * 一个永远不 settle 的 Promise，等价于「供应商连 TCP 都不回」，而且不需要真的等
 * 30 秒：预算注入 120 毫秒。
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SearchRouteServices } from '../../../src/api/http/routes/search.js';
import { createSearchRoutes } from '../../../src/api/http/routes/search.js';
import { createHttpServer } from '../../../src/api/http/server.js';
import { createContainer, type Container } from '../../../src/bootstrap/container.js';
import { Uri } from '../../../src/domain/uri.js';
import { AllowAllAuthorizer } from '../../helpers/allow-all-authorizer.js';
import type { SearchService } from '../../../src/services/search.js';

const ROOT = 'comem://user/local';

/** 测试预算：远小于 30 秒，足以区分「到点返回」与「挂住」。 */
const BUDGET_MS = 120;

/**
 * 「到点后 provider 收到 abort」用例的预算。
 *
 * 取 1 秒是因为服务层给上游留了「剩余时间 - min(1s, 剩余/5)」的余量：1 秒预算下
 * 重排约在 800 毫秒中止，离总上限还有 200 毫秒，响应能先走完「降级」而不是
 * 被总上限兜成 503。更小的值会让两件事挤在同一个定时器窗口里。
 */
const ABORT_BUDGET_MS = 1_000;

/**
 * LLM 供应商地址：显式指向不可能成功的回环端口（与 `http.test.ts` 同一做法）。
 *
 * 真正的隔离靠 `fetch` 替身；这个地址只是让配置本身也不指外网。
 */
const UNREACHABLE_LLM_BASE_URL = 'http://127.0.0.1:1/v1';

const TIMEOUT_ALLOWANCE_MS = 1_500;

let dataDir: string;
let container: Container;
const apps: FastifyInstance[] = [];

beforeEach(async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async (): Promise<Response> => {
      throw new TypeError('fetch failed: 集成测试不发起真实网络请求。');
    },
  );

  dataDir = await mkdtemp(join(tmpdir(), 'comem-http-deadline-'));
  container = await createContainer({
    configPath: join(dataDir, 'config.yaml'),
    env: {
      ...process.env,
      COMEM_DATA_DIR: dataDir,
      COMEM_SUMMARY_GENERATOR: 'rule',
      COMEM_LOGGING_LEVEL: 'error',
      COMEM_PROVIDERS_LLM_DEFAULT_BASE_URL: UNREACHABLE_LLM_BASE_URL,
    },
  });
  await container.services.acl.ensureRootPreset(Uri.parse(ROOT));
});

afterEach(async () => {
  await container.services.indexObserver.drain();
  for (const app of apps.splice(0)) {
    await app.close();
  }
  await container.close();
  vi.restoreAllMocks();
  await rm(dataDir, { recursive: true, force: true });
});

function json(response: { readonly body: string }): Record<string, unknown> {
  return JSON.parse(response.body) as Record<string, unknown>;
}

function errorOf(body: Record<string, unknown>): Record<string, unknown> {
  expect(body['status']).toBe('error');
  expect(body['result']).toBeUndefined();
  return body['error'] as Record<string, unknown>;
}

/** 一个永远不 settle 的 Promise（模拟挂起的上游）。 */
function hang(): Promise<never> {
  return new Promise<never>(() => undefined);
}

/**
 * 模型请求挂起的检索服务：三个入口各自上报一个外部上游后不再返回。
 *
 * `as unknown as SearchService` 与 `tests/integration/mcp/tool-deadline.test.ts` 的
 * `hangingService` 同一手法：`SearchService` 是带私有字段的类，测试只需要这三个
 * 方法。
 */
function hangingSearch(): SearchService {
  const hangOn = (
    upstream: 'llm' | 'embedding' | 'rerank',
  ): ((query: string, options?: { onUpstream?: (name: string) => void }) => Promise<never>) => {
    return (_query, options) => {
      options?.onUpstream?.(upstream);
      return hang();
    };
  };
  return {
    find: hangOn('embedding'),
    search: hangOn('llm'),
    context: hangOn('rerank'),
  } as unknown as SearchService;
}

function searchServices(search: SearchService): SearchRouteServices {
  return {
    search,
    // `/find` 与 `/search` 不经过 `authorizer`（只有 `grep` / `glob` 先求权）。
    authorizer: new AllowAllAuthorizer(),
    observability: container.observability,
  };
}

/** 只挂检索路由、但经过真实中间件与错误映射的应用。 */
async function createAppWithSearchRoutes(
  search: SearchService,
  options: { readonly deadlineMs?: number } = {},
): Promise<FastifyInstance> {
  const app = await createHttpServer({
    config: container.config,
    logger: container.logger,
    observability: container.observability,
    routes: [createSearchRoutes(searchServices(search), options)],
    mcp: container.mcp,
    resolveIdentity: container.resolveIdentity,
  });
  apps.push(app);
  return app;
}

/** 生产装配的应用（`container.routes`，上限取默认值）。 */
async function createProductionApp(): Promise<FastifyInstance> {
  const app = await createHttpServer({
    config: container.config,
    logger: container.logger,
    observability: container.observability,
    routes: container.routes,
    mcp: container.mcp,
    resolveIdentity: container.resolveIdentity,
  });
  apps.push(app);
  return app;
}

/**
 * 会调模型的三个入口与它们各自的替身上游。
 *
 * 期望的上游名来自 `CallDeadline` 的标签表：`find` 先标 `index`，随后服务层上报
 * `embedding`；`search` 上报 `llm`（意图分析）；`mode=context` 上报 `rerank`。
 */
const MODEL_ENDPOINTS: readonly {
  readonly url: string;
  readonly payload: Record<string, unknown>;
  readonly upstream: 'llm' | 'embedding' | 'rerank';
  readonly upstreamLabel: string;
}[] = [
  {
    url: '/api/v1/search/find',
    payload: { query: '记忆' },
    upstream: 'embedding',
    upstreamLabel: '向量嵌入（embedding）',
  },
  {
    url: '/api/v1/search/search',
    payload: { query: '记忆' },
    upstream: 'llm',
    upstreamLabel: 'LLM 生成（意图分析）',
  },
  {
    url: '/api/v1/search/search',
    payload: { query: '记忆', mode: 'context' },
    upstream: 'rerank',
    upstreamLabel: '重排（rerank）',
  },
];

describe('HTTP 检索端点的总上限', () => {
  it('模型请求挂住时，三个端点都在预算内返回 503 超时错误（不是空结果）', async () => {
    const app = await createAppWithSearchRoutes(hangingSearch(), { deadlineMs: BUDGET_MS });

    for (const endpoint of MODEL_ENDPOINTS) {
      const startedAt = Date.now();
      const response = await app.inject({
        method: 'POST',
        url: endpoint.url,
        payload: endpoint.payload,
      });
      const elapsedMs = Date.now() - startedAt;

      expect(response.statusCode).toBe(503);
      const error = errorOf(json(response));
      expect(error['code']).toBe('PROVIDER_UNAVAILABLE');
      expect(String(error['message'])).toContain(`${BUDGET_MS} 毫秒`);
      expect(String(error['message'])).toContain(endpoint.upstreamLabel);
      expect(String(error['message'])).toContain('中止等待');

      const details = error['details'] as Record<string, unknown>;
      expect(details['timeout']).toBe(true);
      expect(details['timeoutMs']).toBe(BUDGET_MS);
      expect(details['reason']).toBe('deadline_exceeded');
      expect(details['upstream']).toBe(endpoint.upstream);
      expect(typeof details['requestId']).toBe('string');

      // 预算 + 协议与调度开销。上限的意义是「有界」，不是「精确到毫秒」。
      expect(elapsedMs).toBeLessThan(BUDGET_MS + TIMEOUT_ALLOWANCE_MS);
    }
  });

  it('真实监听端口上的请求同样受上限约束（上限在 handler 上，不只在 inject 路径）', async () => {
    const app = await createAppWithSearchRoutes(hangingSearch(), { deadlineMs: BUDGET_MS });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (typeof address !== 'object' || address === null) {
      throw new Error('无法获取测试服务器端口。');
    }

    // 上面的 `fetch` 替身拦的是**服务端**的供应商调用；这个用例的客户端就是本进程，
    // 需要真实 fetch 才能打到刚监听的端口。替身在这里没有要挡的东西：检索替身
    // 根本不发请求。
    vi.restoreAllMocks();

    const startedAt = Date.now();
    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/search/find`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: '记忆' }),
    });
    const elapsedMs = Date.now() - startedAt;

    expect(response.status).toBe(503);
    const body = (await response.json()) as Record<string, unknown>;
    const error = errorOf(body);
    expect(error['code']).toBe('PROVIDER_UNAVAILABLE');
    expect((error['details'] as Record<string, unknown>)['reason']).toBe('deadline_exceeded');
    expect(elapsedMs).toBeLessThan(BUDGET_MS + TIMEOUT_ALLOWANCE_MS);
  });

  it('到点后 provider 收到 abort（在途重排请求被真正取消，不是只返回 503）', async () => {
    // 这一条用**真实**的 SearchService + 重排 provider：上限注入 1 秒，重排供应商
    // 配 60 秒且永不回包。断言两件事：
    //
    // 1. 重排请求拿到的 `AbortSignal` 在上限到点前后变成 aborted——provider 的
    //    超时预算是从 `deadlineAt` 收窄出来的（`min(60 秒, 剩余时间 - 余量)`），
    //    所以它会在总上限之前中止在途 HTTP，而不是让请求在 503 之后继续跑；
    // 2. 这次检索仍然按「先降级」的语义返回 200（重排失败 → 融合分），说明
    //    收紧预算没有把一次本可完成的检索变成错误。
    const dir = await mkdtemp(join(tmpdir(), 'comem-http-deadline-abort-'));
    // `HttpRerankProvider` 在**构造时**就捕获了 `fetch` 引用，所以替身必须在
    // `createContainer` 之前装好；beforeEach 里那个替身对所有请求都抛错，这里
    // 换成「挂住直到 signal abort」的那一个。
    const rerankSignals: AbortSignal[] = [];
    vi.restoreAllMocks();
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        if (!String(input).includes('/rerank')) {
          throw new TypeError('集成测试只模拟重排请求。');
        }
        const signal = init?.signal;
        if (signal === undefined || signal === null) {
          // 没有信号就不会被取消，测试会挂住——直接失败比静默通过好。
          throw new Error('重排请求没有超时信号。');
        }
        rerankSignals.push(signal);
        return new Promise<Response>((_resolve, reject) => {
          if (signal.aborted) {
            reject(new Error('aborted'));
            return;
          }
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
      },
    );

    const local = await createContainer({
      configPath: join(dir, 'config.yaml'),
      env: {
        ...process.env,
        COMEM_DATA_DIR: dir,
        COMEM_SUMMARY_GENERATOR: 'rule',
        COMEM_LOGGING_LEVEL: 'error',
        COMEM_RETRIEVAL_ENGINE: 'fts5',
        COMEM_RETRIEVAL_RERANK_ENABLED: 'true',
        COMEM_PROVIDERS_RERANK_TYPE: 'http',
        COMEM_PROVIDERS_RERANK_BASE_URL: 'http://127.0.0.1:1/v1',
        // 故意大于总上限：没有 `deadlineAt` 收窄时这条请求会跑 60 秒。
        COMEM_PROVIDERS_RERANK_TIMEOUT_SECONDS: '60',
      },
    });

    try {
      await local.services.acl.ensureRootPreset(Uri.parse(ROOT));
      await local.services.filesystem.write(
        Uri.parse(`${ROOT}/memories/abort-on-deadline.md`),
        '# 标题\n\n上下文记忆数据库。',
        ['user:local', 'user:*'],
        { frontmatter: { summary: '一句话摘要' } },
      );
      await local.services.indexObserver.drain();

      const app = await createHttpServer({
        config: local.config,
        logger: local.logger,
        observability: local.observability,
        routes: [
          createSearchRoutes(
            {
              search: local.services.search,
              authorizer: local.services.acl,
              observability: local.observability,
            },
            { deadlineMs: ABORT_BUDGET_MS },
          ),
        ],
        mcp: local.mcp,
        resolveIdentity: local.resolveIdentity,
      });
      apps.push(app);

      const startedAt = Date.now();
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/search/find',
        payload: { query: '上下文' },
      });
      const elapsedMs = Date.now() - startedAt;

      expect(response.statusCode).toBe(200);
      const result = JSON.parse(response.body).result as Record<string, unknown>;
      expect((result['hits'] as unknown[]).length).toBeGreaterThan(0);
      expect(rerankSignals.length).toBeGreaterThan(0);
      for (const signal of rerankSignals) {
        expect(signal.aborted).toBe(true);
      }
      expect(elapsedMs).toBeLessThan(ABORT_BUDGET_MS + TIMEOUT_ALLOWANCE_MS);
    } finally {
      await local.services.indexObserver.drain();
      await local.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('正常请求不受影响：默认上限下 find 返回 200，意图分析快速降级也不变成超时错误', async () => {
    const app = await createProductionApp();

    const find = await app.inject({
      method: 'POST',
      url: '/api/v1/search/find',
      payload: { query: '记忆' },
    });
    expect(find.statusCode).toBe(200);
    const findBody = json(find);
    expect(findBody['status']).toBe('ok');
    expect((findBody['result'] as Record<string, unknown>)['hits']).toEqual([]);

    // 意图分析打的是被拦下的不可达地址，立即失败并降级成原查询：这是一次**快速
    // 完成**的检索，不能被上限改写成 503。
    const search = await app.inject({
      method: 'POST',
      url: '/api/v1/search/search',
      payload: { query: '记忆' },
    });
    expect(search.statusCode).toBe(200);
    const searchBody = json(search);
    expect(searchBody['status']).toBe('ok');
    const plan = (searchBody['result'] as Record<string, unknown>)['plan'] as Record<string, unknown>;
    expect(plan['analyzed']).toBe(false);
    expect(String(plan['reason'])).toContain('意图分析失败');
  });
});
