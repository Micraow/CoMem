/**
 * 检索接口（架构文档 §8.3）。
 *
 * 这是 brief 里唯一明确要求预留的扩展点（「查找要做成接口，后续可能要做成向量库」）。
 * 接口只描述「给一个查询，返回命中」，实现放在 `adapters/sqlite/retrieval-index.ts`。
 *
 * 权限过滤在索引侧完成：`principals` 由 `Authorizer` 统一算好传进来，FTS5 实现与
 * 未来的向量实现共用同一套过滤条件（§8.3）。
 */

import type { Level } from './level.js';
import type { ContextType, NodeKind, NodeStatus } from './node.js';
import { ComemError } from './errors.js';
import { applyLevelWeight, type LevelWeights } from './ranking.js';

/** 索引里的一行 `node`（架构文档 §8.1）。 */
export interface IndexRecord {
  readonly uri: string;
  readonly parentUri: string;
  readonly scope: 'user' | 'group';
  readonly kind: NodeKind;
  readonly contextType: ContextType;
  readonly memoryType: string | null;
  readonly level: Level;
  readonly abstract: string | null;
  readonly content: string;
  readonly bodyDigest: string;
  readonly size: number;
  readonly updatedAt: string;
  readonly status: NodeStatus;
  /**
   * 记忆的有效区间（`node.valid_from` / `node.valid_until`），ISO 8601 UTC 形态。
   *
   * `null`（或省略）都表示这一侧没有边界：没写 `valid_from` 即不设下界（对迁移前的
   * 存量行也等于「不知道从何时开始有效」），没写 `valid_until` 就是「仍然有效」；
   * 过滤时按「该侧不设条件」放行。**只有记忆文件能给出值**——它来自记忆
   * frontmatter 的保留键，由三处解析器算出；目录行、资源、技能一律省略。
   *
   * 省略与 `null` 同义，因为构造 `IndexRecord` 的另外几处（目录摘要的 L0 / L1 两行、
   * 资源、技能、重放）在分层上都不该知道有效期，让它们逐个写 `null` 只是噪声。
   * 记忆行由 `index-observer` 与 `reindex` 显式给出——那两处才是这条数据的事实来源。
   */
  readonly validFrom?: string | null;
  /** 见 `validFrom`。 */
  readonly validUntil?: string | null;
}

export interface SearchQuery {
  readonly text: string;
  /** 路径前缀 */
  readonly scopes: readonly string[];
  /** 调用方权限主体，如 `user:alice`、`group:eng`、`user:*` */
  readonly principals: readonly string[];
  readonly contextTypes?: readonly ContextType[];
  /**
   * 只看这些层级。**过滤的是检索行，不是节点**：目录在索引里有 L0（摘要）与 L1
   * （概览正文）两行（§8.5），`['L1']` 命中的是概览行——它返回的 `abstract` 仍是
   * 该目录的 L0 摘要。
   *
   * 省略或空数组 = 不按层级过滤。三层的权重不同（`ranking.levelWeights`），所以
   * 这个维度既影响「能不能命中」，也影响排序分。
   */
  readonly levels?: readonly Level[];
  /**
   * 只看这些记忆类型（`node.memory_type`）。
   *
   * 省略或空数组 = 不按类型过滤。**非记忆节点的 `memory_type` 是 `NULL`**，因此
   * 一旦给了类型，它们永远不出现——`rule_search` 的 `['rules']` 正是靠这一点
   * 在 SQL 里把偏好 / 实体挡在候选之外，而不是先取 5 条再筛。
   */
  readonly memoryTypes?: readonly string[];
  /**
   * 更新时间下界，**闭区间**：`updated_at >= updatedAfter`。
   *
   * ISO 8601 绝对时刻。比较前用 `canonicalInstant` 归一化成 `Date#toISOString()`
   * 的 UTC 形态——`node.updated_at` 就是那个形态（定长、带 `Z`），TEXT 比较才与
   * 时间顺序一致；带偏移的输入（`+08:00`）不归一化会按字符串比较出错。
   */
  readonly updatedAfter?: string;
  /** 更新时间上界，**闭区间**：`updated_at <= updatedBefore`。语义同上。 */
  readonly updatedBefore?: string;
  /**
   * 「现在」：只返回这一刻有效的节点（W98）。
   *
   * 条件是 `(valid_from IS NULL OR valid_from <= asOf)` 且
   * `(valid_until IS NULL OR valid_until > asOf)`。NULL 在两侧都放行，所以旧数据
   * （全 NULL）与非记忆节点（无有效期）不受影响。
   *
   * **不对外暴露。** MCP 的 16 个工具与 HTTP 查询参数都没有这一项：所有入口都用
   * 「请求到达的时刻」，由 `SearchService` 自己填。允许调用方指定 `asOf` 等于把
   * 「回溯某个时刻的记忆状态」变成一个没人测过的入口。
   *
   * 省略 = 不做有效期过滤。`glob` / `grep` / `tree` 的对外面就是这样：它们是路径
   * 工具，契约是磁盘上的全部节点（含已失效的历史版本）。
   */
  readonly asOf?: string;
  readonly limit: number;
}

