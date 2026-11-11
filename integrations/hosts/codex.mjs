/**
 * Codex 宿主适配（架构文档 §15.5、§15.7、§15.8）。
 *
 * 适配器只回答四个问题：**事件名怎么叫**、**返回信封长什么样**、**prompt 从载荷
 * 哪里读**、**一轮结束怎么判定**。去重、游标、锁、重试都在 `lib/` 里，与宿主无关。
 *
 * 为了让「加第三个宿主只加一个文件」（§15.8）成立，这里不 import 任何其它宿主
 * 适配器——信封与载荷解析都是独立的。
 *
 * ## 出处
 *
 * Codex 的生命周期 Hook 是公开能力（`config.toml` 的 `[features].hooks` 开关，默认
 * 开启），官方文档：<https://developers.openai.com/codex/hooks>。它从 `~/.codex/hooks.json`
 * 或 `~/.codex/config.toml` 的内联 `[hooks]` 表加载，按「事件 → matcher 组 →
 * 处理程序」三层组织。处理程序类型是 `command`（子进程，stdin 收 JSON）或
 * `mcp_tool`；CoMem 用 `command`。
 *
 * ## 载荷
 *
 * Codex 的 hook 从 stdin 收 JSON，公共字段与 Claude Code 同形：`session_id`、
 * `transcript_path`、`cwd`、`hook_event_name`、`model`、`permission_mode`。其余按
 * 事件不同：
 *
 * | 事件 | 额外字段 |
 * |---|---|
 * | `SessionStart` | `source`（`startup` / `resume` / `clear` / `compact` / `fork`） |
 * | `UserPromptSubmit` | `prompt` |
 * | `PreToolUse` | `tool_name`、`tool_use_id`、`tool_input` |
 * | `PostToolUse` | 同上 + `tool_response` |
 * | `Stop` | `stop_hook_active`、`last_assistant_message` |
 * | `PreCompact` | `trigger`（`manual` / `auto`） |
 * | `SessionEnd` | `reason`（目前恒为 `other`） |
 *
 * ## 事件 ID
 *
 * 与 Claude Code 同理：`Stop` / `UserPromptSubmit` 没有稳定的事件 ID，两轮合法事件
 * 可以完全一样，拿载荷哈希去重会吞掉第二轮。只有工具类事件用 `tool_use_id` 合成
 * ID，其余一律 `null`（不去重，靠游标兜底，§15.4）。
 *
 * ## 文件工具
 *
 * Codex 没有 `Read` / `Write` / `Edit` 三个独立文件工具；文件编辑统一走
 * `apply_patch`（matcher 别名 `Edit` / `Write`），命令走 `Bash`，其余是 MCP 工具名
 * （`mcp__server__tool`）。`apply_patch` 的路径在 `tool_input.command` 里，不在
 * `tool_input.file_path`——这里对 `apply_patch` 取命令里第一个 `*** ... File:`（或
 * 裸 `comem://`）路径做 best-effort 提取，让 `pre-tool-use` 的 URI 守卫能在 Codex
 * 上生效。普通 `Edit` / `Write` 仍读 `file_path` / `path`。
 */

import { EVENT_NAMES, internalEventNameOf } from '../lib/events.mjs';
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

/** 会话 ID 前缀（§15.5）。宿主自己的 session_id 直接拼在后面。 */
export const SESSION_ID_PREFIX = 'cx-';

/**
 * 宿主对一次 hook 上下文的字节上限。
 *
 * Codex 对「对模型可见的 Hook 输出」默认按 **约 2,500 token** 截断：超过之后把
 * 全文写到 `<temp_dir>/hook_outputs/<session_id>/<uuid>.txt`，只给模型一段头尾
 * 预览（官方文档「大 Hook 输出」一节：`additionalContextLimit` 默认 2500 token）。
 * 2,500 token 按最坏情况 4 字节/token ≈ 10,000 字节，9,500 留 5% 余量——与 Claude
 * Code 取同一个数不是照抄，是同一个 2,500 token 阈值倒推出来的。
 *
 * **这是宿主默认阈值倒推的预算，不是实测**：部署方可以在处理程序上把
 * `additionalContextLimit` 调大，那时这里可以跟着放宽；调大之前以宿主默认值为准，
 * 超限时按 `integrations/lib/injection.mjs` 的 `CONTEXT_BLOCK_DROP_ORDER` 降级，而不是让 CoMem 自己
 * 静默超限。
 */
