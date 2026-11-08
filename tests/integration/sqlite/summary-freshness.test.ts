import type { DatabaseSync } from 'node:sqlite';

import { describe, expect, it } from 'vitest';

import { currentVersion, openDatabase, runMigrations } from '../../../src/adapters/sqlite/database.js';

const URI = 'comem://user/alice/memories/preferences';
const UPDATED_AT = '2026-11-08T00:00:00.000Z';

/** 插入一行 `node`，只填建表必填列（摘要新鲜度三列走默认值）。 */
function insertNode(db: DatabaseSync): void {
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

/**
 * 目录摘要的新鲜度三列（§9.3）。
 *
 * 早期这是 `0003_summary_freshness.sql` 的一个 `ALTER TABLE ADD COLUMN` 迁移；
 * 现在三列直接写进唯一的初始 schema（`0001_init.sql`），迁移不再分版本。
 * 这里断言的是**最终结构的行为**：三列的默认值、可写、以及 `NOT NULL` 约束。
 */
describe('node 摘要新鲜度三列', () => {
  it('幂等：runMigrations 跑两次不炸', () => {
    const db = openDatabase(':memory:');
    try {
      const version = runMigrations(db);
      expect(version).toBeGreaterThanOrEqual(1);
      expect(runMigrations(db)).toBe(version);
      expect(currentVersion(db)).toBe(version);
    } finally {
      db.close();
    }
  });

  it('新建行的三列取默认值', () => {
    const db = openDatabase(':memory:');
    try {
      runMigrations(db);
      insertNode(db);

      const inserted = row(db);
      expect(inserted?.['uri']).toBe(URI);
      expect(inserted?.['abstract']).toBe('偏好目录的摘要');
      expect(inserted?.['body_digest']).toBe('digest-before-0003');
      expect(inserted?.['status']).toBe('active');
      // 三列的初始值就是「从未生成过摘要」（§9.3「没有基线」）。
      expect(inserted?.['summary_baseline']).toBeNull();
      expect(Number(inserted?.['summary_pending'])).toBe(0);
      expect(Number(inserted?.['summary_entries'])).toBe(0);
    } finally {
      db.close();
    }
  });

  it('summary_pending 与 summary_entries 不接受 NULL', () => {
    const db = openDatabase(':memory:');
    try {
      runMigrations(db);
      insertNode(db);

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
      insertNode(db);

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
});
