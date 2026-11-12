/**
 * DSH 宿主适配（架构文档 §15.5、§15.8）。
 *
 * DSH 的插件 hook 载荷没有公开规范，本文件定义插件所依赖的那一份（写进 README
 * 的「宿主载荷」一节）。为了让「加第三个宿主只加一个文件」（§15.8）成立，这里
 * 不 import 任何其它宿主适配器——信封与载荷解析都是独立的。共用 `lib/` 不违反
 * 这条：入口骨架在 `lib/hook-runner.mjs`，它本来就没有宿主差异。
 *
 * ## 载荷
 *
 * ```json
 * {
 *   "event": "UserPromptSubmit",
 *   "sessionId": "0b1c…",
 *   "eventId": "evt_7f3a",
 *   "cwd": "/repo",
 *   "data": { "prompt": "…", "toolName": "Read", "filePath": "comem://…" }
 * }
 * ```
 *
 * 同时兼容 Claude Code 的扁平形状（`hook_event_name` / `session_id` / `prompt`）：
 * 两份 settings 用同一批脚本时，适配器不需要跟着换。
 *
 * `data.messages` 必须是**会话累积列表**（与 Claude Code 的 transcript 同语义）：
 * 游标记的是「已经提交到第几条」，只给本轮消息会让游标跳过它们。
 *
 * ## 信封
 *
 * 与 CoMem 自己的 HTTP 封套同形（`{status, result}`），DSH 的插件运行器按
 * `result.context` 注入、按 `result.block` 拦截。
 *
 * | 字段 | 含义 |
 * |---|---|
 * | `result.context` | 追加到模型上下文的文本 |
 * | `result.block` + `result.reason` | 拦截这次工具调用 |
 * | `result.message` | 显示给用户的系统消息 |
 */

import { randomUUID } from 'node:crypto';

import { EVENT_NAMES, internalEventNameOf } from '../lib/events.mjs';
import { createRunHook } from '../lib/hook-runner.mjs';
import { ComemHookError } from '../lib/http.mjs';
import { asRecord, renderToolOutput, text } from '../lib/values.mjs';

/** 会话 ID 前缀（§15.5）。 */
export const SESSION_ID_PREFIX = 'dsh-';

/**
 * 宿主对一次 hook 输出的字节上限。
 *
 * DSH 的插件 hook 没有公开的输出上限，这里取「其它宿主 20,000 字节」的保守值：
 * 超过之后按 `integrations/lib/injection.mjs` 的 `CONTEXT_BLOCK_DROP_ORDER` 降级
 * （技能目录 → 召回 → 偏好 → 画像），而不是让宿主把整段上下文转存成文件。
 *
 * **这是保守假设，没有实测**。真实上限更低时调小，不要指望宿主报错——它只会
 * 静默降级成预览。
 */
export const MAX_CONTEXT_BYTES = 20000;

/**
 * 内部事件名 ↔ 宿主事件名。
 *
 * 表在 `lib/events.mjs`（全仓库唯一一份）。DSH 的事件名与其它两个宿主相同，
 * 所以共用一张表；名字本身不在这里定义。
 */
export { EVENT_NAMES };

/** 需要拦截 `comem://` 路径的文件工具（任务书：只有这三个）。 */
const FILE_TOOLS = new Set(['Read', 'Write', 'Edit']);

/**
 * DSH 的消息形状：`{ role, text }` 或 `{ role, parts }`。
 *
 * 只接受文本 part——图片与工具调用由各自的 hook 采集，不在这里重复。
 */
function normalizeMessages(value) {
  if (!Array.isArray(value)) {
    return null;
  }
  const messages = [];
  for (const entry of value) {
    const record = asRecord(entry);
    const role = record['role'];
    if (role !== 'user' && role !== 'assistant') {
      continue;
    }
    const parts = [];
    if (typeof record['text'] === 'string' && record['text'] !== '') {
      parts.push({ kind: 'text', text: record['text'] });
    }
    if (Array.isArray(record['parts'])) {
      for (const part of record['parts']) {
        const candidate = asRecord(part);
        if (candidate['kind'] === 'text' && typeof candidate['text'] === 'string') {
          parts.push({ kind: 'text', text: candidate['text'] });
        }
      }
    }
    if (parts.length === 0) {
      continue;
    }
    messages.push({
      id: text(record['id']) ?? randomUUID(),
      role,
      parts,
      createdAt: text(record['createdAt']) ?? new Date().toISOString(),
    });
  }
  return messages;
}