export const MAX_CONTEXT_BYTES = 9500;

/**
 * 内部事件名 ↔ 宿主事件名。
 *
 * 表在 `lib/events.mjs`（全仓库唯一一份）。Codex 的事件名与 Claude Code 相同，
 * 所以共用一张表；名字本身不在这里定义。
 */
export { EVENT_NAMES };

/** 直接带 `file_path` / `path` 的文件工具（Codex 的 apply_patch 别名也在此）。 */
const PATCH_TOOLS = new Set(['apply_patch', 'Edit', 'Write']);

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
 * 从 `apply_patch` 的补丁文本里取第一个路径。
 *
 * 补丁格式是 `*** Update File: path` / `*** Add File: path` / `*** Delete File: path`，
 * 或裸的 `comem://…` 行。取不到就返回 `null`——守卫只在明确拿到 URI 时拦。
 */
function patchFilePath(command) {
  const match = /\*\*\*\s+(?:Update|Add|Delete)?\s*File:\s*(\S+)/.exec(command);
  if (match !== null) {
    return match[1];
  }
  const uri = /(comem:\/\/\S+)/.exec(command);
  return uri === null ? null : uri[1];
}

function toolFilePath(toolName, toolInput) {
  if (toolName === null || !PATCH_TOOLS.has(toolName)) {
    return null;
  }
  const direct = text(toolInput['file_path']) ?? text(toolInput['path']);
  if (direct !== null) {
    return direct;
  }
  const command = text(toolInput['command']);
  return command === null ? null : patchFilePath(command);
}

/**
 * 从 rollout 消息的 `content` 里抽纯文本。
 *
 * `content` 是数组，元素形如 `{type:'input_text'|'output_text', text}`；图片
 * （`input_image`）没有 `text` 字段，自然被跳过。多个文本块按换行拼接——它们是
 * 同一条消息的不同段落，拆成多条消息会让「用户说过什么」的边界错位。
 */
function extractTextParts(content) {
  if (!Array.isArray(content)) {
    return [];
  }
  const texts = [];
  for (const block of content) {
    const record = asRecord(block);
    if (typeof record['text'] === 'string' && record['text'] !== '') {
      texts.push(record['text']);
    }
  }
  return texts.length === 0 ? [] : [{ kind: 'text', text: texts.join('\n') }];
}

/** 一行被跳过内容的形状：只看键名与 `type` 这类枚举值，不取正文。 */
function describeEntry(entry) {
  const keys = Object.keys(entry).slice(0, 3).join(',');
  const type = typeof entry['type'] === 'string' ? entry['type'] : '?';
  const payload = asRecord(entry['payload']);
  const payloadType = typeof payload['type'] === 'string' ? payload['type'] : '?';
  return `type=${type} payload.type=${payloadType} keys=${keys}`;
}

/** rollout 里值得采集的 `payload.type`：对话消息。其余（`reasoning` 等）跳过。 */
const MESSAGE_PAYLOAD_TYPE = 'message';

