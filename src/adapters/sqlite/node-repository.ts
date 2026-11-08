/**
 * 节点读模型仓储（架构文档 §8.1 的 `node` 表、§6 的路径语义）。
 *
 * 只负责 `node` 表：路径前缀匹配、子节点枚举、批量写入与子树删除。全文索引与
 * 物化权限分别在 `retrieval-index.ts` 与 `permission-repository.ts`，它们复用这里的
 * 两个 SQL 片段（`globPrefixPattern` / `placeholders`）——转义规则只能有一份，
 * 否则某个仓储漏转义 `*` 就会在「带星号的目录名」上产生越权候选。
 */

import type { DatabaseSync, SQLInputValue, SQLOutputValue } from 'node:sqlite';

import { ComemError } from '../../domain/errors.js';
import type { Level } from '../../domain/level.js';
import type { Logger } from '../../domain/log.js';
import type { ContextType, NodeKind, NodeStatus } from '../../domain/node.js';
import type { UriScope } from '../../domain/uri.js';
import { withWriteTransaction } from './database.js';

/** `node` 表的一行（架构文档 §8.1）。 */
export interface NodeRow {
  readonly uri: string;
  readonly parentUri: string;
  readonly scope: UriScope;
  readonly kind: NodeKind;
  readonly contextType: ContextType;
  readonly memoryType: string | null;
  readonly level: Level;
  readonly abstract: string | null;
  readonly bodyDigest: string;
  readonly size: number;
  readonly updatedAt: string;
  readonly status: NodeStatus;
}

export interface NodeRepositoryDeps {
  readonly db: DatabaseSync;
  readonly logger: Logger;
}

/**
 * 热度衰减的输入（架构文档 §17.5、`0009_access_tracking.sql`）。
 *
 * 与 `NodeRow` 分开：`NodeRow` 是检索的读模型（`uri` / `level` / `abstract` 这些
 * 一次查询就要的列），访问计数只在算热度时用。混进去会让「检索命中」这个热路径
 * 每次都多读两列，而它们只在控制台的统计页上有意义。
 */
export interface NodeAccessStats {
  readonly uri: string;
  /** 被检索命中并注入的次数。从没访问过是 0。 */
  readonly accessCount: number;
  /** ISO 8601；从没访问过是 `null`。 */
  readonly lastAccessedAt: string | null;
}

/** 列顺序与 `NodeRow` 字段顺序一致，映射函数只依赖这个常量。 */
const NODE_COLUMN_NAMES = [
  'uri',
  'parent_uri',
  'scope',
  'kind',
  'context_type',
  'memory_type',
  'level',
  'abstract',
  'body_digest',
  'size',
  'updated_at',
  'status',
] as const;

const NODE_COLUMNS = NODE_COLUMN_NAMES.join(', ');

/**
 * 子树前缀模式：把前缀里的 GLOB 元字符转义后补 `/*`。
 *
 * 用 `GLOB` 而不是 `LIKE`：URI 的根标识与大写敏感（§6.2 只做 NFC，不做大小写折叠），
 * `comem://user/Alice` 与 `comem://user/alice` 是两个不同用户。`LIKE` 对 ASCII
 * 大小写不敏感，会把前者的子树算进后者的范围；`GLOB` 是二进制比较，与主键的排序
 * 规则一致。
 *
 * 转义是必须的：URI 的路径段允许 `*` `?` `[` `]` `_` `%`（§6.2 只禁控制字符、
 * 反斜杠、斜杠与保留名），不转义时 `comem://user/alice/a*b` 的前缀会匹配
 * `comem://user/alice/aXb` 的子树。GLOB 用「字符类里放字面量」转义（`*` → `[*]`，
 * `[` → `[[]`）。
 *
 * 补 `/*` 而不是 `*` 是为了段边界：`comem://user/alice` 不能命中
 * `comem://user/alice2`。
 *
 * 三个仓储共用这一份实现（`node` / `node_permission` / `node_fts` 的前缀过滤），
 * 保证转义规则不会各写一遍。
 */
export function globPrefixPattern(prefix: string): string {
  return `${prefix.replace(/[[\]*?]/g, (char) => `[${char}]`)}/*`;
}

/** `IN (?, ?, ...)` 的占位符列表。`count` 由调用方按已校验的数组长度传入。 */
export function placeholders(count: number): string {
  return new Array<string>(count).fill('?').join(', ');
}

function text(value: SQLOutputValue | undefined): string {
  return String(value);
}

function nullableText(value: SQLOutputValue | undefined): string | null {
  return value === null || value === undefined ? null : String(value);
}

function integer(value: SQLOutputValue | undefined): number {
  return Number(value);
}

