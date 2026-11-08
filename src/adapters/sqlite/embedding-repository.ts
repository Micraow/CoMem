/**
 * 嵌入向量仓储（架构文档 §8.1 的 `node_embedding` 表）。
 *
 * 只负责这张表的读写：批量 upsert、按 URI 读、按段边界/模型删、回填游标。余弦
 * 计算在 `vector-index.ts`，嵌入调用在 `adapters/llm/embedding-provider.ts`——三者
 * 拆开是因为它们的失败模式不同：仓储失败是磁盘/事务，索引失败是数据（模型换了、
 * 维度不匹配），提供者失败是网络。
 *
 * **为什么 `iterMissingUris` 查的是 `node`。** 「还没有嵌入的 URI」这个集合定义在
 * `node` 上，`node_embedding` 只能回答「已经嵌了哪些」。反查 `node` 而不是给
 * `node_embedding` 加一列 `embedded`，让「缺一行」本身就是缺失的表示——不需要在
 * 两个地方维护同一个布尔值。
 */

import type { DatabaseSync, SQLInputValue } from 'node:sqlite';

import type { Logger } from '../../domain/log.js';
import { ComemError } from '../../domain/errors.js';
import { withWriteTransaction } from './database.js';
import { globPrefixPattern, placeholders } from './node-repository.js';

/** `node_embedding` 表的一行。 */
export interface EmbeddingRow {
  readonly uri: string;
  readonly model: string;
  readonly dimension: number;
  readonly vector: Uint8Array;
  readonly scale: number;
  readonly contentDigest: string;
  readonly createdAt: string;
}

export interface EmbeddingRepositoryDeps {
  readonly db: DatabaseSync;
  readonly logger: Logger;
}

/**
 * 单条 `IN (...)` 的最大参数个数。
 *
 * SQLite 的 `SQLITE_MAX_VARIABLE_NUMBER` 默认是 32766（3.32 起；更早的版本是 999），
 * 500 留足两个数量级的余量。分片还有一个副作用是好的：语句文本长度稳定，SQLite 的
 * 计划缓存能命中同一条编译结果，不会因为候选集大小每变一次就重编译。
 */
const URI_CHUNK_SIZE = 500;

const COLUMN_NAMES = [
  'uri',
  'model',
  'dimension',
  'vector',
  'scale',
  'content_digest',
  'created_at',
] as const;

const COLUMNS = COLUMN_NAMES.join(', ');

function text(value: unknown): string {
  return String(value);
}

/**
 * BLOB 列 → `Uint8Array`。
 *
 * `node:sqlite` 对 BLOB 就返回 `Uint8Array`，这里只是让类型收窄。空数组是兜底：
 * 列是 `NOT NULL`，正常路径走不到；真读到空值时让下游的维度校验先报错，比在
 * 映射函数里抛一个没有上下文的异常更容易定位。
 */
function blob(value: unknown): Uint8Array {
  return value instanceof Uint8Array ? value : new Uint8Array();
}

function toEmbeddingRow(row: Record<string, unknown>): EmbeddingRow {
  return {
    uri: text(row['uri']),
    model: text(row['model']),
    dimension: Number(row['dimension']),
    vector: blob(row['vector']),
    scale: Number(row['scale']),
    contentDigest: text(row['content_digest']),
    createdAt: text(row['created_at']),
  };
}

export class EmbeddingRepository {
  readonly #db: DatabaseSync;
  readonly #logger: Logger;

  constructor(deps: EmbeddingRepositoryDeps) {
    this.#db = deps.db;
    this.#logger = deps.logger;
  }

