/**
 * `request_log` 与 `llm_call_log` 的保留策略（架构文档 §17.6）。
 *
 * 两条规则在同一个事务里：先按天数删、再按行数删。第二条只看剩下的行，所以两条规则
 * 不会互相「救回」被删的行。行数规则先 `COUNT(*)`，超限时按时间列升序取溢出行的
 * rowid 再按 rowid 删——`id NOT IN (SELECT ... LIMIT ?)` 在超限与不超限时都要全表扫
 * （10 万行实测 75 ms），而这里每轮调度都调，稳态成本必须与「没有可删的行」同阶。
 *
 * 表名与时间列由调用点写死，不来自外部输入，所以直接拼进 SQL。
 */

import type { DatabaseSync } from 'node:sqlite';

import type { Logger } from '../../domain/log.js';
import { MILLISECONDS_PER_DAY } from '../../domain/time.js';

import { withWriteTransaction } from './database.js';

export function pruneByRetention(
  db: DatabaseSync,
  target: {
    readonly table: string;
    /** 用于按天数裁剪与挑最旧行的列，如 `created_at` / `started_at` */
    readonly timeColumn: string;
    /** 真的删了行时写进日志的文案，如「请求记录已裁剪」 */
    readonly label: string;
  },
  rules: { readonly retainDays: number; readonly retainRows: number; readonly now: Date },
  logger: Logger,
): number {
  const cutoff = new Date(
    rules.now.getTime() - rules.retainDays * MILLISECONDS_PER_DAY,
  ).toISOString();
  const { table, timeColumn } = target;

  const deleted = withWriteTransaction(db, () => {
    const expired = db
      .prepare(`DELETE FROM ${table} WHERE ${timeColumn} < ?`)
      .run(cutoff).changes;

    const total = Number(
      db.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get()?.['total'] ?? 0,
    );
    let overflow = 0;
    if (total > rules.retainRows) {
      overflow = Number(
        rules.retainRows <= 0
          ? db.prepare(`DELETE FROM ${table}`).run().changes
          : db
              .prepare(
                `DELETE FROM ${table}
                  WHERE rowid IN (
                    SELECT rowid FROM ${table}
                     ORDER BY ${timeColumn} ASC
                     LIMIT ?
                  )`,
              )
              .run(total - rules.retainRows).changes,
      );
    }

    return Number(expired) + Number(overflow);
  });

  if (deleted > 0) {
    logger.info(target.label, {
      deleted,
      retainDays: rules.retainDays,
      retainRows: rules.retainRows,
    });
  }
  return deleted;
}
