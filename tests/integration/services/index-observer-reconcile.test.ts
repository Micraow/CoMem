/**
 * `IndexObserver` 的索引失败 → 对账记录 → 重放（架构文档 §10.6「索引双写补偿」）。
 *
 * 这条测试要证明的是**恢复结果**：记忆写入走观察者落索引，索引写失败之后文件在盘上
 * 但 `find` 搜不到；对账日志里必须出现**那条精确的 URI**，真实 `ReconcileService`
 * 重放一轮之后 `find` 就能搜到。不是「函数被调用了」。
 *
 * 装配按生产形状搭（`bootstrap/container.ts`）：记忆文件由 `MemoryService` 经字节口
 * 写入 `ContentStore`，写后手动通知观察者——这正是「不经过 `FileSystemService` 的
 * 写路径」，也是原先漏记对账的那条路。
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AclFileStore } from '../../../src/adapters/fs/acl-file.js';
import { ContentStore } from '../../../src/adapters/fs/content-store.js';
import { createPathLockManager, type PathLockManager } from '../../../src/adapters/fs/lock.js';
import { MetadataFileStore } from '../../../src/adapters/fs/metadata-file.js';
import { ReconcileLog } from '../../../src/adapters/fs/reconcile-log.js';
import { openDatabase, runMigrations } from '../../../src/adapters/sqlite/database.js';
import { NodeRepository } from '../../../src/adapters/sqlite/node-repository.js';
import { PermissionRepository } from '../../../src/adapters/sqlite/permission-repository.js';
import { SqliteFtsIndex } from '../../../src/adapters/sqlite/retrieval-index.js';
import { InheritingAuthorizer } from '../../../src/bootstrap/container.js';
import type { Logger } from '../../../src/domain/log.js';
import { preferencesMemoryType } from '../../../src/domain/memory-types/preferences.js';
import { Uri } from '../../../src/domain/uri.js';
import { AclService } from '../../../src/services/acl.js';
import { ContextAssembler } from '../../../src/services/context-assembler.js';
import { FileSystemService } from '../../../src/services/filesystem.js';
import { IndexObserver } from '../../../src/services/index-observer.js';
import { MemoryService, type MemoryServicePorts } from '../../../src/services/memory.js';
import { ReconcileService } from '../../../src/services/reconcile.js';
import { SearchService, type RetrievalSettings } from '../../../src/services/search.js';
import { RuleSummarizer, SummaryService } from '../../../src/services/summary.js';

const ROOT = 'comem://user/alice';
const PREFERENCES = `${ROOT}/memories/preferences`;
const CODE_STYLE = `${PREFERENCES}/code-style.md`;
const SUBJECT = 'user:alice';
const PRINCIPALS: readonly string[] = [SUBJECT, 'user:*'];

/** 只出现在这条记忆里的 ASCII 串：`unicode61` 分词器不切中文，检索词用它更稳。 */
const PROBE = 'indexprobe';

const RETRIEVAL: RetrievalSettings = {
  candidateMultiplier: 4,
  levelWeights: { l0: 1.15, l1: 1.05, l2: 1 },
  queryFilters: [],
  assembly: { maxTokens: 1600, dedupTurns: 3, quotaPreset: 'coding' },
};

const FIND_OPTIONS = { scopes: [ROOT], subject: SUBJECT, principals: PRINCIPALS };

interface RecordingLogger extends Logger {
  readonly errors: string[];
}

interface Harness {
  readonly dataDir: string;
  readonly logger: RecordingLogger;
  readonly db: DatabaseSync;
  readonly store: ContentStore;
  readonly index: SqliteFtsIndex;
  readonly nodes: NodeRepository;
  readonly acl: AclService;
  readonly observer: IndexObserver;
  readonly filesystem: FileSystemService;
  readonly memory: MemoryService;
  readonly reconcileLog: ReconcileLog;
  readonly reconcile: ReconcileService;
  readonly search: SearchService;
  close(): Promise<void>;
}

function createLogger(): RecordingLogger {
  const errors: string[] = [];
  const logger: RecordingLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn((message: string) => {
      errors.push(message);
    }),
    errors,
  };
  return logger;
}