export interface SearchHit {
  readonly uri: string;
  readonly level: Level;
  readonly abstract: string | null;
  readonly score: number;
  readonly contextType: ContextType;
  /**
   * 记忆类型，非记忆文件为 `null`。
   *
   * 必须返回：§8.6 的分层投放按记忆类型决定起始层级（`events` 从 L1 概览起），
   * 少这一列就只能一律从 L0 起投，事件类记忆会退化成一句话摘要。
   */
  readonly memoryType: string | null;
}

/**
 * 意图分析产出的一条类型化查询（§8.4）。
 *
 * 「类型化」的意思是：模型必须说明这条查询**想找什么**（`intent`），而不是只给
 * 一串关键词。`intent` 是解释标签（控制台能说清「这次想找的是偏好还是决定」），
 * 也是将来 rerank 的输入；**当前不参与合并**——多条查询的命中按 URI 去重，与
 * `intent` 无关（§8.4 第 5 步）。
 */
export const TYPED_QUERY_INTENTS = [
  /** 用户的偏好、习惯、风格 */
  'preference',
  /** 事实性知识（项目结构、约定、配置） */
  'fact',
  /** 做过的决定与理由 */
  'decision',
  /** 发生过的事（某次提交、某次讨论） */
  'event',
  /** 步骤、流程、怎么操作 */
  'procedure',
  /** 兜底：模型给了契约外的 intent，或这条查询不该分类 */
  'other',
] as const;

export type TypedQueryIntent = (typeof TYPED_QUERY_INTENTS)[number];

/**
 * `SearchPlan.queries` 的上限（§8.4 的「0–5 条 TypedQuery」）。
 *
 * 5 不是经验值：每条查询都要并发跑一次 `find`，上限直接决定一次 `search` 的
 * 索引查询次数。架构文档把它写成「0–5 条」，这里是与文档同一个数。
 */
export const MAX_TYPED_QUERIES = 5;

export interface TypedQuery {
  /** 重写后的查询文本。**可以与原 query 完全不同** */
  readonly text: string;
  readonly intent: TypedQueryIntent;
  /** 0–1，模型对「这条查询值得跑」的置信度 */
  readonly confidence: number;
  /** 从原 query 的哪一段衍生出来（用于在 UI 上解释） */
  readonly derivedFrom: string | null;
}

/**
 * 模型产出的原始条目。
 *
 * 与 `TypedQuery` 的差别只在 `derivedFrom` 可以缺省：供应商的结构化输出里少一个
 * 键是常态，为此让整次意图分析失败没有意义。收敛由 `normalizeTypedQueries` 做。
 * `intent` 已经过 schema 的 `catch('other')`，所以这里仍是 `TypedQueryIntent`。
 */
export interface TypedQueryDraft {
  readonly text: string;
  readonly intent: TypedQueryIntent;
  readonly confidence: number;
  readonly derivedFrom?: string | null;
}

export interface SearchPlan {
  /** 原 query */
  readonly original: string;
  /** 0–5 条。空数组表示「模型认为不该检索」 */
  readonly queries: readonly TypedQuery[];
  /** 意图分析是不是跑成功了。false 时 `queries` 是兜底的单条原 query */
  readonly analyzed: boolean;
  /** 为什么没分析成功（`analyzed: false` 时非空） */
  readonly reason: string | null;
  readonly elapsedMs: number;
}

