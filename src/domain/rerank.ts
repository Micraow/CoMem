/**
 * 重排契约（架构文档 §8.5 的「后续的 rerank」、§18 的 `providers.rerank`）。
 *
 * 重排解决的是**召回之后**的问题：向量召回的 top-50 里噪声比 BM25 大，融合分只
 * 说明「两个后端都认为它相关」，不说明「它真的回答了问题」。重排模型看一遍
 * `(query, document)` 对，给出的分数比名次融合更贴近意图。
 *
 * 接口与实现分开的理由与 `EmbeddingProvider` 相同：错误处置不同（重排超时该降级
 * 到融合分，而不是让整次检索失败），而且 `services/` 不该知道供应商的 HTTP 形状。
 *
 * **这里只有纯函数。** 网络调用在 `adapters/llm/rerank-provider.ts`。
 */

export interface RerankCandidate {
  readonly uri: string;
  /** 用于重排的文本（正文或摘要）。空字符串的候选会被跳过。 */
  readonly text: string;
  /** 召回阶段的分数，模型没给出分数时用它兜底。 */
  readonly fallbackScore: number;
}

/** 一次重排的结果。 */
export interface RerankResult {
  readonly scores: readonly number[];
  /** `reranked[i]` 为 `true` 表示这个分数来自模型，`false` 表示用了兜底值 */
  readonly reranked: readonly boolean[];
}

export interface RerankOptions {
  /** 单次调用超时，毫秒。省略时用适配器构造时配置的 `timeoutSeconds` */
  readonly timeoutMs?: number;
  /** 上游取消信号；HTTP 请求断开时用它中止重排调用 */
  readonly signal?: AbortSignal;
}

export interface RerankProvider {
  /** 模型标识，如 `BAAI/bge-reranker-v2-m3`。写进日志，用于排查「为什么这次重排没生效」 */
  readonly model: string;

  /**
   * 给候选打分。
   *
   * **返回值与入参同序同长**。模型只返回部分结果时，缺的位置是 `null`，由
   * `applyRerank` 用兜底分填——所以这里**不要**自己截断或补位：补位会把「模型
   * 没给分」和「模型给了这个分」混成同一件事，日志里再也看不出重排到底生效了没有。
   *
   * 空 `documents` 返回 `[]`，不产生网络请求。
   */
  score(
    query: string,
    documents: readonly string[],
    options?: RerankOptions,
  ): Promise<readonly (number | null)[]>;
}

/**
 * 分数是否可用（有限数）。
 *
 * 类型守卫**不做隐式转换**：`'0.5'` 是 `false`。供应商返回的 JSON 里
 * `relevance_score` 偶尔是字符串，隐式 `Number()` 会把 `''` 变成 0、把 `'abc'`
 * 变成 `NaN`，而这两种都应该落到兜底分上，不该变成「模型给了 0 分」。
 */
export function isFiniteScore(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * 把模型的分数合并回候选列表。
 *
 * **逐条兜底**：模型返回的分数数量不对、或者某条是 `NaN` / `Infinity` 时，那一条
 * 用 `fallbackScore`，其余保留模型分数。整批失败（`modelScores === null`）才全用
 * 兜底。
 *
 * 为什么不是「要么全用模型分，要么全用兜底」：重排模型对超长文本会返回 `null`，
 * 一个候选的文本超长不该让整批重排作废。
 *
 * **空文本候选不送模型**，在结果里表现为 `reranked[i] === false`：空串在模型侧
 * 没有可打分的语义，发过去只会浪费一次调用或换来一个无意义的分数。
 *
 * 长度按 `min` 取：`modelScores` 比候选短，尾部全兜底；比候选长，多出来的分数
 * 丢弃（没有候选可以对应，写进结果只会让两个数组错位）。纯函数，不改入参。
 */
export function applyRerank(
  candidates: readonly RerankCandidate[],
  modelScores: readonly (number | null | undefined)[] | null,
): RerankResult {
  const scores: number[] = [];
  const reranked: boolean[] = [];

  for (const [index, candidate] of candidates.entries()) {
    const modelScore = modelScores === null ? undefined : modelScores[index];
    if (candidate.text.trim() !== '' && isFiniteScore(modelScore)) {
      scores.push(modelScore);
      reranked.push(true);
    } else {
      scores.push(candidate.fallbackScore);
      reranked.push(false);
    }
  }

  return { scores, reranked };
}
