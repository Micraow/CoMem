/**
 * 记忆 TTL 的验收（架构文档 §11.7）。
 *
 * 用真实 SQLite（`:memory:`）与真实的 `NodeRepository` / `SqliteFtsIndex` /
 * `ContentStore` / `FileSystemService`：这一层的价值全在 SQL 与文件删除上（滑动窗口
 * 的判据、类型豁免、`status <> 'archived'` 的幂等、不碰 `updated_at`、两段式物理
 * 删除），用替身测等于测替身。
 *
 * 判据是 `max(updated_at, last_accessed_at)`（最后一次被使用），不是 `updated_at`
 * 单独一项。`最近被访问过的记忆不归档` 那条用例是这个行为的锚点：把 `sweepExpired`
 * 的 SQL 改回只看 `updated_at` 时它必须变红。
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AclFileStore } from '../../../src/adapters/fs/acl-file.js';
import { ContentStore } from '../../../src/adapters/fs/content-store.js';
import { createPathLockManager } from '../../../src/adapters/fs/lock.js';
import { MetadataFileStore } from '../../../src/adapters/fs/metadata-file.js';
import { ReconcileLog } from '../../../src/adapters/fs/reconcile-log.js';
import { openDatabase, runMigrations } from '../../../src/adapters/sqlite/database.js';
import { NodeRepository, type NodeRow } from '../../../src/adapters/sqlite/node-repository.js';
import { PermissionRepository } from '../../../src/adapters/sqlite/permission-repository.js';
import { SqliteFtsIndex } from '../../../src/adapters/sqlite/retrieval-index.js';
import type { Logger } from '../../../src/domain/log.js';
import { preferencesMemoryType } from '../../../src/domain/memory-types/preferences.js';
import type { IndexRecord } from '../../../src/domain/retrieval.js';
import { MILLISECONDS_PER_DAY } from '../../../src/domain/time.js';
import { Uri } from '../../../src/domain/uri.js';
import { AllowAllAuthorizer } from '../../helpers/allow-all-authorizer.js';
import { AclService } from '../../../src/services/acl.js';
import { ContextAssembler } from '../../../src/services/context-assembler.js';
import { FileSystemService, type NodeWriteObserver } from '../../../src/services/filesystem.js';
import { IndexObserver } from '../../../src/services/index-observer.js';
import { MemoryService } from '../../../src/services/memory.js';
import { SearchService, type RetrievalSettings } from '../../../src/services/search.js';
import { RuleSummarizer, SummaryService } from '../../../src/services/summary.js';
import { TtlService } from '../../../src/services/ttl.js';

const NOW = new Date('2026-11-08T00:00:00.000Z');

/** 滑动窗口长度（`memory.ttl.defaultDays` 的测试取值）。 */
const TTL_DAYS = 30;

const PREFERENCES = 'comem://user/alice/memories/preferences';
const OLD = `${PREFERENCES}/old.md`;
const FRESH = `${PREFERENCES}/fresh.md`;
const COLD = `${PREFERENCES}/cold.md`;

/** 系统动作求权用的主体集合（`AllowAllAuthorizer` 下无所谓，接口要它）。 */
const PRINCIPALS = ['user:alice', 'user:*'];

/** `daysAgo(n)`：相对注入时钟的 ISO 时刻，测试里的所有时间都从这里来。 */
function daysAgo(days: number): string {
  return atDaysAgo(days).toISOString();
}

function atDaysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * MILLISECONDS_PER_DAY);
}

let dataDir: string;
let db: DatabaseSync;
let logger: Logger;
let nodes: NodeRepository;
let store: ContentStore;
let metadata: MetadataFileStore;
let fts: SqliteFtsIndex;
let authorizer: AllowAllAuthorizer;
let filesystem: FileSystemService;
let ttl: TtlService;

/** 检索所需的默认配置（与 `config/schema.ts` 的默认值一致）。 */
const RETRIEVAL: RetrievalSettings = {
  candidateMultiplier: 4,
  levelWeights: { l0: 1.15, l1: 1.05, l2: 1 },
  queryFilters: [],
  assembly: { maxTokens: 1600, dedupTurns: 3, quotaPreset: 'coding' },
};

/** 生产默认配置下的检索服务：`telemetry.hotness.weight = 0`。 */
function createSearch(hotnessWeight: number): SearchService {
  const assembler = new ContextAssembler({
    store,
    metadata,
    authorizer,
    logger,
  });
  return new SearchService({
    index: fts,
    filesystem,
    authorizer,
    assembler,
    logger,
    config: RETRIEVAL,
    engine: 'fts5',
    hotnessWeight,
    hotnessHalfLifeHours: 168,
    accessStats: (uris) => nodes.readAccessStats(uris),
    // 与生产装配同一条闭包（`container.ts`）：检索命中与按 URI 读取共用它。
    recordAccess: (uris) => nodes.recordAccess(uris, NOW),
  });
}

function createLogger(): Logger {
  const mock: Logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return mock;
}

/**
 * 写入一行节点（走生产写路径 `SqliteFtsIndex.upsert`）。过期判据由 `updated_at` /
 * `last_accessed_at` 决定，不存绝对时刻。
 */
