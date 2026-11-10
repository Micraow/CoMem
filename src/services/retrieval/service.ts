/**
 * 负责：`SearchService` 的装配、构造期校验，以及 `find` / `search` / `context` 的编排。
 * 不负责：检索臂、合并排序、重排、路径面、意图分析、交付记账（见同目录各文件）。
 */

import { ComemError } from '../../domain/errors.js';
import type { Logger } from '../../domain/log.js';
import type { AssemblyCandidate, AssemblyOptions } from '../../domain/assembly.js';
import {
  applyQueryFilters,
  compileQueryFilters,
  type QueryFilter,
} from '../../domain/query-filter.js';
import type { GrepHit, RetrievalEngine, SearchPlan } from '../../domain/retrieval.js';

import type { ContextAssembler } from '../context-assembler.js';
import { Arms } from './arms.js';
import { elapsedMs, resolveLimit } from './budget.js';
import { DeliveryTracker } from './delivery.js';
import { IntentStage } from './intent.js';
import { combineReasons, mergeHits } from './merge.js';
import { PathSearch } from './paths.js';
import { RerankStage } from './rerank.js';
import type {
  ContextAssembly,
  ContextOptions,
  FindDiagnostics,
  FindOptions,
  RankedScoredHit,
  RerankFailure,
  RerankHealth,
  RetrieveOutcome,
  RetrievalSettings,
  ScoredSearchResult,
  SearchOptions,
  SearchServiceDeps,
  VectorRetrievalDeps,
} from './types.js';

/** 一天的小时数。`hotnessHalfLifeHours` 的单位是小时，`hotnessScore` 的输入是天。 */
const HOURS_PER_DAY = 24;

export class SearchService {
  readonly #logger: Logger;
  readonly #assembler: ContextAssembler;
  readonly #config: RetrievalSettings;
  readonly #queryFilters: readonly QueryFilter[];
  readonly #engine: RetrievalEngine;
  readonly #arms: Arms;
  readonly #intent: IntentStage;
  readonly #paths: PathSearch;
  readonly #delivery: DeliveryTracker;
  readonly #rerankStage: RerankStage;

