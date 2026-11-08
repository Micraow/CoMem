/**
 * 向量索引（架构文档 §8.3 的 `RetrievalIndex` 扩展点、§18 的 `retrieval.engine`）。
 *
 * **KNN 由 `sqlite-vec` 的 `vec0` 完成，这里不自己算距离。** 虚拟表的
 * `embedding MATCH ? AND k = N` 走 C 层的 SIMD 内核，`distance_metric=cosine`
 * 时 `distance = 1 - 余弦`。实测 10,000 条 × 1024 维：不带候选集过滤 8–10ms，
 * 带 1 万条 `uris` 约 78ms（`vec0` 的 `uri IN (...)` 是逐条主键点查）；同一份数据
 * 用 JS 标量循环按 128 维实测 38ms 外推约 300ms。
 *
 * **`uris` 是候选集，过滤下推到 SQL。** 调用方传的是权限过滤后的可读 URI；
 * `model` / `minScore` / `uris` 全部进 `WHERE`，**距离只对候选算**。唯一在 JS 里
 * 做的一步是「与库中真实存在的主键求交」——那是 `vec0` 0.1.9 的缺陷绕行，
 * 见 `#existingUris`。
 *
 * **`uris` 为空数组返回空结果**，不是全库扫描。权限过滤后为空就是没有候选——
 * 退化成全库扫描既慢又是越权：调用方传空数组的意思正是「一个都不许看」。
 */

import type { DatabaseSync, SQLInputValue } from 'node:sqlite';

import type { Logger } from '../../domain/log.js';
import { assertValidVector } from '../../domain/embedding.js';
import { ComemError } from '../../domain/errors.js';
import { toVectorBlob } from './embedding-repository.js';
import { placeholders } from './node-repository.js';

export interface VectorIndexOptions {
  readonly db: DatabaseSync;
  readonly logger: Logger;
}

export interface VectorSearchQuery {
  readonly vector: readonly number[];
  readonly model: string;
  /** 限定候选集（权限过滤后的 URI）。`undefined` = 全库，`[]` = 没有候选 */
  readonly uris?: readonly string[];
  readonly limit: number;
  /** 余弦下限，默认 0（不相关的不要） */
  readonly minScore?: number;
}

export interface VectorHit {
  readonly uri: string;
  readonly score: number;
}

/**
 * 单条 `IN (...)` 的最大参数个数。
 *
 * SQLite 的 `SQLITE_MAX_VARIABLE_NUMBER` 默认是 32766（3.32 起），500 是保守值：
 * 留两个数量级余量，同时让语句文本长度稳定（SQLite 的计划缓存能命中同一条编译
 * 结果，不会因为候选集大小每变一次就重编译）。超过 500 条时按 500 分批查再合并。
 */
const URI_CHUNK_SIZE = 500;

/** `vec0` 的 KNN 查询形态。`k` 与 `MATCH` 必须同时出现，只写 `MATCH` 会报错。 */
const KNN_SQL = `SELECT uri, distance FROM node_embedding
   WHERE embedding MATCH ? AND k = ?
     AND model = ?
     AND distance <= ?`;

function toHit(row: Record<string, unknown>): VectorHit {
  return {
    uri: String(row['uri']),
    // `vec0` 返回余弦距离，转成「越大越相关」的分数（§8.4 的排序口径）。
    score: 1 - Number(row['distance']),
  };
}

export class SqliteVectorIndex {
  readonly #db: DatabaseSync;
  readonly #logger: Logger;

  constructor(options: VectorIndexOptions) {
    this.#db = options.db;
    this.#logger = options.logger;
  }

