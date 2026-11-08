/**
 * 记忆 TTL 的验收（架构文档 §11.7、`0010_ttl.sql`）。
 *
 * 用真实 SQLite（`:memory:`）与真实的 `NodeRepository` / `SqliteFtsIndex`：这一层
 * 的价值全在 SQL 上（部分索引、`status <> 'archived'` 的幂等、不碰 `updated_at`），
 * 用替身测等于测替身。
 */

import type { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { openDatabase, runMigrations } from '../../../src/adapters/sqlite/database.js';
import { NodeRepository } from '../../../src/adapters/sqlite/node-repository.js';
import { SqliteFtsIndex } from '../../../src/adapters/sqlite/retrieval-index.js';
import type { Logger } from '../../../src/domain/log.js';
import { TtlService } from '../../../src/services/ttl.js';

const NOW = new Date('2026-11-08T00:00:00.000Z');

/** 一天，与 `TtlService` / `retrieval-index` 的换算同一份来源。 */
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

const EXPIRED = 'comem://user/alice/memories/preferences/expired.md';
const FRESH = 'comem://user/alice/memories/preferences/fresh.md';
const NEVER = 'comem://user/alice/memories/preferences/never.md';

let db: DatabaseSync;
let logger: Logger;
let nodes: NodeRepository;
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

function expiryOf(uri: string): string | null {
  const row = db.prepare('SELECT expires_at FROM node WHERE uri = ?').get(uri);
  const value = row?.['expires_at'];
  return value === null || value === undefined ? null : String(value);
}

function statusOf(uri: string): string {
  return String(db.prepare('SELECT status FROM node WHERE uri = ?').get(uri)?.['status']);
}

beforeEach(() => {
  db = openDatabase(':memory:');
  runMigrations(db);
  logger = createLogger();
  nodes = new NodeRepository({ db, logger });
  ttl = new TtlService({ nodes, logger, now: () => NOW });
});

afterEach(() => {
  db.close();
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

describe('sweep', () => {
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

  it('软过期：节点行还在（不删除），只是 status 变了', async () => {
    insertNode(EXPIRED);
    await ttl.setExpiry([EXPIRED], new Date('2026-11-07T00:00:00.000Z'));

    await ttl.sweep();

    expect(nodes.get(EXPIRED)).not.toBeNull();
    expect(nodes.get(EXPIRED)?.status).toBe('archived');
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

    await expect(ttl.sweep()).resolves.toEqual({ expired: 1 });
    await expect(ttl.sweep()).resolves.toEqual({ expired: 0 });
    await expect(ttl.sweep()).resolves.toEqual({ expired: 0 });
  });

  it('limit 是每轮上界：先清最老的，剩下的下一轮再清', async () => {
    const uris = [0, 1, 2].map((index) => `comem://user/alice/memories/events/e${String(index)}.md`);
    for (const [index, uri] of uris.entries()) {
      insertNode(uri, { contextType: 'memory', memoryType: 'events', level: 'L1' });
      // 越靠前的越老。
      await ttl.setExpiry([uri], new Date(`2026-11-0${String(index + 1)}T00:00:00.000Z`));
    }

    await expect(ttl.sweep({ limit: 2 })).resolves.toEqual({ expired: 2 });
    expect(statusOf(uris[0] ?? '')).toBe('archived');
    expect(statusOf(uris[1] ?? '')).toBe('archived');
    expect(statusOf(uris[2] ?? '')).toBe('active');

    await expect(ttl.sweep({ limit: 2 })).resolves.toEqual({ expired: 1 });
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
