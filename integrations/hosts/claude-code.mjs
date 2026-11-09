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
export const SESSION_ID_PREFIX = 'cc-';

/**
 * 宿主对一次 hook 输出的字节上限。
 *
 * 超过之后宿主不把输出当上下文，而是**转存成文件、只放预览**——`SessionStart` 注入
 * 的三个块等于静默失效（模型看到的是「输出太大」而不是画像）。
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

function toolFilePath(toolName, toolInput) {
  if (toolName === null || !FILE_TOOLS.has(toolName)) {
    return null;
  }
  return text(toolInput['file_path']) ?? text(toolInput['path']);
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
 * 默认读 stdin：上限与总预算同源（`STDIN_READ_CAP_MS`）。
 *
 * 宿主不写也不关 stdin 时，`for await` 永远不会返回；这个上限把它变成
 * 「没有事件」（`HOOK_STDIN_TIMEOUT`），由 `runHook` 收敛成诊断 + 退出码 0。
 */
async function readJsonStdin() {
  const raw = (await readStdinText(STDIN_READ_CAP_MS)).trim();
  if (raw === '') {
    throw new ComemHookError('Claude Code hook 没有收到 stdin 载荷。', {
      code: 'HOOK_INVALID_ARGUMENT',
    });
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
