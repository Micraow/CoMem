import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  currentVersion,
  openDatabase,
  runMigrations,
  withWriteTransaction,
} from '../../../src/adapters/sqlite/database.js';

/**
 * 迁移目录里的最大版本号。
 *
 * **不要写成字面量。** 每加一个迁移，写死的数字就会红一次——那不是回归，是测试在
 * 替我们数文件。这里扫目录，断言的是「迁移框架应用到了最新的那个版本」。
 */
const LATEST_VERSION = Math.max(
  ...readdirSync(new URL('../../../src/adapters/sqlite/migrations', import.meta.url))
    .map((name) => /^(\d{4})_/.exec(name)?.[1])
    .filter((version): version is string => version !== undefined)
    .map(Number),
);

let tempDir: string;
let openDatabases: DatabaseSync[];

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'comem-sqlite-'));
  openDatabases = [];
});

afterEach(() => {
  for (const db of openDatabases) {
    db.close();
  }
  rmSync(tempDir, { recursive: true, force: true });
});

function open(file: string): DatabaseSync {
  const db = openDatabase(file);
  openDatabases.push(db);
  return db;
}

function tableNames(db: DatabaseSync): string[] {
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all();
  return rows.map((row) => String(row['name']));
}

describe('openDatabase', () => {
  it('内存库可用，PRAGMA 不因内存库报错', () => {
    const db = open(':memory:');

    expect(db.prepare('SELECT 1 AS ok').get()).toMatchObject({ ok: 1 });
  });

  it('真实文件：开启 WAL 与 busy_timeout，外键打开', () => {
    const file = join(tempDir, 'comem.sqlite');
    const db = open(file);

    expect(db.prepare('PRAGMA journal_mode').get()).toMatchObject({ journal_mode: 'wal' });
    expect(db.prepare('PRAGMA busy_timeout').get()).toMatchObject({ timeout: 5000 });
    expect(db.prepare('PRAGMA foreign_keys').get()).toMatchObject({ foreign_keys: 1 });
  });

  it('只读连接可以读，不能写', () => {
    const file = join(tempDir, 'readonly.sqlite');
    const writer = open(file);
    writer.exec('CREATE TABLE sample (id INTEGER PRIMARY KEY)');

    const reader = openDatabase(file, { readonly: true });
    openDatabases.push(reader);

    expect(reader.prepare('SELECT COUNT(*) AS total FROM sample').get()).toMatchObject({ total: 0 });
    expect(() => reader.exec('CREATE TABLE other (id INTEGER)')).toThrow();
  });
});

describe('runMigrations', () => {
  it('首次应用返回最新版本号，并建立 schema_version 表', () => {
    const db = open(':memory:');

    expect(currentVersion(db)).toBe(0);
    expect(runMigrations(db)).toBe(LATEST_VERSION);
    expect(currentVersion(db)).toBe(LATEST_VERSION);
    expect(tableNames(db)).toContain('schema_version');
  });

  it('幂等：重复运行不新增版本记录', () => {
    const db = open(':memory:');

    runMigrations(db);
    runMigrations(db);
    runMigrations(db);

    expect(currentVersion(db)).toBe(LATEST_VERSION);
    expect(db.prepare('SELECT COUNT(*) AS total FROM schema_version').get()).toMatchObject({
      total: LATEST_VERSION,
    });
  });

  it('0002 建索引与检索的业务表', () => {
    const db = open(':memory:');

    runMigrations(db);

    expect(tableNames(db)).toEqual(
      expect.arrayContaining([
        'schema_version',
        'node',
        'node_fts',
        'node_permission',
        'acl_entry',
        'task',
      ]),
    );
  });

  it('记录应用时间', () => {
    const db = open(':memory:');

    runMigrations(db);

    const row = db.prepare('SELECT applied_at FROM schema_version WHERE version = 1').get();
    expect(typeof row?.['applied_at']).toBe('string');
    expect(new Date(String(row?.['applied_at'])).toString()).not.toBe('Invalid Date');
  });

  it('文件库同样生效', () => {
    const file = join(tempDir, 'migrated.sqlite');
    expect(runMigrations(open(file))).toBe(LATEST_VERSION);

    const reopened = open(file);
    expect(currentVersion(reopened)).toBe(LATEST_VERSION);
    expect(runMigrations(reopened)).toBe(LATEST_VERSION);
  });
});

