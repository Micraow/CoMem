/**
 * 节点读模型仓储（架构文档 §8.1 的 `node` 表、§6 的路径语义）。
 *
 * 只负责 `node` 表：路径前缀匹配、子节点枚举、批量写入与子树删除。全文索引与
 * 物化权限分别在 `retrieval-index.ts` 与 `permission-repository.ts`，它们复用这里的
 * 两个 SQL 片段（`globPrefixPattern` / `placeholders`）——转义规则只能有一份，
 * 否则某个仓储漏转义 `*` 就会在「带星号的目录名」上产生越权候选。
 */

import type { DatabaseSync, SQLInputValue, SQLOutputValue } from 'node:sqlite';

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
}
