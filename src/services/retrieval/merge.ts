/**
 * 负责：命中列表的合并、去重与排序——多查询合并、层级加权排序、按 `(uri, abstract)` 去重、热度加权。
 * 不负责：取候选（`arms.ts`）与重排打分（`rerank.ts`）。
 */

import { hotnessScore } from '../../domain/hotness.js';
import { rankCandidates, type LevelWeights, type RankedCandidate } from '../../domain/ranking.js';
import type { SearchHit, TypedQuery } from '../../domain/retrieval.js';

import type {
  PreHotnessHit,
  RankedScoredHit,
  RetrieveOutcome,
  ScoredHit,
  ScoredSearchHit,
  SearchServiceDeps,
} from './types.js';

/** 热度加权的三个输入：`telemetry.hotness.*` 与读访问统计端口。 */
export interface HotnessSettings {
  /** `telemetry.hotness.weight`；`0` = 不参与排序，也不查库。 */
  readonly weight: number;
  /** 半衰期（天）。`hotnessScore` 的输入是天，配置里的单位是小时。 */
  readonly halfLifeDays: number;
  /** 读访问统计；缺省时不做热度计算（`hotness` 恒为 `null`）。 */
  readonly accessStats: SearchServiceDeps['accessStats'];
}

/**
 * 合并多条 TypedQuery 的命中（§8.4 第 5 步）。
 *
 * 按 URI 去重、**保留最高分**，同时记下「哪条 TypedQuery 命中的」。同一个 URI
 * 可能被多条查询命中：重写后的文本不同，BM25 分数不同，取高的那条才反映最好的
 * 一次匹配。降序 + `slice(0, limit)` 与 `find` 的 `rankCandidates` 是同一套口径。
 *
 * `limit` 语义：每条 TypedQuery 都用**同一个 limit** 取候选，不是 `limit / 条数`；
 * 去重之后可能不足 limit 条，宁可多取再合并。
 */
export function mergeHits(
  ran: readonly { readonly typedQuery: TypedQuery; readonly outcome: RetrieveOutcome }[],
  limit: number,
): ScoredSearchHit[] {
  const byUri = new Map<string, ScoredSearchHit>();
  for (const { typedQuery, outcome } of ran) {
    for (const hit of outcome.hits) {
      const existing = byUri.get(hit.uri);
      if (existing !== undefined && existing.score >= hit.score) {
        continue;
      }
      byUri.set(hit.uri, {
        uri: hit.uri,
        contextType: hit.contextType,
        memoryType: hit.memoryType,
        level: hit.level,
        abstract: hit.abstract,
        score: hit.score,
        // 名次跟着命中的那条查询走：同一个 URI 被两条查询命中时，保留分数更高
        // 的那次的 `ranks`，与 `score` / `matchedQuery` 同一套「取最好一次」口径。
        ranks: hit.ranks,
        matchedQuery: typedQuery.text,
      });
    }
  }
  return [...byUri.values()].sort((left, right) => right.score - left.score).slice(0, limit);
}

/**
 * 层级加权 + 截断（§8.5），最后按「同一 URI 的同一段
 * 摘要」去重（§8.6 第 3 步在命中列表这一层的对应物）。
 *
 * `rankCandidates` 只排序不去重，所以用「下标当身份」把排名结果映射回原始命中：
 * 同一个 URI 可能同时命中两条记录（目录的 L0 行与 L1 行，§8.5），用 URI 当键会把
 * 它们合并成一条、只剩下其中一层的分数与层级。
 *
 * **去重键是 `(uri, abstract)` 而不是 `uri`**：L0 行与 L1 行的 `abstract` 是同一份
 * L0 摘要，两条命中渲染给用户的内容逐字相同——留两条就是同一句话出现两遍；
 * 将来某个 URI 的两条记录若携带不同摘要，两条都保留，因为那不是同一条信息。
 * `ranked` 已按分数降序，先出现的即高分那条。
 *
 * 截断口径：`rankCandidates` 先按候选上限（`limit × candidateMultiplier`）截断，
 * 去重发生在它之后、调用方切 `limit` 之前。**重复行仍占候选名额**——候选池按行
 * 计不按 URI 计，所以「命中几乎全是同一批目录的两行」时返回条数会少于 `limit`。
 * 没有为它扩大候选数：那等于给所有引擎加检索开销，而 4× 余量下 `pnpm eval` 的
 * R@10 逐位不变（见 `local/notes/decisions.md`）。
 */
