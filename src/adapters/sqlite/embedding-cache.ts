/**
 * 嵌入缓存的读写（架构文档 §8.1 的 `embedding_cache` 表）。
 *
 * ## 缓存的是什么
 *
 * `(model, content_digest) → 向量`。同一段正文出现在两个 URI 下、同一段查询被
 * 重复执行、换模型前先跑过一次回填——这些场景都不该再打一次供应商。
 *
 * 与 `node_embedding` 的分工：
 *
 * | 表 | 主键 | 回答的问题 |
 * |---|---|---|
 * | `node_embedding` | `uri` | 这个**节点**的向量是不是最新的（检索读它） |
 * | `embedding_cache` | `(model, content_digest)` | 这份**正文**嵌过吗（写路径读它） |
 *
 * 两张表都不是真相：删掉它们只会让下一次嵌入重新打供应商，结果逐位相同。
 *
 * ## 淘汰：FIFO（插入顺序），不是 LRU
 *
 * 先淘汰 `created_at` 最小的行。**选它的理由是不在命中路径上写库**：LRU 要在每次
 * 命中时更新「最近使用时间」，而命中是写路径上最热的操作，为了一次淘汰把它变成
 * 写事务不划算——缓存存在的意义是省掉网络，不是省掉一次索引维护。
 *
 * **失效场景（说清楚）**：一份很早插入、之后被反复命中的正文，会先于一份只嵌过
 * 一次的近期正文被淘汰。代价是那份正文下次要重新打一次供应商，结果仍然正确。
 * 换句话说，FIFO 的错判只影响命中率，不影响数据。
 *
 * **默认上限 20,000 条**（`providers.embedding.cache.maxEntries`）。按常见维度算：
 * 1024 维每行 4 KiB，共约 80 MiB；1536 维约 120 MiB。这不是「能存多少」的容量，
 * 而是「磁盘不是无限的」这一条下的保守取值：它覆盖 100 倍于 `pnpm eval` 的语料量
 * （52 篇 + 105 条查询），也覆盖中等规模部署里反复出现的那部分正文；再大的库靠
 * 供应商调用补，那是延迟成本，不是正确性成本。上限按**条数**而不是字节是因为
 * 条数可以直接对上「读了几次供应商」，字节数要按维度换算，反而不好判断。
 *
 * ## 失败降级
 *
 * 缓存是派生数据（§7 的同一原则）。`getMany` / `put` 的异常**不在这里吞**：调用方
 * （`services/embedding.ts`）按「没命中」降级并记日志——它可以决定一次嵌入是否
 * 值得因为缓存坏掉而失败，而这个答案永远是「不值得」。这里只负责把数据库错误原样
 * 抛出去，不做半套兜底。
 */

import type { DatabaseSync } from 'node:sqlite';

import type { Logger } from '../../domain/log.js';
import { ComemError } from '../../domain/errors.js';
import { withWriteTransaction } from './database.js';
import { fromVectorBlob, toVectorBlob } from './embedding-repository.js';
import { placeholders } from './node-repository.js';

/** 一行缓存。`dimension` 是 `vector` 的长度，读路径用它做一致性校验。 */
export interface EmbeddingCacheEntry {
  readonly model: string;
  readonly contentDigest: string;
  readonly dimension: number;
  readonly vector: readonly number[];
}

export interface EmbeddingCacheDeps {
  readonly db: DatabaseSync;
  readonly logger: Logger;
  /**
   * 最多保留多少行。达到上限后按 `created_at` 升序淘汰最旧的行。
   *
   * 非法值直接抛：`0` 会被读成「无限」还是「不缓存」取决于实现，而两种都有人
   * 以为是另一种。要关缓存用 `providers.embedding.cache.enabled: false`。
   */
  readonly maxEntries: number;
}

/**
 * 单条 `IN (...)` 的最大参数个数。
 *
 * 与 `EmbeddingRepository.URI_CHUNK_SIZE` 同一个理由（SQLite 的绑定变量上限）与
 * 同一个取值（500 留足两个数量级余量）。一次 `embed()` 的 `maxBatchSize` 默认
 * 128，正常不会触发分片；回填路径可能一次查几千条。
 */
const DIGEST_CHUNK_SIZE = 500;

export class EmbeddingCacheRepository {
  readonly #db: DatabaseSync;
  readonly #logger: Logger;
  readonly #maxEntries: number;

