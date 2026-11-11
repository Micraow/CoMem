import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDatabase, runMigrations } from '../../../src/adapters/sqlite/database.js';

const MIGRATIONS_DIR = fileURLToPath(
  new URL('../../../src/adapters/sqlite/migrations', import.meta.url),
);

/** 加 `bootstrap_admin` 之前的最新版本。升级用例模拟「已经跑过 0007 的数据根」。 */
const VERSION_BEFORE_BOOTSTRAP_ADMIN = 7;

let tempDir: string;
let openDatabases: DatabaseSync[];

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'comem-bootstrap-migration-'));
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

function columnOf(db: DatabaseSync, name: string): Record<string, unknown> | undefined {
  return db
    .prepare('PRAGMA table_info(app_user)')
    .all()
    .find((row) => row['name'] === name);
}

/** 手工应用 0001..`upTo` 并记录版本，模拟一份「停在旧版本」的数据根。 */
function applyHistoricalMigrations(db: DatabaseSync, upTo: number): void {
  db.exec(
    'CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)',
  );
  const enabled = Number(db.prepare('PRAGMA foreign_keys').get()?.['foreign_keys'] ?? 0) === 1;
  if (enabled) {
    db.exec('PRAGMA foreign_keys = OFF');
  }
  try {
    for (const name of readdirSync(MIGRATIONS_DIR).sort()) {
      const match = /^(\d{4})_/.exec(name);
      if (match === null) {
        continue;
      }
      const version = Number(match[1]);
      if (version > upTo) {
        continue;
      }
      db.exec(readFileSync(join(MIGRATIONS_DIR, name), 'utf8'));
      db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(
        version,
        new Date().toISOString(),
      );
    }
  } finally {
    if (enabled) {
      db.exec('PRAGMA foreign_keys = ON');
    }
  }
}

describe('0008_bootstrap_admin 迁移', () => {
  it('全新数据根：建出 bootstrap_admin 列（NOT NULL DEFAULT 0）', () => {
    const db = open(':memory:');

    expect(runMigrations(db)).toBeGreaterThanOrEqual(8);

    const column = columnOf(db, 'bootstrap_admin');
    expect(column).toMatchObject({ type: 'INTEGER', notnull: 1, dflt_value: '0' });
  });

  it('已有 0007 数据根：升级加上这一列，旧行取默认值 0，数据不丢', () => {
    const db = open(join(tempDir, 'comem.sqlite'));
    applyHistoricalMigrations(db, VERSION_BEFORE_BOOTSTRAP_ADMIN);
    db.prepare(
      'INSERT INTO app_user (id, display_name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run('local', '本机用户', 'active', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');

    // 升级前没有这一列。
    expect(columnOf(db, 'bootstrap_admin')).toBeUndefined();

    expect(runMigrations(db)).toBeGreaterThanOrEqual(8);

    expect(columnOf(db, 'bootstrap_admin')).toMatchObject({ notnull: 1, dflt_value: '0' });
    expect(
      db.prepare('SELECT id, display_name, bootstrap_admin FROM app_user WHERE id = ?').get('local'),
    ).toMatchObject({ id: 'local', display_name: '本机用户', bootstrap_admin: 0 });
    // 迁移之后没有悬空外键（重建被引用表时的经典翻车点）。
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('重放：已应用 0008 的数据根再跑一次不会重复加列', () => {
    const db = open(join(tempDir, 'comem.sqlite'));
    expect(runMigrations(db)).toBeGreaterThanOrEqual(8);

    // 幂等由版本表保证：第二次不执行 ALTER（否则 SQLite 报 duplicate column）。
    expect(() => runMigrations(db)).not.toThrow();
    expect(columnOf(db, 'bootstrap_admin')).toMatchObject({ notnull: 1, dflt_value: '0' });
  });
});
