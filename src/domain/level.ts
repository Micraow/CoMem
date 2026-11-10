/**
 * 渐进式披露的层级（架构文档 §8.5、§9.1）。
 *
 * 这个类型被摘要、检索、排序、组装四处共用，单独成文件是为了让 W1 的两个
 * 并行实现都只依赖一个冻结的契约，而不是互相 import。
 *
 * ## 一份来源
 *
 * 数组是唯一来源，类型从它派生（第 2 条验收判据）：MCP 的 `inputSchema.enum`、
 * HTTP 的 `levels` 查询参数、`LEVEL_ORDER` 的键都要跟着它走。反过来写（先写联合、
 * 再手抄一份数组）时，往数组里少抄一个成员不会有任何编译错误，而 HTTP 会拒绝一个
 * 层级合法的请求。
 */

export const LEVELS = ['L0', 'L1', 'L2'] as const;

export type Level = (typeof LEVELS)[number];

/** 层级的数值序，用于比较「这条记录比那条更细」。漏一个键即编译错误。 */
export const LEVEL_ORDER: Readonly<Record<Level, number>> = {
  L0: 0,
  L1: 1,
  L2: 2,
};

/**
 * 层级名守卫。
 *
 * 写成 `.some()` 而不是 `new Set(LEVELS).has(value)`：`Set<string>.has` 需要把入参
 * 断言成 `Level`，等于在这道边界上关掉类型检查。
 */
export function isLevel(value: string): value is Level {
  return LEVELS.some((level) => level === value);
}