  /**
   * 批量 upsert，单事务。
   *
   * 用 `ON CONFLICT(uri) DO UPDATE` 而不是先查后写：回填时同一批里可能既有新节点
   * 又有重嵌的旧节点，逐条分支会把一次写入变成 N 次读 + N 次写。`created_at` 跟着
   * 一起更新——它记的是「这份向量什么时候算出来的」，不是「这行什么时候插进去的」。
   */
  upsert(rows: readonly EmbeddingRow[]): void {
    if (rows.length === 0) {
      return;
    }
    withWriteTransaction(this.#db, () => {
      const statement = this.#db.prepare(
        `INSERT INTO node_embedding (${COLUMNS})
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(uri) DO UPDATE SET
           model = excluded.model,
           dimension = excluded.dimension,
           vector = excluded.vector,
           scale = excluded.scale,
           content_digest = excluded.content_digest,
           created_at = excluded.created_at`,
      );
      for (const row of rows) {
        statement.run(
          row.uri,
          row.model,
          row.dimension,
          row.vector,
          row.scale,
          row.contentDigest,
          row.createdAt,
        );
      }
    });
    this.#logger.debug('嵌入写入', { count: rows.length });
  }

  get(uri: string): EmbeddingRow | null {
    const row = this.#db
      .prepare(`SELECT ${COLUMNS} FROM node_embedding WHERE uri = ?`)
      .get(uri);
    return row === undefined ? null : toEmbeddingRow(row);
  }

  /**
   * 按 URI 批量读。
   *
   * 分片是为了绕开 SQLite 的绑定变量上限（见 `URI_CHUNK_SIZE`）。返回顺序不保证
   * 与入参一致：调用方要么按 URI 建映射，要么只关心集合本身——向量检索属于后者。
   */
  getMany(uris: readonly string[]): readonly EmbeddingRow[] {
    if (uris.length === 0) {
      return [];
    }
    const rows: EmbeddingRow[] = [];
    for (let start = 0; start < uris.length; start += URI_CHUNK_SIZE) {
      const chunk = uris.slice(start, start + URI_CHUNK_SIZE);
      const statement = this.#db.prepare(
        `SELECT ${COLUMNS} FROM node_embedding WHERE uri IN (${placeholders(chunk.length)})`,
      );
      for (const row of statement.all(...chunk)) {
        rows.push(toEmbeddingRow(row));
      }
    }
    return rows;
  }

  /**
   * 删除索引行。`recursive` 为真时按段边界删整棵子树。
   *
   * 与 `retrieval-index.ts` 的 `deleteByUri` 同一套子句：`uri = ?` 命中自身，
   * `GLOB 前缀 + '/*'` 命中子树。用 `GLOB` 而不是 `LIKE`——`LIKE` 的 `_` 是单字符
   * 通配符，而 URI 段允许 `_`，`a_b` 的子树会被算进 `axb` 的范围。
   */
  deleteByUri(uri: string, options: { readonly recursive?: boolean } = {}): number {
    const recursive = options.recursive ?? false;
    const clause = recursive ? 'uri = ? OR uri GLOB ?' : 'uri = ?';
    const params: SQLInputValue[] = recursive ? [uri, globPrefixPattern(uri)] : [uri];
    const deleted = withWriteTransaction(this.#db, () =>
      Number(this.#db.prepare(`DELETE FROM node_embedding WHERE ${clause}`).run(...params).changes),
    );
    this.#logger.debug('嵌入删除', { uri, recursive, deleted });
    return deleted;
  }

  /** 按模型过滤；换模型后清空用。返回删除行数。 */
  deleteByModel(model: string): number {
    const deleted = withWriteTransaction(this.#db, () =>
      Number(this.#db.prepare('DELETE FROM node_embedding WHERE model = ?').run(model).changes),
    );
    this.#logger.debug('嵌入按模型删除', { model, deleted });
    return deleted;
  }

  count(model?: string): number {
    const row =
      model === undefined
        ? this.#db.prepare('SELECT COUNT(*) AS total FROM node_embedding').get()
        : this.#db.prepare('SELECT COUNT(*) AS total FROM node_embedding WHERE model = ?').get(model);
    return Number(row?.['total'] ?? 0);
  }

  /**
   * 回填用：返回还没有嵌入的 URI（按 URI 排序保证可重放）。
   *
   * 游标是 `after` 而不是 `OFFSET`：回填过程中会不断插入新行，`OFFSET` 在同一份
   * 结果集上会跳行——插了 100 行之后再取第 101 条，实际跳过了 100 条没处理过的。
   * 按 URI 排序 + 严格大于游标，重放几次都只会拿到同一批。
   *
   * 「还没嵌入」按 `model` 判定：换模型后旧向量还在表里，但它们对这个模型而言是
   * 缺失的，回填会全部重算。要清空用 `deleteByModel`，两件事分开做。
   */
  iterMissingUris(
    model: string,
    options: { readonly limit: number; readonly after?: string },
  ): readonly string[] {
    if (!Number.isInteger(options.limit) || options.limit <= 0) {
      throw new ComemError('INVALID_ARGUMENT', 'limit 必须是正整数。', { limit: options.limit });
    }
    const after = options.after;
    const cursorClause = after === undefined ? '' : 'AND n.uri > ?';
    const params: SQLInputValue[] =
      after === undefined ? [model, options.limit] : [model, after, options.limit];
    const sql = `SELECT n.uri AS uri
       FROM node n
       WHERE NOT EXISTS (
           SELECT 1 FROM node_embedding e
           WHERE e.uri = n.uri AND e.model = ?
         )
         ${cursorClause}
       ORDER BY n.uri ASC
       LIMIT ?`;
    return this.#db
      .prepare(sql)
      .all(...params)
      .map((row) => text(row['uri']));
  }
}