/**
 * 读 Codex 的 rollout（`~/.codex/sessions/<日期>/rollout-*.jsonl`），只保留 user /
 * assistant 的文本消息。
 *
 * 行形状（本机实测，字段顺序与真实文件一致）：
 *
 * ```json
 * {"timestamp":"2026-11-06T11:35:39.659Z","ordinal":2,"type":"response_item",
 *  "payload":{"type":"message","id":"msg_…","role":"user",
 *             "content":[{"type":"input_text","text":"…"}]}}
 * ```
 *
 * 与 Claude Code 的 transcript **不是一种格式**：没有顶层 `message` 字段，文本在
 * `payload.content[*].text` 里。早期实现只认 Claude Code 的形状，Codex 的每一行
 * 都被跳过，`Stop` 拿到空数组后早退——整条阶段二没有启动。所以解析器必须由宿主
 * 适配器提供，`servers/stop.mjs` 不内置任何一种。
 *
 * 跳过而不是抛错：一份 rollout 里绝大多数行是 `session_meta` / `event_msg` /
 * `turn_context` / `reasoning` / 工具调用，只有 `response_item` + `payload.type =
 * 'message'` 是对话正文。格式不认识的行同理——为一行新出现的类型丢掉整轮会话，
 * 方向反了。
 *
 * @param {string} text rollout 文件的内容
 * @param {{ sessionId?: string }} [options]
 * @returns {{
 *   messages: Record<string, unknown>[],
 *   lines: number,
 *   skipped: number,
 *   sample: string | null,
 * }}
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
    if (entry['type'] !== 'response_item') {
      skipped += 1;
      sample ??= describeEntry(entry);
      continue;
    }
    const payload = asRecord(entry['payload']);
    if (payload['type'] !== MESSAGE_PAYLOAD_TYPE) {
      skipped += 1;
      sample ??= describeEntry(entry);
      continue;
    }
    const role = payload['role'];
    if (role !== 'user' && role !== 'assistant') {
      // `developer` 是宿主注入的系统指令，不是用户说过的话。
      skipped += 1;
      sample ??= describeEntry(entry);
      continue;
    }
    const parts = extractTextParts(payload['content']);
    if (parts.length === 0) {
      skipped += 1;
      sample ??= describeEntry(entry);
      continue;
    }
    messages.push({
      // 用 rollout 里的 `msg_…`：重投同一批消息时 ID 稳定，服务端能按 ID 去重。
      id:
        typeof payload['id'] === 'string' && payload['id'] !== ''
          ? payload['id']
          : `${sessionId}:${index}`,
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
 * 未知事件直接抛错：静默忽略等于让一个拼错的 hooks.json 条目长期不生效，而宿主
 * 不会提示。抛出的错误由 `runHook` 收敛成 stderr + 退出码 0（不能打断对话）。
 *
 * @param {unknown} raw
 */
export function normalizeEvent(raw) {
  const payload = asRecord(raw);
  const rawEventName = text(payload['hook_event_name']) ?? text(payload['event']);
  if (rawEventName === null) {
    throw new ComemHookError('Codex 载荷缺少 hook_event_name。', {
      code: 'HOOK_INVALID_ARGUMENT',
    });
  }
  // 宿主事件名 → 内部事件名。`SessionEnd` 是一等事件（自己的预算与上报标签），
  // 不再改写成 `PreCompact`。
  const event = internalEventNameOf(rawEventName);
  if (event === null) {
    throw new ComemHookError(`未支持的 Codex hook 事件：${rawEventName}`, {
      code: 'HOOK_INVALID_ARGUMENT',
    });
  }

  const sessionId = text(payload['session_id']);
  if (sessionId === null) {
    throw new ComemHookError('Codex 载荷缺少 session_id。', {
      code: 'HOOK_INVALID_ARGUMENT',
    });
  }

  const toolInput = asRecord(payload['tool_input']);
  const toolName = text(payload['tool_name']);
  const toolUseId = text(payload['tool_use_id']);

  return {
    host: 'codex',
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
 * 内部结果 → Codex 的返回信封。`null` 表示不写 stdout（等于放行）。
 *
 * - `SessionStart` / `UserPromptSubmit` / `PostToolUse`：`hookSpecificOutput.additionalContext`
 * - `PreToolUse`：`hookSpecificOutput.permissionDecision = 'deny'` + reason
 * - 其余：`systemMessage`（或不输出）
 *
 * 信封形状与 Claude Code 一致（Codex 的 hook 输出契约刻意与 Claude Code 对齐），
 * 但这里独立拼装，不 import 任何其它宿主。
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
 * 默认读 stdin：上限与总预算同源（`STDIN_READ_CAP_MS`）。
 *
 * 宿主不写也不关 stdin 时，`for await` 永远不会返回；这个上限把它变成
 * 「没有事件」（`HOOK_STDIN_TIMEOUT`），由 `runHook` 收敛成诊断 + 退出码 0。
 */
async function readJsonStdin() {
  const raw = (await readStdinText(STDIN_READ_CAP_MS)).trim();
  if (raw === '') {
    throw new ComemHookError('Codex hook 没有收到 stdin 载荷。', { code: 'HOOK_INVALID_ARGUMENT' });
  }
  return JSON.parse(raw);
}

/**
 * 入口：stdin → 归一化 → 业务处理 → 宿主信封。
 *
 * 任何异常都写 stderr 并正常退出（退出码 0）：hook 是旁路，它挂了不能把用户的
 * 这一轮对话一起挂掉。`PreToolUse` 的拦截是**返回值**，不是抛错。
 *
 * `read` 与 `write` 可注入，测试不启动子进程也能跑完整链路。
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
