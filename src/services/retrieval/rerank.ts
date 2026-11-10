/**
 * 负责：重排这一条质量增强路径——候选文本的取法、送模型的条数上限、失败分类与健康度状态。
 * 不负责：融合分与层级加权的计算（`arms.ts` / `merge.ts`），也不负责热度加权。
 */

import { ComemError } from '../../domain/errors.js';
import type { Level } from '../../domain/level.js';
import type { Logger } from '../../domain/log.js';
import { applyLevelWeight, type LevelWeights } from '../../domain/ranking.js';
import { applyRerank, type RerankCandidate } from '../../domain/rerank.js';
import { truncateToChars } from '../../domain/summary.js';
import { Uri } from '../../domain/uri.js';

import type { FileSystemService } from '../filesystem.js';
import { budgetExceeded, remainingBudget, withBudget } from './budget.js';
import type {
  FindOptions,
  PreHotnessHit,
  RerankFailure,
  RerankFailureReason,
  RerankHealth,
  SearchServiceDeps,
} from './types.js';

/**
 * 查询重排的预算（毫秒），只在接口层给了 `deadlineAt` 时生效。
 *
 * 12000 是**推导值**：本地 0.6B 重排 50 条候选实测 p95 为 9.35 秒
 * （`eval/README.md` 的 105 条基线）。12 秒是 p95 的 1.28 倍，仍覆盖绝大多数
 * 查询；超过它的调用退回融合分并标注 `Degraded`。**不沿用
 * `providers.rerank.timeoutSeconds` 的 30 秒**：那是「不静默降级」的配置预算，
 * 30 秒的重排等待会直接吃掉 MCP 工具总上限（见 `api/deadline.ts`）。
 */
const QUERY_RERANK_TIMEOUT_MS = 12_000;

/**
 * 重排候选文本的兜底上限：512 个字符（Unicode 码点）。
 *
 * 重排模型（Qwen3-Reranker-0.6B）的输入上限是 32k token，但重排只判断「这段文本
 * 是否回答了这个查询」，不需要全文。按**摘要量级**取 512 字符（L0 摘要预算是 256，
 * §9.1；512 是「摘要 + 一点上下文」的两倍余量），再长不会让判断更准，只会让每次
 * 查询多读几 KB 文件。
 *
 * 这是**兜底**，不是主路径：正常情况下重排直接读 `SearchHit.abstract`（记忆写入
 * 时已经把 L0 摘要写进 frontmatter 的 `summary`），只有存量文档与非记忆文件才会
 * 落到「读正文前 512 字符」。
 */
const RERANK_TEXT_MAX_CHARS = 512;

/**
 * 把重排错误收敛成降级原因。
 *
 * 规则与 `adapters/llm/rerank-provider.ts` 的 `mapRerankError` 一致，但**不按
 * 错误码分支**：`PROVIDER_UNAVAILABLE` 同时覆盖「超时」「5xx」「网络不可达」三种，
 * 只看 code 会把它们都记成同一件事，而「调大超时」与「换 API Key」的处置完全不同。
 */
function rerankFailureReason(error: ComemError): RerankFailureReason {
  if (error.details?.['timeout'] === true) {
    return 'timeout';
  }
  const statusCode = error.details?.['statusCode'];
  if (typeof statusCode === 'number' && statusCode >= 500) {
    return 'http_5xx';
  }
  // 没有状态码的 PROVIDER_UNAVAILABLE 是 fetch 抛 TypeError（DNS / 连接被拒）。
  // 4xx 落到 other：那是配置错误，重试同样的请求结果一样。
  if (statusCode === undefined && error.code === 'PROVIDER_UNAVAILABLE') {
    return 'network';
  }
  return 'other';
}

/** 重排阶段的依赖。`rerank` 缺省时整条重排路径不执行（默认关）。 */
export interface RerankStageDeps {
  readonly rerank: SearchServiceDeps['rerank'];
  readonly logger: Logger;
  readonly levelWeights: LevelWeights;
  readonly filesystem: FileSystemService;
}

export class RerankStage {
  readonly #rerank: SearchServiceDeps['rerank'];
  readonly #logger: Logger;
  readonly #levelWeights: LevelWeights;
  readonly #filesystem: FileSystemService;
  /** 进程启动以来重排失败的次数。只增不清，作为「间歇性降级」的历史。 */
  #failures = 0;
  /** 最近一次重排失败；成功一次即清空，`degraded` 因此表达「现在」而不是「曾经」。 */
  #lastFailure: RerankFailure | null = null;

  constructor(deps: RerankStageDeps) {
    this.#rerank = deps.rerank;
    this.#logger = deps.logger;
    this.#levelWeights = deps.levelWeights;
    this.#filesystem = deps.filesystem;
  }

