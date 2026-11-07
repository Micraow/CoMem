/**
 * SQLite 连接与迁移入口（架构文档 §8.1、§18「并发控制」）。
 *
 * 用 `node:sqlite` 的 `DatabaseSync`：同步 API 适合单写者的任务模型，
 * 也不需要为 `better-sqlite3` 维护原生编译产物。
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

export interface OpenOptions {
  readonly?: boolean;
}

const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations', import.meta.url));

/** 迁移文件命名：`NNNN_name.sql`，数字是版本号（架构文档 §8.1 的版本化建表脚本）。 */
const MIGRATION_FILE_PATTERN = /^(\d{4})_[A-Za-z0-9_]+\.sql$/;

/** `busy_timeout`，单位毫秒。架构文档 §18：超过它抛 CONFLICT 由任务层重试。 */
const BUSY_TIMEOUT_MS = 5000;

interface MigrationFile {
  readonly version: number;
  readonly path: string;
}

/**
 * 打开数据库并设置连接级 PRAGMA。
 * 只读连接不能改 `journal_mode`，因此只设 `busy_timeout` 与 `foreign_keys`。
 */
export function openDatabase(file: string, options: OpenOptions = {}): DatabaseSync {
  const readonly = options.readonly ?? false;
  const db = new DatabaseSync(file, { readOnly: readonly });
  if (!readonly) {
    // 架构文档 §18「并发控制」：WAL 允许并发读、单写者。
    db.exec('PRAGMA journal_mode = WAL');
  }
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  db.exec('PRAGMA foreign_keys = ON');
  return db;
}

function tableExists(db: DatabaseSync, name: string): boolean {
  const row = db
    .prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name);
  return row !== undefined;
}

/** 已经应用到的版本号；空库（连版本表都没有）返回 0。 */
export function currentVersion(db: DatabaseSync): number {
  if (!tableExists(db, 'schema_version')) {
    return 0;
  }
  const row = db.prepare('SELECT MAX(version) AS version FROM schema_version').get();
  const version = row?.['version'];
  return typeof version === 'number' ? version : 0;
}

function listMigrations(): MigrationFile[] {
  const migrations: MigrationFile[] = [];
  for (const name of readdirSync(MIGRATIONS_DIR)) {
    const match = MIGRATION_FILE_PATTERN.exec(name);
    const rawVersion = match?.[1];
    if (rawVersion === undefined) {
      continue;
    }
    migrations.push({ version: Number(rawVersion), path: join(MIGRATIONS_DIR, name) });
  }
  return migrations.sort((left, right) => left.version - right.version);
}

/**
 * 按版本号顺序应用未执行的迁移，返回应用到的版本号。
 *
 * 幂等：已经记录在 `schema_version` 里的版本跳过。
 * 每个迁移单独一个事务——某个脚本失败时，前面成功的版本保持已应用状态，
 * 版本表与库结构始终一致。
 */
export function runMigrations(db: DatabaseSync): number {
  db.exec(
    'CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)',
  );

  let applied = currentVersion(db);
  for (const migration of listMigrations()) {
    if (migration.version <= applied) {
      continue;
    }
    const sql = readFileSync(migration.path, 'utf8');
    withWriteTransaction(db, () => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(
        migration.version,
        new Date().toISOString(),
      );
    });
    applied = migration.version;
  }
  return applied;
}

/**
 * 写事务包装（架构文档 §18「并发控制」）。
 *
 * 用 `BEGIN IMMEDIATE` 立刻拿写锁，避免读事务升级写事务时的死锁。
 * 嵌套调用直接复用外层事务——SQLite 不支持嵌套事务，内层再 BEGIN 会报错。
 * `fn` 必须是同步函数，返回 Promise 时事务会在 Promise 完成前提交。
 */
export function withWriteTransaction<T>(db: DatabaseSync, fn: () => T): T {
  if (db.isTransaction) {
    return fn();
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
