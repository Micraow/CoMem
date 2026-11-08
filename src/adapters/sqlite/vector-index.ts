/**
 * 向量索引（架构文档 §8.3 的 `RetrievalIndex` 扩展点、§18 的 `retrieval.engine`）。
 *
 * **暴力余弦，没有 ANN 索引。** 每次查询从 `node_embedding` 读出候选，在 JS 里逐条
 * 算余弦。代价是 O(n·d)：1 万节点 × 1536 维约 1500 万次乘加，本机几十毫秒。这个
 * 量级（单用户、单组、万级节点）用不上 ANN，HNSW / IVF 要额外维护一份图结构，换来的
 * 是「十万节点以上才需要」的查询延迟。**上到十万节点时必须换**——这条注释是现在的
 * 诚实交代，不是「以后再说」的托词。
 *
 * 换句话说：v1 的向量检索**不可扩展**，它只对得起当前的数据规模。写清楚这一点比
 * 留一条看起来能扩展的接口更重要。
 *
 * **模型不匹配的行直接跳过。** 换模型后旧向量还在表里（`deleteByModel` 是显式操作），
 * 但它们的空间与当前查询无关，算出来的余弦是噪音。跳过时记 debug：整库为 0 条命中
 * 时，这条日志是「模型换了但忘了清空」的唯一线索。
 *
 * **`uris` 为空数组返回空结果**，不是全库扫描。权限过滤后为空就是没有候选——退化成
 * 全库扫描既慢又是越权：调用方传空数组的意思正是「一个都不许看」。
 */

import type { DatabaseSync } from 'node:sqlite';

import type { Logger } from '../../domain/log.js';
import { assertValidVector, cosineSimilarity, dequantizeVector } from '../../domain/embedding.js';
import { ComemError } from '../../domain/errors.js';
import type { EmbeddingRepository } from './embedding-repository.js';

export interface VectorIndexOptions {
  readonly db: DatabaseSync;
  readonly embeddings: EmbeddingRepository;
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
 * 全库扫描只读检索需要的列。
 *
 * 不通过 `EmbeddingRepository` 读：它的 `getMany` 按 URI 取，全库扫描是索引自己的
 * 查询。少读 `content_digest` / `created_at` 不是省 IO——它们对相似度没有贡献，
 * 读出来还要构造一个只用了 5 个字段的对象。
 */
const CANDIDATE_COLUMNS = 'uri, model, dimension, vector, scale';

interface VectorCandidate {
  readonly uri: string;
  readonly model: string;
  readonly dimension: number;
  readonly vector: Uint8Array;
  readonly scale: number;
}

/**
 * BLOB 的字节 → int8 分量。
 *
 * SQLite 的 BLOB 是无符号字节序列（`node:sqlite` 给 `Uint8Array`），而量化向量在
 * `domain/embedding.ts` 里是 `Int8Array`。两者位模式相同，按同一段内存重解释即可；
 * 不要用 `Uint8Array.from()` 让 `-127` 走一遍 `ToUint8` 的环绕语义——结果一样，
 * 但读代码的人得停下来推一遍才敢相信。
 */
function toInt8(bytes: Uint8Array): Int8Array {
  return new Int8Array(bytes.buffer, bytes.byteOffset, bytes.length);
}

export class SqliteVectorIndex {
  readonly #db: DatabaseSync;
  readonly #embeddings: EmbeddingRepository;
  readonly #logger: Logger;

  constructor(options: VectorIndexOptions) {
    this.#db = options.db;
    this.#embeddings = options.embeddings;
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
    // 只做有限性与非全零校验：维度由候选行决定（见下面 `candidate.dimension` 的比较），
    // 查询向量自己就是它该有的长度。
    assertValidVector(query.vector, query.vector.length);

    if (query.uris !== undefined && query.uris.length === 0) {
      this.#logger.debug('向量检索：候选集为空', { model: query.model });
      return [];
    }

    const candidates = this.#candidates(query.uris);
    const hits: VectorHit[] = [];
    let skippedByModel = 0;
    let skippedByDimension = 0;

    for (const candidate of candidates) {
      if (candidate.model !== query.model) {
        skippedByModel += 1;
        continue;
      }
      // 维度不同的行是上一个模型留下的：同一张表里换模型后还没清空。
      if (candidate.dimension !== query.vector.length) {
        skippedByDimension += 1;
        continue;
      }
      const score = cosineSimilarity(
        query.vector,
        dequantizeVector(toInt8(candidate.vector), candidate.scale),
      );
      if (score < minScore) {
        continue;
      }
      hits.push({ uri: candidate.uri, score });
    }

    if (skippedByModel > 0 || skippedByDimension > 0) {
      this.#logger.debug('向量检索跳过不匹配的行', {
        model: query.model,
        skippedByModel,
        skippedByDimension,
      });
    }

    // 同分按 URI 升序：只按分数排会让「同一份输入」在 V8 的稳定排序下也依赖读表
    // 顺序，而读表顺序不是查询的一部分。
    hits.sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      if (left.uri === right.uri) {
        return 0;
      }
      return left.uri < right.uri ? -1 : 1;
    });

    const returned = hits.slice(0, query.limit);
    this.#logger.debug('向量检索', {
      model: query.model,
      candidates: candidates.length,
      returned: returned.length,
    });
    return returned;
  }

  /**
   * 读候选行。
   *
   * `uris` 未限定（`undefined`）时全库扫描；这是唯一需要 `db` 的路径，也是为什么
   * 构造参数里同时有 `db` 和 `embeddings`——后者只按 URI 取，不提供「全部」。
   */
  #candidates(uris: readonly string[] | undefined): readonly VectorCandidate[] {
    if (uris !== undefined) {
      return this.#embeddings.getMany(uris);
    }
    return this.#db
      .prepare(`SELECT ${CANDIDATE_COLUMNS} FROM node_embedding`)
      .all()
      .map((row) => ({
        uri: String(row['uri']),
        model: String(row['model']),
        dimension: Number(row['dimension']),
        vector: row['vector'] instanceof Uint8Array ? row['vector'] : new Uint8Array(),
        scale: Number(row['scale']),
      }));
  }
}
