import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AclFileStore } from '../../../src/adapters/fs/acl-file.js';
import { ContentStore } from '../../../src/adapters/fs/content-store.js';
import { createPathLockManager } from '../../../src/adapters/fs/lock.js';
import { MetadataFileStore } from '../../../src/adapters/fs/metadata-file.js';
import { openDatabase, runMigrations } from '../../../src/adapters/sqlite/database.js';
import { NodeRepository } from '../../../src/adapters/sqlite/node-repository.js';
import { PermissionRepository } from '../../../src/adapters/sqlite/permission-repository.js';
import { SqliteFtsIndex } from '../../../src/adapters/sqlite/retrieval-index.js';
import { TaskRepository } from '../../../src/adapters/sqlite/task-repository.js';
import { SqliteVectorIndex } from '../../../src/adapters/sqlite/vector-index.js';
import type { McpToolContext } from '../../../src/api/mcp/context.js';
import {
  ToolRegistry,
  type McpToolDefinition,
  type McpToolName,
  type McpToolResult,
} from '../../../src/api/mcp/registry.js';
import { MCP_TOOLS } from '../../../src/api/mcp/tools/index.js';
import { InheritingAuthorizer } from '../../../src/bootstrap/container.js';
import { configSchema } from '../../../src/config/index.js';
import { ComemError } from '../../../src/domain/errors.js';
import type { Level } from '../../../src/domain/level.js';
import type { Logger } from '../../../src/domain/log.js';
import { preferencesMemoryType } from '../../../src/domain/memory-types/preferences.js';
import type { ContextType, NodeStatus } from '../../../src/domain/node.js';
import type { IndexRecord, RetrievalEngine } from '../../../src/domain/retrieval.js';
import { Uri } from '../../../src/domain/uri.js';
import {
  permissionDenied,
  type AclAction,
  type Authorizer,
} from '../../../src/services/authorizer.js';
import { AllowAllAuthorizer } from '../../helpers/allow-all-authorizer.js';
import { AclService } from '../../../src/services/acl.js';
import { ContextAssembler } from '../../../src/services/context-assembler.js';
import type { EmbedOutcome } from '../../../src/services/embedding.js';
import type { MemoryHealth } from '../../../src/services/observability.js';
import { FileSystemService } from '../../../src/services/filesystem.js';
import { MemoryService } from '../../../src/services/memory.js';
import {
  ResourceService,
  type ReconcileEntry,
  type ResourceStorage,
  type StageUploadInput,
  type StagedUpload,
  type StagedUploadInfo,
} from '../../../src/services/resource.js';
import { SearchService, type RetrievalSettings } from '../../../src/services/search.js';
import { SessionService, stableMessageId } from '../../../src/services/session.js';
import { SkillService } from '../../../src/services/skill.js';
import { RuleSummarizer, SummaryService } from '../../../src/services/summary.js';
import { TaskService } from '../../../src/services/task.js';


const SCOPE = 'comem://user/alice';
const MEM = `${SCOPE}/mem`;
const SUBJECT = 'user:alice';
const PRINCIPALS = [SUBJECT, 'user:*'];

/** 架构文档 §18 的 `retrieval` 段（与 search.test.ts 同一份）。 */
const RETRIEVAL_SETTINGS: RetrievalSettings = {
  candidateMultiplier: 4,
  levelWeights: { l0: 1.15, l1: 1.05, l2: 1 },
  queryFilters: [],
  assembly: { maxTokens: 1600, dedupTurns: 3, quotaPreset: 'coding' },
};

function createLogger(): Logger {
  const logger: Logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return logger;
}

/** `ResourceStorage` 的内存实现：测试不需要真实临时目录。 */
class MemoryResourceStorage implements ResourceStorage {
  readonly #staged = new Map<string, StagedUpload>();
  readonly reconciled: ReconcileEntry[] = [];

  async stage(input: StageUploadInput): Promise<string> {
    this.#staged.set(input.uploadId, {
      info: {
        uploadId: input.uploadId,
        fileName: input.fileName,
        size: input.bytes.byteLength,
        tempPath: `/tmp/${input.uploadId}`,
        stagedAtMs: input.stagedAtMs,
      },
      bytes: input.bytes,
    });
    return `/tmp/${input.uploadId}`;
  }

  async readStaged(uploadId: string): Promise<StagedUpload | null> {
    return this.#staged.get(uploadId) ?? null;
  }

  async listStaged(): Promise<readonly StagedUploadInfo[]> {
    return [...this.#staged.values()].map((entry) => entry.info);
  }

  async removeStaged(uploadId: string): Promise<void> {
    this.#staged.delete(uploadId);
  }

  async appendReconcile(entry: ReconcileEntry): Promise<void> {
    this.reconciled.push(entry);
  }
}

class DenyAllAuthorizer implements Authorizer {
  async check(): Promise<boolean> {
    return false;
  }

  async filterReadable(): Promise<ReadonlySet<string>> {
    return new Set();
  }

  async assert(uri: Uri, action: AclAction): Promise<void> {
    throw permissionDenied(uri, action);
  }
}

interface Harness {
  readonly context: McpToolContext;
  readonly dataDir: string;
  readonly db: DatabaseSync;
  readonly index: SqliteFtsIndex;
  readonly store: ContentStore;
  readonly filesystem: FileSystemService;
  close(): Promise<void>;
}

interface HarnessOptions {
  readonly authorizer?: Authorizer;
  /**
   * 用与生产装配同一份的真实权限：`AclService` + `InheritingAuthorizer`。
   *
   * 默认的 `AllowAllAuthorizer` 的 `assert` 是空操作——它永远不会物化
   * `node_permission` 行，所以「写完之后 `list` 能不能看到」这类断言在它下面
   * 恒真，测不出东西。
   */
  readonly realAcl?: boolean;
  /**
   * 检索引擎。默认 `fts5`（与接入向量前的回归基线一致）。
   *
   * 非 `fts5` 时注入一个**降级**的嵌入服务：混合检索仍然走 RRF 融合（分数约
   * `1/61`），但不需要连供应商。rule_search 的阈值语义正是靠这条路径验证的。
   */
  readonly engine?: RetrievalEngine;
}