  /**
   * 重排健康度快照（`/health` 与 MCP `health` 读它）。
   *
   * 返回新对象而不是内部字段：调用方拿到的是快照，改它不会影响下一次查询。
   * `configured: false` 时 `degraded` 恒为 `false`——没配重排不是降级，是正常的
   * 「不做语义重排」配置（与 `providers.rerank.type: disabled` 的默认值一致）。
   */
  get health(): RerankHealth {
    const configured = this.#rerank !== undefined;
    return {
      configured,
      degraded: configured && this.#lastFailure !== null,
      failures: this.#failures,
      lastFailure: this.#lastFailure,
    };
  }

  /** 送重排前的候选上限（`providers.rerank.topN`）；没配重排时是 0，候选集不放大。 */
  get candidateFloor(): number {
    return this.#rerank?.topN ?? 0;
  }

  /**
   * 重排（`retrieval.rerank.*` / `providers.rerank.*`）。
   *
   * 位置：融合 / 层级加权之后、热度加权之前。**先重排，再按热度乘性加权**——重排
   * 是相关性判断，热度是相关性同档内的微调；反过来会让「最近访问过」压过「更相关」。
   *
   * 候选文本**摘要优先、正文兜底**（见 `#rerankText`）：摘要在索引里就有，取值
   * 不花钱；`abstract` 为空（存量文档、非记忆文件）时读正文前 512 字符，否则空
   * 文本候选会被 `applyRerank` 全部跳过——重排看起来开着，实际一个候选都没送模型。
   * `topN` 之外的候选不送模型，保留融合分。
   *
   * 拿到模型分后**重新施加层级先验**（`applyLevelPrior`）：模型判断相关性，层级
   * 先验判断「这段文本的出处」，两者正交。全部候选都没有可用文本时直接返回融合
   * 分，不发这次请求。
   *
   * **不要 clamp 分数**：`jina/jina-reranker-v3` 的 `relevance_score` 未归一化，
   * 可以是负数；按原值降序才是模型给出的顺序。等同分时按 URI 码点序，与
   * `rankCandidates` 同一套口径。
   *
   * 失败全部兜底：`applyRerank` 逐条兜底，`score` 抛错时整批退化成融合分，**只
   * 记 warn、不让检索失败**。但降级不静默（§17.9 的同一原则）：warn 里带
   * `reason`（`timeout` / `http_5xx` / `network` / `other`）、耗时与 `topN`，
   * 并把最近一次失败写进 `rerankHealth` 供 `/health` 暴露——「配了重排但一半查询
   * 在超时」必须能被查出来，否则用户以为用了重排，实际用的是融合分。
   */
  async apply(
    query: string,
    hits: readonly PreHotnessHit[],
    options: FindOptions,
  ): Promise<{ readonly hits: PreHotnessHit[]; readonly failure: RerankFailure | null }> {
    const rerank = this.#rerank;
    if (rerank === undefined || hits.length === 0) {
      return { hits: [...hits], failure: null };
    }

    const limited = hits.slice(0, rerank.topN);
    // 候选文本有 I/O（摘要为空时要读正文），先并发取齐再一次性送模型：串行读
    // 会把 N 次磁盘延迟叠在用户身上，而 topN 上限是配置里的 50 条。
    const texts = await Promise.all(limited.map((hit) => this.#rerankText(hit, options.principals)));
    const candidates: RerankCandidate[] = limited.map((hit, index) => ({
      uri: hit.uri,
      text: texts[index] ?? '',
      fallbackScore: hit.score,
    }));

    // 全部候选都没有可用文本（正文读失败、摘要为空）时不发这次请求：模型对空串
    // 打不出有意义的分数，`applyRerank` 也会逐条兜底。一次没有输入的调用只会
    // 花掉一次延迟预算。
    if (candidates.every((candidate) => candidate.text.trim() === '')) {
      this.#logger.debug('重排候选全部没有可用文本，跳过本次重排', {
        model: rerank.provider.model,
        candidates: candidates.length,
      });
      return { hits: [...hits], failure: null };
    }

    let modelScores: readonly (number | null)[] | null = null;
    let failure: RerankFailure | null = null;
    // 只计模型调用本身：候选正文读取是本地 I/O，不属于「重排有多慢」。
    const startedAt = Date.now();
    // 与查询嵌入同一套语义：只在接口层给了总预算时收窄，否则沿用配置的
    // `providers.rerank.timeoutSeconds`。
    const budget = remainingBudget(options.deadlineAt, QUERY_RERANK_TIMEOUT_MS);
    options.onUpstream?.('rerank');
    try {
      const scoring =
        budget === null
          ? rerank.provider.score(
              query,
              candidates.map((candidate) => candidate.text),
            )
          : rerank.provider.score(query, candidates.map((candidate) => candidate.text), {
              timeoutMs: budget,
            });
      modelScores =
        budget === null
          ? await scoring
          : await withBudget(scoring, budget, () => budgetExceeded('重排（rerank）', budget));
      // 最近一次成功：`degraded` 回答的是「现在」，历史次数留在 `failures` 里。
      this.#lastFailure = null;
    } catch (error) {
      const caught = ComemError.from(error);
      const reason = rerankFailureReason(caught);
      const durationMs = Date.now() - startedAt;
      this.#failures += 1;
      failure = {
        at: new Date().toISOString(),
        reason,
        durationMs,
        topN: candidates.length,
        code: caught.code,
        message: caught.message,
      };
      this.#lastFailure = failure;
      // `reason` 是给「调大超时」还是「换 API Key」分流用的：只看 code 的话
      // 超时、5xx、网络不可达都是 PROVIDER_UNAVAILABLE，运维无从下手。
      this.#logger.warn('重排失败，使用融合分', {
        model: rerank.provider.model,
        reason,
        durationMs,
        topN: candidates.length,
        code: caught.code,
        message: caught.message,
      });
    }

    const result = applyRerank(candidates, modelScores);
    const reranked = limited.map((hit, index) => ({
      ...hit,
      // 重排只换「相关性判断」，层级是**文档先验**（摘要经过压缩），必须保留：
      // 否则 `hybrid + rerank` 下层级权重只在模型没给分的尾部候选上生效。
      score: applyLevelPrior(
        result.scores[index] ?? hit.score,
        hit.level,
        this.#levelWeights,
      ),
    }));
    const merged = [...reranked, ...hits.slice(rerank.topN)];
    merged.sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      if (left.uri === right.uri) {
        return 0;
      }
      return left.uri < right.uri ? -1 : 1;
    });
    return {
      hits: rerank.keepTopN > 0 ? merged.slice(0, rerank.keepTopN) : merged,
      failure,
    };
  }

  /**
   * 重排候选的文本：摘要优先，摘要为空时降级读正文前 `RERANK_TEXT_MAX_CHARS` 个
   * 字符。
   *
   * **为什么需要兜底**：`SearchHit.abstract` 是 `document.frontmatter?.summary`，
   * 只有 `addResource` 带 summary 的附件才有；绝大多数文档是 `null`。`applyRerank`
   * 对空文本候选直接跳过（空串没有可打分的语义），所以只用摘要会让重排整批空转。
   *
   * 读盘失败（刚删、刚移动、权限在 `filesystem` 层被拒）时返回空串，让这一条用
   * 融合分兜底：重排是质量增强，不能让一次读盘失败变成整次检索失败。**不降级成
   * 「用别的候选的正文」**——那会把两条不相干的文档混在一起。
   */
  async #rerankText(hit: PreHotnessHit, principals: readonly string[]): Promise<string> {
    const abstract = hit.abstract?.trim() ?? '';
    if (abstract !== '') {
      return truncateToChars(abstract, RERANK_TEXT_MAX_CHARS);
    }

    const uri = Uri.tryParse(hit.uri);
    if (uri === null) {
      return '';
    }
    try {
      const document = await this.#filesystem.read(uri, principals);
      return truncateToChars(document.text.trim(), RERANK_TEXT_MAX_CHARS);
    } catch (error) {
      this.#logger.warn('重排候选正文不可读，改用融合分', {
        uri: hit.uri,
        code: ComemError.from(error).code,
      });
      return '';
    }
  }
}

/**
 * 重排后重新施加层级先验（§8.5）。
 *
 * 重排把「相关性分」换成模型的判断，但层级是**文档先验**：同一段文本，摘要经过
 * 压缩，模型从文本本身看不出「这是摘要」这层出处信息。先验因子与单引擎排序 /
 * RRF 贡献用的是同一个 `levelWeight`（1.15 / 1.05 / 1.00）。
 *
 * **按符号保序地**施加：非负分乘权重，负分除以权重。模型分未归一化（§18 明确
 * 不 clamp，`jina-reranker-v3` 可能给负数），直接乘会让负分**更负**、把先验反
 * 过来；除法在两种情况下都是「向更相关的方向移动」。`weight = 1` 时是恒等变换
 * （`x * 1 === x / 1 === x`），关闭层级权重不改变重排分数。
 *
 * 不用加法（`modelScore + (weight - 1) × 融合分`）：两者量纲不同（融合分约
 * `0.03`，模型分约 `1`），加出来的先验只有千分之几，除了精确同分之外没有可观察
 * 效果，等于没接。
 */
function applyLevelPrior(score: number, level: Level, weights: LevelWeights): number {
  const weight = applyLevelWeight(1, level, weights);
  return score >= 0 ? score * weight : score / weight;
}
