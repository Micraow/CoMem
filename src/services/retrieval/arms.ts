/**
 * 负责：按 `retrieval.engine` 执行三臂（fts / vector / hybrid）的查询、查询嵌入与向量候选集。
 * 不负责：候选合并与排序（`merge.ts`）、命中补全（`enrich.ts`）、重排本身（`rerank.ts`）。
 */

import { ComemError } from '../../domain/errors.js';
import type { LevelWeights } from '../../domain/ranking.js';
import {
  reciprocalRankFusion,
  type FusedHit,
  type RetrievalEngine,
  type RetrievalIndex,
  type SearchHit,
} from '../../domain/retrieval.js';

import type { EmbedOutcome } from '../embedding.js';
import { budgetExceeded, remainingBudget, withBudget } from './budget.js';
import { enrichVectorHits } from './enrich.js';
import { applyHotness, rankHits, type HotnessSettings } from './merge.js';
import type { RerankStage } from './rerank.js';
import type { FindOptions, RetrieveOutcome, VectorRetrievalDeps } from './types.js';

/**
 * 向量检索的候选集：`scope` 下全部可读节点。
 *
 * 与 `grep` 用同一个 `**`（跨 `/` 的子树），区别只在数量——`grep` 有
 * `GREP_CANDIDATE_LIMIT` 兜底，向量检索**不能截断**：传少了会漏掉「BM25 排
 * 第 50 但向量排第 1」的命中，而 RRF 的意义正是在两个后端都有完整候选时融合。
 */
const VECTOR_CANDIDATE_PATTERN = '**';

/**
 * 向量检索候选集的上限：不截断。
 *
 * `GlobQuery.limit` 是必填参数（`validateGlobQuery` 要求正整数），这里用最大
 * 安全整数表达「全部」。代价是每次向量检索都要把 `scope` 下的可读 URI 全查一遍
 * （O(n) 行）——§8.2 已经承认过这种「先取全量候选再过滤」的代价，十万节点以上
 * 必须换成带权限列的 ANN 索引。
 */
const VECTOR_CANDIDATE_LIMIT = Number.MAX_SAFE_INTEGER;

/**
 * 查询嵌入的预算（毫秒），只在接口层给了 `deadlineAt` 时生效。
 *
 * 6000 是**推导值**：一次检索只嵌一条短查询（不是批量回填的 128 条），供应商往返
 * 通常 < 1 秒（§15.9 的检索阶段「向量变体含查询嵌入的网络往返」与整轮 20–100ms
 * 的量级）。6 秒给冷启动与跨地域网关留 6 倍余量，同时让「供应商挂住」在用户可
 * 感知之前退化成 FTS 结果。
 */
const QUERY_EMBED_TIMEOUT_MS = 6_000;

/** 三臂的执行依赖。`vector` 在 `engine === 'fts5'` 时是 `null`（构造期已保证）。 */
export interface ArmsDeps {
  readonly index: RetrievalIndex;
  readonly engine: RetrievalEngine;
  readonly vector: VectorRetrievalDeps | null;
  readonly levelWeights: LevelWeights;
  readonly rerank: RerankStage;
  readonly hotness: HotnessSettings;
}

export class Arms {
  readonly #index: RetrievalIndex;
  readonly #engine: RetrievalEngine;
  /**
   * 向量检索的三个依赖。`engine === 'fts5'` 时是 `null`，其余情况在构造期保证
   * 非空——这样查询路径上不需要反复判空，也不会把「少注入一个依赖」变成运行时
   * 的静默降级。
   */
  readonly #vector: VectorRetrievalDeps | null;
  readonly #levelWeights: LevelWeights;
  readonly #rerank: RerankStage;
  readonly #hotness: HotnessSettings;

  constructor(deps: ArmsDeps) {
    this.#index = deps.index;
    this.#engine = deps.engine;
    this.#vector = deps.vector;
    this.#levelWeights = deps.levelWeights;
    this.#rerank = deps.rerank;
    this.#hotness = deps.hotness;
  }

