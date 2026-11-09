/**
 * MCP 工具调用的时间上限（`src/api/mcp/deadline.ts`、`services/search.ts` 的上游预算）。
 *
 * 这一组测试要证明四件事，每件都对应一条会挂住宿主 agent 的真实故障：
 *
 * 1. **总上限**：不论工具卡在哪，到点返回 MCP `isError`，文本带可定位的
 *    `TOOL_DEADLINE_EXCEEDED` 与「卡在哪个上游」；
 * 2. **慢服务先降级**：向量嵌入超过查询预算时退回 FTS5 并标注 `Degraded`，
 *    不把一次检索失败成错误；
 * 3. **快速失败**：连接被拒绝立刻返回，不等满预算（`reason = network`）；
 * 4. **LLM 慢也先降级**：意图分析超时退化成原查询，`Query plan` 里写明原因。
 *
 * 慢服务是真实的本地 HTTP 服务器（接受连接、永不回包）；不可达端口是一个先监听
 * 再关闭的本地端口。
 */

import { createServer, type Server as HttpServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Socket } from 'node:net';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ContentStore } from '../../../src/adapters/fs/content-store.js';
import { createPathLockManager } from '../../../src/adapters/fs/lock.js';
import { MetadataFileStore } from '../../../src/adapters/fs/metadata-file.js';
import { openDatabase, runMigrations } from '../../../src/adapters/sqlite/database.js';
import { NodeRepository } from '../../../src/adapters/sqlite/node-repository.js';
import { SqliteFtsIndex } from '../../../src/adapters/sqlite/retrieval-index.js';
import { TaskRepository } from '../../../src/adapters/sqlite/task-repository.js';
import { SqliteVectorIndex } from '../../../src/adapters/sqlite/vector-index.js';
import { AiSdkEmbeddingProvider } from '../../../src/adapters/llm/embedding-provider.js';
import { HttpRerankProvider } from '../../../src/adapters/llm/rerank-provider.js';
import type { McpToolContext } from '../../../src/api/mcp/context.js';
import {
  McpHttpServer,
  type McpHttpApp,
  type McpRouteHandler,
  type McpServerOptions,
} from '../../../src/api/mcp/server.js';
import { ToolRegistry, type McpToolName } from '../../../src/api/mcp/registry.js';
import { MCP_TOOLS } from '../../../src/api/mcp/tools/index.js';
import { configSchema } from '../../../src/config/index.js';
import type { Logger } from '../../../src/domain/log.js';
import type { IndexRecord, RetrievalEngine } from '../../../src/domain/retrieval.js';
import { AllowAllAuthorizer } from '../../../src/services/authorizer.js';
import { ContextAssembler } from '../../../src/services/context-assembler.js';
import { EmbeddingService } from '../../../src/services/embedding.js';
import { FileSystemService } from '../../../src/services/filesystem.js';
import type { LlmService } from '../../../src/services/llm.js';
import type { MemoryService } from '../../../src/services/memory.js';
import type { ResourceService } from '../../../src/services/resource.js';
import {
  SearchService,
  type RetrievalSettings,
  type RerankFailure,
} from '../../../src/services/search.js';
import type { SessionService } from '../../../src/services/session.js';
import type { SkillService } from '../../../src/services/skill.js';
import type { SummaryService } from '../../../src/services/summary.js';
import { TaskService } from '../../../src/services/task.js';

const SCOPE = 'comem://user/alice';
const MEM = `${SCOPE}/mem`;
const SUBJECT = 'user:alice';
const PRINCIPALS = [SUBJECT, 'user:*'];
const DOC = `${MEM}/design.md`;

const RETRIEVAL_SETTINGS: RetrievalSettings = {
  candidateMultiplier: 4,
  levelWeights: { l0: 1.15, l1: 1.05, l2: 1 },
  queryFilters: [],
  assembly: { maxTokens: 1600, dedupTurns: 3, quotaPreset: 'coding' },
};

function createLogger(): Logger {
  const logger: Logger = {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => logger,
  };
  return logger;
}

