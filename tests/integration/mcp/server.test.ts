import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server as HttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, describe, expect, it } from 'vitest';

import { openDatabase, runMigrations } from '../../../src/adapters/sqlite/database.js';
import { TaskRepository } from '../../../src/adapters/sqlite/task-repository.js';
import { SqliteFtsIndex } from '../../../src/adapters/sqlite/retrieval-index.js';
import type { McpToolContext } from '../../../src/api/mcp/context.js';
import {
  McpHttpServer,
  type McpHttpApp,
  type McpRouteHandler,
  type McpServerOptions,
} from '../../../src/api/mcp/server.js';
import {
  ToolRegistry,
  type McpToolDefinition,
} from '../../../src/api/mcp/registry.js';
import { createToolRegistry } from '../../../src/api/mcp/tools/index.js';
import { configSchema } from '../../../src/config/index.js';
import { ComemError } from '../../../src/domain/errors.js';
import type { Logger } from '../../../src/domain/log.js';
import type { FileSystemService } from '../../../src/services/filesystem.js';
import type { MemoryService } from '../../../src/services/memory.js';
import type { ResourceService } from '../../../src/services/resource.js';
import type { SearchService } from '../../../src/services/search.js';
import type { SessionService } from '../../../src/services/session.js';
import type { SkillService } from '../../../src/services/skill.js';
import type { SummaryService } from '../../../src/services/summary.js';
import { TaskService } from '../../../src/services/task.js';
import { AllowAllAuthorizer } from '../../helpers/allow-all-authorizer.js';

const EXPECTED_NAMES = [
  'find',
  'search',
  'rule_search',
  'read',
  'list',
  'tree',
  'grep',
  'glob',
  'download',
  'health',
  'write',
  'edit',
  'remember',
  'forget',
  'add_resource',
  'add_skill',
];

function createLogger(): Logger {
  const logger: Logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
  return logger;
}

/** 取出 tools/call 结果的第一段文本。 */
function firstText(result: unknown): string {
  if (typeof result !== 'object' || result === null || !('content' in result)) {
    throw new Error('结果不是 tools/call 的内容形态。');
  }
  const content = result.content;
  if (!Array.isArray(content)) {
    throw new Error('结果没有内容块。');
  }
  const block: unknown = content[0];
  if (
    typeof block === 'object' &&
    block !== null &&
    'type' in block &&
    block.type === 'text' &&
    'text' in block &&
    typeof block.text === 'string'
  ) {
    return block.text;
  }
  throw new Error('第一个内容块不是文本。');
}

interface TestServer {
  readonly httpServer: HttpServer;
  readonly port: number;
  readonly db: DatabaseSync;
  readonly dataDir: string;
  readonly client: Client;
}

const cleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
  while (cleanup.length > 0) {
    const action = cleanup.pop();
    if (action !== undefined) {
      await action();
    }
  }
});

function createContext(db: DatabaseSync, logger: Logger): Omit<
  McpToolContext,
  'subject' | 'principals' | 'requestId'
> {
  const index = new SqliteFtsIndex({ db, logger });
  const tasks = new TaskService({ tasks: new TaskRepository({ db, logger }), logger });
  return {
    // 只有 health 会被调用；其余依赖按类型占位，避免为协议测试构造整套存储。
    // health 额外读 `search.rerankHealth`（重排降级可见性），所以这一项不能是空对象。
    filesystem: {} as unknown as FileSystemService,
    search: {
      rerankHealth: { configured: false, degraded: false, failures: 0, lastFailure: null },
    } as unknown as SearchService,
    summary: {} as unknown as SummaryService,
    acl: new AllowAllAuthorizer(),
    session: {} as unknown as SessionService,
    memory: {} as unknown as MemoryService,
    observability: {
      health: async () => ({
        pendingReview: 0,
        staleSummaries: 0,
        degradedSummaries: 0,
        orphanTasks: 0,
        indexNodes: 0,
        oldestPendingAgeSeconds: null,
        profileFormat: { checked: 0, invalid: 0, violations: 0, truncated: false },
      }),
    },
    resource: {} as unknown as ResourceService,
    skill: {} as unknown as SkillService,
    tasks,
    index,
    logger,
    config: configSchema.parse({}),
  };
}

