/**
 * `unknown` 的运行时形状守卫。
 *
 * 输入来自 `JSON.parse`、`unknown` 形式的端口参数或 `catch` 子句，类型系统在这里
 * 帮不上忙，只能先判形状再取值。这份实现只依赖 JS 内建，所以放在 `domain/`：
 * 这一层不 import 任何其它层，不会把 IO 带进来。
 *
 * 为什么必须只有一份：`isRecord` 是否排除数组决定调用方读出的是对象还是
 * `'length'` 之类恰好存在的成员。各写一份时，同一个 `JSON.parse` 结果在一个
 * 调用点被当成对象、在另一个调用点被拒绝。
 */

/** 非数组对象。排除数组：数组的 `'length' in value` 为真，会读出错误的字段。 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
