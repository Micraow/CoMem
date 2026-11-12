/**
 * HTTP 与 MCP 两个入口的一致性（回归用例）。
 *
 * 同一个能力有两个入口时，默认值、状态判定这类「看起来不重要」的差异会让排查变成
 * 猜谜：同一个部署，HTTP 客户端与 agent 拿到不同规模的检索结果、不同的健康结论。
 * 这里用同一个容器同时驱动两边：HTTP 走真实路由（`app.inject`），MCP 走真实注册表
 * （`container.mcpRegistry`，与 `/mcp` 请求用的是同一份工具定义与包装层）。
 *
 * 值写死而不是从实现导入：契约值从实现推导，实现漂了测试也跟着漂。
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createHttpServer } from '../../../src/api/http/server.js';
import type { McpToolContext } from '../../../src/api/mcp/context.js';
import type { McpToolName } from '../../../src/api/mcp/registry.js';
import { createContainer, type Container } from '../../../src/bootstrap/container.js';
import { Uri } from '../../../src/domain/uri.js';

const ROOT = 'comem://user/local';
const SUBJECT = 'user:local';

/** 默认条数的契约值。source 见 `services/retrieval/budget.ts`。 */
const EXPECTED_DEFAULT_LIMIT = 10;

/** 超过默认条数的命中数：默认值没有生效时，这里会露出来。 */
const SEEDED_DOCUMENTS = 15;

let dataDir: string;
let container: Container;
let app: FastifyInstance;
let principals: readonly string[];