/**
 * `search` 合并后的命中。
 *
 * 在 `SearchHit` 之上多一列「这条命中是哪条 TypedQuery 跑出来的」：5 条查询合并
 * 之后，同一个 URI 可能被多条查询命中，排查「为什么它排在前面」需要知道来源
 * （§8.4 第 5 步）。多一列而不是另建映射表，理由与 `SearchHit.memoryType` 相同。
 */
export interface SearchResultHit extends SearchHit {
  /** 命中的 TypedQuery 文本（重写后的，不是原 query） */
  readonly matchedQuery: string;
}

export interface SearchResult {
  readonly hits: readonly SearchResultHit[];
  readonly plan: SearchPlan;
}

/**
 * 检索后端（§18 的 `retrieval.engine`）。
 *
 * `hybrid` 不是一个独立实现，是「并行跑 fts5 与 vector 再融合」的调度方式，融合规则
 * 由 `reciprocalRankFusion` 定义。写进联合类型是因为它是配置里的一个合法取值，
 * 名字必须与 §18 的 YAML 逐字一致。
 */
export const RETRIEVAL_ENGINES = ['fts5', 'vector', 'hybrid'] as const;

export type RetrievalEngine = (typeof RETRIEVAL_ENGINES)[number];

/** 混合检索的融合结果。 */
export interface FusedHit extends SearchHit {
  /** 各后端的名次（1 起），用于解释「为什么这条排在这」 */
  readonly ranks: Readonly<Record<RetrievalEngine, number | null>>;
}

/**
 * RRF 的 k 值。
 *
 * `score(d) = Σ_retriever 1 / (k + rank_retriever(d))`，k = 60。
 *
 * 60 来自 RRF 原论文（Cormack et al., 2009）的经验值，不是本项目测量出来的，也
 * 不是「调参调出来的最佳值」。它只影响「名次差多少算差很多」：k 越大，前几名之间
 * 的分数差越小。
 */
const DEFAULT_RRF_K = 60;

/**
 * 倒数排名融合（RRF）。
 *
 * **为什么用 RRF 而不是分数加权**：BM25 的分数是无界的，向量余弦在 [-1, 1]，
 * 两者相加前必须归一化，而归一化依赖当次查询的候选集——同一份文档在不同查询下
 * 权重会漂移。RRF 只用名次，没有这个问题（这是它被广泛采用的唯一理由）。
 *
 * **名次取结果集里的下标 + 1**，不重新按 `score` 排：结果集是后端给出的排序，
 * 再排一次等于替后端做决定，而两个后端的分数不可比正是要用 RRF 的原因。
 *
 * 同一 URI 在多个结果集里出现只算一条，`ranks` 记每个后端的最高名次（没出现记
 * `null`）：「最高」指最靠前，即数值最小的那个。同分按 URI 升序——不是审美，
 * 而是 `Array.prototype.sort` 在 V8 上虽然稳定，但依赖「输入顺序稳定」在并发合并
 * 场景下不成立；显式给出全序才能让同一份输入每次都得到同一份输出。
 *
 * ## 层级先验（`levelWeights`）
 *
 * 传了 `levelWeights` 时，每条候选对融合分的**贡献**乘上它所在层级的权重：
 * `score = Σ levelWeight(level) / (k + rank)`。RRF 仍然是名次融合，只是给
 * 「摘要比原文更可能相关」这个文档先验一个位置；它不引入检索后端的分数量纲，
 * 所以 RRF「不比较 BM25 与余弦」的性质不变。
 *
 * 层级是**文档**的属性（`node.level`），不是后端的属性：同一个 URI 在两个后端
 * 出现时层级相同，取第一次出现的那条即可。`levelWeights` 省略时权重恒为 1，
 * 与不带先验的标准 RRF 逐位相同（`1.0 * x === x`），旧调用方不需要改。
 *
 * `limit` 截断；不传 `limit` 时不截断。纯函数，无 IO。
 */
