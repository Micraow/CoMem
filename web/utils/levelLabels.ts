/**
 * 披露层级（L0 摘要 / L1 概览 / L2 原文）→ 界面文案与页签（检索结果与文件树共用）。
 *
 * ## 为什么取值也在这里声明一份
 *
 * 取值清单来自 `src/domain/level.ts` 的 `LEVELS`：`serializeHit()`
 * （`src/api/http/routes/search.ts`）原样输出 `hit.level`，而它的静态类型
 * （`ScoredHit` / `SearchResultHit`，`src/domain/retrieval.ts`）就是 `level: Level`。
 * 中间没有运行期映射产生新值，所以 `/search/find` 与 `/search/search` 的 `level`
 * 只可能是这三个之一。
 *
 * 控制台是独立包（`web/` 不在根 pnpm workspace 里），不能 import `src/domain`，
 * 所以这里的 `as const` 数组是 web 侧的取值来源：类型从数组派生，映射用
 * `satisfies Record<层级, 文案>` 穷举。跨项目一致性由
 * `tests/unit/web/level-labels.test.ts` 对拍——那是唯一同时 import 两边的地方。
 *
 * ## 为什么还有一份小写页签清单
 *
 * 文件树的三档用 `l0` / `l1` / `l2` 当页签标识（`UiTabs` 的 `v-model` 值）。它是
 * 控制台自己的 UI 标识，不是服务端的层级值，所以单独一张表；`LEVEL_OF_TAB` 把
 * 两者钉在一起，少一档或加一档都是编译错误。
 */
export const LEVELS = ['L0', 'L1', 'L2'] as const

export type Level = (typeof LEVELS)[number]

/** 层级 → 「为什么被召回」。层级本身就是原因，不额外编造匹配理由。 */
export const LEVEL_REASON = {
  L0: '摘要命中',
  L1: '概览命中',
  L2: '原文命中',
} satisfies Record<Level, string>

/** 文件树的三档页签。 */
export const LEVEL_TABS = ['l0', 'l1', 'l2'] as const

export type LevelTab = (typeof LEVEL_TABS)[number]

/** 页签 → 领域层级。 */
export const LEVEL_OF_TAB: Readonly<Record<LevelTab, Level>> = {
  l0: 'L0',
  l1: 'L1',
  l2: 'L2',
}

/** 页签 → 页签名。 */
export const LEVEL_TAB_LABEL: Readonly<Record<LevelTab, string>> = {
  l0: '摘要',
  l1: '概览',
  l2: '原文',
}

/**
 * 页签 → 一句话说明。
 *
 * 说明里的 256 / 4000 是服务端摘要的截断长度（`src/domain/summary.ts` 的
 * `ABSTRACT_MAX_CHARS` / `OVERVIEW_MAX_CHARS`）。改上限时这句话要跟着改，但它不是
 * 类型契约——多一个字符的摘要不会让界面说谎。
 */
export const LEVEL_TAB_NOTE: Readonly<Record<LevelTab, string>> = {
  l0: '一句话摘要，256 字符以内。',
  l1: '目录级上下文，4000 字符以内。',
  l2: '完整正文；目录列出直接子项。',
}
