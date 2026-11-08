/**
 * 记忆 TTL 的验收（架构文档 §11.7）。
 *
 * 用真实 SQLite（`:memory:`）与真实的 `NodeRepository` / `SqliteFtsIndex` /
 * `ContentStore` / `FileSystemService`：这一层的价值全在 SQL 与文件删除上（部分索引、
 * `status <> 'archived'` 的幂等、不碰 `updated_at`、两段式物理删除），用替身测等于
 * 测替身。
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { openDatabase, runMigrations } from '../../../src/adapters/sqlite/database.js';
import { NodeRepository } from '../../../src/adapters/sqlite/node-repository.js';
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

const EXPIRED = 'comem://user/alice/memories/preferences/expired.md';
const FRESH = 'comem://user/alice/memories/preferences/fresh.md';
const NEVER = 'comem://user/alice/memories/preferences/never.md';

/** 系统动作求权用的主体集合（`AllowAllAuthorizer` 下无所谓，接口要它）。 */
const PRINCIPALS = ['user:alice', 'user:*'];

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

/** 写入一行节点（`expires_at` 由 `setExpiry` 单独设，这里不碰）。 */
function insertNode(uri: string, overrides: Record<string, unknown> = {}): void {
  const row = {
    uri,
    parentUri: 'comem://user/alice/memories/preferences',
    scope: 'user' as const,
    kind: 'document' as const,
    contextType: 'memory' as const,
    memoryType: 'preferences',
    level: 'L2' as const,
    abstract: null,
    bodyDigest: 'digest',
    size: 10,
    updatedAt: '2026-01-01T00:00:00.000Z',
    status: 'active' as const,
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

function expiryOf(uri: string): string | null {
  const row = db.prepare('SELECT expires_at FROM node WHERE uri = ?').get(uri);
  const value = row?.['expires_at'];
  return value === null || value === undefined ? null : String(value);
}

function archivedAtOf(uri: string): string | null {
  const row = db.prepare('SELECT archived_at FROM node WHERE uri = ?').get(uri);
  const value = row?.['archived_at'];
  return value === null || value === undefined ? null : String(value);
}

function statusOf(uri: string): string {
  return String(db.prepare('SELECT status FROM node WHERE uri = ?').get(uri)?.['status']);
}

async function fileExists(uri: string): Promise<boolean> {
  return (await store.stat(Uri.parse(uri))) !== null;
}

/** 归档一条记忆并把它「据称已经归档了若干天」——用于第二段（物理删除）的测试。 */
function archiveDaysAgo(uri: string, days: number): void {
  db.prepare(`UPDATE node SET status = 'archived', archived_at = ? WHERE uri = ?`).run(
    new Date(NOW.getTime() - days * MILLISECONDS_PER_DAY).toISOString(),
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
  ttl = new TtlService({ nodes, filesystem, principals: PRINCIPALS, retentionDays: 0, logger, now: () => NOW });
});

afterEach(async () => {
  db.close();
  await rm(dataDir, { recursive: true, force: true });
});

describe('setExpiry', () => {
  it('设置绝对时间并返回实际命中的行数', async () => {
    insertNode(EXPIRED);
    insertNode(FRESH);

    const updated = await ttl.setExpiry([EXPIRED, FRESH], new Date('2026-12-01T00:00:00.000Z'));

    expect(updated).toBe(2);
    expect(expiryOf(EXPIRED)).toBe('2026-12-01T00:00:00.000Z');
    expect(expiryOf(FRESH)).toBe('2026-12-01T00:00:00.000Z');
  });

  it('null 是显式取消过期（写回 NULL，不是哨兵时间）', async () => {
    insertNode(EXPIRED);
    await ttl.setExpiry([EXPIRED], new Date('2026-12-01T00:00:00.000Z'));

    const updated = await ttl.setExpiry([EXPIRED], null);

    expect(updated).toBe(1);
    expect(expiryOf(EXPIRED)).toBeNull();
  });

  it('不存在的 URI 静默跳过（索引与磁盘不同步是正常状态）', async () => {
    insertNode(EXPIRED);

    await expect(
      ttl.setExpiry([EXPIRED, 'comem://user/alice/memories/nope.md'], null),
    ).resolves.toBe(1);
  });

  it('空数组不产生一次写事务', async () => {
    await expect(ttl.setExpiry([], new Date())).resolves.toBe(0);
  });

  it('非法 Date 抛 INVALID_ARGUMENT，不写坏列', async () => {
    insertNode(EXPIRED);

    await expect(ttl.setExpiry([EXPIRED], new Date('not-a-date'))).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
    expect(expiryOf(EXPIRED)).toBeNull();
  });

  it('不动 updated_at（设置过期时间不是内容修改）', async () => {
    insertNode(EXPIRED);
    const before = db.prepare('SELECT updated_at FROM node WHERE uri = ?').get(EXPIRED);

    await ttl.setExpiry([EXPIRED], new Date('2026-12-01T00:00:00.000Z'));

    expect(db.prepare('SELECT updated_at FROM node WHERE uri = ?').get(EXPIRED)).toEqual(before);
  });
});

describe('sweep 第一段：归档', () => {
  it('只归档 expires_at < now 的节点，未到期与永不过期的不动', async () => {
    insertNode(EXPIRED);
    insertNode(FRESH);
    insertNode(NEVER);
    await ttl.setExpiry([EXPIRED], new Date('2026-11-07T00:00:00.000Z'));
    await ttl.setExpiry([FRESH], new Date('2026-11-09T00:00:00.000Z'));

    const result = await ttl.sweep();

    expect(result.expired).toBe(1);
    expect(statusOf(EXPIRED)).toBe('archived');
    expect(statusOf(FRESH)).toBe('active');
    expect(statusOf(NEVER)).toBe('active');
    expect(expiryOf(NEVER)).toBeNull();
  });

  it('软过期：retentionDays=0 时节点行还在（不删除），只是 status 变了', async () => {
    insertNode(EXPIRED);
    await ttl.setExpiry([EXPIRED], new Date('2026-11-07T00:00:00.000Z'));

    await ttl.sweep();

    expect(nodes.get(EXPIRED)).not.toBeNull();
    expect(nodes.get(EXPIRED)?.status).toBe('archived');
  });

  it('归档时写 archived_at（= now），不动 updated_at', async () => {
    insertNode(EXPIRED);
    await ttl.setExpiry([EXPIRED], new Date('2026-11-07T00:00:00.000Z'));
    const beforeUpdated = db.prepare('SELECT updated_at FROM node WHERE uri = ?').get(EXPIRED);

    await ttl.sweep();

    expect(archivedAtOf(EXPIRED)).toBe(NOW.toISOString());
    expect(db.prepare('SELECT updated_at FROM node WHERE uri = ?').get(EXPIRED)).toEqual(beforeUpdated);
  });

  it('不动 node_permission：归档节点仍要能按权限查到', async () => {
    insertNode(EXPIRED);
    db.prepare(
      'INSERT INTO node_permission (node_uri, principal, level) VALUES (?, ?, ?)',
    ).run(EXPIRED, 'user:alice', 1);
    await ttl.setExpiry([EXPIRED], new Date('2026-11-07T00:00:00.000Z'));

    await ttl.sweep();

    const rows = db.prepare('SELECT principal, level FROM node_permission WHERE node_uri = ?').all(EXPIRED);
    expect(rows).toEqual([{ principal: 'user:alice', level: 1 }]);
  });

  it('幂等：重复清扫不重复计数', async () => {
    insertNode(EXPIRED);
    await ttl.setExpiry([EXPIRED], new Date('2026-11-07T00:00:00.000Z'));

    await expect(ttl.sweep()).resolves.toEqual({ expired: 1, purged: 0 });
    await expect(ttl.sweep()).resolves.toEqual({ expired: 0, purged: 0 });
    await expect(ttl.sweep()).resolves.toEqual({ expired: 0, purged: 0 });
  });

  it('limit 是每轮上界：先清最老的，剩下的下一轮再清', async () => {
    const uris = [0, 1, 2].map((index) => `comem://user/alice/memories/events/e${String(index)}.md`);
    for (const [index, uri] of uris.entries()) {
      insertNode(uri, { contextType: 'memory', memoryType: 'events', level: 'L1' });
      // 越靠前的越老。
      await ttl.setExpiry([uri], new Date(`2026-11-0${String(index + 1)}T00:00:00.000Z`));
    }

    await expect(ttl.sweep({ limit: 2 })).resolves.toEqual({ expired: 2, purged: 0 });
    expect(statusOf(uris[0] ?? '')).toBe('archived');
    expect(statusOf(uris[1] ?? '')).toBe('archived');
    expect(statusOf(uris[2] ?? '')).toBe('active');

    await expect(ttl.sweep({ limit: 2 })).resolves.toEqual({ expired: 1, purged: 0 });
  });

  it('清扫查询走 idx_node_expires（部分索引）', () => {
    const plan = db
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT uri FROM node
          WHERE expires_at IS NOT NULL AND expires_at < ? AND status <> 'archived'
          ORDER BY expires_at ASC
          LIMIT ?`,
      )
      .all(NOW.toISOString(), 100);

    const detail = plan.map((row) => String(row['detail'])).join('\n');
    expect(detail).toContain('idx_node_expires');
  });
});

describe('sweep 第二段：归档超保留期物理删除', () => {
  function withRetention(days: number): TtlService {
    return new TtlService({ nodes, filesystem, principals: PRINCIPALS, retentionDays: days, logger, now: () => NOW });
  }

  it('归档超期的记忆被物理删除，文件也消失', async () => {
    await createMemoryFile(EXPIRED);
    archiveDaysAgo(EXPIRED, 40);
    await expect(fileExists(EXPIRED)).resolves.toBe(true);

    const result = await withRetention(30).sweep();

    expect(result.purged).toBe(1);
    expect(nodes.get(EXPIRED)).toBeNull();
    await expect(fileExists(EXPIRED)).resolves.toBe(false);
  });

  it('未超保留期的不删（归档 10 天，保留 30 天）', async () => {
    await createMemoryFile(EXPIRED);
    archiveDaysAgo(EXPIRED, 10);

    const result = await withRetention(30).sweep();

    expect(result.purged).toBe(0);
    expect(nodes.get(EXPIRED)).not.toBeNull();
    await expect(fileExists(EXPIRED)).resolves.toBe(true);
  });

  it('retentionDays=0 时永不删（归档再久也物理不动）', async () => {
    await createMemoryFile(EXPIRED);
    archiveDaysAgo(EXPIRED, 1000);

    const result = await withRetention(0).sweep();

    expect(result.purged).toBe(0);
    expect(nodes.get(EXPIRED)).not.toBeNull();
    await expect(fileExists(EXPIRED)).resolves.toBe(true);
  });

  it('没有 archived_at 的旧 archived 行永不删（NULL 不当成「很久以前」）', async () => {
    await createMemoryFile(EXPIRED);
    // status 是 archived，但 archived_at 是 NULL（迁移前的历史行）。
    db.prepare(`UPDATE node SET status = 'archived' WHERE uri = ?`).run(EXPIRED);

    const result = await withRetention(30).sweep();

    expect(result.purged).toBe(0);
    expect(nodes.get(EXPIRED)).not.toBeNull();
    await expect(fileExists(EXPIRED)).resolves.toBe(true);
  });

  it('只删叶子文档：目录节点不入选（即便它 archived 且超期）', async () => {
    // 目录行存在但磁盘上没有子项；它不该被删除逻辑盯上。
    insertNode('comem://user/alice/memories/old', {
      kind: 'directory',
      contextType: 'memory',
      memoryType: null,
      level: 'L0',
    });
    archiveDaysAgo('comem://user/alice/memories/old', 40);

    const result = await withRetention(30).sweep();

    expect(result.purged).toBe(0);
    expect(nodes.get('comem://user/alice/memories/old')).not.toBeNull();
  });

  it('删除失败不打断整轮：一个 URI 删失败，其余照删', async () => {
    const A = 'comem://user/alice/memories/preferences/a.md';
    const B = 'comem://user/alice/memories/preferences/b.md';
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

    const result = await withRetention(30).sweep();

    expect(result.purged).toBe(1);
    // 失败的那条仍在（下一轮重试），成功的没了。
    const survivors = [A, B].filter((uri) => nodes.get(uri) !== null);
    expect(survivors).toHaveLength(1);
    expect(logger.warn).toHaveBeenCalled();
  });

  it('保留期很短（< 7 天）时记 warning', async () => {
    await createMemoryFile(EXPIRED);
    archiveDaysAgo(EXPIRED, 3);

    await withRetention(1).sweep();

    expect(logger.warn).toHaveBeenCalledWith(
      'TTL 保留期很短，归档记忆将在数天内被物理删除。',
      expect.objectContaining({ retentionDays: 1 }),
    );
  });

  it('归档节点重新变 active 后不再被删（例如复核通过）', async () => {
    await createMemoryFile(EXPIRED);
    archiveDaysAgo(EXPIRED, 40);
    db.prepare(`UPDATE node SET status = 'active' WHERE uri = ?`).run(EXPIRED);

    const result = await withRetention(30).sweep();

    expect(result.purged).toBe(0);
    await expect(fileExists(EXPIRED)).resolves.toBe(true);
  });
});

describe('memory.ttl.defaultDays 在写入时算成绝对时刻', () => {
  function index(defaultTtlDays: number): SqliteFtsIndex {
    return new SqliteFtsIndex({ db, logger, defaultTtlDays });
  }

  function record(uri: string, contextType: 'memory' | 'resource'): Parameters<SqliteFtsIndex['upsert']>[0][number] {
    return {
      uri,
      parentUri: 'comem://user/alice/memories',
      scope: 'user',
      kind: 'document',
      contextType,
      memoryType: contextType === 'memory' ? 'preferences' : null,
      level: 'L2',
      abstract: null,
      content: '正文',
      bodyDigest: 'digest',
      size: 10,
      // 基准是写入时间（`updated_at`），不是 `new Date()`：同一份文件重建索引得到
      // 同一个过期时刻。
      updatedAt: NOW.toISOString(),
      status: 'active',
    };
  }

  it('defaultDays > 0 时记忆行拿到 updated_at + defaultDays', async () => {
    await index(30).upsert([record(EXPIRED, 'memory')]);

    expect(expiryOf(EXPIRED)).toBe(new Date(NOW.getTime() + 30 * MILLISECONDS_PER_DAY).toISOString());
  });

  it('defaultDays = 0（默认）时是 NULL：永不过期', async () => {
    await index(0).upsert([record(NEVER, 'memory')]);

    expect(expiryOf(NEVER)).toBeNull();
  });

  it('只对 memory 生效：resources 不会被套上记忆的存活时间', async () => {
    const resource = 'comem://user/alice/resources/spec.md';
    await index(30).upsert([record(resource, 'resource')]);

    expect(expiryOf(resource)).toBeNull();
  });

  it('内容重写不清掉显式设置的过期时间（ON CONFLICT 不更新 expires_at）', async () => {
    await index(30).upsert([record(EXPIRED, 'memory')]);
    await ttl.setExpiry([EXPIRED], null);

    await index(30).upsert([record(EXPIRED, 'memory')]);

    expect(expiryOf(EXPIRED)).toBeNull();
  });
});