async function createHarness(): Promise<Harness> {
  const dataDir = await mkdtemp(join(tmpdir(), 'comem-observer-reconcile-'));
  const logger = createLogger();
  const db = openDatabase(':memory:');
  runMigrations(db);

  const store = new ContentStore({ dataDir, logger });
  const metadata = new MetadataFileStore({ dataDir, logger });
  const permissions = new PermissionRepository({ db, logger });
  const nodes = new NodeRepository({ db, logger });
  const index = new SqliteFtsIndex({ db, logger });
  const locks = createPathLockManager({ dataDir, logger, pollIntervalMs: 1 });
  const acl = new AclService({
    db,
    aclFile: new AclFileStore({ dataDir, logger }),
    permissions,
    nodes,
    logger,
    locks,
  });
  await acl.ensureRootPreset(Uri.parse(ROOT));

  const summary = new SummaryService({
    nodes,
    index,
    metadata,
    store,
    db,
    acl,
    generator: new RuleSummarizer(),
    logger,
    config: { abstractMaxChars: 256, overviewMaxChars: 4000 },
    locks,
  });

  const reconcileLog = new ReconcileLog({ dataDir, logger });
  const observer = new IndexObserver({
    store,
    index,
    acl,
    summary,
    nodes,
    permissions,
    logger,
    reconcile: reconcileLog,
  });
  const authorizer = new InheritingAuthorizer(acl, store);
  const filesystem = new FileSystemService({
    store,
    locks,
    authorizer,
    logger,
    observers: [observer],
  });

  // 生产装配里记忆文件走这条字节口（`bootstrap/container.ts` 的 `rawFilesystem`）：
  // 不经过 `FileSystemService` 的序列化，写后手动通知观察者。
  const rawFilesystem: MemoryServicePorts['filesystem'] = {
    read: async (uri) => ({
      text: Buffer.from(await store.readBytes(uri)).toString('utf8'),
    }),
    write: async (uri, text) => {
      const stat = await store.writeBytes(uri, Uint8Array.from(Buffer.from(text, 'utf8')));
      await observer.onNodeWritten(uri, 'file');
      return stat;
    },
    stat: (uri) => store.stat(uri),
    remove: async (uri) => {
      const removed = await store.remove(uri, { recursive: true });
      await observer.onNodeRemoved(uri);
      return removed;
    },
    list: (uri) => store.list(uri),
  };

  const memory = new MemoryService({
    locks: locks as PathLockManager,
    filesystem: rawFilesystem,
    // 预取只是「写之前先看看有没有重复」，这条链路不依赖它。
    search: { find: async () => [] },
    logger,
  });

  const reconcile = new ReconcileService({ store, index, acl, nodes, log: reconcileLog, logger });
  const assembler = new ContextAssembler({
    store,
    metadata,
    authorizer,
    logger,
  });
  const search = new SearchService({
    index,
    filesystem,
    authorizer,
    assembler,
    logger,
    config: RETRIEVAL,
    hotnessWeight: 0,
    hotnessHalfLifeHours: 168,
  });

  return {
    dataDir,
    logger,
    db,
    store,
    index,
    nodes,
    acl,
    observer,
    filesystem,
    memory,
    reconcileLog,
    reconcile,
    search,
    close: async () => {
      await observer.drain();
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

/** 对账日志原文；不存在按空处理（与 `ReconcileLog.read` 的 ENOENT 语义一致）。 */
async function readLog(): Promise<string> {
  try {
    return await readFile(join(harness.dataDir, '_meta/reconcile.log'), 'utf8');
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') {
      return '';
    }
    throw error;
  }
}

async function logEntries(): Promise<readonly { op: string; uri: string }[]> {
  const raw = await readLog();
  return raw
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as { op: string; uri: string });
}

async function writeMemory(content: string): Promise<string> {
  const result = await harness.memory.upsertMemory(Uri.parse(ROOT), preferencesMemoryType, {
    topic: 'code-style',
    content,
  });
  await harness.observer.drain();
  return result.uri.toString();
}

/** 某个节点的物化权限行（只数行，不关心具体主体）。 */
function permissionRowsOf(uri: string): readonly Record<string, unknown>[] {
  return harness.db
    .prepare('SELECT node_uri, principal, level, effect FROM node_permission WHERE node_uri = ?')
    .all(uri);
}

/**
 * 只让**某一个** URI 的权限物化失败，其余照常。
 *
 * `mockRejectedValueOnce` 会撞上同一次调用里的其它物化（写路径先物化节点自己再
 * 物化祖先），按 URI 过滤才测得到「失败的是哪一条」。
 */
function spyOnMaterialize(failing: string) {
  const original = harness.acl.materializeNode.bind(harness.acl);
  return vi.spyOn(harness.acl, 'materializeNode').mockImplementation(async (uri) => {
    if (uri.toString() === failing) {
      throw new Error('权限表坏了');
    }
    return original(uri);
  });
}

describe('IndexObserver 的索引失败进入对账', () => {
  it('索引写失败 → 精确 URI 的对账记录 → 重放 → find 能搜到', async () => {
    // 让这一次单节点 upsert 真的失败：文件已经写盘，索引一行都没有。
    const upsert = vi.spyOn(harness.index, 'upsert').mockRejectedValueOnce(new Error('索引坏了'));

    const uri = await writeMemory(`偏好 TypeScript 严格模式（${PROBE}）。`);

    expect(uri).toBe(CODE_STYLE);
    upsert.mockRestore();

    // 记录必须精确到这一条 URI：多写父目录就是重放做无用功。
    const entries = await logEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ op: 'index', uri });

    // 权限物化没有被索引失败带走：否则重放补上索引行之后，权限过滤仍然把它挡住。
    const permission = harness.db
      .prepare('SELECT COUNT(*) AS total FROM node_permission WHERE node_uri = ?')
      .get(uri);
    expect(Number(permission?.['total'])).toBeGreaterThan(0);

    // 失败后的原始状态：文件在、索引不在——检索看不到。
    expect(await harness.search.find(PROBE, FIND_OPTIONS)).toEqual([]);

    await expect(harness.reconcile.replay()).resolves.toMatchObject({
      scanned: 1,
      resolved: 1,
      failed: 0,
      remaining: 0,
      compacted: true,
    });

    const hits = await harness.search.find(PROBE, FIND_OPTIONS);
    expect(hits.map((hit) => hit.uri)).toContain(uri);
    // 重放成功之后日志被清空：这条失败不再占着待重放的位置。
    expect(await readLog()).toBe('');
  });

  it('索引成功时不写对账记录', async () => {
    const uri = await writeMemory(`偏好 TypeScript 严格模式（${PROBE}）。`);

    expect(await readLog()).toBe('');
    const hits = await harness.search.find(PROBE, FIND_OPTIONS);
    expect(hits.map((hit) => hit.uri)).toContain(uri);
  });

  it('移动后批量索引写失败 → 记录目标 URI，重放后新位置可搜、旧位置不可搜（注意目录摘要也会命中同一个词，断言按文件 URI）', async () => {
    const from = Uri.parse(`${ROOT}/resources/spec/orbital.md`);
    const to = Uri.parse(`${ROOT}/resources/spec-v2/orbital.md`);
    await harness.filesystem.write(from, 'orbital-teapot 只出现在这条资源里。', PRINCIPALS);
    await harness.observer.drain();
    expect((await harness.search.find('orbital', FIND_OPTIONS)).map((hit) => hit.uri)).toContain(
      from.toString(),
    );

    // 只让移动这一步的批量 upsert 失败（写源文件时索引是好的）。
    const upsert = vi.spyOn(harness.index, 'upsert').mockRejectedValueOnce(new Error('索引坏了'));
    await harness.filesystem.move(from, to, PRINCIPALS);
    upsert.mockRestore();
    await harness.observer.drain();

    // 记的是**目标** URI：源前缀磁盘上已经没了，记源 URI 只会被重放器按「目标已
    // 不存在」移出，等于没记。
    const entries = await logEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ op: 'index', uri: to.toString() });
    expect(await readLog()).not.toContain(from.toString());

    // 失败后的状态：文件在新位置、索引里没有；旧位置的索引行已被删掉。
    // 目录的 L0 摘要也会命中 'orbital'（`spec-v2` 的摘要列了子文件名），所以按
    // **文件 URI** 断言，不断言整个结果为空。
    const beforeReplay = (await harness.search.find('orbital', FIND_OPTIONS)).map((hit) => hit.uri);
    expect(beforeReplay).not.toContain(to.toString());
    expect(beforeReplay).not.toContain(from.toString());

    await expect(harness.reconcile.replay()).resolves.toMatchObject({
      scanned: 1,
      resolved: 1,
      failed: 0,
      remaining: 0,
    });

    const hits = await harness.search.find('orbital', FIND_OPTIONS);
    expect(hits.map((hit) => hit.uri)).toContain(to.toString());
    expect(hits.map((hit) => hit.uri)).not.toContain(from.toString());
  });

  it('删除后父目录权限物化失败 → 记录 op:permission → 重放补回物化行', async () => {
    const file = Uri.parse(`${ROOT}/resources/docs/removable.md`);
    const parent = `${ROOT}/resources/docs`;
    await harness.filesystem.write(file, '待删除的正文。', PRINCIPALS);
    await harness.observer.drain();

    // 先摘掉父目录的物化行：否则「重放修好了」没有可观察的差别。
    harness.db.prepare('DELETE FROM node_permission WHERE node_uri = ?').run(parent);

    const materialize = spyOnMaterialize(parent);
    await harness.filesystem.remove(file, PRINCIPALS);
    materialize.mockRestore();
    await harness.observer.drain();

    const entries = await logEntries();
    expect(entries).toHaveLength(1);
    // 被删节点自己不能记：重放器只重放磁盘上仍存在的目标。
    expect(entries[0]).toMatchObject({ op: 'permission', uri: parent });

    // 摘要失效会顺带物化父目录（`SummaryService.#persistSummary` 的写后钩子），
    // 所以等排期跑完再摘一次行：之后的恢复只可能来自重放。
    await harness.observer.drain();
    harness.db.prepare('DELETE FROM node_permission WHERE node_uri = ?').run(parent);
    expect(permissionRowsOf(parent)).toEqual([]);

    await expect(harness.reconcile.replay()).resolves.toMatchObject({ resolved: 1, remaining: 0 });
    expect(permissionRowsOf(parent).length).toBeGreaterThan(0);
  });

  it('写路径的祖先目录权限物化失败 → 记录 op:permission → 重放补回物化行', async () => {
    const materialize = spyOnMaterialize(PREFERENCES);
    const uri = await writeMemory(`偏好 TypeScript 严格模式（${PROBE}）。`);
    materialize.mockRestore();

    const entries = await logEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ op: 'permission', uri: PREFERENCES });
    // 索引行不受影响：权限失败不该让节点从检索里消失两次。
    expect(
      (await harness.search.find(PROBE, FIND_OPTIONS)).map((hit) => hit.uri),
    ).toContain(uri);

    await harness.observer.drain();
    harness.db.prepare('DELETE FROM node_permission WHERE node_uri = ?').run(PREFERENCES);
    expect(permissionRowsOf(PREFERENCES)).toEqual([]);

    await expect(harness.reconcile.replay()).resolves.toMatchObject({ resolved: 1, remaining: 0 });
    expect(permissionRowsOf(PREFERENCES).length).toBeGreaterThan(0);
  });

  it('目录索引行写失败只记日志：重放器不重建目录行，消息不能声称「已记录待重放」', async () => {
    const directory = Uri.parse(`${ROOT}/resources/made-by-hand`);
    const upsert = vi.spyOn(harness.index, 'upsert').mockRejectedValueOnce(new Error('索引坏了'));
    await harness.filesystem.mkdir(directory, PRINCIPALS);
    upsert.mockRestore();
    await harness.observer.drain();

    expect(await logEntries()).toEqual([]);
    expect(harness.logger.errors).toContain('节点写入后目录索引行写入失败，已忽略。');
    // 运维照日志去翻 `reconcile.log` 会什么都找不到，所以这条消息不能说「已记录」。
    expect(harness.logger.errors.join('\n')).not.toContain('已记录待重放');
  });

  it('索引删除失败只记日志：重放器没有「删一条过期行」的动作，不写假记录', async () => {
    const file = Uri.parse(`${ROOT}/resources/docs/gone.md`);
    await harness.filesystem.write(file, '会被删掉的正文。', PRINCIPALS);
    await harness.observer.drain();

    const remove = vi
      .spyOn(harness.index, 'deleteByUri')
      .mockRejectedValueOnce(new Error('索引坏了'));
    await harness.filesystem.remove(file, PRINCIPALS);
    remove.mockRestore();
    await harness.observer.drain();

    expect(await logEntries()).toEqual([]);
    expect(harness.logger.errors).toContain('节点删除后清理索引失败，已忽略。');
  });

  it('对账日志写失败只记 error，记忆写入本身仍然成功', async () => {
    vi.spyOn(harness.index, 'upsert').mockRejectedValueOnce(new Error('索引坏了'));
    vi.spyOn(harness.reconcileLog, 'append').mockRejectedValueOnce(new Error('日志盘满了'));

    const result = await harness.memory.upsertMemory(Uri.parse(ROOT), preferencesMemoryType, {
      topic: 'code-style',
      content: `偏好 TypeScript 严格模式（${PROBE}）。`,
    });
    await harness.observer.drain();

    expect(result.written).toBe(true);
    // 内容已经是真相：线索写不进去不能把写操作变成失败。
    expect(await harness.store.stat(Uri.parse(CODE_STYLE))).not.toBeNull();
    expect(harness.logger.errors).toContain('对账日志写入失败，已忽略。');
  });
});
