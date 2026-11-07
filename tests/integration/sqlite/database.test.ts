import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
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
