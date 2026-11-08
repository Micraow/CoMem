/**
 * 检索质量指标（W23 评估框架）。
 *
 * 这一层是**纯函数**：输入是「检索返回的 URI 有序列表」与「标注」，输出是一个
 * `[0, 1]` 的分数。它不知道 FTS5、向量、RRF 的存在——评估框架要能比较任意
 * 检索实现，指标就不能绑定在某一个实现上。
 *
 * ## 三个指标各自回答什么
 *
 * | 指标 | 回答的问题 | 对「顺序」敏感 |
 * |---|---|---|
 * | Recall@k | 该找的东西有没有被找出来 | 否（只看集合） |
 * | MRR | 第一个相关结果排在第几 | 是，只看第一个 |
 * | nDCG@k | 相关的排得靠不靠前、相关程度高的有没有更靠前 | 是，看全部 |
 *
 * 三个一起看才有意义：Recall 高但 MRR 低，说明「找到了但埋得很深」；MRR 高但
 * Recall 低，说明「只找到一条且恰好排第一」。只报一个数字会把这两类问题混成
 * 同一个「分数还行」。
 */

import { ComemError } from '../domain/errors.js';

/**
 * 一条查询的评估结果。
 *
 * 四个字段都是**单条查询**的分数，不是聚合值；聚合见 `aggregateMetrics`。
 */
export interface QueryMetrics {
  /** 召回率：top-k 里命中的相关文档 / 全部相关文档 */
  readonly recallAtK: number;
  /** 第一个相关文档的倒数排名；没有命中为 0 */
  readonly reciprocalRank: number;
  /** 归一化折损累计增益（分级相关性） */
  readonly ndcgAtK: number;
  /** 命中数：top-k 里属于 `relevant` 的文档条数（去重后） */
  readonly hits: number;
}

/**
 * 多条查询的算术平均。
 *
 * `queryCount` 不是「有效查询数」：`recallAtK` 为 1 的空标注查询也算一条。聚合是
 * 算术平均而不是加权平均——数据集里每条查询的权重相同，这是 W23 的约定；需要按
 * 业务重要性加权时应该拆成多个数据集，而不是在指标层引入权重（权重一旦可配，
 * 「这次分数为什么变了」就多一个变量）。
 */
export interface AggregateMetrics {
  /** 参与聚合的查询条数 */
  readonly queryCount: number;
  readonly recallAtK: number;
  /** 平均倒数排名（Mean Reciprocal Rank） */
  readonly mrr: number;
  readonly ndcgAtK: number;
  /** 平均命中数 */
  readonly meanHits: number;
}

/**
 * 校验截断位置 `k`。
 *
 * `k` 是「取前几名」，必须是非负整数里的正数：`0` 表示一个都不看，任何指标都
 * 没有定义；小数或 `NaN` 会让 `slice(0, k)` 静默取整。两者都在这里抛
 * `INVALID_ARGUMENT`，不把错误推迟到「为什么分数是 0」。
 */
function assertK(k: number): void {
  if (!Number.isInteger(k) || k <= 0) {
    throw new ComemError('INVALID_ARGUMENT', 'k 必须是正整数。', { k });
  }
}

/**
 * 召回率 `|top-k ∩ relevant| / |relevant|`。
 *
 * **`relevant` 为空时返回 1，不是 0。** 这是明确的取舍：空标注表示「这条查询没有
 * 该找的东西」，检索系统没有做错任何事。返回 0 会把「数据集没标注」记成「检索
 * 失败」，而这两件事的排查方向完全相反（前者改数据集，后者改检索）。不少实现
 * （例如部分 IR 教程的玩具代码）在这里返回 0，本实现不采用。
 *
 * `retrieved` 为空且 `relevant` 非空时返回 0。
 *
 * 命中按**集合**算：同一个 URI 在 top-k 里出现两次只算一条。检索结果本身是唯一的
 * （`SearchService.find` 按 URI 去重），去重只是为了不让一个重复项把召回率推过 1。
 */
export function recallAtK(
  retrieved: readonly string[],
  relevant: ReadonlySet<string>,
  k: number,
): number {
  assertK(k);
  if (relevant.size === 0) {
    return 1;
  }
  if (retrieved.length === 0) {
    return 0;
  }

  const hit = new Set<string>();
  for (const uri of retrieved.slice(0, k)) {
    if (relevant.has(uri)) {
      hit.add(uri);
    }
  }
  return hit.size / relevant.size;
}

