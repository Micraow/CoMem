/**
 * Hook 开销上报：事件白名单、最近一次的四阶段耗时与单轮合计（§17.2）。
 *
 * 只保留**每个事件最近一次**。历史分布由 `request_log` 与 Prometheus 的抓取间隔
 * 共同回答，服务端不再存一份直方图。
 */

import type { Logger } from '../../domain/log.js';

import type { HookOverheadReport } from './contracts.js';

/**
 * 会在 `/metrics` 里出现的 Hook 事件：§15.2 的七个生命周期点减去 `pre_tool_use`。
 * `event` 标签只允许这几个值加 `other`。
 *
 * 白名单而不是「原样透传」：Hook 是装进宿主的独立进程，它的上报内容是外部输入，
 * 一个拼错的事件名会在指标库里造出一个新时间序列，而且永远不会有第二个样本。
 *
 * **`pre_tool_use` 不在这里。** `PreToolUse` 的处理器只做本地字符串判断、刻意不发
 * HTTP（`integrations/servers/pre-tool-use.mjs` 的文件头），它不承担开销上报——给每次
 * 工具调用加一次网络往返不值得。留在白名单里会让控制台多一个永远不会有点的行，
 * 而空行会被读成「这个事件没发生」，不是「这个事件没被采集」。它的耗时排查走宿主
 * 自己的日志。这条约定由 hook 侧的 `events.json`（`reportsOverhead: false`）与
 * `integrations/tests/event-names.test.mjs` 共同守住。
 *
 * 名字是 **snake_case**。上报方（`integrations/lib/events.json`）必须发这组名字，
 * 它同时被控制台的行键（`web/pages/monitor.vue`）与 hook 的预算表
 * （`integrations/lib/lifecycle.mjs`）使用。两边的一致性由
 * `tests/integration/services/observability.test.ts` 断言：加事件时同时改这一张表
 * 与 `integrations/lib/events.json`，不要在两个方向上各加一套映射。
 */
const HOOK_EVENTS: readonly string[] = [
  'session_start',
  'user_prompt_submit',
  'post_tool_use',
  'stop',
  'pre_compact',
  'session_end',
];

/** 未知事件归到这里（§17.1 的低基数要求）。 */
const OTHER_EVENT = 'other';

function normalizeEvent(event: string): string {
  return HOOK_EVENTS.includes(event) ? event : OTHER_EVENT;
}

/**
 * 报告字段 → 指标 `phase` 标签名。
 *
 * 报告用 camelCase（TypeScript 字段），指标用 snake_case（§17.2 的
 * `phase = process_start | recall | serialize | capture`）。映射只写这一份。
 */
const BLOCKING_PHASE_LABELS = [
  ['processStartMs', 'process_start'],
  ['recallMs', 'recall'],
  ['serializeMs', 'serialize'],
  ['captureMs', 'capture'],
] as const;

/** 每个事件最近一次的阶段耗时与单轮合计（`/metrics` 的 gauge 数据源）。 */
export interface HookOverheadState {
  /** `telemetry.hookOverhead.enabled`。关掉时上报直接丢弃，不进 Map。 */
  readonly enabled: boolean;
  /** 每个事件最近一次的四阶段耗时（`comem_hook_overhead_seconds`）。 */
  readonly phases: Map<string, Map<string, number>>;
  /** 每个事件最近一次的单轮阻塞合计（`comem_hook_overhead_total_seconds`）。 */
  readonly totals: Map<string, number>;
}

export function createHookOverheadState(enabled: boolean): HookOverheadState {
  return { enabled, phases: new Map<string, Map<string, number>>(), totals: new Map<string, number>() };
}

/**
 * Hook 开销上报（§17.2 的「报告路径」）。
 *
 * `comem_hook_overhead_seconds` 是 gauge，控制台要展示的是「本轮 CoMem 开销 142ms」
 * 这样的当前值，所以每个事件只保留最近一次。
 */
export function recordHookOverheadEntry(
  state: HookOverheadState,
  logger: Logger,
  report: HookOverheadReport,
): void {
  // 关掉时直接丢弃，不进 Map：Hook 每个事件每轮都上报，禁用它是为了省内存与 CPU，
  // 记下来再过滤等于没关。
  if (!state.enabled) {
    return;
  }
  const event = normalizeEvent(report.event);
  const phaseValues = new Map<string, number>();
  let totalMs = 0;
  for (const [field, label] of BLOCKING_PHASE_LABELS) {
    const elapsed = report.phases[field];
    phaseValues.set(label, elapsed);
    totalMs += elapsed;
  }

  state.phases.set(event, phaseValues);
  state.totals.set(event, totalMs);
  // 后台耗时与阻塞分开（§17.2），也不挂到这次上报上：后台阶段的最近一次值由
  // `TimingState.asyncPhases` 自己维护，`/metrics` 直接按 `phase` 渲染。以前这里把
  // 同一份进程级快照复制进「刚上报的那个事件」，于是每个事件的 async 值都一样——
  // 那是给同一个值贴了不同的标签，不是维度。

  logger.info('Hook 开销上报完成。', {
    event: report.event,
    sessionId: report.sessionId,
    totalMs,
    phases: Object.fromEntries(phaseValues),
  });
}