  async search(query: VectorSearchQuery): Promise<readonly VectorHit[]> {
    if (!Number.isInteger(query.limit) || query.limit <= 0) {
      throw new ComemError('INVALID_ARGUMENT', 'limit 必须是正整数。', { limit: query.limit });
    }
    const minScore = query.minScore ?? 0;
    if (!Number.isFinite(minScore)) {
      throw new ComemError('INVALID_ARGUMENT', 'minScore 必须是有限数。', { minScore });
    }
    // 维度取查询向量自身长度：虚拟表的维度由 `ensureSchema` 与配置对齐，两者不一致
    // 时启动期已经报过 `CONFLICT`，这里只挡 NaN / 全零 / 空向量。
    assertValidVector(query.vector, query.vector.length);

    if (query.uris !== undefined && query.uris.length === 0) {
      this.#logger.debug('向量检索：候选集为空', { model: query.model });
      return [];
    }

    const candidates = this.#nearest(query, 1 - minScore);
    // 同分按 URI 升序：`vec0` 的平局顺序不在它的契约里，只按分数排会让「同一份
    // 输入」在两次查询之间换顺序，而排序稳定性是 §8.4 合并规则的前提。
    candidates.sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      if (left.uri === right.uri) {
        return 0;
      }
      return left.uri < right.uri ? -1 : 1;
    });

    const returned = candidates.slice(0, query.limit);
    this.#logger.debug('向量检索', {
      model: query.model,
      candidates: candidates.length,
      returned: returned.length,
    });
    return returned;
  }

  /**
   * KNN 查询。`distanceLimit` 是 `1 - minScore`：分数下限换算成距离上限，过滤在
   * SQL 里做，不把不相关的行读出来再丢。
   *
   * 候选集超过 `URI_CHUNK_SIZE` 时分批查（SQLite 的绑定变量上限），每批各取
   * `limit` 条再合并——全局前 `limit` 名一定落在某一批的前 `limit` 名里。
   */
  #nearest(query: VectorSearchQuery, distanceLimit: number): VectorHit[] {
    const uris = query.uris;
    const params: SQLInputValue[] = [
      toVectorBlob(query.vector),
      query.limit,
      query.model,
      distanceLimit,
    ];

    if (uris === undefined) {
      return this.#db
        .prepare(`${KNN_SQL} ORDER BY distance`)
        .all(...params)
        .map(toHit);
    }

    // 先与库中真实存在的主键求交，见 `#existingUris` 的说明。
    const existing = this.#existingUris();
    const candidates = uris.filter((uri) => existing.has(uri));
    if (candidates.length === 0) {
      return [];
    }

    const hits: VectorHit[] = [];
    for (let start = 0; start < candidates.length; start += URI_CHUNK_SIZE) {
      const chunk = candidates.slice(start, start + URI_CHUNK_SIZE);
      const statement = this.#db.prepare(
        `${KNN_SQL} AND uri IN (${placeholders(chunk.length)}) ORDER BY distance`,
      );
      for (const row of statement.all(...params, ...chunk)) {
        hits.push(toHit(row));
      }
    }
    return hits;
  }

  /**
   * 库中真实存在的主键。
   *
   * **为什么不能把候选集直接放进 `uri IN (...)`**：`sqlite-vec` 0.1.9 的 KNN
   * 查询里，`uri IN (...)` 只要有一个值不存在，整条查询返回**空**（非 KNN 的
   * `uri IN (...)` 正常，已实测）。而「权限候选集里的 URI 刚被并发删除」是正常
   * 竞态——静默返回空等于「语义检索偶尔查不出东西」，是 AGENTS §1 说的最难发现
   * 的缺陷。
   *
   * 代价是一次全表主键扫描：实测 1 万行 5.8ms，10 万行约 58ms。**不要换成按
   * 候选集点查**——`vec0` 的主键点查约 7µs/条，1 万条要 70ms，比全表扫贵一个
   * 数量级。
   */
  #existingUris(): ReadonlySet<string> {
    const uris = new Set<string>();
    for (const row of this.#db.prepare('SELECT uri FROM node_embedding').all()) {
      uris.add(String(row['uri']));
    }
    return uris;
  }
}
