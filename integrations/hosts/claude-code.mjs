/**
 * Claude Code 宿主适配（架构文档 §15.5、§15.8）。
 *
 * 适配器只回答四个问题：**事件名怎么叫**、**返回信封长什么样**、**prompt 从载荷
 * 哪里读**、**一轮结束怎么判定**。去重、游标、锁、重试都在 `lib/` 里，与宿主无关。
 *
 * ## 载荷
 *
 * Claude Code 的 hook 从 stdin 收 JSON，公共字段是 `session_id`、`transcript_path`、
 * `cwd`、`hook_event_name`，其余按事件不同：
 *
 * | 事件 | 额外字段 |
 * |---|---|
 * | `SessionStart` | `source`（`startup` / `resume` / `clear` / `compact`） |
 * | `UserPromptSubmit` | `prompt` |
 * | `PreToolUse` | `tool_name`、`tool_input`、`tool_use_id` |
 * | `PostToolUse` | 同上 + `tool_response` |
 * | `Stop` | `stop_hook_active` |
 * | `PreCompact` | `trigger`、`custom_instructions` |
 * | `SessionEnd` | `reason`（`clear` / `logout` / `prompt_input_exit` / `other`） |
 *
 * ## 事件 ID
 *
 * Claude Code 的 `Stop` 载荷里没有事件 ID，而两轮合法的 `Stop` 可以完全一样。
 * 拿载荷哈希当 ID 会把第二轮当成重复事件吞掉（丢消息），所以只有工具类事件用
 * `tool_use_id` 合成 ID，其余一律 `null`（不去重，靠游标兜底，§15.4）。
 */

import { EVENT_NAMES, internalEventNameOf } from '../lib/events.mjs';
import { createRunHook } from '../lib/hook-runner.mjs';
import { ComemHookError } from '../lib/http.mjs';
import { asRecord, describeEntry, renderToolOutput, text } from '../lib/values.mjs';

/** 会话 ID 前缀（§15.5）。宿主自己的 session_id 直接拼在后面。 */
export const SESSION_ID_PREFIX = 'cc-';

/**
 * 宿主对一次 hook 输出的字节上限。
 *
 * 超过之后宿主不把输出当上下文，而是**转存成文件、只放预览**——`SessionStart` 注入
 * 的三个块等于静默失效（模型看到的是「输出太大」而不是画像）。CoMem 侧按
 * `integrations/lib/injection.mjs` 的 `CONTEXT_BLOCK_DROP_ORDER` 降级，不赌宿主。
 *
 * 9,500 的来源：宿主侧的观测阈值是「hook 输出超过约 10,000 字符转存文件」，9,500
 * 留 5% 余量。**这是宿主的实现细节，不是公开规范，CoMem 没有独立复测**；数字在
 * `integrations/lib/injection.mjs` 的截断路径上，改这里就够。
 */
export const MAX_CONTEXT_BYTES = 9500;

/**
 * 内部事件名 ↔ 宿主事件名。
 *
 * 表在 `lib/events.mjs`（全仓库唯一一份，三个宿主共用）。这里只转出去，方便
 * 调用方按宿主取名字；名字本身不在这里定义。
 */
export { EVENT_NAMES };

/** 需要拦截 `comem://` 路径的文件工具（任务书：只有这三个）。 */
const FILE_TOOLS = new Set(['Read', 'Write', 'Edit']);

function toolFilePath(toolName, toolInput) {
  if (toolName === null || !FILE_TOOLS.has(toolName)) {
    return null;
  }
  return text(toolInput['file_path']) ?? text(toolInput['path']);
}

/**
 * 从 transcript 的 `content` 里抽纯文本 part。
 *
 * 只认 `text` 块：`tool_use` / `tool_result` 由 `PostToolUse` 采集（两边不重叠），
 * 图片在 v1 的 Hook 里不采集（§10.1：图片只存 URL，解析交给 agent）。
 */
function extractTextParts(content) {
  if (typeof content === 'string') {
    return content === '' ? [] : [{ kind: 'text', text: content }];
  }
  if (!Array.isArray(content)) {
    return [];
  }
  const parts = [];
  for (const block of content) {
    const record = asRecord(block);
    if (record['type'] === 'text' && typeof record['text'] === 'string' && record['text'] !== '') {
      parts.push({ kind: 'text', text: record['text'] });
    }
  }
  return parts;
}

/**
 * 读 Claude Code 的 transcript（JSONL），只保留 user / assistant 的文本消息。
 *
 * **transcript 的格式由写它的宿主决定**，所以这个解析器挂在宿主适配器上，而不是
 * `servers/stop.mjs`（Codex 的 rollout 是另一种形状，见 `hosts/codex.mjs`）。
 *
 * 畸形行跳过而不是整体失败：transcript 是宿主边写边追加的，最后一行经常是半个
 * JSON。为一行半截数据丢掉整轮会话，方向反了。
 *
 * `isSidechain` 的行（子 agent 的对话）也跳过：它属于另一个会话，混进来会被
 * 抽取成「用户说过」的记忆。
 *
 * @param {string} text transcript 文件的内容
 * @param {{ sessionId?: string }} [options]
 * @returns {{
 *   messages: Record<string, unknown>[],
 *   lines: number,
 *   skipped: number,
 *   sample: string | null,
 * }}
 *   `lines` 是非空行数，`skipped` 是被跳过的行数，`sample` 是**第一行**被跳过内容
 *   的形状。解析出 0 条时，`servers/stop.mjs` 靠这三项在诊断日志里指出「这份文件
 *   不是这个宿主的格式」。
 */
