/**
 * 检索界面的两张文案表：查询计划的意图、命中的上下文类型（检索页）。
 *
 * ## 为什么取值也在这里声明一份
 *
 * 取值清单来自 `src/domain/retrieval.ts` 的 `TYPED_QUERY_INTENTS`：意图分析把模型
 * 输出交给 `z.enum(TYPED_QUERY_INTENTS).catch('other')`（`src/services/prompts/
 * rewrite.ts`），`serializePlan()`（`src/api/http/routes/search.ts`）原样输出
 * `TypedQuery.intent`。所以 `/search/search` 的 `plan.queries[].intent` 只可能是这
 * 六个值之一——旧实现 `INTENT_LABEL[intent] ?? '其他'` 的兜底永远不会命中，它只是
 * 把「领域层加一个意图、界面没跟」伪装成一句「其他」。
 *
 * 控制台是独立包（`web/` 不在根 pnpm workspace 里），不能 import `src/domain`，
 * 所以这里的 `as const` 数组是 web 侧的取值来源：类型从数组派生，映射用
 * `satisfies Record<意图, 文案>` 穷举。跨项目一致性由
 * `tests/unit/web/search-labels.test.ts` 对拍——那是唯一同时 import 两边的地方。
 */
export const TYPED_QUERY_INTENTS = [
  'preference',
  'fact',
  'decision',
  'event',
  'procedure',
  'other',
] as const

export type TypedQueryIntent = (typeof TYPED_QUERY_INTENTS)[number]

/** 意图 → 文案。漏一个意图即编译失败，多一个键也是。 */
const INTENT_LABEL = {
  preference: '偏好',
  fact: '事实',
  decision: '决定',
  event: '事件',
  procedure: '流程',
  other: '其他',
} satisfies Record<TypedQueryIntent, string>

/**
 * 意图 → 界面文案。
 *
 * 入参就是 `TypedQueryIntent`：`components/domain/HitList.vue` 的
 * `SearchTypedQueryPayload.intent` 用的也是这个类型。写宽成 `string` 时索引只能靠
 * `as` 断言，而断言会在「领域层加一个意图、界面没跟」时把 `undefined` 渲染出来。
 */
export function typedQueryIntentLabel(intent: TypedQueryIntent): string {
  return INTENT_LABEL[intent]
}

/**
 * `contextType` 的取值清单，来自 `src/domain/node.ts` 的 `CONTEXT_TYPES`。
 *
 * `serializeHit()` 原样输出 `hit.contextType`，其静态类型是 `ContextType`，所以
 * 命中的上下文类型只可能是这四个之一。`/search/find` 与 `/search/search` 共用同一
 * 份序列化，两者没有分叉。
 */
export const CONTEXT_TYPES = ['memory', 'resource', 'skill', 'session'] as const

export type ContextType = (typeof CONTEXT_TYPES)[number]

/** 上下文类型 → 文案。漏一个类型即编译失败，多一个键也是。 */
export const CONTEXT_LABEL = {
  memory: '记忆',
  resource: '资源',
  skill: '技能',
  session: '会话',
} satisfies Record<ContextType, string>

/**
 * `retrieval.engine` 的取值，来自 `src/domain/retrieval.ts` 的 `RETRIEVAL_ENGINES`。
 *
 * 控制台从 `GET /health` 的 `retrieval.engine` 读实际生效的配置。界面上写的是
 * 「关键词匹配 / 向量检索 / 混合检索」：`fts5` 是词法召回，叫「语义检索」等于说谎。
 */
export const RETRIEVAL_ENGINES = ['fts5', 'vector', 'hybrid'] as const

export type RetrievalEngine = (typeof RETRIEVAL_ENGINES)[number]

/** 引擎 → 界面文案。漏一个引擎即编译失败，多一个键也是。 */
const ENGINE_LABEL = {
  fts5: '关键词匹配',
  vector: '向量检索',
  hybrid: '混合检索',
} satisfies Record<RetrievalEngine, string>

export function retrievalEngineLabel(engine: RetrievalEngine): string {
  return ENGINE_LABEL[engine]
}

/**
 * 0 命中时对当前引擎边界的说明。
 *
 * `fts5` 的查询是「查询里每个词都要在正文里出现」的词法匹配；自然语言长句几乎
 * 一定 0 命中。向量 / 混合检索没有这条限制，返回 `null`（空态里不再补一句废话）。
 */
export function retrievalEngineLimit(engine: RetrievalEngine): string | null {
  return engine === 'fts5'
    ? '当前按关键词匹配：查询里的词需要同时出现在记忆里，长句子往往一个词都对不上。'
    : null
}