  constructor(deps: EmbeddingCacheDeps) {
    if (!Number.isInteger(deps.maxEntries) || deps.maxEntries <= 0) {
      throw new ComemError('INVALID_ARGUMENT', '缓存上限必须是正整数。', {
        maxEntries: deps.maxEntries,
      });
    }
    this.#db = deps.db;
    this.#logger = deps.logger;
    this.#maxEntries = deps.maxEntries;
  }

  get maxEntries(): number {
    return this.#maxEntries;
  }

  /**
   * 批量读。返回 `contentDigest → 向量`，未命中的 digest 不在结果里。
   *
   * `dimension` 与行里记录的维度不一致时**当未命中**并记 warn：主键是
   * `(model, content_digest)`，模型名没变而维度变了（同一个模型换了量化版本、
   * 或者配置写错了维度）时主键仍然命中，但向量长度已经对不上——直接返回会让
   * `assertValidVector` 在写 `node_embedding` 时抛错，而写 `node_embedding` 的
   * 路径不该因为缓存坏掉而失败。
   *
   * 只 warn 一次（聚合计数），不逐行打：一次 128 条的批量里 128 行维度全不一致
   * 是同一件事，逐行刷屏只会把真正的问题淹掉。
   */
  getMany(
    model: string,
    digests: readonly string[],
    dimension: number,
  ): ReadonlyMap<string, readonly number[]> {
    const found = new Map<string, readonly number[]>();
    if (digests.length === 0) {
      return found;
    }

    let mismatched = 0;
    for (let start = 0; start < digests.length; start += DIGEST_CHUNK_SIZE) {
      const chunk = digests.slice(start, start + DIGEST_CHUNK_SIZE);
      const rows = this.#db
        .prepare(
          `SELECT content_digest, dimension, vector FROM embedding_cache
           WHERE model = ? AND content_digest IN (${placeholders(chunk.length)})`,
        )
        .all(model, ...chunk);

      for (const row of rows) {
        if (Number(row['dimension']) !== dimension) {
          mismatched += 1;
          continue;
        }
        const vector = fromVectorBlob(row['vector']);
        // 空 BLOB 是坏行（列 NOT NULL，但手工改过库的情况不必崩）。当未命中。
        if (vector.length === 0) {
          continue;
        }
        found.set(String(row['content_digest']), vector);
      }
    }

    if (mismatched > 0) {
      this.#logger.warn('嵌入缓存维度与配置不一致，按未命中处理', {
        model,
        expected: dimension,
        rows: mismatched,
      });
    }
    return found;
  }

  /**
   * 批量写。同一个 `(model, content_digest)` 覆盖向量，**不刷新 `created_at`**。
   *
   * 不刷新是有意的：淘汰按「插入顺序」而不是「最近写入顺序」。写入只发生在未命中
   * 之后，所以「最近写入」等价于「刚刚被淘汰过」——拿它排序等于把刚淘汰的又留下。
   */
  put(entries: readonly EmbeddingCacheEntry[]): void {
    if (entries.length === 0) {
      return;
    }
    const createdAt = new Date().toISOString();
    withWriteTransaction(this.#db, () => {
      const upsert = this.#db.prepare(
        `INSERT INTO embedding_cache (model, content_digest, vector, dimension, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(model, content_digest) DO UPDATE SET
           vector = excluded.vector,
           dimension = excluded.dimension`,
      );
      for (const entry of entries) {
        upsert.run(
          entry.model,
          entry.contentDigest,
          toVectorBlob(entry.vector),
          entry.dimension,
          createdAt,
        );
      }
      this.#trim();
    });
  }

  /** 行数。只服务 `#trim` 的上限判断，不对外。 */
  #count(): number {
    const row = this.#db.prepare('SELECT COUNT(*) AS total FROM embedding_cache').get();
    return Number(row?.['total'] ?? 0);
  }

  /**
   * 淘汰到 `maxEntries` 以内。
   *
   * 必须在写事务里调用（`put` 已经包了一层）：`DELETE` 与 `INSERT` 要么一起生效，
   * 要么一起回滚，不会出现「插进去但没淘汰」把上限顶破一个窗口。
   */
  #trim(): void {
    const total = this.#count();
    if (total <= this.#maxEntries) {
      return;
    }
    const deleted = Number(
      this.#db
        .prepare(
          `DELETE FROM embedding_cache WHERE rowid IN (
             SELECT rowid FROM embedding_cache ORDER BY created_at ASC, rowid ASC LIMIT ?
           )`,
        )
        .run(total - this.#maxEntries).changes,
    );
    this.#logger.debug('嵌入缓存淘汰', { deleted, maxEntries: this.#maxEntries });
  }
}