/**
 * 平均倒数排名（单条查询的倒数排名）：`1 / rank_of_first_relevant`。
 *
 * `rank` 从 1 开始计数（第一个结果的名次是 1，不是 0）。没有命中返回 0。
 * 只看第一个相关结果，后面的命中不影响分数——这是 MRR 与 nDCG 的分工：MRR 回答
 * 「第一条要多久出现」，nDCG 回答「整体排得好不好」。
 *
 * `relevant` 为空时返回 0：没有「第一个相关结果」可找。
 */
export function reciprocalRank(
  retrieved: readonly string[],
  relevant: ReadonlySet<string>,
): number {
  for (const [index, uri] of retrieved.entries()) {
    if (relevant.has(uri)) {
      return 1 / (index + 1);
    }
  }
  return 0;
}

/** 分级增益 `2^rel - 1`（Järvelin & Kekäläinen 2002 的指数增益形式）。 */
function gain(relevance: number): number {
  return 2 ** relevance - 1;
}

/** 名次 `i`（从 1 开始）的折损 `1 / log2(i + 1)`。 */
function discount(rank: number): number {
  return 1 / Math.log2(rank + 1);
}

/**
 * 归一化折损累计增益 `DCG@k / IDCG@k`。
 *
 * 公式来源：**Järvelin, K. & Kekäläinen, J. (2002). Cumulated gain-based evaluation
 * of IR techniques. ACM Transactions on Information Systems, 20(4), 422–446.**
 * 本实现用它的指数增益形式：
 *
 * ```
 * DCG@k  = Σ_{i=1..k} (2^rel_i - 1) / log2(i + 1)
 * IDCG@k = 同一公式作用在「按相关度降序排列的理想结果」上
 * ```
 *
 * 其中 `i` 是名次，从 1 开始；`rel_i` 是第 `i` 名文档的分级相关度，`graded` 里没有
 * 的文档按 `rel = 0` 处理（增益 0，不贡献也不惩罚）。IDCG 取 `graded` 的分级
 * 相关度降序前 `k` 条——这是「同一批标注能做到的最好排序」，所以归一化之后不同
 * 查询之间可比。
 *
 * `graded` 为空、或所有相关度都是 0 时，IDCG 为 0，没有可归一化的基准，返回 0。
 * 注意这与 `recallAtK` 的「空标注返回 1」不同：召回率有「没有该找的」这个自然
 * 解释，nDCG 的分子分母同时为 0，0 是「没有可衡量的排序质量」而不是「排序失败」。
 * 数据集里出现这种查询时应该删掉，而不是靠指标兜底。
 *
 * 相关度必须是有限的非负数；负相关度在指数增益下会得到负数增益，让「排得越前越
 * 差」——`parseDataset` 已经把值域限制在 0–3，这里不再重复校验，但纯函数本身
 * 不做假设之外的修正。
 */
export function ndcgAtK(
  retrieved: readonly string[],
  graded: ReadonlyMap<string, number>,
  k: number,
): number {
  assertK(k);
  if (graded.size === 0) {
    return 0;
  }

  let dcg = 0;
  for (const [index, uri] of retrieved.slice(0, k).entries()) {
    dcg += gain(graded.get(uri) ?? 0) * discount(index + 1);
  }

  const ideal = [...graded.values()].sort((left, right) => right - left).slice(0, k);
  let idcg = 0;
  for (const [index, relevance] of ideal.entries()) {
    idcg += gain(relevance) * discount(index + 1);
  }

  return idcg === 0 ? 0 : dcg / idcg;
}

/**
 * 把每条查询的结果聚合成一个变体的分数。
 *
 * 各指标取算术平均；空输入返回全 0 与 `queryCount: 0`（除零会得到 `NaN`，
 * `NaN` 在表格里显示成 `NaN` 而不是「没有数据」，容易误读）。
 */
export function aggregateMetrics(perQuery: readonly QueryMetrics[]): AggregateMetrics {
  if (perQuery.length === 0) {
    return { queryCount: 0, recallAtK: 0, mrr: 0, ndcgAtK: 0, meanHits: 0 };
  }

  let recall = 0;
  let reciprocal = 0;
  let ndcg = 0;
  let hits = 0;
  for (const metrics of perQuery) {
    recall += metrics.recallAtK;
    reciprocal += metrics.reciprocalRank;
    ndcg += metrics.ndcgAtK;
    hits += metrics.hits;
  }

  const count = perQuery.length;
  return {
    queryCount: count,
    recallAtK: recall / count,
    mrr: reciprocal / count,
    ndcgAtK: ndcg / count,
    meanHits: hits / count,
  };
}