/**
 * 数据库行 → `NodeRow`。
 *
 * 枚举列用 `as` 收窄：写入路径（`upsert`）只接受领域类型，表里出现的值一定是枚举
 * 成员；这里再写一遍校验只会给每个字段加一个不可能走到的分支。
 */
function toNodeRow(row: Record<string, SQLOutputValue>): NodeRow {
  return {
    uri: text(row['uri']),
    parentUri: text(row['parent_uri']),
    scope: text(row['scope']) as UriScope,
    kind: text(row['kind']) as NodeKind,
    contextType: text(row['context_type']) as ContextType,
    memoryType: nullableText(row['memory_type']),
    level: text(row['level']) as Level,
    abstract: nullableText(row['abstract']),
    bodyDigest: text(row['body_digest']),
    size: integer(row['size']),
    updatedAt: text(row['updated_at']),
    status: text(row['status']) as NodeStatus,
  };
}

export class NodeRepository {
  readonly #db: DatabaseSync;
  readonly #logger: Logger;

  constructor(deps: NodeRepositoryDeps) {
    this.#db = deps.db;
    this.#logger = deps.logger;
  }

  get(uri: string): NodeRow | null {
    const row = this.#db.prepare(`SELECT ${NODE_COLUMNS} FROM node WHERE uri = ?`).get(uri);
    return row === undefined ? null : toNodeRow(row);
  }

  /**
   * 直接子节点，按 name 升序。
   *
   * 同一父目录下的子节点共享 `parentUri + '/'` 前缀，所以按完整 URI 升序等价于按
   * 最后一段的码点升序，不需要 SQLite 没有的 `basename()`。
   */
  children(parentUri: string): readonly NodeRow[] {
    return this.#db
      .prepare(`SELECT ${NODE_COLUMNS} FROM node WHERE parent_uri = ? ORDER BY uri ASC`)
      .all(parentUri)
      .map(toNodeRow);
  }

  /** 子树全部节点（不含自身），按 uri 升序。 */
  descendants(uri: string): readonly NodeRow[] {
    return this.#db
      .prepare(`SELECT ${NODE_COLUMNS} FROM node WHERE uri GLOB ? ORDER BY uri ASC`)
      .all(globPrefixPattern(uri))
      .map(toNodeRow);
  }

