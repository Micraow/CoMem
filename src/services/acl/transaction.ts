/**
 * 事务端口：`services/` 不能 import `node:sqlite`（§4.2），这里用最小结构端口
 * `AclDatabase` 自己开 `BEGIN IMMEDIATE`。
 *
 * 不用 `withWriteTransaction`：那是 `adapters/sqlite/database.ts` 的**值**导出，
 * 而 `services/` 只允许 `import type` 引用适配层（§4.2）。`PermissionRepository`
 * 的两个写入方法检测到外层已有事务会直接复用，所以两步仍是一个事务。
 */

import type { AclDatabase } from './types.js';

/**
 * `BEGIN IMMEDIATE` 包住 `PermissionRepository` 的两个写入。
 *
 * 两个写入方法内部各自调 `withWriteTransaction`，检测到外层事务会直接复用，
 * 所以不会嵌套 `BEGIN`。
 */
export function runInTransaction(db: AclDatabase, fn: () => void): void {
  if (db.isTransaction) {
    fn();
    return;
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    fn();
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/**
 * 删掉主体的物化行与反查行（列名见迁移 0002 的两张表）。
 *
 * 两张表都要清：`node_permission` 是求权实际读的表，留着就等于授权还在；
 * `acl_entry` 是反查来源，留着会让控制台列出一个不存在的主体。
 */
export function deletePrincipalRows(db: AclDatabase, principal: string): void {
  db.prepare('DELETE FROM acl_entry WHERE principal = ?').run(principal);
  db.prepare('DELETE FROM node_permission WHERE principal = ?').run(principal);
}
