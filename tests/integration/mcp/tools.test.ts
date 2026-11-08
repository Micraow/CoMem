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
import type { ContextType } from '../../../src/domain/node.js';
import type { IndexRecord } from '../../../src/domain/retrieval.js';
import { Uri } from '../../../src/domain/uri.js';
import {
  AllowAllAuthorizer,
  permissionDenied,
  type AclAction,
  type Authorizer,
} from '../../../src/services/authorizer.js';
import { AclService } from '../../../src/services/acl.js';
import { ContextAssembler } from '../../../src/services/context-assembler.js';
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
import { SessionService } from '../../../src/services/session.js';
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
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => logger,
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
          dataDir,
          db,
          aclFile: new AclFileStore({ dataDir, logger }),
          permissions,
          nodes,
          logger,
          subject: SUBJECT,
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
    estimateTokens: (text) => text.length,
  });
  const search = new SearchService({
    index,
    filesystem,
    authorizer,
    assembler,
    logger,
    config: RETRIEVAL_SETTINGS,
  });
  const summary = new SummaryService({
    nodes,
    index,
    metadata,
    store,
    db,
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
  const skill = new SkillService({ store, locks, index, summary, permissions, logger, authorizer });

  const context: McpToolContext = {
    filesystem,
    search,
    summary,
    acl: authorizer,
    session,
    memory,
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
    status: 'active',
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

describe('find', () => {
  const DOC = `${MEM}/design.md`;

  it('中文检索按 §13.2 的格式返回', async () => {
    await seed(DOC, '上下文记忆数据库的设计', { abstract: '上下文记忆数据库' });

    const text = await callText('find', { query: '记忆' });

    expect(text).toMatch(/^Found 1 item\(s\):/);
    expect(text).toMatch(/^- \[memory \d+\.\d{2}\] comem:\/\/user\/alice\/mem\/design\.md$/m);
    expect(text).toContain('\n  上下文记忆数据库');
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
    await harness.filesystem.write(Uri.parse(TEXT_URI), 'abcdefghij');
  });

  it('offset / limit 按码点切片', async () => {
    expect(await callText('read', { uri: TEXT_URI, offset: 2, limit: 3 })).toBe('cde');
    expect(await callText('read', { uri: TEXT_URI })).toBe('abcdefghij');
  });

  it('多 URI 返回带边界的文本', async () => {
    const other = `${MEM}/other.txt`;
    await harness.filesystem.write(Uri.parse(other), 'xyz');

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

describe('list', () => {
  const ROOT = `${MEM}`;

  beforeEach(async () => {
    await harness.filesystem.write(Uri.parse(`${ROOT}/b.md`), 'bb');
    await harness.filesystem.write(Uri.parse(`${ROOT}/a.md`), 'a');
    await harness.filesystem.write(Uri.parse(`${ROOT}/dirA/c.md`), 'ccc');
  });

  it('默认只列直接子项并按 name 升序', async () => {
    const text = await callText('list', { uri: ROOT });

    expect(text.split('\n')).toEqual(['[file] a.md', '[file] b.md', '[dir] dirA']);
  });

  it('recursive 展开子树', async () => {
    const text = await callText('list', { uri: ROOT, recursive: true });

    expect(text.split('\n')).toContain('[file] dirA/c.md');
  });

  it('sortBy 支持 size 与 _desc', async () => {
    expect((await callText('list', { uri: ROOT, sortBy: 'size' })).split('\n')[0]).toBe(
      '[file] a.md',
    );
    expect((await callText('list', { uri: ROOT, sortBy: 'name_desc' })).split('\n')[0]).toBe(
      '[dir] dirA',
    );
  });
});

describe('tree', () => {
  it('levelLimit 控制层数', async () => {
    await harness.filesystem.write(Uri.parse(`${MEM}/a.md`), 'a');
    await harness.filesystem.write(Uri.parse(`${MEM}/dirA/c.md`), 'c');

    const level1 = await callText('tree', { uri: MEM, levelLimit: 1 });
    expect(level1).toContain('  dirA/');
    expect(level1).not.toContain('c.md');

    const level2 = await callText('tree', { uri: MEM, levelLimit: 2 });
    expect(level2).toContain('    c.md');
  });
});

describe('grep', () => {
  const FILE = `${MEM}/error.ts`;

  beforeEach(async () => {
    await harness.filesystem.write(Uri.parse(FILE), 'Boom\nok\nBOOM again\n');
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
    await harness.filesystem.write(Uri.parse(editUri), 'foo foo foo');

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
    await harness.filesystem.write(Uri.parse(`${dir}/child.md`), 'x');

    await expect(callText('forget', { uri: dir })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });

    const text = await callText('forget', { uri: dir, recursive: true });
    expect(text).toContain(`Deleted: ${dir}`);
    expect(await harness.store.exists(Uri.parse(dir))).toBe(false);
  });
});

describe('health', () => {
  it('返回索引条数与摘要降级标记', async () => {
    await seed(`${MEM}/a.md`, 'a');
    await seed(`${MEM}/b.md`, 'b');

    const text = await callText('health', {});

    expect(text).toContain('status: ok');
    expect(text).toContain('index.nodes: 2');
    expect(text).toContain('summary.degraded: false');
  });

  it('返回绑定主体与可寻址的根', async () => {
    const text = await callText('health', {});

    expect(text).toContain(`subject: ${SUBJECT}`);
    expect(text).toContain(`scopes: ${SCOPE}`);
  });
});

describe('~ 别名（§6.1）', () => {
  const ALIAS = '~/mem/alias.md';

  it('每个需要 URI 的工具都接受 ~ 开头的路径', async () => {
    await harness.filesystem.write(Uri.parse(`${MEM}/alias.md`), 'x');
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

  it('rule_search 返回规则完整正文', async () => {
    const ruleUri = `${SCOPE}/memories/rules/license-review/rule.md`;
    await harness.filesystem.write(Uri.parse(ruleUri), '提交前必须检查许可证。');
    await seed(ruleUri, '提交前必须检查许可证', {
      memoryType: 'rules',
      abstract: '许可证规则',
    });

    const text = await callText('rule_search', {
      taskContext: '提交前必须检查许可证',
      threshold: 0,
    });

    expect(text).toContain(ruleUri);
    expect(text).toContain('提交前必须检查许可证。');
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

  it('不传 sessionId 时每次新建随机会话（向后兼容）', async () => {
    const messages = [{ role: 'user', content: '同一句' }];

    await callText('remember', { messages });
    await callText('remember', { messages });

    expect(await harness.store.list(Uri.parse(`${SCOPE}/sessions`))).toHaveLength(2);
  });

  it('download 返回签名 URL', async () => {
    const uri = `${SCOPE}/resources/doc.md`;
    await harness.filesystem.write(Uri.parse(uri), 'x');

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

  it('add_resource 之后 list(parent) 能看到新文件', async () => {
    const parent = `${SCOPE}/resources`;
    await withRealAcl(async (context, filesystem) => {
      await tool('add_resource').execute(
        { parentUri: parent, files: [{ path: 'docs/api.md', content: '# API' }] },
        context,
      );

      const topLevel = await filesystem.list(Uri.parse(parent));
      expect(topLevel.map((entry) => entry.uri.name)).toEqual(['docs']);

      const documents = await filesystem.list(Uri.parse(`${parent}/docs`));
      expect(documents.map((entry) => entry.uri.toString())).toEqual([`${parent}/docs/api.md`]);
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

      const listed = await filesystem.list(Uri.parse(parent));
      expect(listed.map((entry) => entry.uri.toString())).toEqual([`${parent}/demo-skill`]);

      const nested = await filesystem.list(Uri.parse(`${parent}/demo-skill`));
      expect(nested.map((entry) => entry.uri.name).sort()).toEqual(['SKILL.md', 'scripts']);
    });
  });

  it('remember 之后会话目录可见（GET /sessions 依赖它）', async () => {
    await withRealAcl(async (context, filesystem) => {
      await tool('remember').execute(
        { messages: [{ role: 'user', content: '我偏好中文回答' }] },
        context,
      );

      const listed = await filesystem.list(Uri.parse(`${SCOPE}/sessions`));
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