async function insertNode(uri: string, overrides: Partial<NodeRow> = {}): Promise<void> {
  const row: NodeRow = {
    uri,
    parentUri: PREFERENCES,
    scope: 'user',
    kind: 'document',
    contextType: 'memory',
    memoryType: 'preferences',
    level: 'L2',
    abstract: null,
    bodyDigest: 'digest',
    size: 10,
    updatedAt: daysAgo(1),
    status: 'active',
    ...overrides,
  };
  await fts.upsert([{ ...row, content: '' }]);
}

/** 在磁盘上写一个真实文件并给它建索引行，模拟一条「被 TTL 管理的记忆」。 */
async function createMemoryFile(uri: string): Promise<void> {
  const parsed = Uri.parse(uri);
  await store.writeBytes(parsed, Uint8Array.from(Buffer.from('# 记忆正文\n', 'utf8')));
  await insertNode(uri);
}

function createTtl(options: { readonly ttlDays: number; readonly retentionDays?: number }): TtlService {
  return new TtlService({
    nodes,
    filesystem,
    principals: PRINCIPALS,
    ttlDays: options.ttlDays,
    retentionDays: options.retentionDays ?? 0,
    logger,
    now: () => NOW,
  });
}

function statusOf(uri: string): string {
  return String(db.prepare('SELECT status FROM node WHERE uri = ?').get(uri)?.['status']);
}

function archivedAtOf(uri: string): string | null {
  const row = db.prepare('SELECT archived_at FROM node WHERE uri = ?').get(uri);
  const value = row?.['archived_at'];
  return value === null || value === undefined ? null : String(value);
}

async function fileExists(uri: string): Promise<boolean> {
  return (await store.stat(Uri.parse(uri))) !== null;
}

/** 归档一条记忆并把它「据称已经归档了若干天」——用于第二段（物理删除）的测试。 */
function archiveDaysAgo(uri: string, days: number): void {
  db.prepare(`UPDATE node SET status = 'archived', archived_at = ? WHERE uri = ?`).run(
    daysAgo(days),
    uri,
  );
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'comem-ttl-'));
  db = openDatabase(':memory:');
  runMigrations(db);
  logger = createLogger();
  nodes = new NodeRepository({ db, logger });
  fts = new SqliteFtsIndex({ db, logger });
  store = new ContentStore({ dataDir, logger });
  metadata = new MetadataFileStore({ dataDir, logger });
  authorizer = new AllowAllAuthorizer();
  // 最小的派生数据观察者：删除时把 `node` 行一并删掉，模拟生产里 `IndexObserver`
  // 通过 `deleteByUri` 做的事（`forget` 与 TTL 第二段共用同一条删除路径，
  // 索引行由观察者清）。只测第二段关心的「文件 + 索引行一起消失」，不引入整个
  // IndexObserver 的依赖图。
  const indexCleanup: NodeWriteObserver = {
    onNodeWritten: async () => {},
    onNodeMoved: async () => {},
    onNodeRemoved: async (uri) => {
      await fts.deleteByUri(uri.toString(), { recursive: true });
    },
  };
  filesystem = new FileSystemService({
    store,
    locks: createPathLockManager({ dataDir, logger }),
    authorizer,
    logger,
    observers: [indexCleanup],
    recordAccess: (uris) => {
      nodes.recordAccess(uris, NOW);
    },
  });
  ttl = createTtl({ ttlDays: TTL_DAYS });
});

afterEach(async () => {
  db.close();
  await rm(dataDir, { recursive: true, force: true });
});