async function startServer(
  mcp: McpHttpServer,
  db: DatabaseSync,
  dataDir: string,
): Promise<TestServer> {
  const routes = new Map<string, McpRouteHandler>();
  const app: McpHttpApp = {
    post(path, handler) {
      routes.set(`POST ${path}`, handler as McpRouteHandler);
    },
    get(path, handler) {
      routes.set(`GET ${path}`, handler as McpRouteHandler);
    },
  };
  mcp.mount(app);

  const httpServer = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const handler = routes.get(`${request.method ?? 'GET'} ${url.pathname}`);
    if (handler === undefined) {
      response.statusCode = 404;
      response.end();
      return;
    }
    const headers = Object.fromEntries(
      Object.entries(request.headers).map(([name, value]) => [
        name,
        Array.isArray(value) ? value[0] : value,
      ]),
    );
    void handler({ headers, raw: request }, { raw: response }).catch((error: unknown) => {
      if (!response.headersSent) {
        response.statusCode = 500;
        response.end(error instanceof Error ? error.message : String(error));
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(0, '127.0.0.1', () => resolve());
  });
  const address = httpServer.address();
  if (typeof address !== 'object' || address === null) {
    throw new Error('无法获取测试服务器端口。');
  }

  const client = new Client({ name: 'comem-test-client', version: '0.1.0' });
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${address.port}/mcp`),
  );
  await client.connect(transport);

  return { httpServer, port: address.port, db, dataDir, client };
}

async function createTestServer(
  resolveIdentity: McpServerOptions['resolveIdentity'],
  registry: ToolRegistry = createToolRegistry(),
): Promise<TestServer> {
  const dataDir = await mkdtemp(join(tmpdir(), 'comem-mcp-server-'));
  const db = openDatabase(':memory:');
  runMigrations(db);
  const logger = createLogger();
  const options: McpServerOptions = {
    registry,
    config: configSchema.parse({}),
    logger,
    context: createContext(db, logger),
    resolveIdentity,
  };
  const mcp = new McpHttpServer(options);
  const server = await startServer(mcp, db, dataDir);

  cleanup.push(async () => {
    await server.client.close().catch(() => undefined);
    await new Promise<void>((resolve) => {
      server.httpServer.close(() => resolve());
    });
    server.db.close();
    await rm(server.dataDir, { recursive: true, force: true });
  });
  return server;
}

describe('McpHttpServer', () => {
  it('MCP 客户端能连上，tools/list 返回 16 个，tools/call 调 health 成功', async () => {
    const server = await createTestServer(async () => ({
      subject: 'user:alice',
      principals: ['user:alice', 'user:*'],
    }));

    const tools = await server.client.listTools();

    expect(tools.tools.map((tool) => tool.name)).toEqual(EXPECTED_NAMES);

    const result = await server.client.callTool({ name: 'health', arguments: {} });
    expect(result.isError).toBeFalsy();
    if (!Array.isArray(result.content)) {
      throw new Error('health 应当返回文本内容块。');
    }
    const first = result.content[0];
    expect(first).toMatchObject({ type: 'text' });
    if (first !== undefined && first.type === 'text') {
      expect(first.text).toContain('index.visibleNodes: 0');
      expect(first.text).toContain('status: ok');
    }
  });

  it('业务错误与超时错误的文本都以 code 开头', async () => {
    const identity = async (): Promise<{ subject: string; principals: string[] }> => ({
      subject: 'user:alice',
      principals: ['user:alice', 'user:*'],
    });
    const server = await createTestServer(identity);

    // 业务错误：`read` 的 limit=0 在工具层被拒绝，走 server 的 catch 分支。
    const business = await server.client.callTool({
      name: 'read',
      arguments: { uri: 'comem://user/alice/mem/a.md', limit: 0 },
    });
    expect(business.isError).toBe(true);
    expect(firstText(business)).toMatch(/^INVALID_ARGUMENT: /);

    // 超时：注入一个永不返回的工具，上限 20 毫秒，走 `type: 'error'` 分支。
    const hanging: McpToolDefinition = {
      name: 'read',
      kind: 'read',
      description: '测试用：永不返回。',
      inputSchema: { type: 'object', properties: {} },
      execute: () => new Promise<never>(() => undefined),
    };
    const slow = await createTestServer(
      identity,
      new ToolRegistry([hanging], { deadlineMs: 20 }),
    );

    const timedOut = await slow.client.callTool({ name: 'read', arguments: {} });
    expect(timedOut.isError).toBe(true);
    expect(firstText(timedOut)).toMatch(/^TOOL_DEADLINE_EXCEEDED: /);
  });

  it('身份解析失败返回 401', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'comem-mcp-server-'));
    const db = openDatabase(':memory:');
    runMigrations(db);
    const logger = createLogger();
    const mcp = new McpHttpServer({
      registry: createToolRegistry(),
      config: configSchema.parse({}),
      logger,
      context: createContext(db, logger),
      resolveIdentity: async () => {
        throw new ComemError('UNAUTHENTICATED', '缺少有效的身份凭据。');
      },
    });

    const routes = new Map<string, McpRouteHandler>();
    const app: McpHttpApp = {
      post(path, handler) {
        routes.set(`POST ${path}`, handler as McpRouteHandler);
      },
      get(path, handler) {
        routes.set(`GET ${path}`, handler as McpRouteHandler);
      },
    };
    mcp.mount(app);

    const httpServer = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const handler = routes.get(`${request.method ?? 'GET'} ${url.pathname}`);
      if (handler === undefined) {
        response.statusCode = 404;
        response.end();
        return;
      }
      const headers = Object.fromEntries(
        Object.entries(request.headers).map(([name, value]) => [
          name,
          Array.isArray(value) ? value[0] : value,
        ]),
      );
      void handler({ headers, raw: request }, { raw: response });
    });

    await new Promise<void>((resolve, reject) => {
      httpServer.once('error', reject);
      httpServer.listen(0, '127.0.0.1', () => resolve());
    });
    const address = httpServer.address();
    if (typeof address !== 'object' || address === null) {
      throw new Error('无法获取测试服务器端口。');
    }

    cleanup.push(async () => {
      await new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
      });
      db.close();
      await rm(dataDir, { recursive: true, force: true });
    });

    const response = await fetch(`http://127.0.0.1:${address.port}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'comem-test', version: '0.1.0' },
        },
      }),
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      status: 'error',
      error: { code: 'UNAUTHENTICATED' },
    });
  });
});
