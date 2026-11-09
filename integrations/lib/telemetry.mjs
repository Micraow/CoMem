/**
 * 延迟归因上报（架构文档 §17.2）。
 *
 * 四个阶段的定义与「阻塞 / 异步」的区分：
 *
 * | 阶段 | 字段 | 谁等它 |
 * |---|---|---|
 * | `node hook.mjs` 进程启动 | `processStartMs` | 用户 |
 * | 检索（`find` / `search`） | `recallMs` | 用户 |
 * | 注入序列化 | `serializeMs` | 用户 |
 * | 采集写入 | `captureMs` | 用户 |
 *
 * 归档 / 抽取 / 合并 / 摘要在后台跑，**不计入阻塞开销**（§17.2 最后一段）。
 *
 * ## 进程启动为什么必须单独上报
 *
 * 起一个新 Node 进程就是 30–50ms 纯开销（§15.9）。把它藏在「检索 20ms」后面会
 * 让人以为 CoMem 只花 20ms。`processStartMs` 用 `performance.timeOrigin`
 * 算——它是进程开始执行的时刻（epoch ms），比在任何模块顶部记一次 `Date.now()`
 * 更接近「真实起点」。
 *
 * ## 上报失败不能影响 hook
 *
 * `reportOverhead` 吞掉所有异常并返回 `false`。可观测性是旁路：它挂了，用户的
 * 这一轮对话不该跟着挂。
 */

import { loadConfig } from './config.mjs';
import { createHttpClient } from './http.mjs';

/** 纳秒 → 毫秒。 */
const NANOSECONDS_PER_MILLISECOND = 1_000_000;

/** §17.2 的端点。 */
const TELEMETRY_PATH = '/api/v1/telemetry/hook';

/**
 * 从进程开始到现在的毫秒数（§17.2 的 `process_start` 阶段）。
 *
 * `performance.timeOrigin` 是当前 Node 进程的启动时刻。取不到时退回 `0`：上报
 * 一个偏小的值，仍然比让整个 hook 抛错好。
 */
export function processStartMs() {
  const origin = globalThis.performance?.timeOrigin;
  return typeof origin === 'number' && Number.isFinite(origin) ? Math.max(0, Date.now() - origin) : 0;
}

/**
 * `process.hrtime.bigint()` 差值 → 毫秒（保留三位小数）。
 *
 * @param {bigint} startedAt
 */
export function elapsedMs(startedAt) {
  return (
    Math.round((Number(process.hrtime.bigint() - startedAt) / NANOSECONDS_PER_MILLISECOND) * 1000) /
    1000
  );
}

/**
 * 上报一次 hook 的阻塞开销。返回是否上报成功；**从不抛错**（见文件头）。
 *
 * `options.config` / `options.http` 供测试注入：真实调用每次都会重新读配置，
 * 测试里传假客户端即可，不需要落盘配置文件。
 *
 * `report.event` 必须是**内部事件名**（`lib/events.json` 的键，snake_case）。调用方
 * 一律转发适配器归一化后的 `event.event`，不自己拼字符串：服务端白名单
 * （`src/services/observability.ts` 的 `HOOK_EVENTS`）只认这组名字，拼错或写成宿主
 * 的 PascalCase 会被归成 `other`，按事件的指标维度就全丢了。
 *
 * @param {{ event: string, sessionId: string, phases: Record<string, number> }} report
 * @param {{ config?: object, http?: { post(path: string, body?: unknown): Promise<unknown> } }} [options]
 * @returns {Promise<boolean>}
 */
export async function reportOverhead(report, options = {}) {
  try {
    const config = options.config ?? (await loadConfig());
    const http = options.http ?? createHttpClient(config);
    await http.post(TELEMETRY_PATH, {
      event: report.event,
      sessionId: report.sessionId,
      phases: report.phases,
    });
    return true;
  } catch {
    return false;
  }
}
