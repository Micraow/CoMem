/**
 * 摘要新鲜度：`node` 表上的三列（§9.3）。
 *
 * `summary_baseline` 是上次生成时 L0 正文的摘要，`summary_pending` 是「生成之后
 * 又变了几次」，`summary_entries` 是生成时的直接子项数。三列只在目录的 L0 行上
 * 有意义（`0004_node_level_rows.sql`）。
 *
 * 判定（`shouldRecompute`）与计数变换（`recordChange` / `consumeChanges`）是
 * `domain/summary.ts` 的纯函数；本文件只负责这三列的读写，不重复判定。
 */

import { consumeChanges, type SummaryFreshness } from '../../domain/summary.js';

import { DIRECTORY_LEVEL } from './levels.js';
import type { SummaryDatabase } from './ports.js';

/** 摘要新鲜度三列只在目录的 L0 行上有意义（`0004_node_level_rows.sql`）。 */
const FRESHNESS_ROW_SQL = `level = '${DIRECTORY_LEVEL}'`;

function nullableText(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function integer(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function readFreshness(db: SummaryDatabase, uri: string): SummaryFreshness {
  const row = db
    .prepare(
      `SELECT summary_baseline, summary_pending, summary_entries
         FROM node WHERE uri = ? AND ${FRESHNESS_ROW_SQL}`,
    )
    .get(uri);
  return {
    baseline: nullableText(row?.['summary_baseline']),
    pendingChanges: integer(row?.['summary_pending']),
    totalEntries: integer(row?.['summary_entries']),
  };
}

/** 只更新计数器，不动基线（§9.3 第 4 步的 else 分支）。 */
export function writePendingChanges(
  db: SummaryDatabase,
  uri: string,
  pendingChanges: number,
): void {
  db
    .prepare(`UPDATE node SET summary_pending = ? WHERE uri = ? AND ${FRESHNESS_ROW_SQL}`)
    .run(pendingChanges, uri);
}

/**
 * 写回新鲜度（§9.3「消费时减而不是清零」）。
 *
 * 必须在事务里、在索引行写入之后调用：行不存在时 `UPDATE` 影响 0 行，基线会永远
 * 停在 `NULL`，每次失效都重算整个子树。
 */
export function consumeFreshness(
  db: SummaryDatabase,
  uri: string,
  baseline: string,
  snapshotPending: number,
  entries: number,
): void {
  const current = readFreshness(db, uri);
  const consumed = consumeChanges(
    { baseline, pendingChanges: current.pendingChanges, totalEntries: entries },
    snapshotPending,
  );
  db.prepare(
    `UPDATE node
        SET summary_baseline = ?,
            summary_pending = ?,
            summary_entries = ?
      WHERE uri = ? AND ${FRESHNESS_ROW_SQL}`,
  ).run(baseline, consumed.pendingChanges, entries, uri);
}
