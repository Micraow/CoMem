/**
 * 嵌入向量仓储（架构文档 §8.1 的 `node_embedding` 表）。
 *
 * 存储是 `sqlite-vec` 的 `vec0` 虚拟表：`uri` 是主键，`model` / `content_digest`
 * 是普通列，`embedding` 是 `FLOAT[N]` 向量列，距离度量 `cosine`（`distance =
 * 1 - 余弦`）。余弦与量化在扩展的 C 层完成，这里只做行级读写。
 *
 * ## 为什么维度不在迁移里
 *
 * `vec0` 的维度在 `CREATE VIRTUAL TABLE` 时固定，而维度来自
 * `providers.embedding.dimension`——换模型就变。写死在静态 SQL 里会让「换模型」
 * 变成「静默跳过所有行」，所以虚拟表由 `ensureSchema` 在启动时按配置建，迁移
 * （`0007_embedding.sql`）只建记录模型与维度的单行表 `embedding_model`。
 *
 * ## 为什么 `iterMissingUris` 查的是 `node`
 *
 * 「还没有嵌入的 URI」这个集合定义在 `node` 上，`node_embedding` 只能回答「已经
 * 嵌了哪些」。反查 `node` 而不是给 `node_embedding` 加一列 `embedded`，让「缺一行」
 * 本身就是缺失的表示——不需要在两个地方维护同一个布尔值。
 *
 * ## 失败模式的分工
 *
 * 仓储失败是磁盘 / 事务，索引失败是数据（模型换了、维度不匹配），提供者失败是
 * 网络。三者拆开是因为处置完全不同。
 */

import type { DatabaseSync, SQLInputValue } from 'node:sqlite';

import type { Logger } from '../../domain/log.js';
import { normalizeVector } from '../../domain/embedding.js';
import { ComemError } from '../../domain/errors.js';
import { withWriteTransaction } from './database.js';
import { globPrefixPattern, placeholders } from './node-repository.js';