export function rankHits(
  hits: readonly SearchHit[],
  limit: number,
  levelWeights: LevelWeights,
): ScoredHit[] {
  const ranked = rankCandidates(
    hits.map((hit, index) => ({
      uri: hit.uri,
      level: hit.level,
      score: hit.score,
      rendered: String(index),
    })),
    limit,
    levelWeights,
  );

  const byHandle = new Map<string, SearchHit>();
  for (const [index, hit] of hits.entries()) {
    byHandle.set(String(index), hit);
  }

  const scored = toScoredHits(ranked, byHandle);
  const seen = new Set<string>();
  const unique: ScoredHit[] = [];
  for (const hit of scored) {
    const key = `${hit.uri}\n${hit.abstract ?? ''}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(hit);
  }
  return unique;
}

function toScoredHits(
  ranked: readonly RankedCandidate[],
  byHandle: ReadonlyMap<string, SearchHit>,
): ScoredHit[] {
  const result: ScoredHit[] = [];
  for (const entry of ranked) {
    const hit = byHandle.get(entry.rendered);
    if (hit === undefined) {
      continue;
    }
    result.push({
      uri: hit.uri,
      contextType: hit.contextType,
      memoryType: hit.memoryType,
      level: hit.level,
      abstract: hit.abstract,
      score: entry.score,
    });
  }
  return result;
}

/**
 * 热度加权（架构文档 §17.5 的 `telemetry.hotness.weight`）。
 *
 * `finalScore = score × (1 + weight × hotnessAsFactor)`，`hotness ∈ [0, 1]`。
 *
 * **为什么是乘性而不是加性**：RRF 融合分是 `0.016–0.033` 量级，热度是 `[0,1]`。
 * 加法会让热度完全压过相关性——一条 30 天没访问、只被单路命中的记忆，加 0.3 就
 * 排到了双路第一前面。乘性保住「先按相关性排序，热度只在同档次内做区分」。
 *
 * **为什么不用归一化后线性混合**：RRF 分数没有绝对尺度，归一化等于每次查询按
 * 当前结果集重新缩放；多返回一条结果就会改变所有分数，「为什么这条排第一」无法
 * 复现。乘性不依赖结果集。
 *
 * `weight === 0`（默认）时**不查库**：默认部署是绝大多数，多一次 SQL 全是浪费。
 * 此时 `hotness` 恒为 `null`，与接线前的行为逐字一致。
 *
 * 输入已经是「本引擎相关性排序并截断」的结果，这里只重排：热度不能把一条没进
 * 候选集的记忆拉进来（那等于让热度决定相关性）。
 */
export function applyHotness(
  settings: HotnessSettings,
  hits: readonly PreHotnessHit[],
): RankedScoredHit[] {
  const stats = settings.accessStats;
  if (settings.weight === 0 || stats === undefined) {
    return hits.map((hit) => ({ ...hit, hotness: null }));
  }
  if (hits.length === 0) {
    return [];
  }

  // 同一个 URI 可能有多条命中行（目录的 L0 摘要行与 L1 概览行，见 `rankHits` 与
  // §8.5），去重后再查访问统计——两行都查只是同一份 stats 查两遍。
  const uniqueUris = [...new Set(hits.map((hit) => hit.uri))];
  const byUri = new Map(stats(uniqueUris).map((row) => [row.uri, row]));
  const now = new Date();

  const weighted: RankedScoredHit[] = hits.map((hit) => {
    const row = byUri.get(hit.uri);
    if (row === undefined) {
      // 索引里有、`node` 表里没有：数据不一致。热度按「没算」处理，但分数保持
      // 原样——不能因为少了一行统计就把这条命中从结果里抹掉。
      return { ...hit, hotness: null };
    }
    const hotness = hotnessScore({
      activeCount: row.accessCount,
      lastAccessedAt: row.lastAccessedAt,
      now,
      halfLifeDays: settings.halfLifeDays,
    });
    return { ...hit, score: hit.score * (1 + settings.weight * hotness), hotness };
  });

  return weighted.sort(compareRankedHits);
}

/**
 * 热度加权后的排序比较器：`finalScore` 降序 → `hotness` 降序（`null` 最后）→ URI 升序。
 *
 * 后两级是**稳定性**：同分同热度的两条命中，不同次查询不能换顺序。URI 用码点序
 * 比较（`<` / `>`），与 `domain/ranking.ts` 的 `compareCandidates` 同一套口径，
 * 不依赖运行环境的 ICU 数据。
 *
 * `null` 用 `-1` 兜：热度分落在 `[0, 1]`，`-1` 比任何算出来的分都小。
 */
function compareRankedHits(left: RankedScoredHit, right: RankedScoredHit): number {
  if (right.score !== left.score) {
    return right.score - left.score;
  }
  const leftHotness = left.hotness ?? -1;
  const rightHotness = right.hotness ?? -1;
  if (rightHotness !== leftHotness) {
    return rightHotness - leftHotness;
  }
  if (left.uri === right.uri) {
    return 0;
  }
  return left.uri < right.uri ? -1 : 1;
}

/**
 * 合并「意图分析降级」与「向量降级」两条原因。
 *
 * 两条都非空时拼接，不覆盖：它们回答的是不同问题（查询重写不可用 / 语义检索
 * 不可用），只保留一条会让排查的人以为另一条没发生。去重是必要的——5 条
 * TypedQuery 同时降级时原因完全相同，拼 5 遍只会让消息不可读。
 */
export function combineReasons(
  analysisReason: string | null,
  degradations: readonly (string | null)[],
): string | null {
  const reasons: string[] = [];
  if (analysisReason !== null) {
    reasons.push(analysisReason);
  }
  for (const degradation of degradations) {
    if (degradation !== null && !reasons.includes(degradation)) {
      reasons.push(degradation);
    }
  }
  return reasons.length === 0 ? null : reasons.join('；');
}
