/**
 * `search` 的出参形态（架构文档 §8.6）：`list` 是默认，`context` 返回可直接注入
 * 模型的文本与分层明细。同一个 `search` 能力的两种出参，不是第 17 个 MCP 工具。
 *
 * MCP 的 `search` 与 HTTP `/search` 各抄一份取值时，给一个入口加第三种形态不会让
 * 另一个编译失败——同一个能力按入口给出不同结果。
 */

export const SEARCH_MODES = ['list', 'context'] as const;

export type SearchMode = (typeof SEARCH_MODES)[number];

/** 形态守卫。`.some()` 而不是 `includes(value as SearchMode)`：不打断言。 */
export function isSearchMode(value: string): value is SearchMode {
  return SEARCH_MODES.some((mode) => mode === value);
}