export function reciprocalRankFusion(
  resultSets: readonly { readonly engine: RetrievalEngine; readonly hits: readonly SearchHit[] }[],
  options: {
    readonly k?: number;
    readonly limit?: number;
    readonly levelWeights?: LevelWeights;
  } = {},
): FusedHit[] {
  const k = options.k ?? DEFAULT_RRF_K;
  if (!Number.isFinite(k) || k <= 0) {
    throw invalidArgument('k 必须是正数。', { k });
  }
  if (options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit <= 0)) {
    throw invalidArgument('limit 必须是正整数。', { limit: options.limit });
  }

  interface Accumulator {
    readonly hit: SearchHit;
    readonly ranks: Record<RetrievalEngine, number | null>;
  }

  const byUri = new Map<string, Accumulator>();
  for (const resultSet of resultSets) {
    for (const [index, hit] of resultSet.hits.entries()) {
      const rank = index + 1;
      let accumulator = byUri.get(hit.uri);
      if (accumulator === undefined) {
        accumulator = { hit, ranks: { fts5: null, vector: null, hybrid: null } };
        byUri.set(hit.uri, accumulator);
      }
      const current = accumulator.ranks[resultSet.engine];
      if (current === null || rank < current) {
        accumulator.ranks[resultSet.engine] = rank;
      }
    }
  }

  const fused: FusedHit[] = [];
  for (const [uri, accumulator] of byUri) {
    // 取第一次出现的那条，保证「融合分的权重」与「结果里展示的 level / abstract」
    // 是同一个值。**一个 URI 可能有多条命中行**：目录有 L0 摘要行与 L1 概览行
    // （§8.5），FTS 臂会同时返回两者，而向量臂按 URI 一条。首次出现的通常是名次
    // 更高（分数更好）的那一行，所以融合用的层级先验就是「这次匹配最好的行」的
    // 层级——与单引擎路径 `score × levelWeight[命中行]` 同一口径。
    const weight =
      options.levelWeights === undefined
        ? 1
        : applyLevelWeight(1, accumulator.hit.level, options.levelWeights);
    let score = 0;
    for (const rank of Object.values(accumulator.ranks)) {
      if (rank !== null) {
        score += weight / (k + rank);
      }
    }
    fused.push({ ...accumulator.hit, uri, score, ranks: accumulator.ranks });
  }

  fused.sort((left, right) => {
    if (right.score !== left.score) {
      return right.score - left.score;
    }
    if (left.uri === right.uri) {
      return 0;
    }
    return left.uri < right.uri ? -1 : 1;
  });

  return options.limit === undefined ? fused : fused.slice(0, options.limit);
}

export interface GrepHit {
  readonly uri: string;
  readonly line: number;
  readonly text: string;
  readonly before: readonly string[];
  readonly after: readonly string[];
}

/**
 * 路径通配查询。
 *
 * 除「路径 + 权限」外还带元数据过滤，因为它同时是**向量检索的候选集来源**
 * （`services/search.ts` 的 `#readableUris`）：`vec0` 只接受候选 URI 列表，
 * 记忆类型与时间范围必须在枚举候选时就下推到 SQL，否则先取最近邻再在 JS 里过滤，
 * 会白白丢掉「最近邻排在后面、但类型匹配」的候选。MCP / HTTP 的 `glob` 面不暴露
 * 后面三个字段，它们只为候选集枚举存在。
 */
export interface GlobQuery {
  readonly pattern: string;
  readonly scopes: readonly string[];
  readonly principals: readonly string[];
  /** 同 `SearchQuery.memoryTypes` */
  readonly memoryTypes?: readonly string[];
  /** 同 `SearchQuery.updatedAfter` */
  readonly updatedAfter?: string;
  /** 同 `SearchQuery.updatedBefore` */
  readonly updatedBefore?: string;
  /**
   * 同 `SearchQuery.asOf`。
   *
   * `glob` 是向量检索的候选集来源（`services/search.ts` 的 `#readableUris`），
   * 所以它必须能带着同一个 `asOf` 枚举候选：漏传时 kNN 的名额会被已失效的历史
   * 版本占掉，top-k 里一半是同一段正文的旧版本。
   */
  readonly asOf?: string;
  readonly limit: number;
}

export interface NodeStat {
  readonly uri: string;
  readonly kind: NodeKind;
  readonly contextType: ContextType;
  readonly memoryType: string | null;
  readonly size: number;
  readonly updatedAt: string;
  readonly status: NodeStatus;
  readonly abstract: string | null;
}

/**
 * 检索索引。`SearchQuery` / `GlobQuery` 走索引，`grep` 不走。
 *
 * **`grep` 不属于索引。** FTS5 索引的是**词**，`grep` 匹配的是**任意正则**。两者是
 * 不同的访问路径：让索引实现 `grep` 等于让索引去读文件，那不是它的职责（索引只
 * 持有 token，没有正文，也没法按行号返回上下文）。`grep` 由 `services/search.ts`
 * 实现——先用索引拿到权限过滤后的候选 URI，再逐个读文件做行匹配。
 *
 * `GrepHit` 保留：它是服务层的输出形状，不属于索引契约。
 */
