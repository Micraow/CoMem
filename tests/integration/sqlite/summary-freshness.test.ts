import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  currentVersion,
  openDatabase,
  runMigrations,
} from '../../../src/adapters/sqlite/database.js';

/** 迁移目录：`runMigrations` 也从这里读脚本（`database.ts` 的 `MIGRATIONS_DIR`）。 */
const MIGRATIONS_DIR = fileURLToPath(
  new URL('../../../src/adapters/sqlite/migrations', import.meta.url),
);

const URI = 'comem://user/alice/memories/preferences';
const UPDATED_AT = '2026-11-08T00:00:00.000Z';

/** 只应用一个迁移，并把版本号记进 `schema_version`（模拟「升级前的旧库」）。 */
function applyMigration(db: DatabaseSync, version: number, name: string): void {
  db.exec(readFileSync(join(MIGRATIONS_DIR, name), 'utf8'));
  db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(
    version,
    UPDATED_AT,
  );
}

/** 迁移 0003 之前的 `node` 行（12 列，没有新鲜度三列）。 */
function insertLegacyNode(db: DatabaseSync): void {
  db.prepare(
    `INSERT INTO node (
       uri, parent_uri, scope, kind, context_type, memory_type, level,
       abstract, body_digest, size, updated_at, status
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    URI,
    'comem://user/alice/memories',
    'user',
    'directory',
    'memory',
    null,
    'L0',
    '偏好目录的摘要',
    'digest-before-0003',
    2,
    UPDATED_AT,
    'active',
  );
}

function row(db: DatabaseSync): Record<string, unknown> | undefined {
  return db.prepare('SELECT * FROM node WHERE uri = ?').get(URI);
}

describe('0003_summary_freshness', () => {
  it('幂等：runMigrations 跑两次不炸', () => {
    const db = openDatabase(':memory:');
    try {
      const version = runMigrations(db);
      // 不写死版本号：本文件只保证 0003 之后还能重复迁移（后续 wave 会继续加）。
      expect(version).toBeGreaterThanOrEqual(3);
      expect(runMigrations(db)).toBe(version);
      expect(currentVersion(db)).toBe(version);
    } finally {
      db.close();
    }
  });

  it('ADD COLUMN 之后老数据不丢，默认值正确', () => {
    const db = openDatabase(':memory:');
    try {
      // 旧库：只到 0002，已经有一行 node。
      applyMigration(db, 1, '0001_init.sql');
      applyMigration(db, 2, '0002_index.sql');
      insertLegacyNode(db);

      expect(runMigrations(db)).toBeGreaterThanOrEqual(3);

      const migrated = row(db);
      expect(migrated?.['uri']).toBe(URI);
      expect(migrated?.['abstract']).toBe('偏好目录的摘要');
      expect(migrated?.['body_digest']).toBe('digest-before-0003');
      expect(migrated?.['status']).toBe('active');
      // 三列的初始值就是「从未生成过摘要」（§9.3「没有基线」）。
      expect(migrated?.['summary_baseline']).toBeNull();
      expect(Number(migrated?.['summary_pending'])).toBe(0);
      expect(Number(migrated?.['summary_entries'])).toBe(0);
    } finally {
      db.close();
    }
  });

  it('summary_pending 与 summary_entries 不接受 NULL', () => {
    const db = openDatabase(':memory:');
    try {
      runMigrations(db);
      insertLegacyNode(db);

      expect(() =>
        db.prepare('UPDATE node SET summary_pending = NULL WHERE uri = ?').run(URI),
      ).toThrow();
      expect(() =>
        db.prepare('UPDATE node SET summary_entries = NULL WHERE uri = ?').run(URI),
      ).toThrow();
      // summary_baseline 允许 NULL：它表示「从未生成过摘要」。
      expect(() =>
        db.prepare('UPDATE node SET summary_baseline = NULL WHERE uri = ?').run(URI),
      ).not.toThrow();
    } finally {
      db.close();
    }
  });

  it('三列可写回（§9.3 的消费路径）', () => {
    const db = openDatabase(':memory:');
    try {
      runMigrations(db);
      insertLegacyNode(db);

      db.prepare(
        'UPDATE node SET summary_baseline = ?, summary_pending = ?, summary_entries = ? WHERE uri = ?',
      ).run('baseline-after-generation', 3, 2, URI);

      const updated = row(db);
      expect(updated?.['summary_baseline']).toBe('baseline-after-generation');
      expect(Number(updated?.['summary_pending'])).toBe(3);
      expect(Number(updated?.['summary_entries'])).toBe(2);
    } finally {
      db.close();
    }
  });

  it('空库直接跑到最新版本，新建行的三列取默认值', () => {
    const db = openDatabase(':memory:');
    try {
      expect(runMigrations(db)).toBeGreaterThanOrEqual(3);
      insertLegacyNode(db);

      const inserted = row(db);
      expect(inserted?.['summary_baseline']).toBeNull();
      expect(Number(inserted?.['summary_pending'])).toBe(0);
      expect(Number(inserted?.['summary_entries'])).toBe(0);
    } finally {
      db.close();
    }
  });
});
