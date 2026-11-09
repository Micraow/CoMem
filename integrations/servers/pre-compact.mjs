#!/usr/bin/env node
/**
 * `PreCompact` / `SessionEnd`：把待处理消息提交完（架构文档 §15.2、§15.3）。
 *
 * 与 `Stop` 相反，这里**等提交完成**。原因是这两个时机的语义就是「对话要没了」：
 * 上下文马上被压缩、会话马上结束，后台 worker 还没跑完就被宿主杀掉，这一轮就
 * 丢了。§15.3 把它放在 hook 超时预算内（`PreCompact` 的宿主超时通常是分钟级）。
 *
 * ## 采集逻辑复用 `stop.mjs`
 *
 * 两个 hook 做的是同一件事（游标之后的消息 → 提交 → 前进游标），差别只在「等
 * 不等」。采集编排放一份而不是抄两份：`captureSession` 从 `servers/stop.mjs`
 * 导入，`PreCompact` 只是换一个更长的超时。
 *
 * ## 超时用 `commitTimeoutMs`
 *
 * 30 秒来自 §17.2 的 `rewriteTimeoutMs = 30000`——提交管线里单步 LLM 调用的
 * 最长预算。`Stop` 的 5 秒预算在这里不够用。
 *
 * ## 没有待处理消息就不提交
 *
 * 空归档会产出一个空任务，阶段二会写一份空摘要再标记完成（`session.ts` 的
 * `INVALID_ARGUMENT`）。`captureSession` 已经做了这个判断，这里不重复。
 */

import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { isBypassed, loadConfig, resolveHost } from '../lib/config.mjs';
import { FileEventDeduper } from '../lib/dedup.mjs';
import { createHttpClient } from '../lib/http.mjs';
import { runMain, warnToStderr } from '../lib/lifecycle.mjs';
import { elapsedMs, processStartMs, reportOverhead } from '../lib/telemetry.mjs';

import { captureSession } from './stop.mjs';

/** 降级诊断：一行 JSON 到 stderr，不含消息正文。 */
const warn = (message, data) => warnToStderr('pre-compact', message, data);

/**
 * 提交待处理消息。返回是否提交了消息，供调用方（测试 / 诊断）观察。
 *
 * 失败不向外抛：hook 抛错会让宿主在压缩上下文时看到一条红色错误。失败时游标
 * 停在原处，下一次 `Stop` 会重投同一批消息。stderr 留一行诊断（不含消息正文）。
 *
 * @param {{ event: string, sessionId: string, cwd: string, eventId: string | null, transcriptPath: string | null, messages: readonly Record<string, unknown>[] | null }} event `event` 是内部事件名（`pre_compact` 或 `session_end`），上报时原样用
 * @param {{ config: Awaited<ReturnType<typeof loadConfig>>, http: ReturnType<typeof createHttpClient>, env?: NodeJS.ProcessEnv, deduper?: FileEventDeduper, warn?: (message: string, data: Record<string, unknown>) => void }} deps
 * @returns {Promise<{ message?: string } | undefined>}
 */
export async function handlePreCompact(event, deps) {
  const env = deps.env ?? process.env;
  const deduper = deps.deduper ?? new FileEventDeduper(join(deps.config.tmpDir, 'comem-events.json'));

  if (!(await deduper.accept(event.eventId))) {
    return undefined;
  }
  if (isBypassed({ cwd: event.cwd }, env)) {
    return undefined;
  }

  const captureStartedAt = process.hrtime.bigint();
  const result = await captureSession(event, deps).catch((error) => {
    (deps.warn ?? warn)('提交失败，游标停在原处，等待下一次重投。', {
      code: typeof error?.code === 'string' ? error.code : 'UNKNOWN',
      status: typeof error?.status === 'number' ? error.status : null,
    });
    return { captured: 0, committed: false, bypassed: false };
  });
  const captureMs = elapsedMs(captureStartedAt);

  // 这条链路是阻塞的（等提交完成），四个阶段里只有 `captureMs` 有值——检索与
  // 序列化发生在 `UserPromptSubmit`，那条请求已经上报过。
  //
  // 事件名取自载荷里的内部事件名（`lib/events.json` 的键），不写死：同一条链路
  // 服务 `PreCompact` 与 `SessionEnd` 两个生命周期点，写死一个名字会让另一个永远
  // 不出现在 `/metrics` 里。其它脚本也只转发适配器归一化后的名字。
  await reportOverhead(
    {
      event: event.event,
      sessionId: event.sessionId,
      phases: { processStartMs: processStartMs(), recallMs: 0, serializeMs: 0, captureMs },
    },
    { config: deps.config, http: deps.http },
  );

  if (result.captured === 0) {
    return undefined;
  }
  return { message: `CoMem 已提交 ${result.captured} 条消息。` };
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  await runMain('hook pre-compact', async () => {
    const config = await loadConfig();
    const host = await resolveHost();
    await host.runHook(
      async (event, { deadline }) =>
        handlePreCompact(event, {
          config,
          // 这条链路等提交完成，用 §17.2 的单步 LLM 预算（30s）而不是 Stop 的 5s；
          // 三次提交共享同一个总 deadline（`PreCompact` 30000 / `SessionEnd` 1200）。
          http: createHttpClient({ ...config, timeoutMs: config.commitTimeoutMs, deadline }),
        }),
      { hardExit: true },
    );
  });
}