export function parseTranscript(text, options = {}) {
  const sessionId = typeof options.sessionId === 'string' ? options.sessionId : 'transcript';
  const messages = [];
  let lines = 0;
  let skipped = 0;
  let sample = null;

  for (const [index, line] of text.split('\n').entries()) {
    if (line.trim() === '') {
      continue;
    }
    lines += 1;
    let entry;
    try {
      entry = asRecord(JSON.parse(line));
    } catch {
      skipped += 1;
      sample ??= 'invalid JSON';
      continue;
    }
    if (entry['isSidechain'] === true) {
      skipped += 1;
      sample ??= describeEntry(entry);
      continue;
    }
    const message = asRecord(entry['message']);
    const role = message['role'];
    if (role !== 'user' && role !== 'assistant') {
      skipped += 1;
      sample ??= describeEntry(entry);
      continue;
    }
    const parts = extractTextParts(message['content']);
    if (parts.length === 0) {
      skipped += 1;
      sample ??= describeEntry(entry);
      continue;
    }
    messages.push({
      // 用宿主给的 uuid：重投同一批消息时 ID 稳定，服务端能按 ID 去重。
      id: typeof entry['uuid'] === 'string' ? entry['uuid'] : `${sessionId}:${index}`,
      role,
      parts,
      createdAt:
        typeof entry['timestamp'] === 'string' ? entry['timestamp'] : new Date().toISOString(),
    });
  }
  return { messages, lines, skipped, sample };
}

/**
 * 宿主载荷 → 内部事件。
 *
 * 未知事件直接抛错：静默忽略等于让一个拼错的 settings 条目长期不生效，而宿主
 * 不会提示。抛出的错误由 `runHook` 收敛成 stderr + 退出码 0（不能打断对话）。
 *
 * @param {unknown} raw
 */
export function normalizeEvent(raw) {
  const payload = asRecord(raw);
  const rawEventName = text(payload['hook_event_name']) ?? text(payload['event']);
  if (rawEventName === null) {
    throw new ComemHookError('Claude Code 载荷缺少 hook_event_name。', {
      code: 'HOOK_INVALID_ARGUMENT',
    });
  }
  // 宿主事件名 → 内部事件名。`SessionEnd` 也是一等事件（它有自己的预算与
  // 上报标签），不再改写成 `PreCompact`：报文里的 `event` 必须能回答「用户是在
  // 哪个生命周期点上等的」，改写掉就永远看不到会话结束那一段。
  const event = internalEventNameOf(rawEventName);
  if (event === null) {
    throw new ComemHookError(`未支持的 Claude Code hook 事件：${rawEventName}`, {
      code: 'HOOK_INVALID_ARGUMENT',
    });
  }

  const sessionId = text(payload['session_id']);
  if (sessionId === null) {
    throw new ComemHookError('Claude Code 载荷缺少 session_id。', {
      code: 'HOOK_INVALID_ARGUMENT',
    });
  }

  const toolInput = asRecord(payload['tool_input']);
  const toolName = text(payload['tool_name']);
  const toolUseId = text(payload['tool_use_id']);

  return {
    host: 'claude-code',
    event,
    hostEventName: EVENT_NAMES[event],
    sessionId: `${SESSION_ID_PREFIX}${sessionId}`,
    eventId: toolUseId === null ? null : `${event}:${toolUseId}`,
    cwd: text(payload['cwd']) ?? process.cwd(),
    prompt: text(payload['prompt']),
    toolName,
    filePath: toolFilePath(toolName, toolInput),
    toolInput: payload['tool_input'] ?? null,
    toolOutput: renderToolOutput(payload['tool_response']),
    toolUseId,
    transcriptPath: text(payload['transcript_path']),
    messages: null,
    source: text(payload['source']),
  };
}

/**
 * 内部结果 → Claude Code 的返回信封。`null` 表示不写 stdout（等于放行）。
 *
 * - `SessionStart` / `UserPromptSubmit`：`hookSpecificOutput.additionalContext`
 * - `PreToolUse`：`hookSpecificOutput.permissionDecision = 'deny'`
 * - 其余：不输出
 *
 * @param {ReturnType<typeof normalizeEvent>} event
 * @param {{ context?: string, deny?: string, message?: string } | undefined} result
 */
export function formatOutput(event, result) {
  if (result === undefined) {
    return null;
  }
  if (typeof result.context === 'string' && result.context !== '') {
    return {
      hookSpecificOutput: {
        hookEventName: event.hostEventName,
        additionalContext: result.context,
      },
    };
  }
  if (typeof result.deny === 'string' && result.deny !== '') {
    return {
      hookSpecificOutput: {
        hookEventName: event.hostEventName,
        permissionDecision: 'deny',
        permissionDecisionReason: result.deny,
      },
    };
  }
  if (typeof result.message === 'string' && result.message !== '') {
    return { systemMessage: result.message };
  }
  return null;
}

/**
 * 入口：stdin → 归一化 → 业务处理 → 宿主信封。
 *
 * 骨架在 `lib/hook-runner.mjs`（与宿主无关）；这里只绑定本宿主的归一化与信封。
 * 错误路径、总预算与 `hardExit` 语义在那里，三个宿主共用同一份。
 */
export const runHook = createRunHook({
  hostLabel: 'Claude Code',
  normalizeEvent,
  formatOutput,
});