  constructor(deps: SearchServiceDeps) {
    this.#logger = deps.logger;
    this.#assembler = deps.assembler;
    this.#config = deps.config;
    // 配置错误在装配期抛出，不是首次查询时——那时已经有人等着结果了。
    this.#queryFilters = compileQueryFilters(deps.config.queryFilters);

    // 默认值只在 `config/schema.ts` 一处。这里不再兜底：兜底会把「配置错了」变成
    // 「配置被忽略」，正是本 wave 要消灭的那类静默失效。
    const hotnessWeight = deps.hotnessWeight;
    const halfLifeHours = deps.hotnessHalfLifeHours;
    if (!Number.isFinite(hotnessWeight) || hotnessWeight < 0) {
      throw new ComemError('INVALID_ARGUMENT', 'hotnessWeight 必须是非负有限数。', {
        hotnessWeight: deps.hotnessWeight,
      });
    }
    if (!Number.isFinite(halfLifeHours) || halfLifeHours <= 0) {
      // 半衰期是除数：0 得到 Infinity，负数让「越旧越热」。都必须在装配期挡掉。
      throw new ComemError('INVALID_ARGUMENT', 'hotnessHalfLifeHours 必须是正的有限数。', {
        hotnessHalfLifeHours: deps.hotnessHalfLifeHours,
      });
    }

    this.#engine = deps.engine ?? 'fts5';
    let vector: VectorRetrievalDeps | null = null;
    if (this.#engine !== 'fts5') {
      if (deps.embedding === undefined || deps.vectors === undefined || deps.nodes === undefined) {
        throw new ComemError(
          'INVALID_ARGUMENT',
          `retrieval.engine = ${this.#engine} 需要注入 embedding / vectors / nodes，否则向量检索没有可用的数据来源。`,
          {
            engine: this.#engine,
            missing: [
              ...(deps.embedding === undefined ? ['embedding'] : []),
              ...(deps.vectors === undefined ? ['vectors'] : []),
              ...(deps.nodes === undefined ? ['nodes'] : []),
            ],
          },
        );
      }
      vector = {
        embedding: deps.embedding,
        vectors: deps.vectors,
        nodes: deps.nodes,
      };
    }

    this.#rerankStage = new RerankStage({
      rerank: deps.rerank, logger: deps.logger,
      levelWeights: deps.config.levelWeights, filesystem: deps.filesystem,
    });
    this.#arms = new Arms({
      index: deps.index, engine: this.#engine, vector,
      levelWeights: deps.config.levelWeights, rerank: this.#rerankStage,
      hotness: {
        weight: hotnessWeight, halfLifeDays: halfLifeHours / HOURS_PER_DAY,
        accessStats: deps.accessStats,
      },
    });
    this.#intent = new IntentStage({ llm: deps.llm, sessions: deps.sessions, logger: deps.logger });
    this.#paths = new PathSearch({
      index: deps.index, filesystem: deps.filesystem,
      authorizer: deps.authorizer, logger: deps.logger,
    });
    this.#delivery = new DeliveryTracker({
      ledger: deps.ledger, sessions: deps.sessions, logger: deps.logger,
      recordAccess: deps.recordAccess, dedupTurns: deps.config.assembly.dedupTurns,
    });
  }

  /** 重排健康度快照（`/health` 与 MCP `health` 读它）；状态在 `rerank.ts`。 */
  get rerankHealth(): RerankHealth {
    return this.#rerankStage.health;
  }

  /**
   * §8.4 的 `find`：单条 query，不做意图分析。
   *
   * 过滤后为空**直接返回空数组，不调索引**：空查询没有「相关」可比，任何实现给出
   * 的结果都是随机的，而这些随机结果会被当成「用户这句话对应的记忆」写进召回账本
   * （§8.8）。引擎差异见 `arms.ts` 的 `retrieve`。
   */
  async find(query: string, options: FindOptions): Promise<readonly RankedScoredHit[]> {
    const diagnostics = await this.findWithDiagnostics(query, options);
    return diagnostics.hits;
  }

  /**
   * 与 `find` 同一次检索，额外返回向量 / 重排的降级原因。
   *
   * 给「降级必须可见」的出口用（MCP `find` / `rule_search`）。`find` 继续只返回
   * 命中：其它调用方（HTTP、Hook、`memory.search`）的输出契约里没有这一列，加了
   * 反而要改一圈协议。
   *
   * **这里记访问，`context` 不走这里。** 命中列表本身就是交付物，返回即算一次使用
   * （§11.7）；`mode=context` 交付的是组装后的注入块，只该记活到最后的条目，
   * 所以 `contextWithDiagnostics` 直接用 `#findWithOutcome`，在组装之后自己记。
   */
  async findWithDiagnostics(query: string, options: FindOptions): Promise<FindDiagnostics> {
    const outcome = await this.#findWithOutcome(query, options);
    // 记的是「返回给调用方的命中」，不是候选集：截断与阈值都在 `arms.ts` 的 `retrieve` 里做完。
    this.#delivery.recordHits(outcome.hits);
    return {
      hits: outcome.hits,
      degradation: outcome.degradation,
      rerankFailure: outcome.rerankFailure,
    };
  }

  /**
   * `find` 的内部实现。返回 `degradation` 让 `search` 能把「向量降级」写进
   * `plan.reason`（`find` 的返回体里没有 plan 这一列）。
   */
  async #findWithOutcome(query: string, options: FindOptions): Promise<RetrieveOutcome> {
    const startedAt = process.hrtime.bigint();
    const limit = resolveLimit(options.limit);
    const filtered = applyQueryFilters(query, this.#queryFilters);

    if (filtered === '') {
      this.#logger.info('检索查询过滤后为空，跳过', {
        subject: options.subject,
        queryLength: query.length,
        returned: 0,
        durationMs: elapsedMs(startedAt),
      });
      return { hits: [], degradation: null, rerankFailure: null };
    }

    const outcome = await this.#arms.retrieve(filtered, options, limit);
    if (outcome.degradation !== null) {
      this.#logger.warn('向量检索降级', {
        subject: options.subject,
        engine: this.#engine,
        reason: outcome.degradation,
        returned: outcome.hits.length,
      });
    }
    this.#logger.info('检索完成', {
      subject: options.subject,
      queryLength: filtered.length,
      returned: outcome.hits.length,
      durationMs: elapsedMs(startedAt),
    });
    return outcome;
  }

  /**
   * §8.4 的 `search`：先做意图分析（0–5 条 TypedQuery），再逐条 `find` 并合并。
   *
   * 与 `find` 的差别不只是返回体：入口多了一层**重写**。指代（「那它呢」）与复合
   * 意图（「之前那个 X 和 Y」）在 `find` 里只能得到一条字面查询。
   *
   * 三条不能静默的路径与 limit 语义见 `intent.ts` 的 `analyze`、`merge.ts` 的 `mergeHits`。
   */
  async search(query: string, options: SearchOptions): Promise<ScoredSearchResult> {
    const startedAt = process.hrtime.bigint();
    const limit = resolveLimit(options.limit);
    const filtered = applyQueryFilters(query, this.#queryFilters);

    if (filtered === '') {
      const plan: SearchPlan = {
        original: query,
        queries: [],
        analyzed: true,
        reason: null,
        elapsedMs: elapsedMs(startedAt),
      };
      this.#logger.info('检索查询过滤后为空，跳过意图分析', {
        subject: options.subject,
        queryLength: query.length,
        returned: 0,
        durationMs: plan.elapsedMs,
      });
      return { hits: [], plan };
    }

    const analysis = await this.#intent.analyze(filtered, options);

    if (analysis.queries.length === 0) {
      const plan: SearchPlan = {
        original: query,
        queries: [],
        analyzed: analysis.analyzed,
        reason: analysis.reason,
        elapsedMs: elapsedMs(startedAt),
      };
      this.#logger.info('意图分析判定不该检索，返回空命中', {
        subject: options.subject,
        queryLength: filtered.length,
        returned: 0,
        durationMs: plan.elapsedMs,
      });
      return { hits: [], plan };
    }

    // 并行：5 条查询串行执行会把一次 search 变成 5 倍延迟，而索引查询是可重入的只读。
    const ran = await Promise.all(
      analysis.queries.map(async (typedQuery) => ({
        typedQuery,
        outcome: await this.#findWithOutcome(typedQuery.text, {
          scopes: options.scopes,
          subject: options.subject,
          principals: options.principals,
          contextTypes: options.contextTypes,
          levels: options.levels,
          memoryTypes: options.memoryTypes,
          updatedAfter: options.updatedAfter,
          updatedBefore: options.updatedBefore,
          limit,
          // 预算与归因必须穿透到每一路 `find`：只在入口收窄的话，5 条 TypedQuery
          // 各自重排时仍会等满自己的预算。
          deadlineAt: options.deadlineAt,
          onUpstream: options.onUpstream,
        }),
      })),
    );

    const hits = mergeHits(ran, limit);
    // 合并去重之后才是「返回给调用方的命中」。5 条 TypedQuery 各记一次会把
    // 写放大乘上查询条数，同一条记忆被多条查询命中时也只该算一次访问。
    this.#delivery.recordHits(hits);
    const plan: SearchPlan = {
      original: query,
      queries: analysis.queries,
      analyzed: analysis.analyzed,
      // 向量降级与意图分析失败是两条独立的降级路径，都要能解释。`plan.reason`
      // 是 `SearchPlan` 上唯一能承载「这次为什么不是完整结果」的字段，两条都
      // 非空时拼接，不覆盖任何一条。
      reason: combineReasons(analysis.reason, [
        ...ran.map((entry) => entry.outcome.degradation),
        ...ran.map((entry) =>
          entry.outcome.rerankFailure === null
            ? null
            : `重排不可用（${entry.outcome.rerankFailure.reason}），结果使用融合分`,
        ),
      ]),
      elapsedMs: elapsedMs(startedAt),
    };
    this.#logger.info('检索完成（含意图分析）', {
      subject: options.subject,
      queryLength: filtered.length,
      queries: analysis.queries.length,
      analyzed: analysis.analyzed,
      returned: hits.length,
      durationMs: plan.elapsedMs,
    });
    return { hits, plan };
  }

  /** §8.4 的 `grep`：正则 + 路径范围，行级命中带前后文（实现在 `paths.ts`）。 */
  async grep(
    pattern: string,
    options: FindOptions & { readonly contextLines?: number },
  ): Promise<readonly GrepHit[]> {
    return this.#paths.grep(pattern, options);
  }

  /** §8.4 的 `glob`：路径通配（实现在 `paths.ts`）。 */
  async glob(pattern: string, options: FindOptions): Promise<readonly string[]> {
    return this.#paths.glob(pattern, options);
  }

  /**
   * §8.6 的 `context` 变体：返回可直接注入模型的文本。
   *
   * `find` → `AssemblyCandidate[]` →（可选）账本去重 → 组装 → 账本写回 → 访问记账。
   *
   * `memoryType` 从索引透传：§8.6 的起始层级按记忆类型区分（`events` 从 L1 概览起，
   * 其余从 L0 摘要起）。少了这一列，事件类记忆会一律退化成一句话摘要。
   *
   * **访问记账放在组装之后，记的是 `AssemblyResult.items`。** 「使用」= 进入了调用方
   * 的上下文（§11.7）。命中被预算截断、被配额挤掉、被同一渲染正文去重掉的条目不
   * 在 `items` 里，它们没进调用方的上下文，所以不该记。这里不重新算一遍预算：预算
   * 的唯一实现是 `assembleContext`，照着候选集再推一遍会立刻漂移。
   *
   * 账本写回也放在组装之后：只记**真的给了正文**的条目（§8.7 规则 1），只给 URI 的
   * 条目由 `RecallLedger.record` 自己跳过。
   */
  async context(query: string, options: ContextOptions): Promise<ContextAssembly> {
    return (await this.contextWithDiagnostics(query, options)).assembly;
  }

  /**
   * `context` 的带诊断版本：`search` 的 `mode=context` 用它把「这次降级了」写进
   * 返回值。
   *
   * 只返回组装结果时，向量不可用会表现为 `Context: 0 item(s)`——与「记忆里没有」
   * 无法区分。诊断列与 `findWithDiagnostics` 同一套来源，不另算一遍。
   *
   * **不走 `findWithDiagnostics`**：那个入口在返回命中时就记访问，而这里交给调用方
   * 的是组装后的注入块。走它会让被截断的条目也记一次（§11.7）。
   */
  async contextWithDiagnostics(
    query: string,
    options: ContextOptions,
  ): Promise<{
    readonly assembly: ContextAssembly;
    readonly degradation: string | null;
    readonly rerankFailure: RerankFailure | null;
  }> {
    const startedAt = process.hrtime.bigint();
    const retrieval = await this.#findWithOutcome(query, options);
    const hits = retrieval.hits;
    const candidates: AssemblyCandidate[] = hits.map((hit) => ({
      uri: hit.uri,
      contextType: hit.contextType,
      memoryType: hit.memoryType,
      level: hit.level,
      score: hit.score,
      abstract: hit.abstract,
    }));

    const clock = await this.#delivery.clock(options);
    const assembly: AssemblyOptions = {
      maxTokens: this.#config.assembly.maxTokens,
      quotaPreset: this.#config.assembly.quotaPreset,
      excludedUris: await this.#delivery.excluded(clock),
    };
    const result = await this.#assembler.assemble(candidates, assembly, options.principals);
    // 「使用」= 进入了调用方的上下文：只记组装保留下来的条目，被截断 / 被配额挤掉 /
    // 被跨轮去重排除的都不在 `result.items` 里（§11.7）。集合由组装层给出，这里不
    // 用候选再推一遍预算。
    this.#delivery.recordHits(result.items);
    await this.#delivery.delivered(clock, result.items);

    this.#logger.info('上下文组装完成', {
      subject: options.subject,
      queryLength: query.length,
      candidates: candidates.length,
      items: result.items.length,
      dropped: result.dropped,
      tokensUsed: result.tokensUsed,
      durationMs: elapsedMs(startedAt),
    });
    return {
      assembly: result,
      degradation: retrieval.degradation,
      rerankFailure: retrieval.rerankFailure,
    };
  }
}
