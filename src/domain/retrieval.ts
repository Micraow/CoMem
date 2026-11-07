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
}

export interface SearchQuery {
  readonly text: string;
  /** 路径前缀 */
  readonly scopes: readonly string[];
  /** 调用方权限主体，如 `user:alice`、`group:eng`、`user:*` */
  readonly principals: readonly string[];
  readonly contextTypes?: readonly ContextType[];
  readonly levels?: readonly Level[];
  readonly limit: number;
  readonly scoreThreshold?: number;
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
export type TypedQueryIntent =
  /** 用户的偏好、习惯、风格 */
  | 'preference'
  /** 事实性知识（项目结构、约定、配置） */
  | 'fact'
  /** 做过的决定与理由 */
  | 'decision'
  /** 发生过的事（某次提交、某次讨论） */
  | 'event'
  /** 步骤、流程、怎么操作 */
  | 'procedure'
  /** 兜底：模型给了契约外的 intent，或这条查询不该分类 */
  | 'other';

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

export interface GrepQuery {
  readonly pattern: string;
  readonly scopes: readonly string[];
  readonly principals: readonly string[];
  readonly limit: number;
  readonly contextLines: number;
}

export interface GrepHit {
  readonly uri: string;
  readonly line: number;
  readonly text: string;
  readonly before: readonly string[];
  readonly after: readonly string[];
}

export interface GlobQuery {
  readonly pattern: string;
  readonly scopes: readonly string[];
  readonly principals: readonly string[];
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
 * `GrepQuery` / `GrepHit` 保留：它们是服务层的输入输出形状，不属于索引契约。
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
 * 校验检索查询。合法返回 `undefined`，非法抛 `INVALID_ARGUMENT`。
 *
 * 在进索引实现之前挡掉不可能成立的查询：空 `scopes` 会退化成全库扫描，
 * 空 `principals` 只会得到空结果，`limit <= 0` 在 SQL 里的语义依实现而异。
 */
export function validateSearchQuery(query: SearchQuery): void {
  validateQueryEnvelope(query);
  validateText(query.text, 'text');
}

/** 校验 `grep` 查询；正则本身也要能编译。 */
export function validateGrepQuery(query: GrepQuery): void {
  validateQueryEnvelope(query);
  validateText(query.pattern, 'pattern');
  if (!Number.isInteger(query.contextLines) || query.contextLines < 0) {
    throw invalidArgument('contextLines 必须是非负整数。', { contextLines: query.contextLines });
  }
  try {
    new RegExp(query.pattern);
  } catch {
    throw invalidArgument('pattern 不是合法的正则表达式。', { pattern: query.pattern });
  }
}

/**
 * 把模型产出的条目收敛成合法 `TypedQuery`（§8.4 的三条约束）。
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
}