describe('sweep 第一段：滑动窗口归档', () => {
  it('从未被访问过的记忆：按 updated_at 起算，超出窗口归档', async () => {
    await insertNode(OLD, { updatedAt: daysAgo(TTL_DAYS + 1) });
    await insertNode(FRESH, { updatedAt: daysAgo(TTL_DAYS - 1) });

    await expect(ttl.sweep()).resolves.toEqual({ expired: 1, purged: 0 });

    expect(statusOf(OLD)).toBe('archived');
    expect(statusOf(FRESH)).toBe('active');
  });

  it('窗口内被访问过：不归档（两条写入时间相同，只有被访问的那条活下来）', async () => {
    await insertNode(OLD, { updatedAt: daysAgo(100) });
    await insertNode(COLD, { updatedAt: daysAgo(100) });
    // 100 天前写入，但 2 天前被检索命中过：窗口从访问时刻重新起算。
    nodes.recordAccess([OLD], atDaysAgo(2));

    await expect(ttl.sweep()).resolves.toEqual({ expired: 1, purged: 0 });

    expect(statusOf(OLD)).toBe('active');
    expect(statusOf(COLD)).toBe('archived');
    // 访问计数列本身不被清扫改动。
    expect(nodes.readAccessStats([OLD])).toEqual([
      { uri: OLD, accessCount: 1, lastAccessedAt: atDaysAgo(2).toISOString() },
    ]);
  });

  it('检索命中过的记忆不归档；同条件没被命中过的归档（默认 hotnessWeight = 0）', async () => {
    // 两条都是 100 天前写入，都在窗口外；只有 HIT 能被 `find` 命中。
    const HIT = 'comem://user/alice/memories/events/hit.md';
    const MISS = 'comem://user/alice/memories/events/miss.md';
    const documents: readonly [string, string][] = [
      [HIT, 'orbitalteapot'],
      [MISS, 'moonlantern'],
    ];
    for (const [uri, token] of documents) {
      await store.writeBytes(
        Uri.parse(uri),
        Uint8Array.from(Buffer.from(`# ${token}\n`, 'utf8')),
      );
      const record: IndexRecord = {
        uri,
        parentUri: 'comem://user/alice/memories/events',
        scope: 'user',
        kind: 'document',
        contextType: 'memory',
        memoryType: 'events',
        level: 'L2',
        abstract: null,
        content: `# ${token}`,
        bodyDigest: 'digest',
        size: 10,
        updatedAt: daysAgo(100),
        status: 'active',
      };
      await fts.upsert([record]);
      // FTS 查询的权限谓词读 `node_permission`（不是 `Authorizer`）：没有这一行时
      // `find` 一条都不返回，测的就不是 TTL 了。
      db.prepare(
        'INSERT INTO node_permission (node_uri, principal, level) VALUES (?, ?, ?)',
      ).run(uri, 'user:alice', 1);
    }

    // 默认配置：`telemetry.hotness.weight = 0`。热度不参与排序，但「命中算一次使用」
    // 与权重无关——否则默认部署的滑动窗口看不到检索命中（缺陷就藏在这里）。
    const search = createSearch(0);
    const hits = await search.find('orbitalteapot', {
      scopes: ['comem://user/alice/memories'],
      subject: 'user:alice',
      principals: PRINCIPALS,
    });
    expect(hits.map((hit) => hit.uri)).toEqual([HIT]);
    // `recordAccess` 是 fire-and-forget；等一个宏任务再清扫，不依赖实现细节。
    await new Promise((resolve) => setTimeout(resolve, 0));

    await expect(ttl.sweep()).resolves.toEqual({ expired: 1, purged: 0 });

    expect(statusOf(HIT)).toBe('active');
    expect(statusOf(MISS)).toBe('archived');
    // 清扫没有改动访问列：活下来是因为 `last_accessed_at` 真的被写进去了。
    expect(nodes.readAccessStats([HIT])[0]?.lastAccessedAt).toBe(NOW.toISOString());
  });

  it('按 URI read 过的记忆不归档；同条件没读过的归档', async () => {
    // 两条都是 100 天前写入，都在窗口外。区别只有一个：其中一条被用户按 URI
    // `read` 过一次。`read` 不算使用的话，它会被误归档——这正是「天天读、从没被
    // 检索命中」的记忆的失效形态。
    await createMemoryFile(OLD);
    await createMemoryFile(COLD);
    db.prepare('UPDATE node SET updated_at = ? WHERE uri IN (?, ?)').run(
      daysAgo(100),
      OLD,
      COLD,
    );

    await filesystem.read(Uri.parse(OLD), PRINCIPALS);
    // `recordAccess` 是 fire-and-forget；等一个宏任务再清扫，不依赖实现细节。
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(nodes.readAccessStats([OLD])[0]?.lastAccessedAt).toBe(NOW.toISOString());

    await expect(ttl.sweep()).resolves.toEqual({ expired: 1, purged: 0 });

    expect(statusOf(OLD)).toBe('active');
    expect(statusOf(COLD)).toBe('archived');
  });

  it('访问时刻早于内容更新时间：从内容更新时间起算（取最大值，不是「有访问就用访问」）', async () => {
    await insertNode(FRESH, { updatedAt: daysAgo(2) });
    nodes.recordAccess([FRESH], atDaysAgo(100));

    await expect(ttl.sweep()).resolves.toEqual({ expired: 0, purged: 0 });

    expect(statusOf(FRESH)).toBe('active');
  });

  it('profile / identity / soul / rules 四类永不过期，即便远超窗口', async () => {
    const uris = {
      profile: 'comem://user/alice/memories/profile.md',
      identity: 'comem://user/alice/memories/identity.md',
      soul: 'comem://user/alice/memories/soul.md',
      rules: 'comem://user/alice/memories/rules/license-review/must-locate-license.md',
    };
    for (const [memoryType, uri] of Object.entries(uris)) {
      await insertNode(uri, { memoryType, updatedAt: daysAgo(3650) });
    }

    await expect(ttl.sweep()).resolves.toEqual({ expired: 0, purged: 0 });

    for (const uri of Object.values(uris)) {
      expect(statusOf(uri)).toBe('active');
    }
  });

  it('events 在同样条件下会归档（豁免只覆盖四类稳定身份与约束）', async () => {
    const event = 'comem://user/alice/memories/events/2025-01-01-decision.md';
    await insertNode(event, { memoryType: 'events', level: 'L2', updatedAt: daysAgo(3650) });

    await expect(ttl.sweep()).resolves.toEqual({ expired: 1, purged: 0 });

    expect(statusOf(event)).toBe('archived');
  });

  it('没有 frontmatter 的 memories/**/*.md 不被归档，但仍能被 find 命中', async () => {
    // 手放的普通 Markdown：`context_type = memory` 由路径推导，`memory_type` 为 NULL。
    // 两条断言必须一起写——TTL 不动它（不是可解析的记忆），检索面照常命中（路径
    // 工具的契约是「磁盘上有什么」）。只断言其中一条，就看不出这是刻意的口径差异。
    const notes = `${PREFERENCES}/notes.md`;
    await store.writeBytes(
      Uri.parse(notes),
      Uint8Array.from(Buffer.from('# 手放的笔记\n', 'utf8')),
    );
    const record: IndexRecord = {
      uri: notes,
      parentUri: PREFERENCES,
      scope: 'user',
      kind: 'document',
      contextType: 'memory',
      memoryType: null,
      level: 'L2',
      abstract: null,
      content: '手放的笔记',
      bodyDigest: 'digest',
      size: 10,
      updatedAt: daysAgo(3650),
      status: 'active',
    };
    await fts.upsert([record]);
    // FTS 的权限谓词读 `node_permission`（不是 `Authorizer`）。
    db.prepare('INSERT INTO node_permission (node_uri, principal, level) VALUES (?, ?, ?)').run(
      notes,
      'user:alice',
      1,
    );

    // 先清扫再检索：`find` 的命中会写 `last_accessed_at`（TTL 的判据之一），
    // 先检索会把这条行变成「刚用过」，让「不被归档」的断言失去意义。
    await expect(ttl.sweep()).resolves.toEqual({ expired: 0, purged: 0 });
    expect(statusOf(notes)).toBe('active');

    const hits = await createSearch(0).find('手放的笔记', {
      scopes: ['comem://user/alice/memories'],
      subject: 'user:alice',
      principals: PRINCIPALS,
    });
    expect(hits.map((hit) => hit.uri)).toContain(notes);
  });

  it('resources 不参与记忆 TTL（context_type 不是 memory）', async () => {
    const resource = 'comem://user/alice/resources/spec.md';
    await insertNode(resource, {
      parentUri: 'comem://user/alice/resources',
      contextType: 'resource',
      memoryType: null,
      updatedAt: daysAgo(3650),
    });

    await expect(ttl.sweep()).resolves.toEqual({ expired: 0, purged: 0 });

    expect(statusOf(resource)).toBe('active');
  });

  it('defaultDays = 0（默认）时一条都不归档，再老的记忆也留着', async () => {
    await insertNode(OLD, { memoryType: 'experiences', updatedAt: daysAgo(3650) });
    await insertNode(COLD, { memoryType: 'events', updatedAt: daysAgo(3650) });

    await expect(createTtl({ ttlDays: 0 }).sweep()).resolves.toEqual({ expired: 0, purged: 0 });

    expect(statusOf(OLD)).toBe('active');
    expect(statusOf(COLD)).toBe('active');
  });

  it('软过期：retentionDays=0 时节点行还在（不删除），只是 status 变了', async () => {
    await insertNode(OLD, { updatedAt: daysAgo(TTL_DAYS + 1) });

    await ttl.sweep();

    expect(nodes.get(OLD)).not.toBeNull();
    expect(nodes.get(OLD)?.status).toBe('archived');
  });

  it('归档时写 archived_at（= 清扫时刻），不动 updated_at', async () => {
    await insertNode(OLD, { updatedAt: daysAgo(TTL_DAYS + 1) });
    const beforeUpdated = db.prepare('SELECT updated_at FROM node WHERE uri = ?').get(OLD);

    await ttl.sweep();

    expect(archivedAtOf(OLD)).toBe(NOW.toISOString());
    expect(db.prepare('SELECT updated_at FROM node WHERE uri = ?').get(OLD)).toEqual(beforeUpdated);
  });

  it('不动 node_permission：归档节点仍要能按权限查到', async () => {
    await insertNode(OLD, { updatedAt: daysAgo(TTL_DAYS + 1) });
    db.prepare(
      'INSERT INTO node_permission (node_uri, principal, level) VALUES (?, ?, ?)',
    ).run(OLD, 'user:alice', 1);

    await ttl.sweep();

    const rows = db.prepare('SELECT principal, level FROM node_permission WHERE node_uri = ?').all(OLD);
    expect(rows).toEqual([{ principal: 'user:alice', level: 1 }]);
  });

  it('幂等：重复清扫不重复计数', async () => {
    await insertNode(OLD, { updatedAt: daysAgo(TTL_DAYS + 1) });

    await expect(ttl.sweep()).resolves.toEqual({ expired: 1, purged: 0 });
    await expect(ttl.sweep()).resolves.toEqual({ expired: 0, purged: 0 });
    await expect(ttl.sweep()).resolves.toEqual({ expired: 0, purged: 0 });
  });

  it('limit 是每轮上界：先清最久没用过的，剩下的下一轮再清', async () => {
    const uris = [0, 1, 2].map((index) => `comem://user/alice/memories/events/e${String(index)}.md`);
    for (const [index, uri] of uris.entries()) {
      // e0 最久没用（40 天），e2 最接近窗口边界（31 天）。
      await insertNode(uri, { memoryType: 'events', updatedAt: daysAgo(40 - index) });
    }

    await expect(ttl.sweep({ limit: 2 })).resolves.toEqual({ expired: 2, purged: 0 });
    expect(statusOf(uris[0] ?? '')).toBe('archived');
    expect(statusOf(uris[1] ?? '')).toBe('archived');
    expect(statusOf(uris[2] ?? '')).toBe('active');

    await expect(ttl.sweep({ limit: 2 })).resolves.toEqual({ expired: 1, purged: 0 });
  });
});

