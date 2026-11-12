#!/usr/bin/env node
/**
 * `PostToolUse`：把工具调用与结果采集为 `tool` 消息（架构文档 §15.2、§10.1）。
 *
 * 经验常常藏在工具输出里（「这个命令报错了，因为 X」），而 `Stop` 从 transcript
 * 里只取 user / assistant 的文本消息——工具调用被单独采集，两边不重叠。
 *
 * ## 为什么这里同步写
 *
 * 消息落盘是 5–20ms 的写操作（§17.2 的「采集写入」阶段，明确属于阻塞部分），
 * 与 `Stop` 的几秒级归档 / 抽取不同。工具调用之间本来就有一次往返，多这几毫秒
 * 看不出来；反过来把每次工具调用都起一个分离进程，会为一次对话起几十个 Node。
 *
 * ## 工具输出不参与记忆抽取
 *
 * 服务端默认隐藏工具输出（§10.1：它会泄漏环境变量与文件系统结构）。这里原样
 * 采集，过滤在抽取侧做——采集侧丢掉就再也找不回来了。
 *
 * **唯一的例外是 CoMem 自己注入的块。** 工具输出可能是 `cat` 出来的 transcript、
 * 某个 hook 的原始输出，或任何含 `<comem-recall>` / `<available-skills>` 的文本。
 * 那些块不是「工具结果」，原样落盘等于让 CoMem 自己的注入以工具结果的身份回到
 * 记忆库（与 `Stop` 的自我污染同一条路）。剥离调 `lib/sanitize.mjs` 的
 * `sanitizeCapturedText`——与 `Stop` 是**同一个实现**，不在这里另写一份规则。
 */

import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { isBypassed, loadConfig, resolveHost } from '../lib/config.mjs';
import { FileEventDeduper } from '../lib/dedup.mjs';
import { createHttpClient } from '../lib/http.mjs';
import { isMainModule } from '../lib/is-main.mjs';
import { runMain, warnToStderr } from '../lib/lifecycle.mjs';
import { sanitizeCapturedText } from '../lib/sanitize.mjs';
import { elapsedMs, processStartMs, reportOverhead } from '../lib/telemetry.mjs';

const SESSIONS_PATH = '/api/v1/sessions';

/** 降级诊断：一行 JSON 到 stderr。工具输出与输入都不进日志。 */
const warn = (message, data) => warnToStderr('post-tool-use', message, data);

/** `POST /sessions` 的 409 表示会话已存在（§19 的 CONFLICT）。 */
const CONFLICT_STATUS = 409;

/**
 * 一次工具调用对应**一条** `tool` 消息，两种 part 都在里面：`tool_use` 与
 * `tool_result` 拆成两条消息会让「调用 → 结果」的配对靠 ID 猜。
 *
 * 工具输出里的 CoMem 注入块在**这里**剥掉（`lib/sanitize.mjs` 的
 * `sanitizeCapturedText`，与 `Stop` 同一个实现）：`cat` 一份 transcript 时，
 * 里面的 `<comem-recall>` 不是工具结果，原样落盘会让注入块以工具结果的身份进
 * 记忆库。三个宿主适配器都经过这一处（`lib/values.mjs` 的 `renderToolOutput` 已经把
 * 任意形状渲染成字符串），所以剥一次就够。
 *
 * 非字符串原样透传：这个字段的形状由宿主决定，`toToolMessage` 不替它决定序列化
 * 方式。剥完为空时发空串——服务端的 `requireStringField` 只校验
 * `typeof === 'string'`（`src/api/http/routes/sessions-request.ts`），空串是合法
 * 值；`toolOutput` 为 `null` 时本来也落在 `''` 上。
 *
 * @param {{ toolName: string | null, toolUseId: string | null, toolInput: unknown, toolOutput: string | null }} event
 * @returns {Record<string, unknown>}
 */
export function toToolMessage(event) {
  const toolUseId = event.toolUseId ?? randomUUID();
  const toolOutput = event.toolOutput;
  return {
    id: `tool_${toolUseId}`,
    role: 'tool',
    createdAt: new Date().toISOString(),
    parts: [
      {
        kind: 'tool_use',
        toolUseId,
        name: event.toolName ?? 'unknown',
        input: event.toolInput ?? null,
      },
      {
        kind: 'tool_result',
        toolUseId,
        output: typeof toolOutput === 'string' ? sanitizeCapturedText(toolOutput) : (toolOutput ?? ''),
        isError: false,
      },
    ],
  };
}

/**
 * @param {{ event: string, sessionId: string, cwd: string, toolName: string | null, toolUseId: string | null, toolInput: unknown, toolOutput: string | null }} event `event` 是内部事件名（`lib/events.json` 的键），上报时原样用
 * @param {{ config: Awaited<ReturnType<typeof loadConfig>>, http: ReturnType<typeof createHttpClient>, env?: NodeJS.ProcessEnv, warn?: (message: string, data: Record<string, unknown>) => void }} deps
 */
export async function handlePostToolUse(event, deps) {
  const env = deps.env ?? process.env;
  if (isBypassed({ cwd: event.cwd }, env)) {
    return undefined;
  }
  if (event.toolName === null && event.toolOutput === null) {
    // 宿主给的载荷里没有工具信息（例如未知事件）。不发一条空消息。
    return undefined;
  }

  const captureStartedAt = process.hrtime.bigint();
  try {
    await deps.http.post(SESSIONS_PATH, {
      sessionId: event.sessionId,
      userId: deps.config.userId,
    });
  } catch (error) {
    // 409 = 会话已存在（正常路径）：复用它，消息原样保留，继续追加。
    // 其它状态说明服务端不可用：这次采集放弃，游标不前进，下一次重投。
    if (error.status !== CONFLICT_STATUS) {
      (deps.warn ?? warn)('创建会话失败，本次工具调用不采集。', {
        code: typeof error.code === 'string' ? error.code : 'UNKNOWN',
        status: typeof error.status === 'number' ? error.status : null,
      });
      return undefined;
    }
  }

  try {
    await deps.http.post(`${SESSIONS_PATH}/${event.sessionId}/messages`, {
      messages: [toToolMessage(event)],
    });
  } catch (error) {
    // 采集失败不打断工具循环。游标不涉及消息，重投由下一次 PostToolUse 自己带。
    (deps.warn ?? warn)('写入工具消息失败，本次工具调用不采集。', {
      code: typeof error.code === 'string' ? error.code : 'UNKNOWN',
      status: typeof error.status === 'number' ? error.status : null,
    });
    return undefined;
  }
  const captureMs = elapsedMs(captureStartedAt);

  await reportOverhead(
    {
      event: event.event,
      sessionId: event.sessionId,
      phases: { processStartMs: processStartMs(), recallMs: 0, serializeMs: 0, captureMs },
    },
    { config: deps.config, http: deps.http },
  );

  return undefined;
}

const isMain = isMainModule(import.meta.url);
if (isMain) {
  await runMain('hook post-tool-use', async () => {
    const host = await resolveHost();
    const config = await loadConfig();
    // 宿主重投同一个工具事件时按 `tool_use_id` 去重（§15.4 第 1 层）。
    const deduper = new FileEventDeduper(join(config.tmpDir, 'comem-events.json'));
    await host.runHook(
      async (event, { deadline }) => {
        if (!(await deduper.accept(event.eventId))) {
          return undefined;
        }
        return handlePostToolUse(event, { config, http: createHttpClient({ ...config, deadline }) });
      },
      { hardExit: true },
    );
  });
}
