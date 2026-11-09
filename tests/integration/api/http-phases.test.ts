/**
 * 请求阶段计时走真实 HTTP 链路（§17.2、§17.6、§20）。
 *
 * 这一组测的不是 `ObservabilityService.phase()` 本身（那在
 * `tests/integration/services/observability.test.ts`），而是**接线**：作用域由
 * `createObservabilityMiddleware` 在 `onRequest` 里建，阶段由路由处理器写进去，
 * `onResponse` 里 `recordRequest` 读出来落库。三者任何一环断了，`request_log.phases`
 * 就会退回 NULL——这正是 2026-11 之前的状态。
 *
 * ## 为什么只断言 recall / capture
 *
 * §17.2 的四个阻塞阶段里，`processStart` 是 hook 进程启动、`serialize` 是 hook 的
 * 注入块格式化，服务端没有对应边界（见 `src/services/observability.ts` 文件头 2.1）。
 * 服务端测得到的是 `recall`（`/search/*` 的服务调用）与 `capture`
 * （`POST /sessions/{id}/messages` 的落盘）。断言「四阶段齐全」等于断言一个不存在的
 * 实现；这里断言的是真实存在的两条边界，以及**未归因间隙存在**这个正常状态。
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createHttpServer } from '../../../src/api/http/server.js';
import type { RequestLogRow } from '../../../src/adapters/sqlite/request-log-repository.js';
import { RequestLogRepository } from '../../../src/adapters/sqlite/request-log-repository.js';
import { createContainer, type Container } from '../../../src/bootstrap/container.js';
import { Uri } from '../../../src/domain/uri.js';

const AUTH_PRINCIPALS: readonly string[] = ['user:local', 'user:*'];
const ROOT = 'comem://user/local';
const FILE = `${ROOT}/memories/phases-note.md`;

/**
 * 写库是 `onResponse` 里的事，它可能在 `app.inject()` 返回之后才跑完。
 * 最多等 2 秒：正常情况是下一次事件循环轮转。
 */
const REQUEST_LOG_TIMEOUT_MS = 2000;

let dataDir: string;
let container: Container;
let requestLog: RequestLogRepository;
let app: FastifyInstance;

beforeEach(async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async (input: string | URL | Request): Promise<Response> => {
      throw new TypeError(`集成测试不发起真实网络请求（${String(input)}）。`);
    },
  );

  dataDir = await mkdtemp(join(tmpdir(), 'comem-http-phases-'));
  container = await createContainer({
    // 配置从临时目录读：仓库根的 `config.yaml` 是本机配置，可能指向真实网关。
    configPath: join(dataDir, 'config.yaml'),
    env: {
      ...process.env,
      COMEM_DATA_DIR: dataDir,
      COMEM_SUMMARY_GENERATOR: 'rule',
      COMEM_LOGGING_LEVEL: 'error',
      COMEM_PROVIDERS_LLM_DEFAULT_BASE_URL: 'http://127.0.0.1:1/v1',
    },
  });
  await container.services.acl.ensureRootPreset(Uri.parse(ROOT));
  requestLog = new RequestLogRepository({ db: container.db, logger: container.logger });
  app = await createHttpServer({
    config: container.config,
    logger: container.logger,
    observability: container.observability,
    routes: container.routes,
    mcp: container.mcp,
    resolveIdentity: container.resolveIdentity,
  });
});

afterEach(async () => {
  await container.services.indexObserver.drain();
  await app.close();
  await container.close();
  vi.restoreAllMocks();
  await rm(dataDir, { recursive: true, force: true });
});

/** 每行请求带一个显式的 `x-request-id`：`onResponse` 写库之后按它取回那一行。 */
function inject(options: InjectOptions & { readonly requestId: string }) {
  const { requestId, ...rest } = options;
  return app.inject({ ...rest, headers: { ...rest.headers, 'x-request-id': requestId } });
}