describe('sweep 第二段：归档超保留期物理删除', () => {
  it('归档超期的记忆被物理删除，文件也消失', async () => {
    await createMemoryFile(OLD);
    archiveDaysAgo(OLD, 40);
    await expect(fileExists(OLD)).resolves.toBe(true);

    const result = await createTtl({ ttlDays: TTL_DAYS, retentionDays: 30 }).sweep();

    expect(result.purged).toBe(1);
    expect(nodes.get(OLD)).toBeNull();
    await expect(fileExists(OLD)).resolves.toBe(false);
  });

  it('第一段关着（ttlDays=0）时第二段照常清理已归档的行', async () => {
    await createMemoryFile(OLD);
    archiveDaysAgo(OLD, 40);

    const result = await createTtl({ ttlDays: 0, retentionDays: 30 }).sweep();

    expect(result).toEqual({ expired: 0, purged: 1 });
    await expect(fileExists(OLD)).resolves.toBe(false);
  });

  it('未超保留期的不删（归档 10 天，保留 30 天）', async () => {
    await createMemoryFile(OLD);
    archiveDaysAgo(OLD, 10);

    const result = await createTtl({ ttlDays: TTL_DAYS, retentionDays: 30 }).sweep();

    expect(result.purged).toBe(0);
    expect(nodes.get(OLD)).not.toBeNull();
    await expect(fileExists(OLD)).resolves.toBe(true);
  });

  it('retentionDays=0 时永不删（归档再久也物理不动）', async () => {
    await createMemoryFile(OLD);
    archiveDaysAgo(OLD, 1000);

    const result = await createTtl({ ttlDays: TTL_DAYS, retentionDays: 0 }).sweep();

    expect(result.purged).toBe(0);
    expect(nodes.get(OLD)).not.toBeNull();
    await expect(fileExists(OLD)).resolves.toBe(true);
  });

  it('没有 archived_at 的旧 archived 行永不删（NULL 不当成「很久以前」）', async () => {
    await createMemoryFile(OLD);
    // status 是 archived，但 archived_at 是 NULL（迁移前的历史行）。
    db.prepare(`UPDATE node SET status = 'archived' WHERE uri = ?`).run(OLD);

    const result = await createTtl({ ttlDays: TTL_DAYS, retentionDays: 30 }).sweep();

    expect(result.purged).toBe(0);
    expect(nodes.get(OLD)).not.toBeNull();
    await expect(fileExists(OLD)).resolves.toBe(true);
  });

  it('只删叶子文档：目录节点不入选（即便它 archived 且超期）', async () => {
    // 目录行存在但磁盘上没有子项；它不该被删除逻辑盯上。
    await insertNode('comem://user/alice/memories/old', {
      kind: 'directory',
      memoryType: null,
      level: 'L0',
    });
    archiveDaysAgo('comem://user/alice/memories/old', 40);

    const result = await createTtl({ ttlDays: TTL_DAYS, retentionDays: 30 }).sweep();

    expect(result.purged).toBe(0);
    expect(nodes.get('comem://user/alice/memories/old')).not.toBeNull();
  });

  it('删除失败不打断整轮：一个 URI 删失败，其余照删', async () => {
    const A = `${PREFERENCES}/a.md`;
    const B = `${PREFERENCES}/b.md`;
    await createMemoryFile(A);
    await createMemoryFile(B);
    archiveDaysAgo(A, 40);
    archiveDaysAgo(B, 40);

    // 让第一个候选的删除抛错（URI 合法、但文件系统请求打空）。用 spy 只对一次失败。
    const original = filesystem.remove.bind(filesystem);
    let call = 0;
    vi.spyOn(filesystem, 'remove').mockImplementation(async (uri, principals) => {
      call += 1;
      if (call === 1) {
        throw new Error('模拟删除失败');
      }
      return original(uri, principals);
    });

    const result = await createTtl({ ttlDays: TTL_DAYS, retentionDays: 30 }).sweep();

    expect(result.purged).toBe(1);
    // 失败的那条仍在（下一轮重试），成功的没了。
    const survivors = [A, B].filter((uri) => nodes.get(uri) !== null);
    expect(survivors).toHaveLength(1);
    expect(logger.warn).toHaveBeenCalled();
  });

  it('保留期很短（< 7 天）时记 warning', async () => {
    await createMemoryFile(OLD);
    archiveDaysAgo(OLD, 3);

    await createTtl({ ttlDays: TTL_DAYS, retentionDays: 1 }).sweep();

    expect(logger.warn).toHaveBeenCalledWith(
      'TTL 保留期很短，归档记忆将在数天内被物理删除。',
      expect.objectContaining({ retentionDays: 1 }),
    );
  });

  it('归档节点重新变 active 后不再被删（例如复核通过）', async () => {
    await createMemoryFile(OLD);
    archiveDaysAgo(OLD, 40);
    db.prepare(`UPDATE node SET status = 'active' WHERE uri = ?`).run(OLD);

    const result = await createTtl({ ttlDays: TTL_DAYS, retentionDays: 30 }).sweep();

    expect(result.purged).toBe(0);
    await expect(fileExists(OLD)).resolves.toBe(true);
  });
});

