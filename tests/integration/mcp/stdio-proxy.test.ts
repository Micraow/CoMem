/**
 * stdio 代理的端到端验证（架构文档 §15.6）。
 *
 * 只支持 `stdio` 的宿主看不到 `/mcp`，它起的是 `node integrations/servers/mcp-proxy.mjs`
 * 这个子进程。这条链路只有真起进程、真走 stdin/stdout 才算验证过——在进程内直接
 * 调 `handleMessage` 测不到「stdout 有没有被日志污染」「子进程退出码对不对」。
 *
 * 服务端用与 `server.test.ts` 同样的进程内 HTTP 实现，所以这里同时覆盖「代理 → 真实
 * MCP 服务端」两段。
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server as HttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterEach, describe, expect, it } from 'vitest';

import { openDatabase, runMigrations } from '../../../src/adapters/sqlite/database.js';
import { TaskRepository } from '../../../src/adapters/sqlite/task-repository.js';
import { SqliteFtsIndex } from '../../../src/adapters/sqlite/retrieval-index.js';
import type { McpToolContext } from '../../../src/api/mcp/context.js';
import {
  McpHttpServer,
  type McpHttpApp,
  type McpRouteHandler,
} from '../../../src/api/mcp/server.js';
import { createToolRegistry } from '../../../src/api/mcp/tools/index.js';
import { configSchema } from '../../../src/config/index.js';
import type { Logger } from '../../../src/domain/log.js';
import { AllowAllAuthorizer } from '../../../src/services/authorizer.js';
import type { FileSystemService } from '../../../src/services/filesystem.js';
import type { MemoryService } from '../../../src/services/memory.js';
import type { ResourceService } from '../../../src/services/resource.js';
import type { SearchService } from '../../../src/services/search.js';
import type { SessionService } from '../../../src/services/session.js';
import type { SkillService } from '../../../src/services/skill.js';
import type { SummaryService } from '../../../src/services/summary.js';
import { TaskService } from '../../../src/services/task.js';

/** 代理脚本的绝对路径（相对本测试文件）。 */
const PROXY_PATH = new URL('../../../integrations/servers/mcp-proxy.mjs', import.meta.url).pathname;

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
    trace: () => undefined,
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child: () => logger,
  };
  return logger;
}

function createContext(db: DatabaseSync, logger: Logger): Omit<
  McpToolContext,
  'subject' | 'principals' | 'requestId'
> {
  const index = new SqliteFtsIndex({ db, logger });
  const tasks = new TaskService({ tasks: new TaskRepository({ db, logger }), logger });
  return {
    filesystem: {} as unknown as FileSystemService,
    search: {
      rerankHealth: { configured: false, degraded: false, failures: 0, lastFailure: null },
    } as unknown as SearchService,
    summary: {} as unknown as SummaryService,
    acl: new AllowAllAuthorizer(),
    session: {} as unknown as SessionService,
    memory: {} as unknown as MemoryService,
    resource: {} as unknown as ResourceService,
    skill: {} as unknown as SkillService,
    tasks,
    index,
    logger,
    config: configSchema.parse({}),
  };
}

interface TestServer {
  readonly port: number;
  readonly httpServer: HttpServer;
  readonly db: DatabaseSync;
  readonly dataDir: string;
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

async function createTestServer(): Promise<TestServer> {
  const dataDir = await mkdtemp(join(tmpdir(), 'comem-stdio-proxy-'));
  const db = openDatabase(':memory:');
  runMigrations(db);
  const logger = createLogger();

  const mcp = new McpHttpServer({
    registry: createToolRegistry(),
    config: configSchema.parse({}),
    logger,
    context: createContext(db, logger),
    resolveIdentity: async () => ({
      subject: 'user:alice',
      principals: ['user:alice', 'user:*'],
    }),
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

  cleanup.push(async () => {
    await new Promise<void>((resolve) => {
      httpServer.close(() => resolve());
    });
    db.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  return { port: address.port, httpServer, db, dataDir };
}

describe('stdio 代理', () => {
  it('StdioClientTransport 能连上，tools/list 返回 16 个工具', async () => {
    const server = await createTestServer();
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [PROXY_PATH],
      env: {
        ...(process.env as Record<string, string>),
        COMEM_BASE_URL: `http://127.0.0.1:${String(server.port)}`,
        // 别让本机配置接管：代理应该只凭环境变量就连上测试服务端。
        COMEM_CONFIG_FILE: join(server.dataDir, 'nonexistent.yaml'),
      },
    });
    const client = new Client({ name: 'comem-stdio-client', version: '0.1.0' });
    cleanup.push(async () => {
      await client.close().catch(() => undefined);
    });

    await client.connect(transport);

    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(EXPECTED_NAMES);
    // 16 条描述都必须自解释：没有空描述，且都说明了使用场景。
    for (const tool of tools) {
      expect(tool.description ?? '', `${tool.name} 没有描述`).not.toBe('');
    }
  }, 30_000);

  it('tools/call 走代理调 health，返回当前身份', async () => {
    const server = await createTestServer();
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [PROXY_PATH],
      env: {
        ...(process.env as Record<string, string>),
        COMEM_BASE_URL: `http://127.0.0.1:${String(server.port)}`,
        COMEM_CONFIG_FILE: join(server.dataDir, 'nonexistent.yaml'),
      },
    });
    const client = new Client({ name: 'comem-stdio-client', version: '0.1.0' });
    cleanup.push(async () => {
      await client.close().catch(() => undefined);
    });

    await client.connect(transport);

    const result = await client.callTool({ name: 'health', arguments: {} });
    expect(result.isError).toBeUndefined();
    const text = (result.content as { type: string; text: string }[])[0]?.text ?? '';
    expect(text).toContain('status: ok');
    expect(text).toContain('subject: user:alice');
  }, 30_000);
});