/** 等 `request_log` 里出现这条请求；没出现就是接线断了，让断言失败而不是等超时。 */
async function waitForRow(requestId: string): Promise<RequestLogRow> {
  const deadline = Date.now() + REQUEST_LOG_TIMEOUT_MS;
  for (;;) {
    const row = requestLog
      .list({ limit: 1000 })
      .find((candidate) => candidate.requestId === requestId);
    if (row !== undefined) {
      return row;
    }
    if (Date.now() > deadline) {
      throw new Error(`request_log 里没有 request_id=${requestId} 的行。`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** 非 NULL 的阶段对象。NULL 说明请求作用域或落库那条链路断了。 */
function phasesOf(row: RequestLogRow): Record<string, number | null> {
  if (row.phases === null) {
    throw new Error(`请求 ${row.requestId}（${row.path}）的 phases 是 NULL。`);
  }
  return row.phases;
}

function sumOf(phases: Readonly<Record<string, number | null>>): number {
  let total = 0;
  for (const elapsed of Object.values(phases)) {
    total += elapsed ?? 0;
  }
  return total;
}

describe('request_log.phases 接线', () => {
  it('/search/find 记 recall，阶段之和不超过总耗时', async () => {
    await container.services.filesystem.write(
      Uri.parse(FILE),
      '# 标题\n\n上下文记忆数据库。',
      AUTH_PRINCIPALS,
      { frontmatter: { summary: '一句话摘要' } },
    );
    await container.services.indexObserver.drain();

    const response = await inject({
      method: 'POST',
      url: '/api/v1/search/find',
      requestId: 'req-phases-find',
      payload: { query: '记忆' },
    });
    expect(response.statusCode).toBe(200);

    const row = await waitForRow('req-phases-find');
    const phases = phasesOf(row);

    // 检索是这条路由唯一被计时的边界；没有 `serialize` / `capture` / `processStart`
    // 是因为服务端没有这些边界（见文件头），不是因为丢了。
    expect(Object.keys(phases)).toEqual(['recall']);
    expect(phases['recall']).toBeGreaterThan(0);
    // **不是「等于」**：身份解析、路由、参数校验、响应编码都没有计时。
    expect(sumOf(phases)).toBeLessThanOrEqual(row.durationMs);
  });

  it('/search/search（mode=context）记 recall，组装与渲染含在里面', async () => {
    await container.services.filesystem.write(
      Uri.parse(FILE),
      '# 标题\n\n上下文记忆数据库。',
      AUTH_PRINCIPALS,
      { frontmatter: { summary: '一句话摘要' } },
    );
    await container.services.indexObserver.drain();

    const response = await inject({
      method: 'POST',
      url: '/api/v1/search/search',
      requestId: 'req-phases-context',
      payload: { query: '记忆', mode: 'context' },
    });
    expect(response.statusCode).toBe(200);

    const row = await waitForRow('req-phases-context');
    const phases = phasesOf(row);

    expect(Object.keys(phases)).toEqual(['recall']);
    expect(sumOf(phases)).toBeLessThanOrEqual(row.durationMs);
  });

  it('POST /sessions/{id}/messages 记 capture，阶段之和不超过总耗时', async () => {
    const created = await inject({
      method: 'POST',
      url: '/api/v1/sessions',
      requestId: 'req-phases-session',
      payload: {},
    });
    expect(created.statusCode).toBe(200);
    const sessionUri = String((JSON.parse(created.body) as { result: { uri: string } }).result.uri);
    const sessionId = sessionUri.slice(sessionUri.lastIndexOf('/') + 1);

    const response = await inject({
      method: 'POST',
      url: `/api/v1/sessions/${sessionId}/messages`,
      requestId: 'req-phases-capture',
      payload: { messages: [{ role: 'user', parts: [{ kind: 'text', text: '继续' }] }] },
    });
    expect(response.statusCode).toBe(200);

    const row = await waitForRow('req-phases-capture');
    const phases = phasesOf(row);

    expect(Object.keys(phases)).toEqual(['capture']);
    expect(phases['capture']).toBeGreaterThan(0);
    expect(sumOf(phases)).toBeLessThanOrEqual(row.durationMs);
  });

  it('没有阶段边界的老路由仍然写 NULL（不伪造数字）', async () => {
    const response = await inject({ method: 'GET', url: '/health', requestId: 'req-phases-health' });
    expect(response.statusCode).toBe(200);

    const row = await waitForRow('req-phases-health');
    expect(row.phases).toBeNull();
  });
});