/**
 * 版本快照（`.history`）与 TTL 的关系（架构文档 §11.11「版本文件与回退」）。
 *
 * 版本文件的 frontmatter 里 `status` 仍然是 `active`（设计如此：它是一条旧值，不是
 * 归档项），检索面靠 `valid_until` 把它滤掉。TTL 不看有效区间，所以这里要证明的是
 * 一件具体的事：**TTL 不能把版本文件当成一条过期记忆删掉**。删掉之后 `reject` 读到
 * 「`supersedes` 指向的文件不存在」，会静默退化成「删文件」，用户以为回到了上一次
 * 正确值。
 *
 * 这套装配照抄生产写路径：`MemoryService` 覆盖写 → `.history` 快照 →
 * `IndexObserver.onNodeWritten`（`bootstrap/container.ts` 的 `rawFilesystem.write`
 * 也是「写完字节 → `onNodeWritten`」）。版本文件的索引行由真实观察者建出来，不是
 * 测试手填的一行；否则测的只是「我在测试里拼的行会不会被删」。
 */
const VERSION_SCOPE = 'comem://user/alice';
const VERSION_CANONICAL = `${VERSION_SCOPE}/memories/preferences/code-style.md`;
const VERSION_DIRECTORY = `${VERSION_SCOPE}/memories/preferences/.history`;
/**
 * 注入给 TTL 的「现在」。
 *
 * 版本文件是**刚写出来的**（真实时钟），而 `NOW` 在它之前；要让它落在滑动窗口之外，
 * 只能把清扫时刻推到真实时刻之后一个窗口以上。`LATER` = 真实现在 + 60 天，
 * 大于 `TTL_DAYS`（30）。
 */
