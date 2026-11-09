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

import { openDatabase, runMigrations } from '../../../src/adapters/sqlite/database.js';
import { NodeRepository, type NodeRow } from '../../../src/adapters/sqlite/node-repository.js';
import { SqliteFtsIndex } from '../../../src/adapters/sqlite/retrieval-index.js';
import { ContentStore } from '../../../src/adapters/fs/content-store.js';
import { createPathLockManager } from '../../../src/adapters/fs/lock.js';
import type { Logger } from '../../../src/domain/log.js';
import { Uri } from '../../../src/domain/uri.js';
import { AllowAllAuthorizer } from '../../../src/services/authorizer.js';
import { FileSystemService, type NodeWriteObserver } from '../../../src/services/filesystem.js';
import { TtlService } from '../../../src/services/ttl.js';

const NOW = new Date('2026-11-08T00:00:00.000Z');

/** 一天，与 `TtlService` 的换算同一份来源。 */
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

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
let fts: SqliteFtsIndex;
let filesystem: FileSystemService;
let ttl: TtlService;

function createLogger(): Logger {
  const mock: Logger = {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => mock,
  };
  return mock;
}

/** 写入一行节点。过期判据由 `updated_at` / `last_accessed_at` 决定，不存绝对时刻。 */
function insertNode(uri: string, overrides: Partial<NodeRow> = {}): void {
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
  nodes.upsert([row]);
}

/** 在磁盘上写一个真实文件并给它建索引行，模拟一条「被 TTL 管理的记忆」。 */
async function createMemoryFile(uri: string): Promise<void> {
  const parsed = Uri.parse(uri);
  await store.writeBytes(parsed, Uint8Array.from(Buffer.from('# 记忆正文\n', 'utf8')));
  insertNode(uri);
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
    authorizer: new AllowAllAuthorizer(),
    logger,
    observers: [indexCleanup],
  });
  ttl = createTtl({ ttlDays: TTL_DAYS });
});

afterEach(async () => {
  db.close();
  await rm(dataDir, { recursive: true, force: true });
});

describe('sweep 第一段：滑动窗口归档', () => {
  it('从未被访问过的记忆：按 updated_at 起算，超出窗口归档', async () => {
    insertNode(OLD, { updatedAt: daysAgo(TTL_DAYS + 1) });
    insertNode(FRESH, { updatedAt: daysAgo(TTL_DAYS - 1) });

    await expect(ttl.sweep()).resolves.toEqual({ expired: 1, purged: 0 });

    expect(statusOf(OLD)).toBe('archived');
    expect(statusOf(FRESH)).toBe('active');
  });

  it('窗口内被访问过：不归档（两条写入时间相同，只有被访问的那条活下来）', async () => {
    insertNode(OLD, { updatedAt: daysAgo(100) });
    insertNode(COLD, { updatedAt: daysAgo(100) });
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

  it('访问时刻早于内容更新时间：从内容更新时间起算（取最大值，不是「有访问就用访问」）', async () => {
    insertNode(FRESH, { updatedAt: daysAgo(2) });
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
      insertNode(uri, { memoryType, updatedAt: daysAgo(3650) });
    }

    await expect(ttl.sweep()).resolves.toEqual({ expired: 0, purged: 0 });

    for (const uri of Object.values(uris)) {
      expect(statusOf(uri)).toBe('active');
    }
  });

  it('events 在同样条件下会归档（豁免只覆盖四类稳定身份与约束）', async () => {
    const event = 'comem://user/alice/memories/events/2025-01-01-decision.md';
    insertNode(event, { memoryType: 'events', level: 'L2', updatedAt: daysAgo(3650) });

    await expect(ttl.sweep()).resolves.toEqual({ expired: 1, purged: 0 });

    expect(statusOf(event)).toBe('archived');
  });

  it('memory_type 为 NULL 的记忆行按普通记忆处理（豁免名单只认那四类）', async () => {
    insertNode(OLD, { memoryType: null, updatedAt: daysAgo(3650) });

    await expect(ttl.sweep()).resolves.toEqual({ expired: 1, purged: 0 });

    expect(statusOf(OLD)).toBe('archived');
  });

  it('resources 不参与记忆 TTL（context_type 不是 memory）', async () => {
    const resource = 'comem://user/alice/resources/spec.md';
    insertNode(resource, {
      parentUri: 'comem://user/alice/resources',
      contextType: 'resource',
      memoryType: null,
      updatedAt: daysAgo(3650),
    });

    await expect(ttl.sweep()).resolves.toEqual({ expired: 0, purged: 0 });

    expect(statusOf(resource)).toBe('active');
  });

  it('defaultDays = 0（默认）时一条都不归档，再老的记忆也留着', async () => {
    insertNode(OLD, { memoryType: 'experiences', updatedAt: daysAgo(3650) });
    insertNode(COLD, { memoryType: 'events', updatedAt: daysAgo(3650) });

    await expect(createTtl({ ttlDays: 0 }).sweep()).resolves.toEqual({ expired: 0, purged: 0 });

    expect(statusOf(OLD)).toBe('active');
    expect(statusOf(COLD)).toBe('active');
  });

  it('软过期：retentionDays=0 时节点行还在（不删除），只是 status 变了', async () => {
    insertNode(OLD, { updatedAt: daysAgo(TTL_DAYS + 1) });

    await ttl.sweep();

    expect(nodes.get(OLD)).not.toBeNull();
    expect(nodes.get(OLD)?.status).toBe('archived');
  });

  it('归档时写 archived_at（= 清扫时刻），不动 updated_at', async () => {
    insertNode(OLD, { updatedAt: daysAgo(TTL_DAYS + 1) });
    const beforeUpdated = db.prepare('SELECT updated_at FROM node WHERE uri = ?').get(OLD);

    await ttl.sweep();

    expect(archivedAtOf(OLD)).toBe(NOW.toISOString());
    expect(db.prepare('SELECT updated_at FROM node WHERE uri = ?').get(OLD)).toEqual(beforeUpdated);
  });

  it('不动 node_permission：归档节点仍要能按权限查到', async () => {
    insertNode(OLD, { updatedAt: daysAgo(TTL_DAYS + 1) });
    db.prepare(
      'INSERT INTO node_permission (node_uri, principal, level) VALUES (?, ?, ?)',
    ).run(OLD, 'user:alice', 1);

    await ttl.sweep();

    const rows = db.prepare('SELECT principal, level FROM node_permission WHERE node_uri = ?').all(OLD);
    expect(rows).toEqual([{ principal: 'user:alice', level: 1 }]);
  });

  it('幂等：重复清扫不重复计数', async () => {
    insertNode(OLD, { updatedAt: daysAgo(TTL_DAYS + 1) });

    await expect(ttl.sweep()).resolves.toEqual({ expired: 1, purged: 0 });
    await expect(ttl.sweep()).resolves.toEqual({ expired: 0, purged: 0 });
    await expect(ttl.sweep()).resolves.toEqual({ expired: 0, purged: 0 });
  });

  it('limit 是每轮上界：先清最久没用过的，剩下的下一轮再清', async () => {
    const uris = [0, 1, 2].map((index) => `comem://user/alice/memories/events/e${String(index)}.md`);
    for (const [index, uri] of uris.entries()) {
      // e0 最久没用（40 天），e2 最接近窗口边界（31 天）。
      insertNode(uri, { memoryType: 'events', updatedAt: daysAgo(40 - index) });
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
    insertNode('comem://user/alice/memories/old', {
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
