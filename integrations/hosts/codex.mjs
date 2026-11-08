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

import { ComemHookError } from '../lib/http.mjs';

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
 * 超限时按 `integrations/lib/injection.mjs` 的优先级丢块，而不是让 CoMem 自己
 * 静默超限。
 */
export const MAX_CONTEXT_BYTES = 9500;

/** 内部事件名 ↔ 宿主事件名。Codex 用同名事件。 */
export const EVENT_NAMES = Object.freeze({
  SessionStart: 'SessionStart',
  UserPromptSubmit: 'UserPromptSubmit',
  PreToolUse: 'PreToolUse',
  PostToolUse: 'PostToolUse',
  Stop: 'Stop',
  PreCompact: 'PreCompact',
});

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
  // `SessionEnd` 与 `PreCompact` 都是「把待处理消息提交完」的时机（§15.2 的表格
  // 把它们并成一行），内部归一成 `PreCompact`。
  const event = rawEventName === 'SessionEnd' ? 'PreCompact' : rawEventName;
  if (!(event in EVENT_NAMES)) {
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

async function readJsonStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (raw === '') {
    throw new ComemHookError('Codex hook 没有收到 stdin 载荷。', {
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
 * @param {(event: ReturnType<typeof normalizeEvent>) => Promise<object | undefined>} handler
 * @param {{ read?: () => Promise<unknown>, write?: (line: string) => void }} [options]
 */
export async function runHook(handler, options = {}) {
  const read = options.read ?? readJsonStdin;
  const write = options.write ?? ((line) => process.stdout.write(`${line}\n`));

  let event;
  try {
    event = normalizeEvent(await read());
  } catch (error) {
    process.stderr.write(`co-mem hook: ${error instanceof Error ? error.message : String(error)}\n`);
    return null;
  }

  try {
    const result = await handler(event);
    const output = formatOutput(event, result);
    if (output !== null) {
      write(JSON.stringify(output));
    }
  } catch (error) {
    process.stderr.write(
      `co-mem hook ${event.event}: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
  return event;
}