export interface RetrievalIndex {
  upsert(records: readonly IndexRecord[]): Promise<void>;
  deleteByUri(uri: string, options?: { readonly recursive?: boolean }): Promise<void>;
  search(query: SearchQuery): Promise<SearchHit[]>;
  glob(query: GlobQuery): Promise<string[]>;
  stat(uri: string): Promise<NodeStat | null>;
}

function invalidArgument(message: string, details: Record<string, unknown>): ComemError {
  return new ComemError('INVALID_ARGUMENT', message, details);
}

/** 查询的公共部分：`limit > 0`、`scopes` 与 `principals` 非空。 */
function validateQueryEnvelope(query: {
  readonly limit: number;
  readonly scopes: readonly string[];
  readonly principals: readonly string[];
}): void {
  if (!Number.isInteger(query.limit) || query.limit <= 0) {
    throw invalidArgument('limit 必须是正整数。', { limit: query.limit });
  }
  if (query.scopes.length === 0) {
    throw invalidArgument('scopes 不能为空：没有路径范围就等于全库扫描。', {});
  }
  if (query.scopes.some((scope) => scope === '')) {
    throw invalidArgument('scopes 里不能有空字符串。', { scopes: query.scopes });
  }
  if (query.principals.length === 0) {
    throw invalidArgument('principals 不能为空：没有权限主体就查不到任何节点。', {});
  }
  if (query.principals.some((principal) => principal === '')) {
    throw invalidArgument('principals 里不能有空字符串。', { principals: query.principals });
  }
}

function validateText(text: string, field: string): void {
  if (text === '') {
    throw invalidArgument(`${field} 不能为空。`, { field });
  }
}

/**
 * ISO 8601 时间 → 规范化的 UTC 串（`Date#toISOString()`）。
 *
 * 索引里的 `node.updated_at` 一律由 `Date#toISOString()` 写入（目录行的 mtime），
 * 定长且带 `Z`，所以按 TEXT 比较与按时间比较等价——**前提是过滤边界也归一化成
 * 同一形态**。带偏移的输入（`2026-11-08T08:00:00+08:00`）不归一化会按字符串比较
 * 得到错误结果，而「时间检索」最不能容忍的就是边界悄悄漂移。
 *
 * 解析失败抛 `INVALID_ARGUMENT`：把 `updatedAfter=昨天` 这种自然语言输入交给
 * SQL 比较只会得到空结果，比报错更难查。自然语言日期解析是另一个任务。
 */
export function canonicalInstant(value: string, field: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw invalidArgument(`${field} 必须是 ISO 8601 时间串。`, { field, value });
  }
  return new Date(timestamp).toISOString();
}

/**
 * 记忆 frontmatter 的 `valid_from` / `valid_until` → 索引列形态；不可用返回 `null`。
 *
 * 与 `canonicalInstant` 的差别只有两点，都来自「输入是磁盘上的手改文件」：
 *
 * 1. **不抛错**。值不是字符串（`valid_from: 123` 会被 YAML 读成 number）、是
 *    布尔、是序列、或根本不是时间串（`valid_from: 下周`），都读作「没有有效期」。
 *    有效期是辅助信息，解析不出来不该让整条记忆读不出来，更不该让一次 `reindex`
 *    在中途抛错。
 * 2. **归一化**。合法值写成 `Date#toISOString()` 的 UTC 形态（`+08:00` 的输入会被
 *    折算成 `Z`）：`node.valid_*` 与过滤边界都是 TEXT 比较，不归一化会得到错误的
 *    时间顺序（同 `canonicalInstant` 的理由）。手写的 `2026-11-10` 补成
 *    `2026-11-10T00:00:00.000Z`。
 *
 * 三个 frontmatter 解析点（`services/memory.ts`、`services/index-observer.ts`、
 * `commands/reindex.ts`）都调这一个函数。三处各写一份判断时，同一份文件会得到三个
 * 有效期：写入时按 A 算、索引按 B 算、`reindex` 按 C 算，而 `reindex` 会把整列
 * 覆盖掉——「检索看不到历史版本」这条保证会在一次重建后悄悄失效。
 */
