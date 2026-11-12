/**
 * 宿主载荷的取值助手（架构文档 §15.5）。
 *
 * `normalizeEvent` 与 `parseTranscript` 拿到的都是**未校验的宿主 JSON**：字段可能是
 * 字符串、`null`、对象、数组，或者干脆不存在。四个函数各管一种取法，逐字相同地出现在
 * 三个宿主适配器里，所以收在这里——它们只回答「这个值是什么形状」，与是哪个宿主无关。
 *
 * 宿主差异仍然留在 `hosts/*.mjs`：那一层决定**从哪个字段取**（`hook_event_name` 还是
 * `event`、`transcript_path` 还是 `data.transcriptPath`），这里只决定**取到的值算不算数**。
 */

/**
 * 只认普通对象；数组与 `null` 都当空对象。
 *
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
export function asRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {};
}

/**
 * 非空字符串，否则 `null`。空串在宿主载荷里和「没给」同义。
 *
 * @param {unknown} value
 * @returns {string | null}
 */
export function text(value) {
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * 工具输出 → 字符串或 `null`。
 *
 * 字符串原样透传（`sanitizeCapturedText` 依赖它仍然是工具输出的原文），其它形状
 * `JSON.stringify`；序列化失败（循环引用）退回 `String`，不抛错——采集侧不能因为
 * 一个畸形工具结果丢掉整轮会话。
 *
 * @param {unknown} value
 * @returns {string | null}
 */
export function renderToolOutput(value) {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value === 'string') {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * 一行被跳过内容的形状：只看键名与 `type` 这类枚举值，不取正文。
 *
 * `Stop` 采到 0 条消息时把第一行的形状写进 `comem-capture.log`，用来说明「这份
 * transcript 不是这个宿主的格式」。正文与凭据不进诊断。
 *
 * @param {Record<string, unknown>} entry
 * @returns {string}
 */
export function describeEntry(entry) {
  const keys = Object.keys(entry).slice(0, 3).join(',');
  const type = typeof entry['type'] === 'string' ? entry['type'] : '?';
  const payload = asRecord(entry['payload']);
  const payloadType = typeof payload['type'] === 'string' ? payload['type'] : '?';
  return `type=${type} payload.type=${payloadType} keys=${keys}`;
}