/**
 * DSH 不解析 transcript。
 *
 * DSH 的会话消息按本插件的约定从 hook 载荷的 `data.messages` 读（见文件头的
 * 「载荷」），采集直接用它，**没有需要解析的 transcript 文件**。载荷里的
 * `transcriptPath` 是为了兼容 Claude Code 的扁平形状而接受的，**DSH 的 transcript
 * 文件格式未验证**——不在这里编一份解析器去猜（那会把一份猜出来的格式当成契约）。
 *
 * 返回空结果并带 `note`：`servers/stop.mjs` 在「解析出 0 条消息」时把它写进
 * 诊断日志，而不是静默早退。
 *
 * @returns {{
 *   messages: Record<string, unknown>[],
 *   lines: number,
 *   skipped: number,
 *   sample: string | null,
 *   note: string,
 * }}
 */
export function parseTranscript() {
  return {
    messages: [],
    lines: 0,
    skipped: 0,
    sample: null,
    note: 'DSH 的会话消息来自 hook 载荷的 data.messages；transcript 文件格式未验证。',
  };
}

/**
 * @param {unknown} raw
 */
export function normalizeEvent(raw) {
  const envelope = asRecord(raw);
  const data = asRecord(envelope['data']);

  // 两种形状：DSH 的 `{event, sessionId, data}`，以及 Claude Code 的扁平形状。
  const rawEventName = text(envelope['event']) ?? text(envelope['hook_event_name']);
  if (rawEventName === null) {
    throw new ComemHookError('DSH 载荷缺少 event。', { code: 'HOOK_INVALID_ARGUMENT' });
  }
  // 宿主事件名 → 内部事件名。`SessionEnd` 是一等事件（自己的预算与上报标签），
  // 不再改写成 `PreCompact`。
  const event = internalEventNameOf(rawEventName);
  if (event === null) {
    throw new ComemHookError(`未支持的 DSH hook 事件：${rawEventName}`, {
      code: 'HOOK_INVALID_ARGUMENT',
    });
  }

  const sessionId = text(envelope['sessionId']) ?? text(envelope['session_id']);
  if (sessionId === null) {
    throw new ComemHookError('DSH 载荷缺少 sessionId。', { code: 'HOOK_INVALID_ARGUMENT' });
  }

  const toolName = text(data['toolName']) ?? text(envelope['tool_name']);
  const toolInput = data['toolInput'] ?? envelope['tool_input'] ?? null;
  const toolUseId = text(data['toolUseId']) ?? text(envelope['tool_use_id']);
  const filePathValue = text(data['filePath']) ?? text(envelope['file_path']);

  return {
    host: 'dsh',
    event,
    hostEventName: EVENT_NAMES[event],
    sessionId: `${SESSION_ID_PREFIX}${sessionId}`,
    eventId: text(envelope['eventId']) ?? text(envelope['event_id']) ?? null,
    cwd: text(envelope['cwd']) ?? process.cwd(),
    prompt: text(data['prompt']) ?? text(envelope['prompt']),
    toolName,
    filePath: toolName !== null && FILE_TOOLS.has(toolName) ? filePathValue : null,
    toolInput,
    toolOutput: renderToolOutput(data['toolOutput'] ?? envelope['tool_response']),
    toolUseId,
    transcriptPath: text(data['transcriptPath']) ?? text(envelope['transcript_path']),
    messages: normalizeMessages(data['messages'] ?? envelope['messages']),
    source: text(data['source']) ?? text(envelope['source']),
  };
}

/**
 * 内部结果 → DSH 信封（`{status, result}`）。
 *
 * @param {ReturnType<typeof normalizeEvent>} event
 * @param {{ context?: string, deny?: string, message?: string } | undefined} result
 */
export function formatOutput(event, result) {
  const payload = { event: event.hostEventName };
  if (result === undefined) {
    return { status: 'ok', result: payload };
  }
  if (typeof result.context === 'string' && result.context !== '') {
    payload['context'] = result.context;
  }
  if (typeof result.deny === 'string' && result.deny !== '') {
    payload['block'] = true;
    payload['reason'] = result.deny;
  }
  if (typeof result.message === 'string' && result.message !== '') {
    payload['message'] = result.message;
  }
  return { status: 'ok', result: payload };
}

/**
 * 入口：stdin → 归一化 → 业务处理 → 宿主信封。
 *
 * 骨架在 `lib/hook-runner.mjs`（与宿主无关）；这里只绑定本宿主的归一化与信封。
 * 错误路径、总预算与 `hardExit` 语义在那里，三个宿主共用同一份。
 */
export const runHook = createRunHook({
  hostLabel: 'DSH',
  normalizeEvent,
  formatOutput,
});
