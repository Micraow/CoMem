/**
 * DSH 宿主适配（架构文档 §15.5、§15.8）。
 *
 * DSH 的插件 hook 载荷没有公开规范，本文件定义插件所依赖的那一份（写进 README
 * 的「宿主载荷」一节）。为了让「加第三个宿主只加一个文件」（§15.8）成立，这里
 * 不 import 任何其它宿主适配器——信封与载荷解析都是独立的。
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

import { ComemHookError } from '../lib/http.mjs';
import {
  STDIN_READ_CAP_MS,
  armHardDeadline,
  budgetForEvent,
  createDeadline,
  diagnose,
  readStdinText,
  scheduleHardExit,
} from '../lib/lifecycle.mjs';

/** 会话 ID 前缀（§15.5）。 */
export const SESSION_ID_PREFIX = 'dsh-';

/**
 * 宿主对一次 hook 输出的字节上限。
 *
 * DSH 的插件 hook 没有公开的输出上限，这里取「其它宿主 20,000 字节」的保守值：
 * 超过之后按 `integrations/lib/injection.mjs` 的优先级丢块（先偏好、再技能目录），
 * 而不是让宿主把整段上下文转存成文件。
 *
 * **这是保守假设，没有实测**。真实上限更低时调小，不要指望宿主报错——它只会
 * 静默降级成预览。
 */
export const MAX_CONTEXT_BYTES = 20000;

/** 内部事件名 ↔ 宿主事件名。DSH 用同一组名字。 */
export const EVENT_NAMES = Object.freeze({
  SessionStart: 'SessionStart',
  UserPromptSubmit: 'UserPromptSubmit',
  PreToolUse: 'PreToolUse',
  PostToolUse: 'PostToolUse',
  Stop: 'Stop',
  PreCompact: 'PreCompact',
});

/** 需要拦截 `comem://` 路径的文件工具（任务书：只有这三个）。 */
const FILE_TOOLS = new Set(['Read', 'Write', 'Edit']);

function asRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {};
}

function text(value) {
  return typeof value === 'string' && value !== '' ? value : null;
}

function renderToolOutput(value) {
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
  const event = rawEventName === 'SessionEnd' ? 'PreCompact' : rawEventName;
  if (!(event in EVENT_NAMES)) {
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
    rawEventName,
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
 * 默认读 stdin：上限与总预算同源（`STDIN_READ_CAP_MS`）。
 *
 * 宿主不写也不关 stdin 时，`for await` 永远不会返回；这个上限把它变成
 * 「没有事件」（`HOOK_STDIN_TIMEOUT`），由 `runHook` 收敛成诊断 + 退出码 0。
 */
async function readJsonStdin() {
  const raw = (await readStdinText(STDIN_READ_CAP_MS)).trim();
  if (raw === '') {
    throw new ComemHookError('DSH hook 没有收到 stdin 载荷。', { code: 'HOOK_INVALID_ARGUMENT' });
  }
  return JSON.parse(raw);
}

/**
 * 入口。异常写 stderr 并正常退出——hook 是旁路，不能打断对话。
 *
 * @param {(event: ReturnType<typeof normalizeEvent>, context: { deadline: ReturnType<typeof createDeadline> }) => Promise<object | undefined>} handler
 * @param {{ read?: () => Promise<unknown>, write?: (line: string) => void, hardExit?: boolean }} [options]
 *   `hardExit` 只由真正的 hook 入口传：安排兜底退出（见 `lib/lifecycle.mjs`）
 */
export async function runHook(handler, options = {}) {
  const read = options.read ?? readJsonStdin;
  // 写完再 resolve：`scheduleHardExit` 不会截断已经开始的 stdout 写入。
  const write =
    options.write ??
    ((line) =>
      new Promise((resolve) => {
        process.stdout.write(`${line}\n`, resolve);
      }));
  // 默认不强制退出：测试用注入的 read/write 在同一个进程里跑多个用例。
  // 真正的 hook 入口（`servers/*.mjs`）传 `hardExit: true`。
  const hardExit = options.hardExit ?? false;

  let event;
  try {
    event = normalizeEvent(await read());
  } catch (error) {
    await diagnose(`co-mem hook: ${error instanceof Error ? error.message : String(error)}`);
    if (hardExit) {
      scheduleHardExit();
    }
    return null;
  }

  // 总预算从进程启动算起：读 stdin 花掉的时间也从里面扣（`lib/lifecycle.mjs`）。
  const deadline = createDeadline(budgetForEvent(event));
  if (hardExit) {
    // 硬上限：handler 不返回时也要退出（见 `armHardDeadline`）。
    armHardDeadline(deadline);
  }

  try {
    const result = await handler(event, { deadline });
    const output = formatOutput(event, result);
    if (output !== null) {
      await write(JSON.stringify(output));
    }
  } catch (error) {
    // 任何内部错误：stdout 一个字节都不写（宿主按「没有输出」放行），退出码 0。
    await diagnose(
      `co-mem hook ${event.event}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (hardExit) {
    scheduleHardExit();
  }
  return event;
}