function record(uri: string, content: string): IndexRecord {
  return {
    uri,
    parentUri: uri.slice(0, uri.lastIndexOf('/')),
    scope: 'user',
    kind: 'document',
    contextType: 'memory',
    memoryType: null,
    level: 'L2',
    abstract: '关键词索引里的上下文记忆',
    content,
    bodyDigest: '0000000000000000',
    size: Buffer.byteLength(content),
    updatedAt: '2026-11-08T00:00:00.000Z',
    status: 'active',
  };
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

/**
 * 真实的本地 HTTP 服务器：接受连接、读完请求、永不回包。
 *
 * 这是「供应商挂起」的形态——TCP 已建立，所以不会像连接被拒那样快速失败。
 * 关闭时主动销毁 socket，否则 `server.close()` 会等这些连接直到测试超时。
 */
async function startHangingServer(): Promise<{ readonly port: number; readonly close: () => Promise<void> }> {
  const sockets = new Set<Socket>();
  const server: HttpServer = createServer(() => {
    // 故意不回包。
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (typeof address !== 'object' || address === null) {
    throw new Error('无法获取慢服务端口。');
  }
  return {
    port: address.port,
    close: async () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

/** 拿一个「已关闭」的本地端口：先监听拿到系统分配值，再关掉。 */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (typeof address !== 'object' || address === null) {
    throw new Error('无法获取测试端口。');
  }
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  return address.port;
}

interface SearchHarness {
  readonly db: DatabaseSync;
  readonly index: SqliteFtsIndex;
  readonly search: SearchService;
  readonly context: McpToolContext;
  readonly registry: ToolRegistry;
  close(): Promise<void>;
}

interface SearchHarnessOptions {
  readonly engine: RetrievalEngine;
  /** 配了嵌入供应商时走真实适配器（用于慢服务 / 不可达端口）。 */
  readonly embeddingBaseUrl?: string;
  readonly rerankBaseUrl?: string;
  readonly rerankTimeoutSeconds?: number;
  readonly llm?: Pick<LlmService, 'generateJson'>;
  readonly deadlineMs?: number;
}

/**
 * 一套真实依赖的检索环境（SQLite + 临时目录 + 真实适配器）。
 *
 * 不用替身：慢服务与不可达端口的故障点在 `fetch` 这一层，替身测不到「连接被拒
 * 立刻返回」与「连接建立后一直不回包」这两种形态的差异。
 */
async function createSearchHarness(options: SearchHarnessOptions): Promise<SearchHarness> {
  const dataDir = await mkdtemp(join(tmpdir(), 'comem-mcp-deadline-'));
  const db = openDatabase(':memory:');
  runMigrations(db);

  const logger = createLogger();
  const index = new SqliteFtsIndex({ db, logger });
  const store = new ContentStore({ dataDir, logger });
  const locks = createPathLockManager({ dataDir, logger, pollIntervalMs: 1 });
  const metadata = new MetadataFileStore({ dataDir, logger });
  const nodes = new NodeRepository({ db, logger });
  const tasks = new TaskService({ tasks: new TaskRepository({ db, logger }), logger });
  const authorizer = new AllowAllAuthorizer();
  const filesystem = new FileSystemService({ store, locks, authorizer, logger });
  const assembler = new ContextAssembler({
    store,
    metadata,
    authorizer,
    logger,
    estimateTokens: (text) => text.length,
  });
  const embedding =
    options.embeddingBaseUrl === undefined
      ? undefined
      : new EmbeddingService({
          provider: new AiSdkEmbeddingProvider({
            type: 'openai-compatible',
            baseUrl: options.embeddingBaseUrl,
            model: 'test-embedding',
            apiKey: 'test',
            dimension: 3,
            // 刻意配成默认量级：证明工具上限不依赖供应商超时被调小。
            timeoutSeconds: 30,
            logger,
          }),
          logger,
          cache: null,
          config: { dimension: 3, maxBatchSize: 8, timeoutMs: 30_000 },
        });
  const rerank =
    options.rerankBaseUrl === undefined
      ? undefined
      : {
          provider: new HttpRerankProvider({
            baseUrl: options.rerankBaseUrl,
            model: 'test-reranker',
            apiKey: '',
            timeoutSeconds: options.rerankTimeoutSeconds ?? 30,
            logger,
          }),
          topN: 5,
          keepTopN: 0,
        };

  const search = new SearchService({
    index,
    filesystem,
    authorizer,
    assembler,
    logger,
    config: RETRIEVAL_SETTINGS,
    llm: options.llm,
    hotnessWeight: 0,
    hotnessHalfLifeHours: 168,
    ...(options.engine === 'fts5'
      ? {}
      : {
          engine: options.engine,
          // 非 fts5 引擎必须注入嵌入服务；用例漏配时在构造期抛错，而不是让
          // `SearchService` 抛一个更远的错误。
          embedding: requireValue(embedding, `engine=${options.engine} 需要 embeddingBaseUrl`),
          vectors: new SqliteVectorIndex({ db, logger }),
          nodes,
        }),
    ...(rerank === undefined ? {} : { rerank }),
  });

  await index.upsert([record(DOC, '上下文记忆数据库的关键词检索')]);
  db.prepare('INSERT INTO node_permission (node_uri, principal, level) VALUES (?, ?, 1)').run(
    DOC,
    SUBJECT,
  );

  const context: McpToolContext = {
    filesystem,
    search,
    summary: {} as unknown as SummaryService,
    acl: authorizer,
    session: {} as unknown as SessionService,
    memory: {} as unknown as MemoryService,
    resource: {} as unknown as ResourceService,
    skill: {} as unknown as SkillService,
    tasks,
    index,
    logger,
    config: configSchema.parse({
      retrieval: { engine: options.engine },
      // 交叉校验：engine 不是 fts5 时必须配嵌入供应商。这里只需要让配置合法，
      // 真正的连接由 `embeddingBaseUrl` 指向的（慢 / 不可达）地址决定。
      ...(options.engine === 'fts5'
        ? {}
        : {
            providers: {
              embedding: {
                type: 'openai-compatible',
                baseUrl: requireValue(options.embeddingBaseUrl, '非 fts5 引擎需要 embeddingBaseUrl'),
              },
            },
          }),
    }),
    subject: SUBJECT,
    principals: PRINCIPALS,
    requestId: 'req-deadline-test',
  };

  return {
    db,
    index,
    search,
    context,
    registry: new ToolRegistry(MCP_TOOLS, {
      deadlineMs: options.deadlineMs ?? 30_000,
    }),
    close: async () => {
      db.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

function toolOf(registry: ToolRegistry, name: McpToolName) {
  const tool = registry.get(name);
  if (tool === undefined) {
    throw new Error(`工具不存在：${name}`);
  }
  return tool;
}

async function callText(
  harness: SearchHarness,
  name: McpToolName,
  input: unknown,
): Promise<string> {
  const result = await toolOf(harness.registry, name).execute(input, harness.context);
  if (result.type !== 'text') {
    throw new Error(`期望文本结果，实际是 ${result.type}`);
  }
  return result.text;
}

function textOfContent(result: unknown): string {
  if (typeof result !== 'object' || result === null || !('content' in result)) {
    throw new Error('结果不是 tools/call 的内容形态。');
  }
  const content = result.content;
  if (!Array.isArray(content)) {
    throw new Error('结果没有内容块。');
  }
  const first: unknown = content[0];
  if (
    typeof first !== 'object' ||
    first === null ||
    !('type' in first) ||
    first.type !== 'text' ||
    !('text' in first) ||
    typeof first.text !== 'string'
  ) {
    throw new Error('结果不是文本内容块。');
  }
  return first.text;
}

interface TestServer {
  readonly client: Client;
  readonly httpServer: HttpServer;
  readonly db: DatabaseSync;
  readonly dataDir: string;
}

/**
 * 起一个真实的 MCP Streamable HTTP 端点，用来验证 `isError` 的线上形态。
 *
 * 只给 `find` / `read` 提供依赖；这两个工具足以触发「外部上游挂起」与「本地 I/O
 * 挂起」两种超时。
 */
async function startMcpServer(options: {
  readonly registry: ToolRegistry;
  readonly context: Omit<McpToolContext, 'subject' | 'principals' | 'requestId'>;
}): Promise<TestServer> {
  const dataDir = await mkdtemp(join(tmpdir(), 'comem-mcp-deadline-server-'));
  const db = openDatabase(':memory:');
  runMigrations(db);

  const routes = new Map<string, McpRouteHandler>();
  const app: McpHttpApp = {
    post(path, handler) {
      routes.set(`POST ${path}`, handler as McpRouteHandler);
    },
    get(path, handler) {
      routes.set(`GET ${path}`, handler as McpRouteHandler);
    },
  };
  const mcpOptions: McpServerOptions = {
    registry: options.registry,
    config: configSchema.parse({}),
    logger: createLogger(),
    context: options.context,
    resolveIdentity: async () => ({ subject: SUBJECT, principals: PRINCIPALS }),
  };
  const mcp = new McpHttpServer(mcpOptions);
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

  const client = new Client({ name: 'comem-deadline-client', version: '0.1.0' });
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${address.port}/mcp`),
  );
  await client.connect(transport);

  cleanup.push(async () => {
    await client.close().catch(() => undefined);
    await new Promise<void>((resolve) => {
      httpServer.close(() => resolve());
    });
    db.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  return { client, httpServer, db, dataDir };
}

/** 只满足 `find` 所需的最小上下文：`acl` 放行，`search` 由用例注入。 */
function minimalContext(search: SearchService): Omit<
  McpToolContext,
  'subject' | 'principals' | 'requestId'
> {
  return {
    // 本地 I/O 也模拟成挂起：`read` 用例要证明「不是只有外部上游才会超时」。
    filesystem: {
      read: () => hang(),
      readBytes: () => hang(),
    } as unknown as FileSystemService,
    search,
    summary: {} as unknown as SummaryService,
    acl: new AllowAllAuthorizer(),
    session: {} as unknown as SessionService,
    memory: {} as unknown as MemoryService,
    resource: {} as unknown as ResourceService,
    skill: {} as unknown as SkillService,
    tasks: {} as unknown as TaskService,
    index: {} as unknown as SqliteFtsIndex,
    logger: createLogger(),
    config: configSchema.parse({}),
  };
}

function hangingService(overrides: Partial<SearchService>): SearchService {
  return overrides as unknown as SearchService;
}

/** 一个永远不 settle 的 Promise（模拟挂起的上游）。 */
function hang<T>(): Promise<T> {
  return new Promise<T>(() => undefined);
}

/** 取出一个可选依赖；缺失时在装配期明确报错。 */
function requireValue<T>(value: T | undefined, message: string): T {
  if (value === undefined) {
    throw new Error(message);
  }
  return value;
}

describe('MCP 工具调用的时间上限', () => {
  it('外部上游挂起时，MCP 在「上限 + 余量」内返回 isError，并指出哪个上游没响应', async () => {
    const search = hangingService({
      // 模拟 `find` 已经进入查询嵌入，然后供应商一直不回包。
      findWithDiagnostics: ((_query: string, options?: { onUpstream?: (name: string) => void }) => {
        options?.onUpstream?.('embedding');
        return hang();
      }) as unknown as SearchService['findWithDiagnostics'],
    });
    const registry = new ToolRegistry(MCP_TOOLS, { deadlineMs: 150 });
    const server = await startMcpServer({ registry, context: minimalContext(search) });

    const startedAt = Date.now();
    const result = await server.client.callTool({ name: 'find', arguments: { query: '记忆' } });
    const elapsedMs = Date.now() - startedAt;

    expect(result.isError).toBe(true);
    const text = textOfContent(result);
    expect(text).toContain('TOOL_DEADLINE_EXCEEDED');
    expect(text).toContain('向量嵌入（embedding）');
    expect(text).toContain('150 毫秒');
    // 150ms 上限 + 客户端与协议开销。上限的意义是「有界」，不是「精确到毫秒」。
    expect(elapsedMs).toBeLessThan(150 + 1_500);
    // 不能返回空结果假装成功。
    expect(text).not.toContain('Found 0 item(s):');
  });

  it('本地 I/O 挂起时也返回 isError，并说明卡在本地而不是供应商', async () => {
    const registry = new ToolRegistry(MCP_TOOLS, { deadlineMs: 120 });
    const context = minimalContext(
      hangingService({
        findWithDiagnostics: (() => hang()) as unknown as SearchService['findWithDiagnostics'],
      }),
    );
    const server = await startMcpServer({ registry, context });

    const startedAt = Date.now();
    const result = await server.client.callTool({
      name: 'read',
      arguments: { uri: `${MEM}/note.md` },
    });
    const elapsedMs = Date.now() - startedAt;

    expect(result.isError).toBe(true);
    const text = textOfContent(result);
    expect(text).toContain('TOOL_DEADLINE_EXCEEDED');
    expect(text).toContain('本地');
    expect(elapsedMs).toBeLessThan(120 + 1_500);
  });

  it('向量服务挂起超过查询预算时，find 退化为 FTS5 并带 Degraded 标注', async () => {
    const slow = await startHangingServer();
    const harness = await createSearchHarness({
      engine: 'hybrid',
      embeddingBaseUrl: `http://127.0.0.1:${slow.port}/v1`,
      deadlineMs: 400,
    });
    cleanup.push(async () => {
      await harness.close();
      await slow.close();
    });

    const startedAt = Date.now();
    const text = await callText(harness, 'find', { query: '记忆' });
    const elapsedMs = Date.now() - startedAt;

    // 降级，而不是失败：FTS 命中仍然返回。
    expect(text).toMatch(/^Found 1 item\(s\):/);
    expect(text).toContain(DOC);
    expect(text).toContain('Degraded: 向量检索不可用');
    expect(text).toContain('FTS5');
    expect(elapsedMs).toBeLessThan(400 + 1_500);
  });

  it('vector 引擎的嵌入不可达时，find 不把「0 条」伪装成成功', async () => {
    const port = await closedPort();
    const harness = await createSearchHarness({
      engine: 'vector',
      embeddingBaseUrl: `http://127.0.0.1:${port}/v1`,
      deadlineMs: 30_000,
    });
    cleanup.push(async () => harness.close());

    const startedAt = Date.now();
    const text = await callText(harness, 'find', { query: '记忆' });
    const elapsedMs = Date.now() - startedAt;

    expect(text).toContain('Found 0 item(s):');
    expect(text).toContain('Degraded: 向量检索不可用');
    // `vector` 是显式选择，不静默换引擎；这一点必须写进结果。
    expect(text).toContain('没有退回关键词检索');
    // 连接被拒立即失败；30 秒预算没有生效，也没有等到预算。
    expect(elapsedMs).toBeLessThan(1_500);
  });

  it('不可达的重排端口快速失败（network），不等满预算', async () => {
    const port = await closedPort();
    const harness = await createSearchHarness({
      engine: 'fts5',
      rerankBaseUrl: `http://127.0.0.1:${port}/v1`,
      // 供应商超时故意配成 30 秒：快速失败必须来自连接被拒，而不是等到超时。
      rerankTimeoutSeconds: 30,
      deadlineMs: 30_000,
    });
    cleanup.push(async () => harness.close());

    const startedAt = Date.now();
    const text = await callText(harness, 'find', { query: '记忆' });
    const elapsedMs = Date.now() - startedAt;

    expect(text).toMatch(/^Found 1 item\(s\):/);
    expect(text).toContain('Degraded: 重排不可用（网络不可达）');
    // 30 秒预算 vs 实测耗时：证明「连接被拒绝」没有被当成「等超时」。
    expect(elapsedMs).toBeLessThan(1_500);
    const failure: RerankFailure | null = harness.search.rerankHealth.lastFailure;
    expect(failure?.reason).toBe('network');
    expect(failure?.code).toBe('PROVIDER_UNAVAILABLE');
  });

  it('意图分析（LLM）挂起时 search 降级为原查询，仍在预算内返回 FTS 结果', async () => {
    const llm = { generateJson: (() => hang()) as unknown as LlmService['generateJson'] };
    const harness = await createSearchHarness({
      engine: 'fts5',
      llm,
      deadlineMs: 300,
    });
    cleanup.push(async () => harness.close());

    const startedAt = Date.now();
    const text = await callText(harness, 'search', { query: '记忆' });
    const elapsedMs = Date.now() - startedAt;

    // 原查询仍然能命中 FTS；`Query plan` 必须写出这次是降级，以及卡在 LLM。
    expect(text).toContain('Found 1 item(s):');
    expect(text).toContain('Query plan:');
    expect(text).toContain('queries: 1 (degraded,');
    expect(text).toContain('degraded:');
    expect(text).toContain('意图分析（LLM）');
    expect(elapsedMs).toBeLessThan(300 + 1_500);
  });
});