  /**
   * 批量 upsert，单事务。
   *
   * 用 `ON CONFLICT(uri) DO UPDATE` 而不是先查后写：重建索引时同一批里可能既有
   * 新节点又有旧节点，逐条分支会把一次写入变成 N 次读 + N 次写。
   */
  upsert(rows: readonly NodeRow[]): void {
    if (rows.length === 0) {
      return;
    }
    withWriteTransaction(this.#db, () => {
      const statement = this.#db.prepare(
        `INSERT INTO node (${NODE_COLUMNS}) VALUES (${placeholders(NODE_COLUMN_NAMES.length)})
         ON CONFLICT(uri) DO UPDATE SET
           parent_uri = excluded.parent_uri,
           scope = excluded.scope,
           kind = excluded.kind,
           context_type = excluded.context_type,
           memory_type = excluded.memory_type,
           level = excluded.level,
           abstract = excluded.abstract,
           body_digest = excluded.body_digest,
           size = excluded.size,
           updated_at = excluded.updated_at,
           status = excluded.status`,
      );
      for (const row of rows) {
        statement.run(
          row.uri,
          row.parentUri,
          row.scope,
          row.kind,
          row.contextType,
          row.memoryType,
          row.level,
          row.abstract,
          row.bodyDigest,
          row.size,
          row.updatedAt,
          row.status,
        );
      }
    });
    this.#logger.debug('节点索引写入', { count: rows.length });
  }

  /**
   * 删除自身与子树，返回删除的行数。
   *
   * 只删 `node`。`node_fts` 由 `SqliteFtsIndex.deleteByUri` 负责：两张表属于同一个
   * 写事务的调用方（索引重建、`forget`），拆开是为了让「删索引」这件事只有一个入口。
   */
  deleteTree(uri: string): number {
    const deleted = Number(
      withWriteTransaction(this.#db, () =>
        this.#db
          .prepare(`DELETE FROM node WHERE uri = ? OR uri GLOB ?`)
          .run(uri, globPrefixPattern(uri))
          .changes,
      ),
    );
    this.#logger.debug('节点索引子树删除', { uri, deleted });
    return deleted;
  }

  /**
   * 路径前缀匹配：自身或子树，按 uri 升序。
   *
   * `limit` 省略时返回全部。负数或非整数不做特殊处理——它来自已校验的配置，
   * 这里再加一层校验只会把「配置错误」变成「静默返回空」。
   */
  listByScope(prefix: string, options: { readonly limit?: number } = {}): readonly NodeRow[] {
    const params: SQLInputValue[] = [prefix, globPrefixPattern(prefix)];
    const limit = options.limit;
    const sql =
      limit === undefined
        ? `SELECT ${NODE_COLUMNS} FROM node WHERE uri = ? OR uri GLOB ? ORDER BY uri ASC`
        : `SELECT ${NODE_COLUMNS} FROM node WHERE uri = ? OR uri GLOB ? ORDER BY uri ASC LIMIT ?`;
    if (limit !== undefined) {
      params.push(limit);
    }
    return this.#db
      .prepare(sql)
      .all(...params)
      .map(toNodeRow);
  }

  count(): number {
    const row = this.#db.prepare('SELECT COUNT(*) AS total FROM node').get();
    return Number(row?.['total'] ?? 0);
  }

  /**
   * 批量累加访问计数。**不走 `updated_at`**——访问不是修改。
   *
   * 一次检索命中 50 条，逐个 UPDATE 是 50 次事务（每次 `BEGIN IMMEDIATE` 都要拿
   * 写锁并落盘）。这里一条事务 + 一条预编译语句，50 条是 50 次 `run`。
   *
   * **不存在的 URI 静默跳过**：索引与磁盘不同步是正常状态（文件被外部删除、
   * 重建索引前），为它抛错会让一次正常的检索失败。返回的是实际命中的行数。
   *
   * **不去重**：同一个 URI 在入参里出现两次就是两次访问。合并检索结果时按 URI
   * 去重是调用方的职责（§8.4 的合并规则），这里再做一次会让「命中两次」这件事
   * 在计数上消失。
   */
  recordAccess(uris: readonly string[], at: Date): number {
    if (uris.length === 0) {
      return 0;
    }
    if (Number.isNaN(at.getTime())) {
      // 非法 Date 调 `toISOString()` 抛的是 `RangeError: Invalid time value`，
      // 消息里没有字段名，上层只能看到一个内部错误。
      throw new ComemError('INVALID_ARGUMENT', '访问时间不是合法的 Date。', { at: at.toString() });
    }

    const timestamp = at.toISOString();
    const updated = withWriteTransaction(this.#db, () => {
      const statement = this.#db.prepare(
        'UPDATE node SET access_count = access_count + 1, last_accessed_at = ? WHERE uri = ?',
      );
      let changes = 0;
      for (const uri of uris) {
        changes += Number(statement.run(timestamp, uri).changes);
      }
      return changes;
    });

    this.#logger.debug('节点访问计数累加', { uris: uris.length, updated });
    return updated;
  }

  /**
   * 批量设置过期时间（`0010_ttl.sql`、架构文档 §11.7）。返回实际命中的行数。
   *
   * `expiresAt === null` 是**显式取消过期**，与「从没设过」在列上都是 NULL——这是
   * 有意的：`expires_at` 只有「一个绝对时刻」和「没有」两种取值，不引入第三个哨兵
   * 值（`'1970-01-01'` 会让「从没设过」和「已经过期」在 `WHERE` 里不可区分）。
   *
   * **不动 `updated_at`**：设置过期时间不是内容修改。与 `recordAccess` 同一条理由
   * ——热度衰减按 `updated_at` 算「这条记忆有多新」，把运维动作当成内容写入会让一条
   * 从没改过的老记忆看起来刚被更新过。
   *
   * 不存在的 URI 静默跳过（索引与磁盘不同步是正常状态，见 `recordAccess`）。
   */
  setExpiry(uris: readonly string[], expiresAt: Date | null): number {
    if (uris.length === 0) {
      return 0;
    }
    if (expiresAt !== null && Number.isNaN(expiresAt.getTime())) {
      throw new ComemError('INVALID_ARGUMENT', '过期时间不是合法的 Date。', {
        at: expiresAt.toString(),
      });
    }

    const timestamp = expiresAt === null ? null : expiresAt.toISOString();
    const updated = withWriteTransaction(this.#db, () =>
      this.#db
        .prepare(`UPDATE node SET expires_at = ? WHERE uri IN (${placeholders(uris.length)})`)
        .run(timestamp, ...uris).changes,
    );
    this.#logger.debug('节点的过期时间已设置', { uris: uris.length, updated, expiresAt: timestamp });
    return Number(updated);
  }

  /**
   * 清扫第一段：`expires_at < now` 的节点 `status` 置 `archived`，**这里不删文件**
   * （软过期，架构文档 §11.7）。物理删除是第二段（`selectPurgeable` + 文件/索引删除），
   * 由 `TtlService` 编排——仓储不碰文件系统，删文件需要 `FileSystemService`。
   *
   * 为什么第一段仍是软过期：TTL 配错（把 7 天写成 7 秒）时，`archived` 还能改回来；
   * 物理删除没有回滚。两段式让「配错」在 `retentionDays` 的宽度里可观测、可撤销。
   *
   * **同时写 `archived_at`**（`0002_archived_at.sql`）：第二段靠它算「归档了多久」。
   * 归档是「内容状态的时间戳」，不是内容写入，所以**不动 `updated_at`**。
   *
   * **不动 `node_permission`**：归档节点仍要能按权限查到——「这条记忆归档了」是内容
   * 状态，不是「这个人失去了访问权」。删权限行会让「归档」变成「对所有人消失」。
   *
   * **幂等**：`status <> 'archived'` 让重复调用不重复计数（第二次返回空）。
   *
   * `ORDER BY expires_at ASC LIMIT ?` 让「积压很多」时先清最老的，同时给每轮一个上界
   * （`memory.ttl.sweepBatchSize`）——一次更新整表会长时间持有写锁，把并发请求卡在
   * `busy_timeout` 上。
   */
  sweepExpired(now: Date, limit: number): readonly string[] {
    const nowIso = now.toISOString();
    const expired = withWriteTransaction(this.#db, () => {
      const rows = this.#db
        .prepare(
          `SELECT uri FROM node
            WHERE expires_at IS NOT NULL AND expires_at < ? AND status <> 'archived'
            ORDER BY expires_at ASC
            LIMIT ?`,
        )
        .all(nowIso, limit);
      const uris = rows.map((row) => text(row['uri']));
      if (uris.length === 0) {
        return uris;
      }
      const statement = this.#db.prepare(
        `UPDATE node SET status = 'archived', archived_at = ? WHERE uri = ?`,
      );
      for (const uri of uris) {
        statement.run(nowIso, uri);
      }
      return uris;
    });
    if (expired.length > 0) {
      this.#logger.info('TTL 清扫：过期节点已归档。', { count: expired.length, uris: expired });
    }
    return expired;
  }

  /**
   * 清扫第二段的候选：已归档且归档时刻早于 `cutoff`（`archived_at < cutoff`）的节点。
   *
   * 只返回 `kind = 'document'` 的叶子节点。目录节点不入选：目录里可能还有子项，
   * 整棵删掉会顺手删掉别人没归档的兄弟记忆；目录行随最后一条子项被删而残留为空行，
   * 由后续重建索引清掉（与 §6.5「索引是派生」一致）。物理删除文件是逐文件的动作，
   * 目标是「这条记忆」而不是「这个目录」。
   *
   * `archived_at IS NOT NULL` 是硬条件：`NULL` 表示「不知道归档时刻」（本迁移之前
   * 的 archived 行、或非 TTL 途径产生的 archived 行），不把未知当成「很久以前」——
   * 物理删除不可逆，宁可永远不删。
   *
   * `ORDER BY archived_at ASC LIMIT ?` 与第一段同一理由：先删最老的、每轮一个上界。
   */
  selectPurgeable(cutoff: Date, limit: number): readonly string[] {
    const cutoffIso = cutoff.toISOString();
    const rows = this.#db
      .prepare(
        `SELECT uri FROM node
          WHERE status = 'archived' AND archived_at IS NOT NULL AND archived_at < ?
            AND kind = 'document'
          ORDER BY archived_at ASC
          LIMIT ?`,
      )
      .all(cutoffIso, limit);
    return rows.map((row) => text(row['uri']));
  }

  /**
   * 读热度所需的两个字段，**按入参顺序**返回。
   *
   * 不在索引里的 URI 不返回（不是补一条 `accessCount: 0`）：补零会让「这条记忆
   * 不在索引里」和「这条记忆从没被访问过」变成同一件事，而前者是数据不一致，
   * 排查时需要的正是这个区别。
   */
  readAccessStats(uris: readonly string[]): readonly NodeAccessStats[] {
    if (uris.length === 0) {
      // 空 IN () 是语法错误。调用方在「一条都没命中」时不该产生一次查询。
      return [];
    }

    const rows = this.#db
      .prepare(
        `SELECT uri, access_count, last_accessed_at FROM node WHERE uri IN (${placeholders(uris.length)})`,
      )
      .all(...uris);

    const byUri = new Map<string, NodeAccessStats>();
    for (const row of rows) {
      const uri = text(row['uri']);
      byUri.set(uri, {
        uri,
        accessCount: integer(row['access_count']),
        lastAccessedAt: nullableText(row['last_accessed_at']),
      });
    }

    return uris
      .map((uri) => byUri.get(uri))
      .filter((stats): stats is NodeAccessStats => stats !== undefined);
  }
}