  /**
   * 按配置的引擎分派。`fts5` 分支与接入向量前的实现逐字一致（回归基线）。
   *
   * ## 引擎差异（§18 的 `retrieval.engine`）
   *
   * | engine | 行为 |
   * |---|---|
   * | `fts5` | 只用关键词检索。**这是回归基线，行为与接入向量前逐字一致** |
   * | `vector` | 只用语义检索。降级时返回空命中并在日志里说明，**不退回 FTS5** |
   * | `hybrid` | 并行跑两者，`reciprocalRankFusion` 融合。向量降级时退化成纯 FTS5 |
   *
   * `vector` 降级不退回 FTS5，是因为用户显式选了语义检索：静默换引擎会给出
   * 「看起来能用、其实换了实现」的结果，比空命中更让人困惑。
   *
   * 配了 `telemetry.hotness.weight` 时，热度只调整排序分，不改变相关性判断：
   * 没有数字阈值——三种引擎的分数量纲不同（FTS5 是 `bm25` 取负、向量是余弦、
   * 融合是 RRF），一个固定的阈值换引擎就失效（§8.5）。
   *
   * **重排开启时候选集放宽到 `topN`。** 重排的意义是把「融合排第 20、但其实最
   * 相关」的候选提上来；只拿 `limit` 条去重排，`topN > limit` 的配置就永远用不满。
   * 关闭重排时 `candidateLimit === limit`，与接线前逐字一致。
   */
  async retrieve(text: string, options: FindOptions, limit: number): Promise<RetrieveOutcome> {
    const candidateLimit = Math.max(limit, this.#rerank.candidateFloor);
    // 「现在」只取一次：FTS 臂与向量臂的候选集必须用同一个时刻。分两次取，一条
    // 恰好在两次取时刻之间开始生效的记忆会出现在向量候选里、却不在 FTS 候选里。
    const asOf = new Date().toISOString();
    if (this.#engine === 'fts5') {
      const hits = await this.#index.search({
        text,
        scopes: options.scopes,
        principals: options.principals,
        contextTypes: options.contextTypes,
        levels: options.levels,
        memoryTypes: options.memoryTypes,
        updatedAfter: options.updatedAfter,
        updatedBefore: options.updatedBefore,
        asOf,
        limit: candidateLimit,
      });
      const ranked = rankHits(hits, candidateLimit, this.#levelWeights).map((hit) => ({
        ...hit,
        ranks: null,
      }));
      const reranked = await this.#rerank.apply(text, ranked, options);
      return {
        hits: applyHotness(this.#hotness, reranked.hits.slice(0, limit)),
        degradation: null,
        rerankFailure: reranked.failure,
      };
    }

    const vector = this.#vector;
    if (vector === null) {
      // 构造期已经挡掉；走到这里说明实例被绕过构造器篡改过。
      throw new ComemError('INTERNAL', `检索后端 ${this.#engine} 缺少向量依赖。`, {
        engine: this.#engine,
      });
    }
    return this.#engine === 'vector'
      ? this.#retrieveVector(vector, text, options, limit, candidateLimit, asOf)
      : this.#retrieveHybrid(vector, text, options, limit, candidateLimit, asOf);
  }

  /**
   * 纯向量检索。
   *
   * 降级时返回空命中 + 原因，**不退回 FTS5**（见 `retrieve` 的引擎差异）。调用方从
   * 日志与 `search` 的 `plan.reason` 能看到原因。
   *
   * `asOf` 由 `retrieve` 算一次传进来，见那里的注释（两臂必须同一个时刻）。
   */
  async #retrieveVector(
    vector: VectorRetrievalDeps,
    text: string,
    options: FindOptions,
    limit: number,
    candidateLimit: number,
    asOf: string,
  ): Promise<RetrieveOutcome> {
    const embedded = await this.#embedQuery(vector, text, options);
    const queryVector = embedded.vectors[0];
    if (embedded.degraded || queryVector === undefined) {
      return {
        hits: [],
        degradation: embedded.reason ?? '向量检索没有拿到查询向量。',
        rerankFailure: null,
      };
    }

    const model = vector.embedding.model;
    if (model === null) {
      return {
        hits: [],
        degradation: '没有配置嵌入模型，无法按模型过滤向量。',
        rerankFailure: null,
      };
    }

    const uris = await this.#readableUris(options, asOf);
    const raw = await vector.vectors.search({
      vector: queryVector,
      model,
      uris,
      limit: candidateLimit,
    });
    const enriched = enrichVectorHits(raw, options, vector.nodes);
    const ranked = rankHits(enriched, candidateLimit, this.#levelWeights).map(
      (hit, index) => ({
        ...hit,
        ranks: { fts5: null, vector: index + 1, hybrid: null },
      }),
    );
    const reranked = await this.#rerank.apply(text, ranked, options);
    return {
      hits: applyHotness(this.#hotness, reranked.hits.slice(0, limit)),
      degradation: null,
      rerankFailure: reranked.failure,
    };
  }

  /**
   * 混合检索：并行跑 FTS5 与向量，RRF 融合。
   *
   * **融合用两个后端自己的名次**，不先按分数重排：RRF 的输入就是「各后端认为谁
   * 更相关」。层级权重是**文档先验**（摘要比原文更可能相关），不是后端分数，所以
   * 它乘在每个后端对融合分的贡献上（`levelWeight / (k + rank)`）——作用在名次上，
   * 不改变「用名次而不是分数融合」这条性质（§8.5）。
   *
   * 权重为 1 时退化成标准 RRF，与接线前逐位相同。
   *
   * 向量降级时退化成纯 FTS5，并把原因带回给 `search` 的 `plan`。
   *
   * `asOf` 由 `retrieve` 算一次传进来，见那里的注释（两臂必须同一个时刻）。
   */
  async #retrieveHybrid(
    vector: VectorRetrievalDeps,
    text: string,
    options: FindOptions,
    limit: number,
    candidateLimit: number,
    asOf: string,
  ): Promise<RetrieveOutcome> {
    // 两路并行：串行会让一次 hybrid 查询把两倍的索引延迟叠在用户身上。
    const [ftsHits, embedded] = await Promise.all([
      this.#index.search({
        text,
        scopes: options.scopes,
        principals: options.principals,
        contextTypes: options.contextTypes,
        levels: options.levels,
        memoryTypes: options.memoryTypes,
        updatedAfter: options.updatedAfter,
        updatedBefore: options.updatedBefore,
        asOf,
        limit: candidateLimit,
      }),
      this.#embedQuery(vector, text, options),
    ]);

    const queryVector = embedded.vectors[0];
    const model = vector.embedding.model;
    let vectorHits: SearchHit[] = [];
    let degradation: string | null = null;

    if (embedded.degraded || queryVector === undefined) {
      degradation = embedded.reason ?? '向量检索没有拿到查询向量。';
    } else if (model === null) {
      degradation = '没有配置嵌入模型，无法按模型过滤向量。';
    } else {
      const uris = await this.#readableUris(options, asOf);
      const raw = await vector.vectors.search({
        vector: queryVector,
        model,
        uris,
        limit: candidateLimit,
      });
      vectorHits = enrichVectorHits(raw, options, vector.nodes);
    }

    const fused = reciprocalRankFusion(
      [
        { engine: 'fts5', hits: ftsHits },
        { engine: 'vector', hits: vectorHits },
      ],
      // 层级先验在融合前作用于每个后端的贡献（见方法注释与 §8.5）。
      { limit: candidateLimit, levelWeights: this.#levelWeights },
    );

    const scored = fused.map((hit: FusedHit) => ({
      uri: hit.uri,
      contextType: hit.contextType,
      memoryType: hit.memoryType,
      level: hit.level,
      abstract: hit.abstract,
      score: hit.score,
      ranks: hit.ranks,
    }));

    const reranked = await this.#rerank.apply(text, scored, options);
    return {
      hits: applyHotness(this.#hotness, reranked.hits.slice(0, limit)),
      degradation,
      rerankFailure: reranked.failure,
    };
  }

  /**
   * 查询嵌入：把「供应商慢」收敛成降级结果，而不是让工具等满总上限。
   *
   * 只在接口层给了 `deadlineAt` 时收窄：预算取 `QUERY_EMBED_TIMEOUT_MS` 与剩余
   * 时间中较小的那个，并同时传给适配器（真正中止 HTTP）与本地闸门（防供应商
   * 不响应 `timeoutMs`）。没有 `deadlineAt` 时保持原样——HTTP / Hook 路径的行为
   * 不变，供应商超时仍由配置决定。
   */
  async #embedQuery(
    vector: VectorRetrievalDeps,
    text: string,
    options: FindOptions,
  ): Promise<EmbedOutcome> {
    const budget = remainingBudget(options.deadlineAt, QUERY_EMBED_TIMEOUT_MS);
    options.onUpstream?.('embedding');
    try {
      if (budget === null) {
        return await vector.embedding.embed([text]);
      }
      return await withBudget(
        vector.embedding.embed([text], { timeoutMs: budget }),
        budget,
        () => budgetExceeded('查询嵌入（embedding）', budget),
      );
    } catch (error) {
      const failure = ComemError.from(error);
      return {
        vectors: [],
        degraded: true,
        reason: `查询嵌入不可用（${failure.code}）：${failure.message}`,
      };
    }
  }

  /**
   * 向量检索的候选集：`scope` 下**全部**可读 URI。
   *
   * 不能传 `limit` 条：传少了会漏掉「BM25 排第 50 但向量排第 1」的命中，而 RRF
   * 的意义正是两个后端都有完整候选。代价是每次查询把可读 URI 全查一遍（O(n)），
   * 见 `VECTOR_CANDIDATE_LIMIT` 的说明。
   *
   * 权限过滤在这里完成（`glob` 的 SQL 里就是 `node_permission` 的 allow/deny
   * 谓词），所以传进 `SqliteVectorIndex.search` 的已经是可读集合——向量索引不需要
   * 再查一次权限。
   *
   * **`memoryTypes` / 时间范围 / 有效期也在这里下推。** `vec0` 的 `uris` 就是候选集
   * 过滤：先取最近邻再在 JS 里按类型丢掉，等于把「距离排第 20、但类型匹配」的候选
   * 浪费掉。把它们交给 `GlobQuery` 的元数据条件，KNN 只在匹配的候选上算距离；
   * hybrid 的融合因此发生在两路都已过滤之后，而不是融合后才筛。
   *
   * **`asOf` 必须传。** 候选集是 kNN 的名额：带上一批已失效的历史版本，top-k 里
   * 一半会是同一段正文的旧版本，用户看到重复内容而且新的那条被挤掉。这个过滤在
   * SQL 里做（`GlobQuery.asOf`），不是取回候选后再筛。
   */
  async #readableUris(options: FindOptions, asOf: string): Promise<readonly string[]> {
    return this.#index.glob({
      pattern: VECTOR_CANDIDATE_PATTERN,
      scopes: options.scopes,
      principals: options.principals,
      memoryTypes: options.memoryTypes,
      updatedAfter: options.updatedAfter,
      updatedBefore: options.updatedBefore,
      asOf,
      limit: VECTOR_CANDIDATE_LIMIT,
    });
  }
}