async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const dataDir = await mkdtemp(join(tmpdir(), 'comem-mcp-tools-'));
  const db = openDatabase(':memory:');
  runMigrations(db);

  const logger = createLogger();
  const index = new SqliteFtsIndex({ db, logger });
  const store = new ContentStore({ dataDir, logger });
  const locks = createPathLockManager({ dataDir, logger, pollIntervalMs: 1 });
  const metadata = new MetadataFileStore({ dataDir, logger });
  const nodes = new NodeRepository({ db, logger });
  const permissions = new PermissionRepository({ db, logger });
  const tasks = new TaskService({ tasks: new TaskRepository({ db, logger }), logger });
  const acl =
    options.realAcl === true
      ? new AclService({
          db,
          aclFile: new AclFileStore({ dataDir, logger }),
          permissions,
          nodes,
          logger,
          locks,
        })
      : null;
  if (acl !== null) {
    // 根预置（§12.6）：没有 `user:alice = manage` 这一行，新建节点从父目录复制不到
    // 任何权限，`list` 会把它们全部过滤掉。
    await acl.ensureRootPreset(Uri.parse(SCOPE));
  }
  const authorizer =
    acl === null ? (options.authorizer ?? new AllowAllAuthorizer()) : new InheritingAuthorizer(acl, store);

  const filesystem = new FileSystemService({ store, locks, authorizer, logger });
  const assembler = new ContextAssembler({
    store,
    metadata,
    authorizer,
    logger,
  });
  const degradedEmbedding = {
    available: false,
    model: null,
    embed: async (): Promise<EmbedOutcome> => ({
      vectors: [],
      degraded: true,
      reason: '测试不连嵌入供应商',
    }),
  };
  const engine = options.engine ?? 'fts5';
  const search = new SearchService({
    index,
    filesystem,
    authorizer,
    assembler,
    logger,
    config: RETRIEVAL_SETTINGS,
    ...(engine === 'fts5'
      ? {}
      : {
          engine,
          embedding: degradedEmbedding,
          vectors: new SqliteVectorIndex({ db, logger }),
          nodes,
        }),
    // 必填依赖：测试显式传默认值（`telemetry.hotness.*` 的 schema 默认值）。
    hotnessWeight: 0,
    hotnessHalfLifeHours: 168,
  });
  const summary = new SummaryService({
    nodes,
    index,
    metadata,
    store,
    db,
    // 不用真实 ACL 的用例里物化没有意义：`AllowAllAuthorizer` 根本不读
    // `node_permission`。需要真实权限行的用例会传 `realAcl: true`。
    acl: acl ?? { materializeNode: async (): Promise<void> => undefined },
    generator: new RuleSummarizer(),
    logger,
    config: { abstractMaxChars: 256, overviewMaxChars: 4000 },
  });
  const session = new SessionService({
    store,
    metadata,
    locks,
    tasks,
    logger,
    meta: metadata,
    config: {
      autoCommit: {
        enabled: true,
        pendingTokenThreshold: 150000,
        messageCountThreshold: 100,
        minCommitIntervalSeconds: 0,
        idleTimeoutSeconds: 0,
        keepRecentCount: 0,
      },
    },
    authorizer,
  });
  const memory = new MemoryService({
    filesystem: {
      read: async (uri) => ({ text: Buffer.from(await store.readBytes(uri)).toString('utf8') }),
      write: (uri, text) => store.writeBytes(uri, Uint8Array.from(Buffer.from(text, 'utf8'))),
      stat: (uri) => store.stat(uri),
      remove: (uri) => store.remove(uri),
      list: (uri) => store.list(uri),
    },
    locks,
    search: { find: async () => [] },
    logger,
  });
  const resource = new ResourceService({
    store,
    locks,
    index,
    summary,
    storage: new MemoryResourceStorage(),
    logger,
    authorizer,
  });
  const skill = new SkillService({
    store,
    locks,
    index,
    summary,
    reconcile: { append: async () => undefined },
    permissions,
    logger,
    authorizer,
  });

  const observability = {
    health: async (): Promise<MemoryHealth> => ({
      pendingReview: 0,
      staleSummaries: 0,
      degradedSummaries: 0,
      orphanTasks: 0,
      indexNodes: 0,
      oldestPendingAgeSeconds: null,
      profileFormat: { checked: 0, invalid: 0, violations: 0, truncated: false },
    }),
  };
  const context: McpToolContext = {
    filesystem,
    search,
    summary,
    acl: authorizer,
    session,
    memory,
    observability,
    resource,
    skill,
    tasks,
    index,
    logger,
    config: configSchema.parse({}),
    subject: SUBJECT,
    principals: PRINCIPALS,
    requestId: 'req-test',
  };

  return {
    context,
    dataDir,
    db,
    index,
    store,
    filesystem,
    close: async () => {
      db.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

let harness: Harness;

beforeEach(async () => {
  harness = await createHarness();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await harness.close();
});

/**
 * 生产路径走 `ToolRegistry`（`~` 别名在注册表的包装层展开）。直接调 `MCP_TOOLS`
 * 会绕过展开，测不到「工具接受 `~`」这条契约。
 */
const registry = new ToolRegistry(MCP_TOOLS);

function tool(name: McpToolName): McpToolDefinition {
  const found = registry.get(name);
  if (found === undefined) {
    throw new Error(`工具不存在：${name}`);
  }
  return found;
}

async function call(
  name: McpToolName,
  input: unknown,
  context: McpToolContext = harness.context,
): Promise<McpToolResult> {
  return tool(name).execute(input, context);
}

async function callText(
  name: McpToolName,
  input: unknown,
  context: McpToolContext = harness.context,
): Promise<string> {
  const result = await call(name, input, context);
  if (result.type !== 'text') {
    throw new Error(`期望文本结果，实际是 ${result.type}`);
  }
  return result.text;
}

interface SeedOverrides {
  readonly level?: Level;
  readonly contextType?: ContextType;
  readonly memoryType?: string | null;
  readonly abstract?: string | null;
  readonly kind?: IndexRecord['kind'];
  readonly status?: NodeStatus;
}

function record(uri: string, content: string, overrides: SeedOverrides = {}): IndexRecord {
  return {
    uri,
    parentUri: uri.slice(0, uri.lastIndexOf('/')),
    scope: 'user',
    kind: overrides.kind ?? 'document',
    contextType: overrides.contextType ?? 'memory',
    memoryType: overrides.memoryType ?? null,
    level: overrides.level ?? 'L2',
    abstract: overrides.abstract ?? null,
    content,
    bodyDigest: '0000000000000000',
    size: Buffer.byteLength(content),
    updatedAt: '2026-11-08T00:00:00.000Z',
    status: overrides.status ?? 'active',
  };
}

async function seed(
  uri: string,
  content: string,
  overrides: SeedOverrides = {},
): Promise<void> {
  await harness.index.upsert([record(uri, content, overrides)]);
  harness.db
    .prepare('INSERT INTO node_permission (node_uri, principal, level) VALUES (?, ?, 1)')
    .run(uri, SUBJECT);
}

describe('参数表', () => {
  /**
   * `wait` 曾经只写进日志：`write` 的 schema 描述向模型承诺「写后等待索引更新」，
   * 实现里观察者是同步的，参数没有任何行为。宁可不给，也不给一个假参数。
   */
  it('write / add_resource 不再暴露 wait', () => {
    for (const name of ['write', 'add_resource'] as const) {
      const properties = tool(name).inputSchema['properties'] as Record<string, unknown>;
      expect(Object.keys(properties), `${name} 的 wait 是假参数`).not.toContain('wait');
    }
  });
});

describe('find', () => {
  const DOC = `${MEM}/design.md`;

  it('中文检索按 §13.2 的格式返回', async () => {
    await seed(DOC, '上下文记忆数据库的设计', { abstract: '上下文记忆数据库' });

    const text = await callText('find', { query: '记忆' });

    expect(text).toMatch(/^Found 1 item\(s\):/);
    expect(text).toMatch(/^- \[memory\] comem:\/\/user\/alice\/mem\/design\.md$/m);
    expect(text).toContain('\n  上下文记忆数据库');
  });

  it('hybrid 引擎的分数不会渲染成 0.00', async () => {
    // 缺陷现场：RRF 融合分是 `Σ 1/(60 + rank)`，最多 `2/61 ≈ 0.0328`，`toFixed(2)`
    // 会把每一条都渲成 `0.00`。那不是「没显示分数」，是一个错误的分数——调用方会
    // 据此把相关结果当成不相关丢掉。
    await harness.close();
    harness = await createHarness({ engine: 'hybrid' });

    const uris = ['一', '二', '三', '四'].map((name) => `${MEM}/hybrid/${name}.md`);
    for (const [index, uri] of uris.entries()) {
      const content = `上下文记忆数据库 第 ${index + 1} 条`;
      await harness.filesystem.write(Uri.parse(uri), content, PRINCIPALS);
      await seed(uri, content, { abstract: `第 ${index + 1} 条` });
    }

    const hits = await harness.context.search.find('上下文记忆数据库', {
      scopes: [SCOPE],
      subject: SUBJECT,
      principals: PRINCIPALS,
      limit: 10,
    });
    // 先钉住「这条用例真的落在 RRF 量纲上」：分数大到 `toFixed(2)` 能显示出来，
    // 这个缺陷就不会被复现。
    expect(hits.length).toBe(4);
    expect(hits[0]?.score).toBeLessThan(0.05);

    const text = await callText('find', { query: '上下文记忆数据库', limit: 10 });

    expect(text).not.toContain('0.00');
    expect(text).not.toMatch(/\d+\.\d{2}/);

    // 4 条结果互相可区分，且顺序就是服务端给的相关度降序。
    const lines = text.split('\n').filter((line) => line.startsWith('- ['));
    expect(lines).toHaveLength(4);
    expect(new Set(lines).size).toBe(4);
    for (const [index, line] of lines.entries()) {
      expect(line).toBe(`- [memory] ${hits[index]?.uri}`);
    }
  });

  it('limit 生效', async () => {
    for (const name of ['a', 'b', 'c']) {
      await seed(`${MEM}/${name}.md`, '偏好 代码 风格');
    }

    const text = await callText('find', { query: '偏好', limit: 2 });

    expect(text).toMatch(/^Found 2 item\(s\):/);
  });

  it('level 过滤', async () => {
    await seed(`${MEM}/l0.md`, '偏好 代码 风格', { level: 'L0' });
    await seed(`${MEM}/l2.md`, '偏好 代码 风格', { level: 'L2' });

    const text = await callText('find', { query: '偏好', level: 'L0' });

    expect(text).toContain(`${MEM}/l0.md`);
    expect(text).not.toContain(`${MEM}/l2.md`);
  });

  it('contextType 过滤', async () => {
    await seed(`${MEM}/mem.md`, '偏好 代码 风格', { contextType: 'memory' });
    await seed(`${SCOPE}/sessions/s1/msg.md`, '偏好 代码 风格', { contextType: 'session' });

    const text = await callText('find', { query: '偏好', contextType: 'session' });

    expect(text).toContain('sessions/s1/msg.md');
    expect(text).not.toContain('/mem/mem.md');
  });
});

describe('read', () => {
  const TEXT_URI = `${MEM}/text.txt`;

  beforeEach(async () => {
    await harness.filesystem.write(Uri.parse(TEXT_URI), 'abcdefghij', PRINCIPALS);
  });

  it('offset / limit 按码点切片，还有内容时标记截断', async () => {
    expect(await callText('read', { uri: TEXT_URI, offset: 2, limit: 3 })).toBe(
      'cde\n... (truncated)',
    );
    expect(await callText('read', { uri: TEXT_URI })).toBe('abcdefghij');
  });

  it('恰好读到末尾不标记截断（返回长度等于 limit 也可能是读完）', async () => {
    // 关键用例：最后一页正好是 5 个码点。调用方不能靠「返回长度 = limit」判断
    // 还有下一页，这正是需要标记的理由。
    expect(await callText('read', { uri: TEXT_URI, offset: 5, limit: 5 })).toBe('fghij');
    expect(await callText('read', { uri: TEXT_URI, offset: 0, limit: 10 })).toBe('abcdefghij');
    // 对照组：只差一个码点没返回。
    expect(await callText('read', { uri: TEXT_URI, offset: 0, limit: 9 })).toBe(
      'abcdefghi\n... (truncated)',
    );

    // 码点计数：内容 "😀a" 是 2 个码点、3 个 UTF-16 码元。从第 2 个码点读 1 个
    // 恰好读完；按 UTF-16 长度算会误判成「还有内容」。
    const emoji = `${MEM}/emoji.txt`;
    await harness.filesystem.write(Uri.parse(emoji), '😀a', PRINCIPALS);
    expect(await callText('read', { uri: emoji, offset: 1, limit: 1 })).toBe('a');
  });

  it('多 URI 分页时每段各自标记自己的截断', async () => {
    const other = `${MEM}/other.txt`;
    await harness.filesystem.write(Uri.parse(other), 'xyz', PRINCIPALS);

    const text = await callText('read', { uris: [TEXT_URI, other], offset: 0, limit: 3 });

    // TEXT_URI 还有 7 个码点没读；other 恰好读完（3 个码点）。
    expect(text).toBe(`# ${TEXT_URI}\nabc\n... (truncated)\n\n# ${other}\nxyz`);
  });

  it('多 URI 返回带边界的文本', async () => {
    const other = `${MEM}/other.txt`;
    await harness.filesystem.write(Uri.parse(other), 'xyz', PRINCIPALS);

    const text = await callText('read', { uris: [TEXT_URI, other] });

    expect(text).toBe(`# ${TEXT_URI}\nabcdefghij\n\n# ${other}\nxyz`);
  });

  it('图片返回 binary', async () => {
    const imageUri = `${MEM}/pic.png`;
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    await harness.store.writeBytes(Uri.parse(imageUri), bytes);

    const result = await call('read', { uri: imageUri });

    expect(result).toEqual({
      type: 'binary',
      mimeType: 'image/png',
      base64: Buffer.from(bytes).toString('base64'),
    });
  });

  it('limit 只能是正整数或 -1', async () => {
    await expect(call('read', { uri: TEXT_URI, limit: 0 })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
  });
});

describe('read 的溯源块（W97）', () => {
  const MEMORY_URI = `${SCOPE}/memories/preferences/code-style.md`;
  const ARCHIVE_1 = `${SCOPE}/sessions/s1/history/archive_001`;
  const ARCHIVE_2 = `${SCOPE}/sessions/s1/history/archive_002`;

  async function writeMemory(sources: readonly string[]): Promise<void> {
    await harness.context.memory.upsertMemory(Uri.parse(SCOPE), preferencesMemoryType, {
      uri: Uri.parse(MEMORY_URI),
      update: () => ({ topic: 'code-style', content: '用户偏好 TypeScript 严格模式。' }),
      provenance: { sources: sources.map((source) => Uri.parse(source)) },
    });
  }

  it('记忆正文后追加 ## provenance，含全部归档 URI', async () => {
    await writeMemory([ARCHIVE_1]);
    await writeMemory([ARCHIVE_2]);

    expect(await callText('read', { uri: MEMORY_URI })).toBe(
      [
        '## content',
        '',
        '用户偏好 TypeScript 严格模式。',
        '',
        '## provenance',
        'sources:',
        `  - ${ARCHIVE_1}`,
        `  - ${ARCHIVE_2}`,
      ].join('\n'),
    );
  });

  it('分页读也带上完整的溯源块（它不是正文切片的一部分）', async () => {
    await writeMemory([ARCHIVE_1]);

    const text = await callText('read', { uri: MEMORY_URI, offset: 0, limit: 3 });

    // 溯源块在切片之后追加；截断标记只在最后一行，仍然可被宿主识别。
    expect(text).toBe(`## \n\n## provenance\nsources:\n  - ${ARCHIVE_1}\n... (truncated)`);
  });

  it('没有 sources 的旧记忆输出与改动前逐字节相同', async () => {
    await writeMemory([]);

    expect(await callText('read', { uri: MEMORY_URI })).toBe(
      '## content\n\n用户偏好 TypeScript 严格模式。',
    );
  });

  it('普通资源文件的输出不带溯源块', async () => {
    await harness.filesystem.write(Uri.parse(`${MEM}/plain.txt`), 'pure', PRINCIPALS);

    expect(await callText('read', { uri: `${MEM}/plain.txt` })).toBe('pure');
  });

  it('edit 重写记忆文件后 sources 仍在（frontmatter 里的未知键原样保留）', async () => {
    await writeMemory([ARCHIVE_1, ARCHIVE_2]);

    await callText('edit', {
      uri: MEMORY_URI,
      oldString: '严格模式',
      newString: '严格模式（已确认）',
    });

    const text = await callText('read', { uri: MEMORY_URI });
    expect(text).toContain('严格模式（已确认）');
    expect(text).toContain(`## provenance\nsources:\n  - ${ARCHIVE_1}\n  - ${ARCHIVE_2}`);
  });
});

describe('list', () => {
  const ROOT = `${MEM}`;

  beforeEach(async () => {
    await harness.filesystem.write(Uri.parse(`${ROOT}/b.md`), 'bb', PRINCIPALS);
    await harness.filesystem.write(Uri.parse(`${ROOT}/a.md`), 'a', PRINCIPALS);
    await harness.filesystem.write(Uri.parse(`${ROOT}/dirA/c.md`), 'ccc', PRINCIPALS);
  });

  it('默认只列直接子项并按 name 升序', async () => {
    const text = await callText('list', { uri: ROOT });

    expect(text.split('\n')).toEqual(['[file] a.md', '[file] b.md', '[dir] dirA']);
  });

  it('recursive 展开子树', async () => {
    const text = await callText('list', { uri: ROOT, recursive: true });

    expect(text.split('\n')).toContain('[file] dirA/c.md');
    // 没超上限时不标记截断。
    expect(text).not.toContain('... (truncated)');
  });

  it('recursive 超过节点上限时标记截断，不静默只给前 1000 条', async () => {
    // 上限与 `tree` 一致（`RECURSIVE_LIMIT = 1000`）。用 store 直接写，只为造
    // 目录内容，不走逐文件加锁与索引。
    const many = `${MEM}/many`;
    for (let index = 0; index < 1001; index += 1) {
      const name = `f-${String(index).padStart(4, '0')}.md`;
      await harness.store.writeBytes(Uri.parse(`${many}/${name}`), Uint8Array.from([0x61]));
    }

    const text = await callText('list', { uri: many, recursive: true });
    const lines = text.split('\n');

    // 1000 条 + 末尾一行标记：调用方拿到的条数不等于「全部」时有明确信号。
    expect(lines).toHaveLength(1001);
    expect(lines.at(-1)).toBe('... (truncated)');
  });

  it('sortBy 支持 size 与 _desc', async () => {
    expect((await callText('list', { uri: ROOT, sortBy: 'size' })).split('\n')[0]).toBe(
      '[file] a.md',
    );
    expect((await callText('list', { uri: ROOT, sortBy: 'name_desc' })).split('\n')[0]).toBe(
      '[dir] dirA',
    );
  });

  it('已归档文件仍然看得见（list 是目录浏览，不是检索面）', async () => {
    const archived = `${ROOT}/archived.md`;
    await harness.filesystem.write(Uri.parse(archived), 'x', PRINCIPALS);
    await seed(archived, 'x', { status: 'archived' });

    const text = await callText('list', { uri: ROOT });

    expect(text.split('\n')).toContain('[file] archived.md');
  });
});

describe('tree', () => {
  it('levelLimit 控制层数', async () => {
    await harness.filesystem.write(Uri.parse(`${MEM}/a.md`), 'a', PRINCIPALS);
    await harness.filesystem.write(Uri.parse(`${MEM}/dirA/c.md`), 'c', PRINCIPALS);

    const level1 = await callText('tree', { uri: MEM, levelLimit: 1 });
    expect(level1).toContain('  dirA/');
    expect(level1).not.toContain('c.md');

    const level2 = await callText('tree', { uri: MEM, levelLimit: 2 });
    expect(level2).toContain('    c.md');
  });

  it('已归档文件仍然看得见（tree 是目录浏览，不是检索面）', async () => {
    const archived = `${MEM}/archived.md`;
    await harness.filesystem.write(Uri.parse(archived), 'x', PRINCIPALS);
    await seed(archived, 'x', { status: 'archived' });

    const text = await callText('tree', { uri: MEM, levelLimit: 2 });

    expect(text).toContain('archived.md');
  });
});

describe('grep', () => {
  const FILE = `${MEM}/error.ts`;

  beforeEach(async () => {
    await harness.filesystem.write(Uri.parse(FILE), 'Boom\nok\nBOOM again\n', PRINCIPALS);
    await seed(FILE, 'Boom');
  });

  it('大小写敏感与不敏感', async () => {
    expect(await callText('grep', { uri: MEM, pattern: 'boom' })).toContain(
      'Found 0 match(es):',
    );

    const insensitive = await callText('grep', {
      uri: MEM,
      pattern: 'boom',
      caseInsensitive: true,
    });
    expect(insensitive).toContain('Found 2 match(es):');
    expect(insensitive).toContain('L1 [boom]: Boom');
    expect(insensitive).toContain('L3 [boom]: BOOM again');
  });

  it('nodeLimit 截断命中', async () => {
    const text = await callText('grep', {
      uri: MEM,
      pattern: 'boom',
      caseInsensitive: true,
      nodeLimit: 1,
    });

    expect(text).toContain('Found 1 match(es):');
  });

  it('已归档文件不出现（候选集来自 glob，§11.7）', async () => {
    const archived = `${MEM}/archived.ts`;
    await harness.filesystem.write(Uri.parse(archived), 'needle\n', PRINCIPALS);
    await seed(archived, 'needle', { status: 'archived' });

    expect(await callText('grep', { uri: MEM, pattern: 'needle' })).toContain(
      'Found 0 match(es):',
    );
  });

  it('空 pattern 是 INVALID_ARGUMENT，不是「匹配所有行」', async () => {
    // `new RegExp('')` 匹配每一行：不拦的话空 pattern 会拿回 nodeLimit 条命中，
    // 看起来像「搜索成功了」，实际什么都没查。
    await expect(callText('grep', { uri: MEM, pattern: '' })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
  });
});

describe('glob', () => {
  const DIR = `${MEM}/files`;

  beforeEach(async () => {
    await seed(`${DIR}/a.md`, 'a');
    await seed(`${DIR}/b.md`, 'b');
    await seed(`${DIR}/c.txt`, 'c');
  });

  it('按扩展名匹配并遵守 nodeLimit', async () => {
    const text = await callText('glob', { pattern: '**/*.md', uri: DIR, nodeLimit: 10 });
    expect(text).toContain('Found 2 file(s):');
    expect(text).toContain(`${DIR}/a.md`);

    const limited = await callText('glob', { pattern: '**/*.md', uri: DIR, nodeLimit: 1 });
    expect(limited).toContain('Found 1 file(s):');
  });

  it('已归档节点不出现（归档只影响检索面，§11.7）', async () => {
    await seed(`${DIR}/archived.md`, 'x', { status: 'archived' });

    const text = await callText('glob', { pattern: '**/*.md', uri: DIR, nodeLimit: 10 });

    expect(text).toContain('Found 2 file(s):');
    expect(text).not.toContain(`${DIR}/archived.md`);
  });
});

describe('write / edit', () => {
  const URI = `${MEM}/write.txt`;

  it('三种 mode', async () => {
    expect(await callText('write', { uri: URI, content: 'one', mode: 'create' })).toContain(
      'created: true',
    );
    await callText('write', { uri: URI, content: 'two' });
    expect(await callText('read', { uri: URI })).toBe('two');
    await callText('write', { uri: URI, content: '!', mode: 'append' });
    expect(await callText('read', { uri: URI })).toBe('two!');

    await expect(
      callText('write', { uri: URI, content: 'x', mode: 'create' }),
    ).rejects.toMatchObject({ code: 'ALREADY_EXISTS' });
  });

  it('不传元数据时正文逐字节落盘（签名快照）', async () => {
    const content = 'one\ntwo\n\n## content\n\n正文';
    await callText('write', { uri: URI, content });

    expect(Buffer.from(await harness.store.readBytes(Uri.parse(URI))).toString('utf8')).toBe(
      content,
    );
  });

  it('edit 默认唯一命中，replaceAll 替换全部', async () => {
    const editUri = `${MEM}/edit.txt`;
    await harness.filesystem.write(Uri.parse(editUri), 'foo foo foo', PRINCIPALS);

    await expect(
      callText('edit', { uri: editUri, oldString: 'foo', newString: 'bar' }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });

    const text = await callText('edit', {
      uri: editUri,
      oldString: 'foo',
      newString: 'bar',
      replaceAll: true,
    });
    expect(text).toContain('Replaced 3 occurrence(s)');
    expect(await callText('read', { uri: editUri })).toBe('bar bar bar');
  });
});

describe('forget', () => {
  it('非空目录需要 recursive', async () => {
    const dir = `${MEM}/gone`;
    await harness.filesystem.write(Uri.parse(`${dir}/child.md`), 'x', PRINCIPALS);

    await expect(callText('forget', { uri: dir })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });

    const text = await callText('forget', { uri: dir, recursive: true });
    expect(text).toContain(`Deleted: ${dir}`);
    expect(await harness.store.exists(Uri.parse(dir))).toBe(false);
  });
});

describe('空查询参数', () => {
  // 空串是「什么都没查」，不是「查到 0 条」：HTTP 侧同一入参是 400
  // `INVALID_ARGUMENT`（`api/http/server.ts` 的 `requireString`），MCP 必须一致。
  it.each([
    ['find', { query: '' }],
    ['search', { query: '' }],
    ['rule_search', { taskContext: '' }],
  ] as const)('%s 的空查询是 INVALID_ARGUMENT', async (name, input) => {
    await expect(callText(name, input)).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
  });
});

describe('health', () => {
  it('返回索引条数与摘要降级标记', async () => {
    await seed(`${MEM}/a.md`, 'a');
    await seed(`${MEM}/b.md`, 'b');

    const text = await callText('health', {});

    expect(text).toContain('status: ok');
    expect(text).toContain('index.visibleNodes: 2');
    expect(text).toContain('summary.degraded: false');
    // 重排没配时不是降级：`degraded` 为 false，计数器为 0。
    expect(text).toContain('rerank.degraded: false');
    expect(text).toContain('rerank.failures: 0');
  });

  it('返回绑定主体与可寻址的根', async () => {
    const text = await callText('health', {});

    expect(text).toContain(`subject: ${SUBJECT}`);
    expect(text).toContain(`scopes: ${SCOPE}`);
  });

  it('降级摘要数计入 status（与 GET /health 同源）', async () => {
    const base = await harness.context.observability.health();
    const context: McpToolContext = {
      ...harness.context,
      observability: {
        health: async () => ({ ...base, degradedSummaries: 2 }),
      },
    };

    const text = await callText('health', {}, context);

    expect(text).toContain('status: degraded');
    expect(text).toContain('summary.degradedDirs: 2');
  });

  it('索引计数达到上限时说明是下界', async () => {
    vi.spyOn(harness.index, 'glob').mockResolvedValue(
      new Array(100_000).fill('comem://user/alice/mem/a.md'),
    );

    const text = await callText('health', {});

    expect(text).toContain('index.visibleNodes: 100000');
    expect(text).toContain('index.visibleNodesTruncated: true');
  });

  it('索引统计失败时是 degraded 且不冒充 0 条', async () => {
    // 计数失败不是「服务坏了」，也不能回报 `visibleNodes: 0` 让人以为库是空的。
    // 与 `GET /health` 共用同一个状态判定，枚举里没有第三种值。
    vi.spyOn(harness.index, 'glob').mockRejectedValue(new Error('索引不可用'));

    const text = await callText('health', {});

    expect(text).toContain('status: degraded');
    expect(text).toContain('index.visibleNodes: unavailable');
  });
});

describe('~ 别名（§6.1）', () => {
  const ALIAS = '~/mem/alias.md';

  it('每个需要 URI 的工具都接受 ~ 开头的路径', async () => {
    await harness.filesystem.write(Uri.parse(`${MEM}/alias.md`), 'x', PRINCIPALS);
    // `grep` / `find` / `search` / `glob` 走索引；别名展开后的 URI 必须与索引里的
    // 绝对 URI 是同一个。
    await seed(`${MEM}/alias.md`, 'x');

    expect(await callText('read', { uri: ALIAS })).toBe('x');
    expect(await callText('read', { uris: [ALIAS] })).toContain('x');
    expect(await callText('list', { uri: '~/mem' })).toContain('alias.md');
    expect(await callText('tree', { uri: '~' })).toContain('mem/');
    expect(await callText('grep', { uri: '~/mem', pattern: 'x' })).toContain('Found 1 match(es)');
    expect(await callText('glob', { pattern: '**/*.md', uri: '~/mem' })).toContain(
      `${MEM}/alias.md`,
    );
    expect(await callText('find', { query: 'x', targetUri: '~' })).toContain('Found');
    expect(await callText('search', { query: 'x', targetUri: '~' })).toContain('Found');
    expect(await callText('download', { uri: ALIAS })).toContain('/content/download?');

    expect(await callText('write', { uri: '~/mem/alias2.md', content: 'y' })).toContain(
      'created: true',
    );
    expect(
      await callText('edit', { uri: '~/mem/alias2.md', oldString: 'y', newString: 'z' }),
    ).toContain('Replaced 1');
    expect(await callText('forget', { uri: '~/mem/alias2.md' })).toContain('Deleted:');

    expect(
      await callText('add_resource', {
        parentUri: '~/resources',
        files: [{ path: 'docs/a.md', content: 'a' }],
      }),
    ).toContain('Added 1 file(s)');
    expect(
      await callText('add_skill', {
        parentUri: '~/skills',
        name: 'demo-skill',
        files: [
          {
            path: 'SKILL.md',
            content: '---\nname: demo-skill\ndescription: 演示技能\n---\n# Demo\n',
          },
        ],
      }),
    ).toContain('Installed skill "demo-skill"');
  });

  it('group 主体展开成 group 根', async () => {
    const groupContext: McpToolContext = { ...harness.context, subject: 'group:eng' };

    await callText('write', { uri: '~/mem/group.md', content: 'g' }, groupContext);

    expect(await harness.store.exists(Uri.parse('comem://group/eng/mem/group.md'))).toBe(true);
  });

  it('没有主体时 ~ 抛 INVALID_URI，不兜底到 user:local', async () => {
    const anonymous: McpToolContext = { ...harness.context, subject: '' };

    await expect(callText('read', { uri: '~' }, anonymous)).rejects.toMatchObject({
      code: 'INVALID_URI',
    });
  });
});

describe('search / rule_search', () => {
  it('search 末尾附 Query plan', async () => {
    await seed(`${MEM}/plan.md`, '上下文记忆数据库');

    const text = await callText('search', { query: '记忆', sessionId: 'sess_1' });

    expect(text).toContain('Query plan:');
    expect(text).toContain('sessionId: sess_1');
  });

  it('rule_search 返回规则完整正文（默认阈值）', async () => {
    const ruleUri = `${SCOPE}/memories/rules/license-review/rule.md`;
    await harness.filesystem.write(Uri.parse(ruleUri), '提交前必须检查许可证。', PRINCIPALS);
    await seed(ruleUri, '提交前必须检查许可证', {
      memoryType: 'rules',
      abstract: '许可证规则',
    });

    // 不传 threshold：默认 0.65 是相对阈值，单条规则以自己为基准必然保留。
    const text = await callText('rule_search', { taskContext: '提交前必须检查许可证' });

    expect(text).toContain(ruleUri);
    expect(text).toContain('提交前必须检查许可证。');
  });

  it('rule_search 在 engine: hybrid 下仍能召回（RRF 分远低于 0.65）', async () => {
    // 换一个混合检索引擎的容器：FTS5 命中经 RRF 融合后分数约 1/61 ≈ 0.016，
    // 旧实现把 0.65 下推给 `scoreThreshold` 时这里恒为 0 条。
    await harness.close();
    harness = await createHarness({ engine: 'hybrid' });

    const ruleUri = `${SCOPE}/memories/rules/hybrid/rule.md`;
    await harness.filesystem.write(Uri.parse(ruleUri), '提交前必须检查许可证。', PRINCIPALS);
    await seed(ruleUri, '提交前必须检查许可证', {
      memoryType: 'rules',
      abstract: '许可证规则',
    });

    // 先钉住「这条用例真的落在 RRF 量纲上」，否则删掉阈值也可能碰巧通过。
    const hits = await harness.context.search.find('提交前必须检查许可证', {
      scopes: [SCOPE],
      subject: SUBJECT,
      principals: PRINCIPALS,
      limit: 5,
      contextTypes: ['memory'],
    });
    expect(hits[0]?.score).toBeLessThan(0.65);

    const text = await callText('rule_search', { taskContext: '提交前必须检查许可证' });

    expect(text).toContain(ruleUri);
    expect(text).toContain('提交前必须检查许可证。');
  });

  it('rule_search 默认阈值只保留与最佳规则接近的（相对阈值）', async () => {
    const strong = `${SCOPE}/memories/rules/strong/rule.md`;
    const weak = `${SCOPE}/memories/rules/weak/rule.md`;
    await harness.filesystem.write(Uri.parse(strong), '提交前必须检查许可证。', PRINCIPALS);
    await harness.filesystem.write(Uri.parse(weak), '提交前必须检查许可证，这条是弱相关。', PRINCIPALS);
    // 两条都含查询短语，但 weak 的文档长度把 bm25 拉到最佳规则的一半左右：
    // 绝对阈值（0.65）下两条都会被丢，相对阈值（0.65 × 最高分）只留 strong。
    await seed(strong, '提交前必须检查许可证', {
      memoryType: 'rules',
      abstract: '许可证规则',
    });
    await seed(weak, `提交前必须检查许可证${'无关内容'.repeat(50)}`, {
      memoryType: 'rules',
      abstract: null,
    });

    const text = await callText('rule_search', { taskContext: '提交前必须检查许可证' });

    expect(text).toContain(strong);
    expect(text).toContain('提交前必须检查许可证。');
    expect(text).not.toContain(weak);
  });

  it('rule_search 在通用检索前 5 条全是偏好时仍返回规则（类型下推，核心验收）', async () => {
    // 缺陷现场：旧实现先 `find(limit: 5)` 再按 `memoryType === 'rules'` 过滤。
    // 6 条偏好把查询短语写 3 遍，bm25 都高于规则，前 5 条全是偏好，规则被筛没。
    const preferences = Array.from(
      { length: 6 },
      (_, index) => `${SCOPE}/memories/preferences/tone-${index}.md`,
    );
    for (const uri of preferences) {
      const content = '提交前必须检查许可证。'.repeat(3);
      await harness.filesystem.write(Uri.parse(uri), content, PRINCIPALS);
      await seed(uri, content, { memoryType: 'preferences', abstract: '偏好' });
    }
    const ruleUri = `${SCOPE}/memories/rules/pushdown/rule.md`;
    await harness.filesystem.write(Uri.parse(ruleUri), '提交前必须检查许可证。', PRINCIPALS);
    await seed(ruleUri, '提交前必须检查许可证', {
      memoryType: 'rules',
      abstract: '许可证规则',
    });

    // 先钉住场景本身：不带 memoryTypes 的通用检索前 5 条确实是偏好，
    // 否则这条用例可能在旧实现下也碰巧通过。
    const generic = await harness.context.search.find('提交前必须检查许可证', {
      scopes: [SCOPE],
      subject: SUBJECT,
      principals: PRINCIPALS,
      limit: 5,
      contextTypes: ['memory'],
    });
    expect(generic).toHaveLength(5);
    expect(generic.every((hit) => hit.memoryType === 'preferences')).toBe(true);

    const text = await callText('rule_search', { taskContext: '提交前必须检查许可证' });

    expect(text).toContain(ruleUri);
    expect(text).toContain('提交前必须检查许可证。');
  });

  it('find 的 memoryTypes 只返回指定记忆类型', async () => {
    const preference = `${MEM}/memories/preferences/tone.md`;
    const rule = `${MEM}/memories/rules/rule.md`;
    await seed(preference, '许可证检查', { memoryType: 'preferences' });
    await seed(rule, '许可证检查', { memoryType: 'rules' });

    const text = await callText('find', { query: '许可证', memoryTypes: ['rules'] });

    expect(text).toContain(rule);
    expect(text).not.toContain(preference);
  });

  it('find 的 updatedAfter / updatedBefore 是闭区间', async () => {
    const boundary = '2026-11-08T00:00:00.000Z';
    const old = `${MEM}/old.md`;
    const fresh = `${MEM}/fresh.md`;
    await seed(old, '许可证检查', {});
    await seed(fresh, '许可证检查', {});
    harness.db.prepare('UPDATE node SET updated_at = ? WHERE uri = ?').run(
      '2026-11-01T00:00:00.000Z',
      old,
    );

    const text = await callText('find', { query: '许可证', updatedAfter: boundary });

    expect(text).toContain(fresh);
    expect(text).not.toContain(old);
  });
});

describe('remember / download', () => {
  /** 会话所有归档里的正文，按归档顺序。 */
  async function archivedTexts(sessionUri: Uri): Promise<string[]> {
    const texts: string[] = [];
    for (const archiveUri of await harness.context.session.listArchives(sessionUri)) {
      const raw = Buffer.from(
        await harness.store.readBytes(archiveUri.child('messages.jsonl')),
      ).toString('utf8');
      for (const line of raw.split('\n')) {
        if (line.trim() === '') {
          continue;
        }
        const message = JSON.parse(line) as { readonly parts: readonly { readonly text: string }[] };
        texts.push(message.parts.map((part) => part.text).join(''));
      }
    }
    return texts;
  }

  it('remember 走提交管线并返回 taskId', async () => {
    const text = await callText('remember', {
      messages: [
        { role: 'user', content: '我偏好中文回答' },
        { role: 'assistant', content: '收到' },
      ],
    });

    expect(text).toMatch(/^taskId: [0-9a-f-]+/);
    expect(text).toContain('Archived 2 message(s)');
  });

  it('同一 sessionId + 同一批消息跑两次只有一份', async () => {
    const messages = [
      { role: 'user', content: '我偏好中文回答', createdAt: '2026-08-25T03:13:44.000Z' },
      { role: 'assistant', content: '收到', createdAt: '2026-08-25T03:13:45.000Z' },
    ];
    const sessionUri = Uri.parse(`${SCOPE}/sessions/claude-code-native-1`);

    expect(
      await callText('remember', { sessionId: 'claude-code-native-1', messages }),
    ).toContain('Archived 2 message(s)');

    // 幂等重跑：消息已经在归档里，live 为空，没有可提交的内容。
    expect(
      await callText('remember', { sessionId: 'claude-code-native-1', messages }),
    ).toContain('taskId: none');

    expect(await archivedTexts(sessionUri)).toEqual(['我偏好中文回答', '收到']);
    expect((await harness.context.session.load(sessionUri)).messages).toHaveLength(0);
  });

  it('同一 sessionId + 新消息追加，不覆盖', async () => {
    const sessionUri = Uri.parse(`${SCOPE}/sessions/codex-native-1`);
    const first = { role: 'user', content: '第一句', createdAt: '2026-08-25T03:13:44.000Z' };
    const second = { role: 'assistant', content: '第二句', createdAt: '2026-08-25T03:13:45.000Z' };

    await callText('remember', { sessionId: 'codex-native-1', messages: [first] });
    await callText('remember', { sessionId: 'codex-native-1', messages: [first, second] });

    expect(await archivedTexts(sessionUri)).toEqual(['第一句', '第二句']);
  });

  /**
   * 跨路径同源：`remember` 与服务端 `stableMessageId` 必须是同一个函数的结果。
   *
   * 服务端按 ID 判等去重。两边各算一份时，任何一边改了分隔符或字段顺序，`remember`
   * 写进去的消息与 `ingest` 写进去的（或已经归档的）就互相认不出来，重投变成重复。
   * 只锁 `services/session.ts` 那份的单元测试看不出这种漂移，所以这里走工具的真实
   * 路径：先按服务端那份额度往 live 里放一条，再让 `remember` 追同一组
   * `(role, text, createdAt)`——命中就只会归档 1 条，ID 也必须是那个固定摘要。
   */
  it('remember 的消息 ID 与 stableMessageId 同源（固定摘要与跨路径去重）', async () => {
    const sessionId = 'shared-message-id-1';
    const sessionUri = Uri.parse(`${SCOPE}/sessions/${sessionId}`);
    const createdAt = '2026-11-08T00:00:00.000Z';
    // 与 `tests/unit/services/stable-message-id.test.ts` 同一组输入：两处共同锁死
    // 「角色 NUL 正文 NUL 时间戳 的 sha256」，公式要改就得同时想清楚已落盘归档怎么办。
    const sharedId = stableMessageId('user', 'hello', createdAt);
    expect(sharedId).toBe('b524dcf734ba6064fe3e7261785142876b8ea19661264f6351c91726bce3f1ef');

    await harness.context.session.ensure(Uri.parse(SCOPE), sessionId, PRINCIPALS);
    await harness.context.session.addMessage(sessionUri, {
      id: sharedId,
      role: 'user',
      parts: [{ kind: 'text', text: 'hello' }],
      createdAt,
    });

    // 同一条消息走 remember：ID 与上面那条相同，所以只归档已经存在的那 1 条。
    expect(
      await callText('remember', {
        sessionId,
        messages: [{ role: 'user', content: 'hello', createdAt }],
      }),
    ).toContain('Archived 1 message(s)');

    const [archiveUri] = await harness.context.session.listArchives(sessionUri);
    if (archiveUri === undefined) {
      throw new Error('remember 没有产生归档');
    }
    const lines = Buffer.from(await harness.store.readBytes(archiveUri.child('messages.jsonl')))
      .toString('utf8')
      .split('\n')
      .filter((line) => line.trim() !== '');
    expect(lines.map((line) => (JSON.parse(line) as { readonly id: string }).id)).toEqual([
      sharedId,
    ]);
  });

  it('不传 sessionId 时每次新建随机会话（向后兼容）', async () => {
    const messages = [{ role: 'user', content: '同一句' }];

    await callText('remember', { messages });
    await callText('remember', { messages });

    expect(await harness.store.list(Uri.parse(`${SCOPE}/sessions`))).toHaveLength(2);
  });

  it('download 返回签名 URL', async () => {
    const uri = `${SCOPE}/resources/doc.md`;
    await harness.filesystem.write(Uri.parse(uri), 'x', PRINCIPALS);

    const text = await callText('download', { uri });

    expect(text).toContain('/api/v1/content/download?');
    expect(text).toContain('expires=');
    expect(text).toContain('signature=');
    expect(text).toContain(encodeURIComponent(uri));
  });

  it('download 对目录返回 NOT_FOUND', async () => {
    await expect(call('download', { uri: MEM })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('add_resource / add_skill', () => {
  it('add_resource 批量写入文件', async () => {
    const parent = `${SCOPE}/resources`;
    const text = await callText('add_resource', {
      parentUri: parent,
      files: [{ path: 'docs/api.md', content: '# API' }],
    });

    expect(text).toContain('Added 1 file(s)');
    expect(await harness.store.exists(Uri.parse(`${parent}/docs/api.md`))).toBe(true);
  });

  it('add_skill 安装技能', async () => {
    const parent = `${SCOPE}/skills`;
    const text = await callText('add_skill', {
      parentUri: parent,
      name: 'demo-skill',
      files: [
        {
          path: 'SKILL.md',
          content: '---\nname: demo-skill\ndescription: 演示技能\n---\n# Demo\n',
        },
      ],
    });

    expect(text).toContain('Installed skill "demo-skill"');
    expect(await harness.store.exists(Uri.parse(`${parent}/demo-skill/SKILL.md`))).toBe(true);
  });
});

describe('工具描述与实际行为', () => {
  it('list / read 的描述写明截断标记', () => {
    // 描述是模型看到的契约：截断行为改了但描述没改，等于又制造一次「描述与实现
    // 不符」。这里钉住关键词，改文案时若丢掉承诺会失败。
    expect(tool('list').description).toContain('... (truncated)');
    expect(tool('read').description).toContain('... (truncated)');
  });

  it('add_skill 的描述写明覆盖范围（旧文件不会被移除）', () => {
    expect(tool('add_skill').description).toContain('同路径文件被覆盖');
    expect(tool('add_skill').description).toContain('上一版存在但本次未提供的文件不会被移除');
  });
});

describe('写后物化权限', () => {
  // 三个 ingest 工具都不经过 `FileSystemService` 的观察者（直接写 `ContentStore`）。
  // 物化漏掉时它们返回成功，但 `list` / `tree` / `find` 因为缺 `node_permission` 行
  // 整个看不到——写成功了，树里什么都没有。这里用真实 ACL 断言「写得进去也看得见」。
  async function withRealAcl(
    run: (context: McpToolContext, filesystem: FileSystemService) => Promise<void>,
  ): Promise<void> {
    const local = await createHarness({ realAcl: true });
    try {
      await run(local.context, local.filesystem);
    } finally {
      await local.close();
    }
  }

  it('add_resource 之后 list(parent) 与 find 都能看到新文件', async () => {
    const parent = `${SCOPE}/resources`;
    await withRealAcl(async (context, filesystem) => {
      await tool('add_resource').execute(
        { parentUri: parent, files: [{ path: 'docs/api.md', content: '# API' }] },
        context,
      );

      const topLevel = await filesystem.list(Uri.parse(parent), PRINCIPALS);
      expect(topLevel.map((entry) => entry.uri.name)).toEqual(['docs']);

      const documents = await filesystem.list(Uri.parse(`${parent}/docs`), PRINCIPALS);
      expect(documents.map((entry) => entry.uri.toString())).toEqual([`${parent}/docs/api.md`]);

      // MCP 单入口（没有 HTTP temp-upload）也能用：content-only 导入后必须能被检索到。
      // 这条断言走真实 `find`：索引行与 `node_permission` 行任一缺失都会返回 0。
      const found = await callText('find', { query: 'API' }, context);
      expect(found).toContain(`${parent}/docs/api.md`);
    });
  });

  it('add_skill 之后 list(parent) 能看到技能目录', async () => {
    const parent = `${SCOPE}/skills`;
    await withRealAcl(async (context, filesystem) => {
      await tool('add_skill').execute(
        {
          parentUri: parent,
          name: 'demo-skill',
          files: [
            {
              path: 'SKILL.md',
              content: '---\nname: demo-skill\ndescription: 演示技能\n---\n# Demo\n',
            },
            { path: 'scripts/check.sh', content: '#!/bin/sh\nexit 0\n' },
          ],
        },
        context,
      );

      const listed = await filesystem.list(Uri.parse(parent), PRINCIPALS);
      expect(listed.map((entry) => entry.uri.toString())).toEqual([`${parent}/demo-skill`]);

      const nested = await filesystem.list(Uri.parse(`${parent}/demo-skill`), PRINCIPALS);
      expect(nested.map((entry) => entry.uri.name).sort()).toEqual(['SKILL.md', 'scripts']);
    });
  });

  it('add_skill 重装同名技能不删除上一版有、本次没提交的文件', async () => {
    const parent = `${SCOPE}/skills`;
    await withRealAcl(async (context, filesystem) => {
      const entry = '---\nname: demo-skill\ndescription: 演示技能\n---\n# Demo\n';
      await tool('add_skill').execute(
        {
          parentUri: parent,
          name: 'demo-skill',
          files: [
            { path: 'SKILL.md', content: entry },
            { path: 'scripts/old.sh', content: '#!/bin/sh\nexit 0\n' },
          ],
        },
        context,
      );
      await tool('add_skill').execute(
        {
          parentUri: parent,
          name: 'demo-skill',
          files: [{ path: 'SKILL.md', content: entry }],
        },
        context,
      );

      const oldFile = `${parent}/demo-skill/scripts/old.sh`;
      // 同路径覆盖，但没提交的旧文件既不在磁盘上被删，也不从索引里清掉。
      expect((await filesystem.stat(Uri.parse(oldFile), PRINCIPALS))?.kind).toBe('file');
      expect(await callText('find', { query: 'exit' }, context)).toContain(oldFile);
    });
  });

  it('remember 之后会话目录可见（GET /sessions 依赖它）', async () => {
    await withRealAcl(async (context, filesystem) => {
      await tool('remember').execute(
        { messages: [{ role: 'user', content: '我偏好中文回答' }] },
        context,
      );

      const listed = await filesystem.list(Uri.parse(`${SCOPE}/sessions`), PRINCIPALS);
      expect(listed).toHaveLength(1);
      expect(listed[0]?.kind).toBe('directory');
      expect(listed[0]?.uri.name).toMatch(/^sess_[0-9a-f]{8}$/);
    });
  });
});

describe('权限', () => {
  it('全部 16 个工具在无权限时抛 PERMISSION_DENIED', async () => {
    const denied = await createHarness({ authorizer: new DenyAllAuthorizer() });
    const file = `${MEM}/denied.md`;
    const dir = `${MEM}`;

    const inputs: Readonly<Record<McpToolName, unknown>> = {
      find: { query: 'x' },
      search: { query: 'x' },
      rule_search: { taskContext: 'x' },
      read: { uri: file },
      list: { uri: dir },
      tree: { uri: dir },
      grep: { uri: dir, pattern: 'x' },
      glob: { pattern: '**', uri: dir },
      download: { uri: file },
      health: {},
      write: { uri: file, content: 'x' },
      edit: { uri: file, oldString: 'a', newString: 'b' },
      remember: { messages: [{ role: 'user', content: 'hi' }] },
      forget: { uri: file },
      add_resource: { parentUri: dir, files: [{ path: 'a.md', content: 'x' }] },
      add_skill: {
        parentUri: dir,
        name: 'demo',
        files: [{ path: 'SKILL.md', content: '# x' }],
      },
    };

    try {
      for (const name of Object.keys(inputs) as McpToolName[]) {
        const error: unknown = await tool(name)
          .execute(inputs[name], denied.context)
          .catch((reason: unknown) => reason);
        expect(error, `${name} 应当被拒绝`).toBeInstanceOf(ComemError);
        if (error instanceof ComemError) {
          expect(error.code, `${name} 的错误码`).toBe('PERMISSION_DENIED');
        }
      }
    } finally {
      await denied.close();
    }
  });
});
