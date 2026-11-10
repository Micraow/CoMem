/**
 * 物化权限与授权反查（架构文档 §8.2、§12.3）。
 *
 * `node_permission` 是「这个节点对谁能做什么」的物化结果：写 ACL 时整棵子树重算，
 * 检索时只查表。代价转移方向是硬约束——ACL 改动低频，读高频，所以物化必须在写侧
 * 完成，读侧不许 open 祖先的 `.acl.json`（§8.2：一条候选要读 5 层文件，40 条候选
 * 就是 200 次 IO，而且候选全无权限时会假报「没有结果」）。
 *
 * `acl_entry` 是物化之前的原始授权条目，只服务授权反查（控制台的 ACL 页、退组清理），
 * 不参与检索。
 *
 * ## deny 也必须物化
 *
 * `level` 只能表达「允许到什么级别」。同一主体在同一节点上既有 allow 又有 deny 时
 * deny 赢（§12.2 不变量 2），求值结果是空集；空集如果只靠「没有行」表达，读侧就
 * 分不清「被拒绝」与「从未授权」，`user:*` 的 allow 会把被 deny 的主体放进来。
 * 所以 `node_permission` 带 `effect`，读侧谓词是「有 allow 且没有 deny」。
 */

import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';

import { READ_LEVEL, type AclEffect, type AclLevel } from '../../domain/acl.js';
import type { Logger } from '../../domain/log.js';
import { withWriteTransaction } from './database.js';
import { globPrefixPattern, placeholders } from './node-repository.js';

/**
 * `node_permission` 的一行：物化后的有效权限。
 *
 * `effect === 'deny'` 的行是「这个主体在链上被 deny 清空」的标记，它没有对应的
 * allow 行，只用于压掉同一查询主体集合里的 `user:*` 通配。
 */
export interface PermissionRow {
  readonly nodeUri: string;
  readonly principal: string;
  readonly level: AclLevel;
  readonly effect: AclEffect;
}

/** `acl_entry` 的一行：原始授权条目。 */
export interface AclEntryRow {
  readonly uri: string;
  readonly principal: string;
  readonly level: AclLevel;
  readonly effect: AclEffect;
}

export interface PermissionRepositoryDeps {
  readonly db: DatabaseSync;
  readonly logger: Logger;
}

const ACL_COLUMNS = 'uri, principal, level, effect';

/**
 * 「主体集合里没有任何人在该节点被 deny」的谓词（§12.2 不变量 2）。**这是唯一一份。**
 *
 * 单独成函数是因为 deny 优先的判定被两条查询共用：可读谓词（`readablePredicateSql`，
 * `search` / `glob` / `readableUris`）与单节点级别查询（`maxLevel`）。各拼一份时，
 * 改一处会让其中一条路径漏掉 deny——被 deny 的主体在检索里消失、在 `check` 里放行。
 *
 * `principalList` 是主体集合的占位符片段（`placeholders(n)`）；调用方按出现顺序
 * 绑定。调用方必须把 `node_permission` 别名为 `p`。
 */
function deniedPredicateSql(principalList: string): string {
  return `NOT EXISTS (
        SELECT 1 FROM node_permission d
        WHERE d.node_uri = p.node_uri
          AND d.principal IN (${principalList})
          AND d.effect = 'deny'
      )`;
}

/**
 * 「这个节点对主体集合可读」的谓词（§12.2 不变量 2）。**这是唯一一份。**
 *
 * 三个条件缺一不可：命中主体集合的 allow 行带读位、没有任何主体在该节点的链上被
 * deny。deny 优先，所以不能合并成单行级别聚合——被 deny 的主体集合可能还有 allow
 * 行，必须由 deny 行整体压掉。
 *
 * 读位用位测试而不是 `>=`：规范级别 1 / 3 / 7 上两者等价，但 `level = 2` / `6` 这类
 * 只带高位、读位为 0 的非规范行会被 `>=` 判成可读，与单节点读路径
 * （`maxLevel` 的级别并集 + `levelSatisfies` 位测试）分叉。
 *
 * `principalList` 是主体集合的占位符片段（`placeholders(n)`）；它在 SQL 里出现两次
 * （外层 allow、内层 deny），调用方按出现顺序绑定两遍。调用方必须把 `node_permission`
 * 别名为 `p`。
 *
 * `SqliteFtsIndex` 的 `EXISTS` 子查询（`search` / `glob`）与 `readableUris` 的批量
 * `IN (...)`（`grep` 的前置过滤、列表类查询）共用它：各存一份时两份写法会漂移，
 * 同一次请求里 `search` 与 `grep` 就会给出不同的可见集合。
 */
export function readablePredicateSql(principalList: string): string {
  return `(p.level & ${READ_LEVEL}) = ${READ_LEVEL}
      AND p.effect = 'allow'
      AND ${deniedPredicateSql(principalList)}`;
}

function text(value: SQLOutputValue | undefined): string {
  return String(value);
}

function integer(value: SQLOutputValue | undefined): number {
  return Number(value);
}

