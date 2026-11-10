/**
 * `write` 的三种模式（MCP `write` 与 HTTP `POST /content/write` 共用的线格式）。
 *
 * 数组是唯一来源，类型从它派生：两个入口各抄一份时，给其中一个加模式（例如
 * `prepend`）不会让另一个编译失败——MCP 接受、HTTP 拒绝，同一个能力两个行为。
 */

export const WRITE_MODES = ['replace', 'append', 'create'] as const;

export type WriteMode = (typeof WRITE_MODES)[number];

/** 模式守卫。`.some()` 而不是 `includes(value as WriteMode)`：不打断言。 */
export function isWriteMode(value: unknown): value is WriteMode {
  return WRITE_MODES.some((mode) => mode === value);
}