const LATER = new Date(Date.now() + 60 * MILLISECONDS_PER_DAY);

interface MemoryWorld {
  readonly dataDir: string;
  readonly db: DatabaseSync;
  readonly store: ContentStore;
  readonly nodes: NodeRepository;
  readonly observer: IndexObserver;
  readonly filesystem: FileSystemService;
  readonly memory: MemoryService;
  close(): Promise<void>;
}

async function createMemoryWorld(): Promise<MemoryWorld> {
  const dataDir = await mkdtemp(join(tmpdir(), 'comem-ttl-version-'));
  const db = openDatabase(':memory:');
  runMigrations(db);
  const worldLogger = createLogger();
  const store = new ContentStore({ dataDir, logger: worldLogger });
  const metadata = new MetadataFileStore({ dataDir, logger: worldLogger });
  const permissions = new PermissionRepository({ db, logger: worldLogger });
  const nodes = new NodeRepository({ db, logger: worldLogger });
  const index = new SqliteFtsIndex({ db, logger: worldLogger });
  const locks = createPathLockManager({ dataDir, logger: worldLogger, pollIntervalMs: 1 });
  const acl = new AclService({
    db,
    aclFile: new AclFileStore({ dataDir, logger: worldLogger }),
    permissions,
    nodes,
    logger: worldLogger,
    locks,
  });
  await acl.ensureRootPreset(Uri.parse(VERSION_SCOPE));
  const summary = new SummaryService({
    nodes,
    index,
    metadata,
    store,
    db,
    acl,
    generator: new RuleSummarizer(),
    logger: worldLogger,
    config: { abstractMaxChars: 256, overviewMaxChars: 4000 },
    locks,
  });
  const observer = new IndexObserver({
    store,
    index,
    acl,
    summary,
    nodes,
    permissions,
    logger: worldLogger,
    reconcile: new ReconcileLog({ dataDir, logger: worldLogger }),
  });
  const filesystem = new FileSystemService({
    store,
    locks,
    authorizer: new AllowAllAuthorizer(),
    logger: worldLogger,
    observers: [observer],
  });
  const memory = new MemoryService({
    locks,
    // 记忆文件的端口语义是「原样文档」：`writeBytes` 写字节，写完通知观察者建索引行
    // （与 `container.ts` 的 `rawFilesystem` 同一形状）。
    filesystem: {
      read: async (uri) => ({ text: Buffer.from(await store.readBytes(uri)).toString('utf8') }),
      write: async (uri, text) => {
        const stat = await store.writeBytes(uri, Uint8Array.from(Buffer.from(text, 'utf8')));
        await observer.onNodeWritten(uri, 'file');
        return stat;
      },
      stat: (uri) => store.stat(uri),
      remove: (uri) => store.remove(uri),
      list: (uri) => store.list(uri),
    },
    search: { find: async () => [] },
    logger: worldLogger,
  });
  return {
    dataDir,
    db,
    store,
    nodes,
    observer,
    filesystem,
    memory,
    close: async () => {
      await observer.drain();
      db.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

describe('版本文件（.history）不参与 TTL', () => {
  let world: MemoryWorld;

  beforeEach(async () => {
    world = await createMemoryWorld();
  });

  afterEach(async () => {
    await world.close();
  });

  /** 真实写路径：写一版、再覆盖一版，返回产生的版本文件 URI。 */
  async function overwriteOnce(): Promise<string> {
    await world.memory.upsertMemory(Uri.parse(VERSION_SCOPE), preferencesMemoryType, {
      topic: 'code-style',
      content: '第一版：用问号。',
    });
    await world.memory.upsertMemory(Uri.parse(VERSION_SCOPE), preferencesMemoryType, {
      topic: 'code-style',
      content: '第二版：用句号。',
    });
    await world.observer.drain();

    const versions = (await world.store.list(Uri.parse(VERSION_DIRECTORY))).filter(
      (entry) => entry.kind === 'file',
    );
    expect(versions).toHaveLength(1);
    const version = versions[0];
    expect(version).toBeDefined();
    return version?.uri.toString() ?? '';
  }

  function sweepTtl(options: {
    readonly ttlDays: number;
    readonly retentionDays: number;
    readonly now?: Date;
    readonly limit?: number;
  }) {
    return new TtlService({
      nodes: world.nodes,
      filesystem: world.filesystem,
      principals: PRINCIPALS,
      ttlDays: options.ttlDays,
      retentionDays: options.retentionDays,
      logger: createLogger(),
      now: () => options.now ?? LATER,
    }).sweep(options.limit === undefined ? {} : { limit: options.limit });
  }

  async function exists(uri: string): Promise<boolean> {
    return (await world.store.stat(Uri.parse(uri))) !== null;
  }

  function backdateArchivedAt(uri: string, days: number): void {
    world.db
      .prepare('UPDATE node SET archived_at = ? WHERE uri = ?')
      .run(new Date(LATER.getTime() - days * MILLISECONDS_PER_DAY).toISOString(), uri);
  }

  it('覆盖写产生的版本文件在索引里就是一条 active 记忆（TTL 会把它当普通记忆）', async () => {
    const version = await overwriteOnce();

    const row = world.nodes.get(version);
    expect(row).not.toBeNull();
    // 这两个字段决定了它会进入 `sweepExpired` 的候选集：context_type = memory、
    // memory_type 不在四类豁免里、status 仍是 active。`valid_until` 非空只影响检索面。
    expect(row?.contextType).toBe('memory');
    expect(row?.memoryType).toBe('preferences');
    expect(row?.status).toBe('active');
    // `valid_until` 是版本文件的标记：非空表示「已失效」，检索面按它滤掉。
    const validUntil = world.db
      .prepare('SELECT valid_until FROM node WHERE uri = ?')
      .get(version)?.['valid_until'];
    expect(validUntil).not.toBeNull();
  });

  it('TTL 到期不归档、也不物理删除版本文件；规范文件照常被删', async () => {
    const version = await overwriteOnce();

    // 第一段：版本文件与规范文件都超出滑动窗口。规范文件归档；版本文件原样留着。
    // 版本文件一旦被归档，`glob`（SQL 带 `status = 'active'`）就再也看不到它——
    // 而路径工具的契约是磁盘，它必须能看到版本文件。
    const first = await sweepTtl({ ttlDays: TTL_DAYS, retentionDays: TTL_DAYS });
    expect(first.expired).toBeGreaterThanOrEqual(1);
    expect(world.nodes.get(VERSION_CANONICAL)?.status).toBe('archived');
    expect(world.nodes.get(version)?.status).toBe('active');

    // 第二段：再过 40 天，规范文件的归档时长超过保留期。版本文件不在候选集里。
    const laterStill = new Date(LATER.getTime() + 40 * MILLISECONDS_PER_DAY);
    const second = await sweepTtl({
      ttlDays: 0,
      retentionDays: TTL_DAYS,
      now: laterStill,
    });
    expect(second.purged).toBeGreaterThanOrEqual(1);

    // 规范文件被物理删除——这证明清扫确实执行了删除动作，不是空转。
    await expect(exists(VERSION_CANONICAL)).resolves.toBe(false);
    // 版本文件还在：`reject` 还能把它写回规范 URI。
    await expect(exists(version)).resolves.toBe(true);
    expect(world.nodes.get(version)?.status).toBe('active');
  });

  it('存量库里已经被归档的版本文件不被清扫，也不堵住清扫队列', async () => {
    const version = await overwriteOnce();
    await world.memory.upsertMemory(Uri.parse(VERSION_SCOPE), preferencesMemoryType, {
      topic: 'notes',
      content: '另一条普通记忆。',
    });
    await world.observer.drain();
    const notes = `${VERSION_SCOPE}/memories/preferences/notes.md`;

    // 模拟「旧版本代码已经归档过版本文件」的存量库：两行都是 archived，版本文件的
    // 归档时刻更早（它排在 `ORDER BY archived_at ASC` 的前面）。
    const archiveRow = world.db.prepare(
      `UPDATE node SET status = 'archived', archived_at = ? WHERE uri = ?`,
    );
    archiveRow.run(new Date(LATER.getTime() - 100 * MILLISECONDS_PER_DAY).toISOString(), version);
    archiveRow.run(new Date(LATER.getTime() - 40 * MILLISECONDS_PER_DAY).toISOString(), notes);

    // `limit = 1`：如果版本文件行参与候选，它会一直占住每轮的唯一名额。
    const result = await sweepTtl({ ttlDays: 0, retentionDays: TTL_DAYS, limit: 1 });

    expect(result.purged).toBe(1);
    await expect(exists(notes)).resolves.toBe(false);
    await expect(exists(version)).resolves.toBe(true);
  });

  it('.history 目录节点自身不被第一段归档（reindex 会为它建一行目录）', async () => {
    const historyDirectory = Uri.parse(VERSION_DIRECTORY);
    await world.store.mkdir(historyDirectory, { recursive: true });
    // `pnpm reindex` 的 `walkDataDir` 会给磁盘上每个目录 upsert 一行：
    // `kind = 'directory'`、`context_type = 'memory'`、`memory_type = NULL`。
    // 这里用真实观察者建这一行，而不是手填 SQL。
    await world.observer.onNodeWritten(historyDirectory, 'directory');
    await world.observer.drain();

    const row = world.nodes.get(VERSION_DIRECTORY);
    expect(row?.kind).toBe('directory');
    expect(row?.memoryType).toBeNull();
    // 摘要失效会顺带给祖先目录建行；本用例只关心 `.history` 这一行，把其它候选
    // 删掉，`expired` 才能直接读作「目录节点自身有没有被归档」。
    world.db.prepare('DELETE FROM node WHERE uri <> ?').run(VERSION_DIRECTORY);

    const first = await sweepTtl({ ttlDays: TTL_DAYS, retentionDays: TTL_DAYS });
    // 目录行在窗口外（mkdtemp 的真实 mtime 早于 LATER - 30 天），若 SQL 只排除
    // `.history/*` 而漏掉目录节点自身，它会被标成 archived。
    expect(first.expired).toBe(0);
    expect(world.nodes.get(VERSION_DIRECTORY)?.status).toBe('active');
  });

  it('rules 镜像的 .history/{scenario}/ 行为不变：目录与版本文件都不归档、不删除', async () => {
    // `rules` 的 `{scenario}/{rule}.md` 在 `.history` 里镜像一层 scenario 目录。
    // 两个节点都要排除：scenario 目录（`memory_type = NULL`，不靠类型豁免）与它
    // 下面的版本文件。目录是这条用例的关键——它的 URI 在 `.history` 后面还有段，
    // 但比版本文件浅一层，钉住 GLOB 的 `*` 跨 `/` 这一点。
    const version = await overwriteOnce();
    const scenario = Uri.parse(`${VERSION_SCOPE}/memories/rules/.history/license-review`);
    await world.store.mkdir(scenario, { recursive: true });
    const ruleVersion = scenario.child('must-locate-license.md--20261110T022746123Z.md');
    await world.store.writeBytes(
      ruleVersion,
      Uint8Array.from(
        Buffer.from(
          [
            '---',
            'memory_type: rules',
            'status: active',
            'created_at: 2026-11-01T00:00:00.000Z',
            'updated_at: 2026-11-01T00:00:00.000Z',
            `uri: ${ruleVersion.toString()}`,
            'scenario: license-review',
            'rule: must-locate-license',
            '---',
            '',
            '## content',
            '',
            '旧规则值。',
          ].join('\n'),
          'utf8',
        ),
      ),
    );
    await world.observer.onNodeWritten(scenario, 'directory');
    await world.observer.onNodeWritten(ruleVersion, 'file');
    await world.observer.drain();

    // 规范文件在窗口外会被归档，证明清扫确实在跑；三个 `.history` 节点保持 active。
    const first = await sweepTtl({ ttlDays: TTL_DAYS, retentionDays: TTL_DAYS });
    expect(first.expired).toBeGreaterThanOrEqual(1);
    expect(world.nodes.get(VERSION_CANONICAL)?.status).toBe('archived');
    expect(world.nodes.get(version)?.status).toBe('active');
    expect(world.nodes.get(scenario.toString())?.status).toBe('active');
    expect(world.nodes.get(ruleVersion.toString())?.status).toBe('active');

    // 第二段也不物理删除（归档超期是相对 `archived_at` 算的）。
    const laterStill = new Date(LATER.getTime() + 40 * MILLISECONDS_PER_DAY);
    const second = await sweepTtl({ ttlDays: 0, retentionDays: TTL_DAYS, now: laterStill });
    expect(second.purged).toBeGreaterThanOrEqual(1);
    await expect(exists(version)).resolves.toBe(true);
    await expect(exists(ruleVersion.toString())).resolves.toBe(true);
  });

  it('文件名是 .history.md 的普通记忆照常过期删除（豁免按路径段，不看子串）', async () => {
    await world.memory.upsertMemory(Uri.parse(VERSION_SCOPE), preferencesMemoryType, {
      topic: '.history',
      content: '这条记忆的 identity 恰好叫 .history。',
    });
    await world.observer.drain();
    const ordinary = `${VERSION_SCOPE}/memories/preferences/.history.md`;
    expect(world.nodes.get(ordinary)).not.toBeNull();

    // `ttlDays = 1`：写出来的时刻（真实时钟）已经早于 LATER - 1 天，不用等更新时刻
    // 变旧就能观测「它照常过期」。
    const first = await sweepTtl({ ttlDays: 1, retentionDays: TTL_DAYS });
    expect(first.expired).toBeGreaterThanOrEqual(1);
    expect(world.nodes.get(ordinary)?.status).toBe('archived');

    backdateArchivedAt(ordinary, 40);
    const second = await sweepTtl({ ttlDays: 0, retentionDays: TTL_DAYS });
    expect(second.purged).toBeGreaterThanOrEqual(1);
    await expect(exists(ordinary)).resolves.toBe(false);
  });
});
