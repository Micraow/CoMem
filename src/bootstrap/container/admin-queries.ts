/**
 * 管理面的统计查询（`api/http/routes` 的 `AdminAccess` 端口实现）。
 *
 * SQL 留在装配层：`api/` 不能 import `adapters/`（架构文档 §4.2）。两个函数都是
 * 同步的——`node:sqlite` 是同步 API，事务边界也必须是同步回调。
 *
 * 从 `api.ts` 拆出来是因为那个文件已经到形状门禁的上限；语义与行为逐字未变。
 */

import type { DatabaseSync } from 'node:sqlite';

/** 每个主体在物化表里的行数。一次 `IN (...)` 查询，不按用户逐条查。 */
export function permissionCountsOf(
  db: DatabaseSync,
  principals: readonly string[],
): ReadonlyMap<string, number> {
  if (principals.length === 0) {
    return new Map();
  }
  const list = principals.map(() => '?').join(', ');
  const rows = db
    .prepare(
      `SELECT principal, COUNT(*) AS total FROM node_permission
       WHERE principal IN (${list})
       GROUP BY principal`,
    )
    .all(...principals);
  return new Map(rows.map((row) => [String(row['principal']), Number(row['total'])]));
}

/** 每个组的成员数。一次 `IN (...)` 查询。 */
export function memberCountsOf(
  db: DatabaseSync,
  groupIds: readonly string[],
): ReadonlyMap<string, number> {
  if (groupIds.length === 0) {
    return new Map();
  }
  const list = groupIds.map(() => '?').join(', ');
  const rows = db
    .prepare(
      `SELECT group_id, COUNT(*) AS total FROM group_member
       WHERE group_id IN (${list})
       GROUP BY group_id`,
    )
    .all(...groupIds);
  return new Map(rows.map((row) => [String(row['group_id']), Number(row['total'])]));
}