function toAclEntryRow(row: Record<string, SQLOutputValue>): AclEntryRow {
  return {
    uri: text(row['uri']),
    principal: text(row['principal']),
    level: integer(row['level']) as AclLevel,
    effect: text(row['effect']) as AclEffect,
  };
}

export class PermissionRepository {
  readonly #db: DatabaseSync;
  readonly #logger: Logger;

  constructor(deps: PermissionRepositoryDeps) {
    this.#db = deps.db;
    this.#logger = deps.logger;
  }

  /**
   * 物化：整棵子树重算，调用方负责在事务里调。
   *
   * 内部仍然包一层 `withWriteTransaction`——它检测到外层已有事务时直接复用，
   * 不会嵌套 `BEGIN`。这样「调用方忘了开事务」时删除与插入也是原子的，而不是留下
   * 一棵没有权限行的子树（那等于整棵子树对所有人不可见）。
   *
   * 用 `ON CONFLICT DO UPDATE` 而不是普通 `INSERT`：入参里同一 `(node_uri, principal)`
   * 出现两次时，普通插入会抛约束错误，而重算语义下后者覆盖前者才是唯一合理的解释。
   */
  replaceSubtree(uri: string, permissions: readonly PermissionRow[]): void {
    withWriteTransaction(this.#db, () => {
      this.#db
        .prepare(`DELETE FROM node_permission WHERE node_uri = ? OR node_uri GLOB ?`)
        .run(uri, globPrefixPattern(uri));
      this.#writeRows(permissions);
    });
    this.#logger.debug('物化权限子树重算', { uri, rows: permissions.length });
  }

  /**
   * 单个节点的物化（增量物化入口）：只替换该节点的行，不碰子树。
   *
   * 与 `replaceSubtree` 的区别只在删除范围。新建节点时两者等价，但这里不会在
   * 「重算一个已有后代的目录」时把后代的行删掉却不算回来。
   */
  replaceNode(uri: string, permissions: readonly PermissionRow[]): void {
    withWriteTransaction(this.#db, () => {
      this.#db.prepare('DELETE FROM node_permission WHERE node_uri = ?').run(uri);
      this.#writeRows(permissions);
    });
    this.#logger.debug('物化权限节点重写', { uri, rows: permissions.length });
  }

  /**
   * 检索用：给定主体集合，返回有 read 权限的 URI 集合。
   *
   * 语义是「有 allow 且没有 deny」（§12.2 不变量 2）：主体集合里任一主体拿到
   * 带读位的 allow，且没有任何主体在同一个节点上有 deny 行。deny 优先于 allow，
   * 所以这两个条件不能合并成单个级别聚合。谓词本体在 `readablePredicateSql()`：
   * `search` / `glob` 的 `EXISTS` 子查询用的是同一份。
   *
   * 一次 `IN (...)` 查询拿完，不按 URI 逐条查：`search` 一次要过滤 40 条候选，
   * 逐条查就是 40 次往返。SQLite 的变量上限默认 32766（`SQLITE_MAX_VARIABLE_NUMBER`），
   * 40 条候选加几个主体远不到上限。
   *
   * 这个方法服务的是「候选已经在内存里、需要批量过滤」的路径（`grep` 读文件前先
   * 过滤、控制台批量操作）。
   */
  readableUris(uris: readonly string[], principals: readonly string[]): ReadonlySet<string> {
    if (uris.length === 0 || principals.length === 0) {
      return new Set<string>();
    }
    // 主体集合在 SQL 里出现两次（外层 allow、内层 deny），复用同一个占位符片段，
    // 绑定顺序与出现顺序一致：先 URI 集合，再两遍主体集合。
    const principalList = placeholders(principals.length);
    const sql = `SELECT DISTINCT p.node_uri FROM node_permission p
      WHERE p.node_uri IN (${placeholders(uris.length)})
        AND p.principal IN (${principalList})
        AND ${readablePredicateSql(principalList)}`;
    const rows = this.#db.prepare(sql).all(...uris, ...principals, ...principals);
    return new Set(rows.map((row) => text(row['node_uri'])));
  }

  /**
   * 单节点：主体集合在物化表里拿到的级别（§12.2）。没有命中行时返回 `null`。
   *
   * 与 `readableUris` 共用同一份 deny 谓词，allow 半边按主体集合的**位并集**求：
   * 每个主体的授权是一个位掩码，`user:bob = 1` 与 `group:eng = 4` 的并集是 5。
   * 逐行取 `MAX(level)` 只在规范级别 1 / 3 / 7 上等价于并集；同一节点出现
   * `level = 1` 与 `level = 4` 这类非规范行时 `MAX` 取 4、读位为 0，而
   * `readableUris` 会因为那条读位为真的行放行——`check` 与检索的可见集合分叉。
   * `permission-visibility-consistency.test.ts` 的多行对拍用例钉住这一点。
   *
   * 返回的级别交给 `domain/acl.ts` 的 `levelSatisfies` 做位测试，所以保留
   * `number` 到 `AclLevel` 的断言：并集可以是非规范级别（1 | 4 = 5），而 5 含
   * 读位必须可读。换成 `isAclLevel` 过滤会把 5 / 6 都判成非法，5 因此失去权限。
   *
   * 用一次查询取回命中的行再在 JS 里合并，而不是 `SELECT MAX(level)`：SQLite 没有
   * 位或聚合函数，`MAX` 也不是位并集。
   */
  maxLevel(uri: string, principals: readonly string[]): AclLevel | null {
    if (principals.length === 0) {
      return null;
    }
    const principalList = placeholders(principals.length);
    const rows = this.#db
      .prepare(
        `SELECT p.level FROM node_permission p
         WHERE p.node_uri = ?
           AND p.principal IN (${principalList})
           AND p.effect = 'allow'
           AND ${deniedPredicateSql(principalList)}`,
      )
      .all(uri, ...principals, ...principals);
    if (rows.length === 0) {
      return null;
    }
    let granted = 0;
    for (const row of rows) {
      granted |= integer(row['level']);
    }
    return granted as AclLevel;
  }

  /** 授权反查：某个主体被授权过哪些节点，按 uri 升序。 */
  entriesByPrincipal(principal: string): readonly AclEntryRow[] {
    return this.#db
      .prepare(`SELECT ${ACL_COLUMNS} FROM acl_entry WHERE principal = ? ORDER BY uri ASC`)
      .all(principal)
      .map(toAclEntryRow);
  }

  /**
   * 替换某节点的直接授权（不涉及子树）。
   *
   * 这是 `acl_entry` 的写入口，**不**重算 `node_permission`：物化是调用方在一次
   * 事务里完成「写 `.acl.json` + `replaceEntries` + `replaceSubtree`」的三步操作。
   * 在这里顺手重算会让「只想改原始条目、稍后统一物化」变成不可能。
   */
  replaceEntries(uri: string, entries: readonly AclEntryRow[]): void {
    withWriteTransaction(this.#db, () => {
      this.#db.prepare('DELETE FROM acl_entry WHERE uri = ?').run(uri);
      const statement = this.#db.prepare(
        `INSERT INTO acl_entry (${ACL_COLUMNS}) VALUES (?, ?, ?, ?)
         ON CONFLICT(uri, principal) DO UPDATE SET
           level = excluded.level,
           effect = excluded.effect`,
      );
      for (const entry of entries) {
        statement.run(entry.uri, entry.principal, entry.level, entry.effect);
      }
    });
    this.#logger.debug('授权条目替换', { uri, rows: entries.length });
  }

  /**
   * 删除子树的两张表，返回删除的 `node_permission` 行数。
   *
   * 返回物化权限的行数而不是 `acl_entry` 的行数：删节点的调用方关心的是「多少条
   * 检索侧可见的权限没了」，那正是 `node_permission`。`acl_entry` 也会被清掉——
   * 节点不存在了，原始授权没有挂载点。
   */
  deleteSubtree(uri: string): number {
    const deleted = Number(
      withWriteTransaction(this.#db, () => {
        const pattern = globPrefixPattern(uri);
        this.#db
          .prepare(`DELETE FROM acl_entry WHERE uri = ? OR uri GLOB ?`)
          .run(uri, pattern);
        return this.#db
          .prepare(
            `DELETE FROM node_permission WHERE node_uri = ? OR node_uri GLOB ?`,
          )
          .run(uri, pattern).changes;
      }),
    );
    this.#logger.debug('物化权限子树删除', { uri, deleted });
    return deleted;
  }

  /**
   * 删除子树内全部原始授权行，返回删除的行数。
   *
   * 与 `deleteSubtree` 的区别：那个方法同时删 `node_permission`，服务的是「节点
   * 不存在了」。这里只清 `acl_entry`——`node_permission` 要按清空后的文件重算，
   * 因为子树里的节点可能从**子树之外**的祖先继承权限（删组时，`comem://group/`
   * 上的条目仍然生效）。只删物化行会让求权结果比文件更严，两边不一致。
   */
  deleteEntriesSubtree(uri: string): number {
    const deleted = Number(
      withWriteTransaction(this.#db, () =>
        this.#db
          .prepare(`DELETE FROM acl_entry WHERE uri = ? OR uri GLOB ?`)
          .run(uri, globPrefixPattern(uri)).changes,
      ),
    );
    this.#logger.debug('子树授权条目已删除', { uri, deleted });
    return deleted;
  }

  /**
   * 写入物化行，调用方负责删除范围与事务边界。
   *
   * 用 `ON CONFLICT DO UPDATE` 而不是普通 `INSERT`：入参里同一
   * `(node_uri, principal)` 出现两次时，普通插入会抛约束错误，而重算语义下
   * 后者覆盖前者才是唯一合理的解释。
   */
  #writeRows(permissions: readonly PermissionRow[]): void {
    const statement = this.#db.prepare(
      `INSERT INTO node_permission (node_uri, principal, level, effect) VALUES (?, ?, ?, ?)
       ON CONFLICT(node_uri, principal) DO UPDATE SET
         level = excluded.level,
         effect = excluded.effect`,
    );
    for (const permission of permissions) {
      statement.run(permission.nodeUri, permission.principal, permission.level, permission.effect);
    }
  }
}
