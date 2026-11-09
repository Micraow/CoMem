/**
 * 正文按 **Unicode 码点** 分页切片（架构文档 §13.2 的 `read`、§14 的 `content/read`）。
 *
 * ## 两个读出口共用这一份
 *
 * MCP 的 `read` 与 HTTP 的 `GET /content/read` 是同一个能力的两个入口：`offset` /
 * `limit` 都是码点下标，`limit = -1` 表示读到末尾。两边各写一份时，分页语义漂了
 * 就是「一个入口对、一个入口错」，而用户看到的形态是「同一份数据两种读法结果
 * 不一样」，会先怀疑数据本身。所以这里只定义一次。
 *
 * ## 为什么在 `api/` 根下
 *
 * 它同时服务 `api/mcp` 与 `api/http`（同层兄弟）。放进任一侧都会造出一条只为共用
 * 一个函数而存在的依赖边；放在 `api/` 下，两边都只依赖「接口层的正文分页」这一个
 * 概念，与 `api/deadline.ts` 的位置理由相同。
 *
 * ## 为什么不是 `String.prototype.slice`
 *
 * 字符串的 `slice` 按 UTF-16 码元下标切，中文之外的 emoji 是代理对（两个码元），
 * 从中间切会得到半个字符（U+FFFD 或孤立代理项）。`[...text]` 按码点迭代，
 * `Array.prototype.slice` 再对码点数组切片，`offset` / `limit` 与调用方约定的一致。
 */

/** `limit` 取负值表示读到末尾；其它值按码点数截断。 */
export function sliceText(text: string, offset: number, limit: number): string {
  const codePoints = [...text];
  return codePoints.slice(offset, limit < 0 ? undefined : offset + limit).join('');
}
