/**
 * Prometheus 文本格式的数值、标签转义与单位换算。
 *
 * 指标名、标签顺序与数值格式是外部契约（见 `../observability.ts` 文件头 §17.1），
 * 这三处工具被指标渲染、请求耗时累加与健康度共用，改一处就会同时改变三处的输出。
 */

/** 1 秒 = 1000 毫秒。`durationMs` 换成 Prometheus 的秒。 */
export const MILLISECONDS_PER_SECOND = 1000;

/** Prometheus 文本里的数值。非有限值（NaN / ±Infinity）写 0，否则抓取会整段失败。 */
export function metricValue(value: number): string {
  return Number.isFinite(value) ? String(value) : '0';
}

/** 标签值转义（Prometheus 文本格式）：反斜杠、换行、双引号。 */
export function escapeLabel(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('\n', '\\n').replaceAll('"', '\\"');
}