beforeEach(async () => {
  // 任何一次真实网络请求都让测试失败：`find` / `health` 在 fts5 下不该碰供应商。
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async (input: string | URL | Request): Promise<Response> => {
      throw new TypeError(`两个入口的一致性测试不发起真实网络请求：${String(input)}`);
    },
  );

  dataDir = await mkdtemp(join(tmpdir(), 'comem-entry-parity-'));
  container = await createContainer({
    configPath: join(dataDir, 'config.yaml'),
    env: {
      ...process.env,
      COMEM_DATA_DIR: dataDir,
      COMEM_SUMMARY_GENERATOR: 'rule',
      COMEM_LOGGING_LEVEL: 'error',
      COMEM_RETRIEVAL_ENGINE: 'fts5',
    },
  });
  await container.services.acl.ensureRootPreset(Uri.parse(ROOT));
  principals = container.services.acl.resolvePrincipals(SUBJECT, []);
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

/** 与 `bootstrap/container.ts` 的 MCP context 同一组依赖（不含每请求身份）。 */
function mcpContext(): McpToolContext {
  return {
    filesystem: container.services.filesystem,
    search: container.services.search,
    summary: container.services.summary,
    acl: container.services.acl,
    session: container.services.session,
    memory: container.services.memory,
    resource: container.services.resource,
    skill: container.services.skill,
    tasks: container.services.task,
    index: container.services.index,
    logger: container.logger,
    config: container.config,
    observability: container.observability,
    subject: SUBJECT,
    principals,
    requestId: 'req-entry-parity',
  };
}

async function callTool(name: McpToolName, input: unknown): Promise<string> {
  const tool = container.mcpRegistry.get(name);
  if (tool === undefined) {
    throw new Error(`工具不存在：${name}`);
  }
  const result = await tool.execute(input, mcpContext());
  if (result.type !== 'text') {
    throw new Error(`期望文本结果，实际是 ${result.type}`);
  }
  return result.text;
}

function inject(options: InjectOptions) {
  return app.inject(options);
}

function resultOf(response: { readonly body: string }): Record<string, unknown> {
  const body = JSON.parse(response.body) as Record<string, unknown>;
  expect(body['status']).toBe('ok');
  return body['result'] as Record<string, unknown>;
}

describe('find 的默认条数', () => {
  beforeEach(async () => {
    for (let index = 0; index < SEEDED_DOCUMENTS; index += 1) {
      await container.services.filesystem.write(
        Uri.parse(`${ROOT}/memories/find-limit/doc-${index}.md`),
        'alpha 默认条数',
        principals,
      );
    }
    await container.services.indexObserver.drain();
  });

  it('HTTP 与 MCP 不传 limit 时都返回 10 条', async () => {
    const httpHits = resultOf(
      await inject({ method: 'POST', url: '/api/v1/search/find', payload: { query: 'alpha' } }),
    )['hits'] as unknown[];

    expect(httpHits).toHaveLength(EXPECTED_DEFAULT_LIMIT);
    expect(await callTool('find', { query: 'alpha' })).toContain(
      `Found ${EXPECTED_DEFAULT_LIMIT} item(s):`,
    );
  });
});

describe('health 的 status', () => {
  /**
   * 让 `ruleGenerator` 不参与判定：这里只留「存在降级摘要」这一个差异信号。
   * 两个入口读的是同一个 `container.config` 对象，改一处两边都变。
   */
  function useLlmGenerator(): void {
    (container.config.summary as { generator: 'llm' | 'rule' }).generator = 'llm';
  }

  async function seedDegradedSummary(): Promise<void> {
    await container.services.filesystem.mkdir(Uri.parse(`${ROOT}/memories/degraded`), principals);
    await writeFile(
      join(dataDir, 'user', 'local', 'memories', 'degraded', '.abstract.md'),
      '---\ngenerated_by: rule\ndegraded: true\n---\n降级摘要\n',
      'utf8',
    );
  }

  async function statuses(): Promise<{ readonly http: string; readonly mcp: string | null }> {
    const http = String(resultOf(await inject({ method: 'GET', url: '/health' }))['status']);
    const mcpText = await callTool('health', {});
    return { http, mcp: /^status: (\S+)$/m.exec(mcpText)?.[1] ?? null };
  }

  it('只有降级摘要时，MCP 与 HTTP 都给出 degraded', async () => {
    useLlmGenerator();
    await seedDegradedSummary();

    const { http, mcp } = await statuses();

    // 枚举只有两个值：MCP 侧把「索引统计失败」记成第三种状态会让监控把两种事情混成一件。
    expect(['ok', 'degraded']).toContain(http);
    expect(['ok', 'degraded']).toContain(mcp);
    expect(mcp).toBe(http);
    expect(mcp).toBe('degraded');
  });

  it('没有降级信号时，MCP 与 HTTP 都给出 ok', async () => {
    useLlmGenerator();

    const { http, mcp } = await statuses();

    expect(mcp).toBe(http);
    expect(mcp).toBe('ok');
  });
});

describe('read 的分页语义', () => {
  const FILE = `${ROOT}/resources/paged.txt`;
  /** 5 个码点：ASCII / 代理对 emoji / ASCII / 超出 BMP / ASCII。 */
  const TEXT = 'a😀b𠮷c';

  beforeEach(async () => {
    await container.services.filesystem.write(Uri.parse(FILE), TEXT, principals);
  });

  /** 两个入口都必须按码点下标解释 offset / limit，`-1` 读到末尾。 */
  const PAGES = [
    { offset: 0, limit: -1 },
    { offset: 0, limit: 2 },
    { offset: 1, limit: 1 },
    { offset: 2, limit: 3 },
    { offset: 4, limit: -1 },
    { offset: 99, limit: 3 },
    { offset: 0, limit: 99 },
  ] as const;

  it('同一组 offset / limit 在 HTTP 与 MCP 给出逐字节相同的正文，截断标记一一对应', async () => {
    // `limit: 0` 不在这里：MCP 的 `readLimit` 契约是正整数或 -1，HTTP 接受 0。
    // 共享实现自己的 limit=0 语义由 `tests/unit/api/text-slice.test.ts` 锁定。
    for (const { offset, limit } of PAGES) {
      const http = resultOf(
        await inject({
          method: 'GET',
          url: `/api/v1/content/read?uri=${encodeURIComponent(FILE)}&offset=${offset}&limit=${limit}`,
        }),
      );
      const mcp = await callTool('read', { uri: FILE, offset, limit });

      // MCP 是纯文本，没有 `truncated` 字段：HTTP 说还有内容时，MCP 正文之后必须
      // 多出独立一行标记；HTTP 说读完时不能多。两个入口的判定必须同一份。
      const body = String(http['text']);
      const expected = http['truncated'] === true ? `${body}\n... (truncated)` : body;
      expect(mcp, `offset=${offset} limit=${limit}`).toBe(expected);
    }
  });
});
