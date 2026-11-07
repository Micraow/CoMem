/**
 * 检索结果的打分、去重与截断（架构文档 §8.5、§8.6）。
 *
 * 排序分 = BM25 × levelWeight[level]。层级本身带信息：L0 是别人总结过的一句话，
 * 信噪比高于 L2 原文。
 *
 * 权重来源（§8.5）：1.15 / 1.05 / 1.00 是「摘要经过一次人工或模型的压缩，信息
 * 密度更高」这个**经验假设**，没有实测数据支撑。加权只用来在 BM25 接近时打破平局：
 * L0 词频不差太多就能赢 L2；L2 词频明显更高时仍然应该赢。调参应该用一批真实查询
 * 做对比，不要在这几个数字上继续叠加经验系数。
 */

import { LEVEL_ORDER } from './level.js';
import type { Level } from './level.js';

export interface LevelWeights {
  readonly l0: number;
  readonly l1: number;
  readonly l2: number;
}

/**
 * 架构文档 §8.5 的默认权重。
 *
 * 来源是经验假设，不是测量结果：L0 1.15、L1 1.05、L2 1.00。集中在这里是为了让
 * 检索侧只依赖一个常量，调参时不用翻多个文件。
 */
export const DEFAULT_LEVEL_WEIGHTS: LevelWeights = Object.freeze({
  l0: 1.15,
  l1: 1.05,
  l2: 1.0,
});

function weightFor(level: Level, weights: LevelWeights): number {
  switch (level) {
    case 'L0':
      return weights.l0;
    case 'L1':
      return weights.l1;
    case 'L2':
      return weights.l2;
  }
}

/** 把 BM25 原始分换算成层级加权分（§8.5）。 */
export function applyLevelWeight(bm25: number, level: Level, weights: LevelWeights): number {
  return bm25 * weightFor(level, weights);
}

export interface RankedCandidate {
  readonly uri: string;
  readonly level: Level;
  readonly score: number;
  readonly rendered: string;
}

/**
 * 排序比较器。
 *
 * 先按加权分降序；同分时按层级由粗到细（L0 → L1 → L2），再按 URI 字典序。
 * 后两级是为了让结果稳定可复现——同样的候选集不能因为 `sort` 的稳定性或输入顺序
 * 不同而给出不同排列。URI 比较用 `<` / `>` 的码点序，不用 `localeCompare`，避免
 * 结果依赖运行环境的 ICU 数据。
 */
function compareCandidates(a: RankedCandidate, b: RankedCandidate): number {
  if (a.score !== b.score) {
    return b.score - a.score;
  }

  const levelOrder = LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level];
  if (levelOrder !== 0) {
    return levelOrder;
  }

  if (a.uri < b.uri) {
    return -1;
  }
  if (a.uri > b.uri) {
    return 1;
  }
  return 0;
}

/**
 * 按加权分降序排序并截断到 `limit` 条。
 *
 * 输入候选的 `score` 是 BM25 原始分；返回值的 `score` 是加权后的分数，方便调用方
 * 直接展示或继续做预算计算。`weights` 默认取 §8.5 的配置值。
 *
 * 同分规则见 `compareCandidates`：层级由粗到细，再按 URI 字典序。
 */
export function rankCandidates(
  candidates: readonly RankedCandidate[],
  limit: number,
  weights: LevelWeights = DEFAULT_LEVEL_WEIGHTS,
): RankedCandidate[] {
  const ranked = candidates.map((candidate) => ({
    ...candidate,
    score: applyLevelWeight(candidate.score, candidate.level, weights),
  }));

  ranked.sort(compareCandidates);

  const max = Math.max(0, Math.floor(limit));
  return ranked.slice(0, max);
}

/**
 * 渲染后正文完全相同的候选只留分数最高的一条（§8.6 第 3 步）。
 *
 * 同一个文件可能同时命中 L0 和 L2 两条记录，渲染出来的正文一样，重复注入只会浪费
 * 上下文。分数相同时保留输入里先出现的那条；输出保持输入顺序，所以调用方先做
 * `rankCandidates` 就能得到分数序。
 */
export function dedupeByRenderedText(
  candidates: readonly RankedCandidate[],
): RankedCandidate[] {
  const bestByRendered = new Map<string, { readonly index: number; readonly score: number }>();

  for (const [index, candidate] of candidates.entries()) {
    const best = bestByRendered.get(candidate.rendered);
    if (best === undefined || candidate.score > best.score) {
      bestByRendered.set(candidate.rendered, { index, score: candidate.score });
    }
  }

  const winnerIndices = new Set([...bestByRendered.values()].map((best) => best.index));
  return candidates.filter((_, index) => winnerIndices.has(index));
}

/** token 估算函数。具体怎么切 token 由调用方注入（模型/provider 相关）。 */
export type TokenEstimator = (text: string) => number;

/**
 * 按 token 预算截断候选（§8.6 第 1 步）。
 *
 * 按输入顺序贪心装入：放得下的保留，放不下的跳过，继续尝试后面的候选——后面的短
 * 候选可能还装得下，直接 `break` 会白白浪费预算。`estimate` 由调用方注入，领域层
 * 不硬编码 `length / 4` 之类的近似（不同模型的分词器不一样）。
 *
 * 预算为 0 或负数时返回空数组；NaN 同样视为没有可用预算。
 */
export function truncateByTokenBudget(
  candidates: readonly RankedCandidate[],
  budgetTokens: number,
  estimate: TokenEstimator,
): RankedCandidate[] {
  if (Number.isNaN(budgetTokens) || budgetTokens < 0) {
    return [];
  }

  const kept: RankedCandidate[] = [];
  let used = 0;

  for (const candidate of candidates) {
    const cost = estimate(candidate.rendered);
    if (used + cost > budgetTokens) {
      continue;
    }
    kept.push(candidate);
    used += cost;
  }

  return kept;
}

/**
 * 单条候选的 token 上限（§8.6 第 1 步）：`maxTokens / 条目数 × 2`。
 *
 * 「× 2」是给单条留 2 倍余量，让高价值条目能占用比平均值更多的预算。token 是整数，
 * 向下取整保证单条不会超过上限。`itemCount <= 0` 时没有可分配的条目，返回 0，
 * 避免除零得到 `Infinity`。
 */
export function perItemTokenCap(budgetTokens: number, itemCount: number): number {
  if (itemCount <= 0) {
    return 0;
  }
  return Math.max(0, Math.floor((budgetTokens / itemCount) * 2));
}