/** `node_embedding` 表的一行。 */
export interface EmbeddingRow {
  readonly uri: string;
  readonly model: string;
  readonly contentDigest: string;
  readonly vector: readonly number[];
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

const COLUMNS = 'uri, model, content_digest, embedding';

/** `Float32Array` 的元素字节数。向量列的 BLOB 是它的原始字节。 */
const FLOAT_BYTES = Float32Array.BYTES_PER_ELEMENT;

/**
 * 建向量虚拟表。`reindex` 重建维度时要用同一份定义，所以导出。
 *
 * 维度直接拼进 SQL 文本：`vec0` 的 `FLOAT[N]` 是 DDL 语法的一部分，没有绑定参数
 * 能表达它。因此这里先校验它是正整数——拼进 SQL 的值必须先过类型。
 */
export function createEmbeddingTable(db: DatabaseSync, dimension: number): void {
  if (!Number.isInteger(dimension) || dimension <= 0) {
    throw new ComemError('INVALID_ARGUMENT', '向量维度必须是正整数。', { dimension });
  }
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS node_embedding USING vec0(
    uri TEXT PRIMARY KEY,
    model TEXT,
    content_digest TEXT,
    embedding FLOAT[${String(dimension)}] distance_metric=cosine
  )`);
}

/**
 * 浮点数组 → `FLOAT[N]` 列的 BLOB。
 *
 * `node:sqlite` 的绑定参数只认 `Uint8Array`（BLOB）。`Float32Array` 与它位模式
 * 相同，按同一段内存重解释即可，不要走 `Array.from` 再转——那是逐元素拷贝。
 */
export function toVectorBlob(vector: readonly number[]): Uint8Array {
  const floats = new Float32Array(vector);
  return new Uint8Array(floats.buffer, floats.byteOffset, floats.byteLength);
}

/**
 * `FLOAT[N]` 列的 BLOB → 浮点数组。
 *
 * 空数组是兜底：列可空，正常路径不会读到 `null`；真读到时空向量会让调用方的
 * 维度校验先报错，比在映射函数里抛一个没有上下文的异常更容易定位。
 *
 * 导出给 `embedding-cache.ts`：缓存表存的是同一种 `Float32Array` 原始字节，
 * 两份实现必须逐位一致，否则「命中」与「重新嵌入」写进 `node_embedding` 的
 * 向量不同。
 */
export function fromVectorBlob(value: unknown): number[] {
  if (!(value instanceof Uint8Array)) {
    return [];
  }
  const floats = new Float32Array(value.buffer, value.byteOffset, value.byteLength / FLOAT_BYTES);
  return Array.from(floats);
}

function text(value: unknown): string {
  return String(value);
}

function toEmbeddingRow(row: Record<string, unknown>): EmbeddingRow {
  return {
    uri: text(row['uri']),
    model: text(row['model']),
    contentDigest: text(row['content_digest']),
    vector: fromVectorBlob(row['embedding']),
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
   * 确保虚拟表存在，且维度与配置一致。
   *
   * 维度不一致时**抛 `CONFLICT`** 并带 `stored` / `configured`：`vec0` 的维度在
   * 建表时固定，配置改小 / 改大之后旧表里的向量既插不进去也查不出来。静默跳过会
   * 让语义检索永久返回空且不报错——使用者只会看到「记忆里明明有这条，就是搜不到」。
   *
   * `model` 也一起写进元数据：它是「当前库里的向量属于哪个向量空间」的标注，换模型
   * 后旧行靠 `model = ?` 过滤，清理是 `deleteByModel` 的显式操作。
   */
  ensureSchema(dimension: number, model: string): void {
    const stored = this.storedDimension();
    if (stored !== null && stored !== dimension) {
      throw new ComemError(
        'CONFLICT',
        `向量维度与库中记录不一致：库中 ${String(stored)} 维，配置 ${String(dimension)} 维。`,
        {
          stored,
          configured: dimension,
          hint: '运行 `reindex --only=embeddings` 按当前配置重建向量表。',
        },
      );
    }
    createEmbeddingTable(this.#db, dimension);
    // 单行表：第一次启动插入，之后把模型与维度刷成当前配置（幂等）。
    this.#db
      .prepare(
        `INSERT INTO embedding_model (id, model, dimension, created_at) VALUES (1, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET model = excluded.model, dimension = excluded.dimension`,
      )
      .run(model, dimension, new Date().toISOString());
    this.#logger.debug('向量表就绪', { model, dimension });
  }

  /**
   * 批量 upsert，单事务。
   *
   * `vec0` **不支持 UPSERT**：`INSERT ... ON CONFLICT(uri) DO UPDATE` 报
   * `UPSERT not implemented for virtual table`，`INSERT OR REPLACE` 报
   * `UNIQUE constraint failed`。所以按主键先删后插，两条语句在同一个事务里。
   *
   * `content_digest` 记的是「这份向量对应哪份正文」（FNV-1a），回填时用它跳过
   * 没变的节点；它跟着向量一起更新，不是「这行什么时候插进去的」。
   */
  upsert(rows: readonly EmbeddingRow[]): void {
    if (rows.length === 0) {
      return;
    }
    withWriteTransaction(this.#db, () => {
      const remove = this.#db.prepare('DELETE FROM node_embedding WHERE uri = ?');
      const insert = this.#db.prepare(
        `INSERT INTO node_embedding (uri, model, content_digest, embedding) VALUES (?, ?, ?, ?)`,
      );
      for (const row of rows) {
        remove.run(row.uri);
        // 归一化放在写入边界：「存进去的向量是单位长度」是这张表的唯一不变量，
        // 分散到每个调用方就迟早有人忘。余弦度量对长度不敏感，归一化不改变分数，
        // 但换成内积 / L2 时不需要回填。
        insert.run(row.uri, row.model, row.contentDigest, toVectorBlob(normalizeVector(row.vector)));
      }
    });
    this.#logger.debug('嵌入写入', { count: rows.length });
  }

  get(uri: string): EmbeddingRow | null {
    const row = this.#db.prepare(`SELECT ${COLUMNS} FROM node_embedding WHERE uri = ?`).get(uri);
    return row === undefined ? null : toEmbeddingRow(row);
  }

  /**
   * 按 URI 批量读。
   *
   * 分片是为了绕开 SQLite 的绑定变量上限（见 `URI_CHUNK_SIZE`）。返回顺序不保证
   * 与入参一致：调用方要么按 URI 建映射，要么只关心集合本身。
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
   * 通配符，而 URI 段允许 `_`，`a_b` 的子树会被算进 `axb` 的范围（跨用户越权）。
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
   *
   * `NOT EXISTS` 相关子查询在 `vec0` 上成立（走主键点查，不是全表扫），所以不需要
   * 「把已嵌入 URI 读进内存 Set 再差集」。代价实测：1 万 `node` 行 × 1 万向量行
   * 约 67ms，属于一次性回填可接受的范围；十万级要换成临时表，那时这条查询会先变慢。
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

  /** 当前库里的维度；没有元数据行（还没建过向量表）时返回 `null`。 */
  storedDimension(): number | null {
    const row = this.#db.prepare('SELECT dimension FROM embedding_model WHERE id = 1').get();
    if (row === undefined) {
      return null;
    }
    const dimension = Number(row['dimension']);
    return Number.isInteger(dimension) && dimension > 0 ? dimension : null;
  }
}