export function parseValidityInstant(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return null;
  }
  return new Date(timestamp).toISOString();
}

/**
 * 元数据过滤维度（记忆类型、更新时间范围、有效期）的校验。
 *
 * 空 `memoryTypes` 与省略同义（`contextTypes` / `levels` 也是这个语义）：调用方
 * 从配置里拿到空数组时不该被迫分支。区间为空（`updatedAfter > updatedBefore`）
 * 报错而不是静默返回空集——那是调用方写错了参数，不是「没有匹配」。
 *
 * `asOf` 只校验可解析：它是**单点**时刻，没有「空区间」可言。口径与
 * `updatedAfter` 一致——非法时间串在这里就被拒绝，不会一路走到 SQL 比较。
 */
function validateMetadataFilter(query: {
  readonly memoryTypes?: readonly string[];
  readonly updatedAfter?: string;
  readonly updatedBefore?: string;
  readonly asOf?: string;
}): void {
  if (query.memoryTypes?.some((memoryType) => memoryType === '') === true) {
    throw invalidArgument('memoryTypes 里不能有空字符串。', { memoryTypes: query.memoryTypes });
  }
  const after =
    query.updatedAfter === undefined
      ? undefined
      : canonicalInstant(query.updatedAfter, 'updatedAfter');
  const before =
    query.updatedBefore === undefined
      ? undefined
      : canonicalInstant(query.updatedBefore, 'updatedBefore');
  if (after !== undefined && before !== undefined && after > before) {
    throw invalidArgument('updatedAfter 不能晚于 updatedBefore：这个时间区间永远为空。', {
      updatedAfter: query.updatedAfter,
      updatedBefore: query.updatedBefore,
    });
  }
  if (query.asOf !== undefined) {
    canonicalInstant(query.asOf, 'asOf');
  }
}

/**
 * 校验检索查询。合法返回 `undefined`，非法抛 `INVALID_ARGUMENT`。
 *
 * 在进索引实现之前挡掉不可能成立的查询：空 `scopes` 会退化成全库扫描，
 * 空 `principals` 只会得到空结果，`limit <= 0` 在 SQL 里的语义依实现而异。
 */
export function validateSearchQuery(query: SearchQuery): void {
  validateQueryEnvelope(query);
  validateText(query.text, 'text');
  validateMetadataFilter(query);
}

/**
 * 把模型产出的条目收敛成合法 `TypedQuery`。
 *
 * 三件事，顺序不能变：
 *
 * 1. **去空**：`text.trim() === ''` 的条目直接丢弃。空查询在索引侧会退化成
 *    随机结果（`validateSearchQuery` 拒绝空 `text` 是同一条理由）。
 * 2. **去重**：按 `text.trim().toLowerCase()` 去重，**保留置信度最高的那条**。
 *    模型常常把同一件事换个大小写或全半角写两遍，跑两遍只多花一次索引查询。
 * 3. **截断**：最多 `maxQueries` 条。
 *
 * 置信度在这里 clamp 到 `[0, 1]`：模型给 1.5 或 -0.3 时，排序规则（按置信度
 * 择一）与 UI 展示都要求区间成立，越界值不该漏到调用方。`NaN` / `Infinity` 落 0。
 *
 * 去重保留**首次出现的位置**（`Map` 的插入序），不在命中同分时打乱模型给的顺序。
 */
export function normalizeTypedQueries(
  drafts: readonly TypedQueryDraft[],
  maxQueries: number,
): readonly TypedQuery[] {
  const byText = new Map<string, TypedQuery>();
  for (const draft of drafts) {
    const text = draft.text.trim();
    if (text === '') {
      continue;
    }
    const derivedFrom = draft.derivedFrom?.trim() ?? '';
    const query: TypedQuery = {
      text,
      intent: draft.intent,
      confidence: clampConfidence(draft.confidence),
      derivedFrom: derivedFrom === '' ? null : derivedFrom,
    };
    const key = text.toLowerCase();
    const existing = byText.get(key);
    if (existing === undefined || query.confidence > existing.confidence) {
      byText.set(key, query);
    }
  }
  return [...byText.values()].slice(0, Math.max(0, maxQueries));
}

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
}

/** 校验 `glob` 查询。 */
export function validateGlobQuery(query: GlobQuery): void {
  validateQueryEnvelope(query);
  validateText(query.pattern, 'pattern');
  validateMetadataFilter(query);
}