describe('withWriteTransaction', () => {
  it('提交后数据可见，并返回回调结果', () => {
    const db = open(':memory:');
    db.exec('CREATE TABLE sample (id INTEGER PRIMARY KEY, name TEXT NOT NULL)');

    const result = withWriteTransaction(db, () => {
      db.prepare('INSERT INTO sample (id, name) VALUES (?, ?)').run(1, 'alice');
      return 'done';
    });

    expect(result).toBe('done');
    expect(db.prepare('SELECT name FROM sample WHERE id = 1').get()).toMatchObject({ name: 'alice' });
  });

  it('回调抛错时回滚全部写入', () => {
    const db = open(':memory:');
    db.exec('CREATE TABLE sample (id INTEGER PRIMARY KEY, name TEXT NOT NULL)');

    expect(() =>
      withWriteTransaction(db, () => {
        db.prepare('INSERT INTO sample (id, name) VALUES (?, ?)').run(1, 'alice');
        throw new Error('boom');
      }),
    ).toThrow('boom');

    expect(db.prepare('SELECT COUNT(*) AS total FROM sample').get()).toMatchObject({ total: 0 });
    expect(db.isTransaction).toBe(false);
  });

  it('嵌套调用复用外层事务：内层不 BEGIN，也不提前 COMMIT', () => {
    const db = open(':memory:');
    db.exec('CREATE TABLE sample (id INTEGER PRIMARY KEY)');

    withWriteTransaction(db, () => {
      expect(db.isTransaction).toBe(true);
      withWriteTransaction(db, () => {
        expect(db.isTransaction).toBe(true);
        db.prepare('INSERT INTO sample (id) VALUES (1)').run();
      });
      // 内层返回后外层仍然在事务里
      expect(db.isTransaction).toBe(true);
    });

    expect(db.prepare('SELECT COUNT(*) AS total FROM sample').get()).toMatchObject({ total: 1 });
  });

  it('外层回滚时内层写入一起消失', () => {
    const db = open(':memory:');
    db.exec('CREATE TABLE sample (id INTEGER PRIMARY KEY)');

    expect(() =>
      withWriteTransaction(db, () => {
        withWriteTransaction(db, () => {
          db.prepare('INSERT INTO sample (id) VALUES (1)').run();
        });
        throw new Error('rollback');
      }),
    ).toThrow('rollback');

    expect(db.prepare('SELECT COUNT(*) AS total FROM sample').get()).toMatchObject({ total: 0 });
  });
});

/**
 * 0004 是一次**真实迁移**：已有部署升级后不能丢数据，也不能让存量节点在中文检索上
 * 退化成搜不到。
 *
 * 这里手工建一份「升级前」的库（0001–0003 已应用、版本记录也在），写入旧格式的
 * `node` / `node_fts` 行（`node_fts` 存的是**已切分**的中文），再跑升级。
 */
describe('0004 升级路径（已有部署）', () => {
  const LEGACY_URI = 'comem://user/alice/memories/legacy.md';
  const MIGRATIONS = new URL('../../../src/adapters/sqlite/migrations/', import.meta.url);

  function applyPre0004(db: DatabaseSync): void {
    db.exec(
      'CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)',
    );
    const files = ['0001_init.sql', '0002_archived_at.sql', '0003_memory_link.sql'];
    for (const [index, name] of files.entries()) {
      db.exec(readFileSync(new URL(name, MIGRATIONS), 'utf8'));
      db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(
        index + 1,
        new Date().toISOString(),
      );
    }
  }

  function seedLegacyRow(db: DatabaseSync): void {
    db.prepare(
      `INSERT INTO node (
         uri, parent_uri, scope, kind, context_type, memory_type, level,
         abstract, body_digest, size, updated_at, status
       ) VALUES (?, ?, 'user', 'document', 'memory', NULL, 'L2', ?, ?, 12, ?, 'active')`,
    ).run(LEGACY_URI, 'comem://user/alice/memories', '一句话摘要', 'digest', '2026-11-08T00:00:00.000Z');
    // 旧行存的是切分后的文本（`segmentCjk` 的产物），不是原文。
    db.prepare('INSERT INTO node_fts (uri, abstract, content) VALUES (?, ?, ?)').run(
      LEGACY_URI,
      '一 句 话 摘 要',
      '记 忆 数 据 库',
    );
  }

  it('存量行保留，node 的主键变成 (uri, level)', () => {
    const db = open(':memory:');
    applyPre0004(db);
    seedLegacyRow(db);
    expect(currentVersion(db)).toBe(3);

    expect(runMigrations(db)).toBe(LATEST_VERSION);

    expect(db.prepare('SELECT level, abstract, size FROM node WHERE uri = ?').all(LEGACY_URI)).toEqual([
      { level: 'L2', abstract: '一句话摘要', size: 12 },
    ]);

    // 同一个 URI 可以再有一行，但同一层级仍然唯一。
    expect(() =>
      db
        .prepare(
          `INSERT INTO node (
             uri, parent_uri, scope, kind, context_type, memory_type, level,
             abstract, body_digest, size, updated_at, status
           ) VALUES (?, ?, 'user', 'directory', 'memory', NULL, 'L1', NULL, 'd', 0, ?, 'active')`,
        )
        .run(LEGACY_URI, 'comem://user/alice/memories', '2026-11-08T00:00:00.000Z'),
    ).not.toThrow();
    expect(() => seedLegacyRow(db)).toThrow();
  });

  it('node_fts 的切分文本原样搬过去，不需要回头 reindex 才能搜中文', () => {
    const db = open(':memory:');
    applyPre0004(db);
    seedLegacyRow(db);

    runMigrations(db);

    const rows = db
      .prepare('SELECT level, abstract, content FROM node_fts WHERE uri = ?')
      .all(LEGACY_URI);
    expect(rows).toEqual([{ level: 'L2', abstract: '一 句 话 摘 要', content: '记 忆 数 据 库' }]);

    // 升级后立刻按切分后的短语检索，仍然命中。
    const hits = db
      .prepare('SELECT uri FROM node_fts WHERE node_fts MATCH ?')
      .all('"记 忆"')
      .map((row) => String(row['uri']));
    expect(hits).toEqual([LEGACY_URI]);
  });

  it('升级不会凭空造出 L1 行：概览行只在摘要重算后出现', () => {
    const db = open(':memory:');
    applyPre0004(db);
    seedLegacyRow(db);

    runMigrations(db);

    expect(
      db.prepare("SELECT COUNT(*) AS total FROM node WHERE level = 'L1'").get(),
    ).toMatchObject({ total: 0 });
  });
});

/**
 * 0005 删掉 `node.expires_at`：TTL 的判据改成清扫时现算的滑动窗口（架构文档
 * §11.7），这一列没有读取方了。升级要在**已有数据**上可用——列没了，行还在。
 */
describe('0005 升级路径（删 node.expires_at）', () => {
  const LEGACY_URI = 'comem://user/alice/memories/legacy.md';
  const MIGRATIONS = new URL('../../../src/adapters/sqlite/migrations/', import.meta.url);

  function applyPre0005(db: DatabaseSync): void {
    db.exec(
      'CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)',
    );
    const files = [
      '0001_init.sql',
      '0002_archived_at.sql',
      '0003_memory_link.sql',
      '0004_node_level_rows.sql',
    ];
    for (const [index, name] of files.entries()) {
      db.exec(readFileSync(new URL(name, MIGRATIONS), 'utf8'));
      db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(
        index + 1,
        new Date().toISOString(),
      );
    }
  }

  function seedLegacyRow(db: DatabaseSync): void {
    db.prepare(
      `INSERT INTO node (
         uri, parent_uri, scope, kind, context_type, memory_type, level,
         abstract, body_digest, size, updated_at, status, access_count,
         last_accessed_at, expires_at
       ) VALUES (?, ?, 'user', 'document', 'memory', 'preferences', 'L2',
         ?, ?, 12, ?, 'active', 3, ?, ?)`,
    ).run(
      LEGACY_URI,
      'comem://user/alice/memories',
      '一句话摘要',
      'digest',
      '2026-01-01T00:00:00.000Z',
      '2026-02-01T00:00:00.000Z',
      '2026-01-31T00:00:00.000Z',
    );
  }

  function columnNames(db: DatabaseSync): string[] {
    return db
      .prepare("SELECT name FROM pragma_table_info('node') ORDER BY name")
      .all()
      .map((row) => String(row['name']));
  }

  it('列与旧索引消失，存量行的其它字段逐值保留', () => {
    const db = open(':memory:');
    applyPre0005(db);
    seedLegacyRow(db);
    expect(columnNames(db)).toContain('expires_at');
    expect(currentVersion(db)).toBe(4);

    expect(runMigrations(db)).toBe(LATEST_VERSION);

    expect(columnNames(db)).not.toContain('expires_at');
    const indexNames = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_node_expires'")
      .all();
    expect(indexNames).toEqual([]);

    // 「删列」不能顺带删行或改掉其它列：TTL 的输入（最后一次写入 / 最后访问）还在。
    expect(
      db
        .prepare(
          `SELECT uri, memory_type, level, size, updated_at, status, access_count, last_accessed_at
             FROM node WHERE uri = ?`,
        )
        .get(LEGACY_URI),
    ).toEqual({
      uri: LEGACY_URI,
      memory_type: 'preferences',
      level: 'L2',
      size: 12,
      updated_at: '2026-01-01T00:00:00.000Z',
      status: 'active',
      access_count: 3,
      last_accessed_at: '2026-02-01T00:00:00.000Z',
    });
  });

  it('升级后索引仍可写：upsert 不再提到 expires_at', () => {
    const db = open(':memory:');
    applyPre0005(db);

    runMigrations(db);

    expect(() =>
      db
        .prepare(
          `INSERT INTO node (
             uri, parent_uri, scope, kind, context_type, memory_type, level,
             abstract, body_digest, size, updated_at, status
           ) VALUES (?, ?, 'user', 'document', 'memory', 'events', 'L2',
             NULL, 'd', 1, ?, 'active')`,
        )
        .run('comem://user/alice/memories/events/new.md', 'comem://user/alice/memories/events', '2026-11-08T00:00:00.000Z'),
    ).not.toThrow();
  });
});
