/**
 * `/metrics` 的 Prometheus 文本渲染（§17.1、§17.3、§17.9）。
 *
 * 指标名、标签顺序与样本顺序都是**外部契约**：控制台、抓取端与测试都按这份文本
 * 断言。改动只能来自本模块，且必须同时改测试与文档。
 */

import type { LlmCallStats } from '../llm.js';

import type { ObservabilityDatabase, RequestLogEntry } from './contracts.js';
import { MILLISECONDS_PER_SECOND } from '../../domain/time.js';

import { escapeLabel, metricValue } from './format.js';
import type { HookOverheadState } from './hook-overhead.js';
import { llmUsageLines } from './llm-usage.js';
import { countRows, NODE_SELF_ROW } from './queries.js';
import type { TimingState } from './timing.js';

/**
 * 没有身份的请求在 `account` 标签里的取值。
 *
 * 不省略标签：同一个指标族的样本标签集必须一致，漏掉 account 会让 Prometheus
 * 抓取整段失败。
 */
const ANONYMOUS_ACCOUNT = 'anonymous';

/** `comem_http_request_duration_seconds` 的 summary 累加器（含按账号分组）。 */
export interface RequestMetricsState {
  readonly includeAccountLabel: boolean;
  requestDurationSumSeconds: number;
  requestDurationCount: number;
  readonly accountDurations: Map<string, { sumSeconds: number; count: number }>;
}

export function createRequestMetrics(includeAccountLabel: boolean): RequestMetricsState {
  return {
    includeAccountLabel,
    requestDurationSumSeconds: 0,
    requestDurationCount: 0,
    accountDurations: new Map<string, { sumSeconds: number; count: number }>(),
  };
}

/** 记录一次请求的耗时（指标先记：采样只影响请求记录表，不影响「系统刚才多慢」）。 */
export function recordRequestDuration(
  state: RequestMetricsState,
  entry: RequestLogEntry,
): void {
  const durationSeconds = entry.durationMs / MILLISECONDS_PER_SECOND;
  state.requestDurationSumSeconds += durationSeconds;
  state.requestDurationCount += 1;
  if (state.includeAccountLabel) {
    const account = entry.subject ?? ANONYMOUS_ACCOUNT;
    const current = state.accountDurations.get(account) ?? { sumSeconds: 0, count: 0 };
    current.sumSeconds += durationSeconds;
    current.count += 1;
    state.accountDurations.set(account, current);
  }
}

/**
 * `comem_http_request_duration_seconds` 的样本。
 *
 * `includeAccountLabel` 为 `true` 时按账号分组；关闭时输出全局汇总（与接线前
 * 逐字一致）。**两种形态不能混着输出**：同一个指标族的标签集必须一致，否则
 * Prometheus 抓取整段失败。
 */
function requestDurationLines(state: RequestMetricsState): string[] {
  if (!state.includeAccountLabel) {
    return [
      `comem_http_request_duration_seconds_sum ${metricValue(state.requestDurationSumSeconds)}`,
      `comem_http_request_duration_seconds_count ${metricValue(state.requestDurationCount)}`,
    ];
  }

  const lines: string[] = [];
  for (const [account, duration] of state.accountDurations) {
    const label = `account="${escapeLabel(account)}"`;
    lines.push(
      `comem_http_request_duration_seconds_sum{${label}} ${metricValue(duration.sumSeconds)}`,
      `comem_http_request_duration_seconds_count{${label}} ${metricValue(duration.count)}`,
    );
  }
  return lines;
}

/** 渲染一次 `/metrics` 需要的全部状态。 */
export interface MetricsRenderPorts {
  readonly db: ObservabilityDatabase;
  readonly stats: LlmCallStats;
  readonly timing: TimingState;
  readonly hooks: HookOverheadState;
  readonly metrics: RequestMetricsState;
}

/**
 * Prometheus 文本（§17.1 的低基数端点）。
 *
 * v1 的 `comem_http_request_duration_seconds` 用 summary 形态（只报 `_sum` /
 * `_count`）：直方图的桶边界要按真实分布调，而 v1 没有长期运行的 Prometheus 来
 * 回答「桶该切在哪」（§17.11 不部署 Prometheus）。summary 的 `_sum` / `_count`
 * 已经能算平均耗时与 TPS，够验收。
 */
export function renderMetrics(ports: MetricsRenderPorts): string {
  const { db, stats, timing, hooks, metrics } = ports;
  const lines: string[] = [
    '# HELP comem_http_request_duration_seconds HTTP 请求完整耗时',
    '# TYPE comem_http_request_duration_seconds summary',
    ...requestDurationLines(metrics),
  ];

  lines.push(
    '# HELP comem_hook_overhead_seconds Hook 阻塞开销的单阶段耗时（取每个事件最近一次）',
    '# TYPE comem_hook_overhead_seconds gauge',
  );
  for (const [event, phases] of hooks.phases) {
    for (const [phase, elapsedMs] of phases) {
      lines.push(
        `comem_hook_overhead_seconds{event="${event}",phase="${phase}"} ${metricValue(
          elapsedMs / MILLISECONDS_PER_SECOND,
        )}`,
      );
    }
  }

  lines.push(
    '# HELP comem_hook_overhead_total_seconds Hook 单轮阻塞开销合计（进程启动 + 检索 + 序列化 + 采集）',
    '# TYPE comem_hook_overhead_total_seconds gauge',
  );
  for (const [event, totalMs] of hooks.totals) {
    lines.push(
      `comem_hook_overhead_total_seconds{event="${event}"} ${metricValue(
        totalMs / MILLISECONDS_PER_SECOND,
      )}`,
    );
  }

  lines.push(
    '# HELP comem_hook_async_seconds 后台处理耗时，不阻塞用户（每个后台阶段最近一次）',
    '# TYPE comem_hook_async_seconds gauge',
  );
  // 按 `phase` 而不是 `event`：`TimingState.asyncPhases` 是进程级的「每个阶段最近
  // 一次」，同一份数据不属于任何一次 hook 上报。阶段之间是真维度（归档/抽取/合并/
  // 摘要是四个不同的操作，各有各的耗时），事件之间不是。
  for (const [phase, elapsedMs] of timing.asyncPhases) {
    lines.push(
      `comem_hook_async_seconds{phase="${phase}"} ${metricValue(
        elapsedMs / MILLISECONDS_PER_SECOND,
      )}`,
    );
  }

  lines.push(
    '# HELP comem_index_nodes 索引节点数',
    '# TYPE comem_index_nodes gauge',
    `comem_index_nodes ${metricValue(
      countRows(db, `SELECT COUNT(*) AS total FROM node WHERE ${NODE_SELF_ROW}`),
    )}`,
    '# HELP comem_pending_review 待复核的记忆条数',
    '# TYPE comem_pending_review gauge',
    `comem_pending_review ${metricValue(
      countRows(db, `SELECT COUNT(*) AS total FROM node WHERE status = ? AND ${NODE_SELF_ROW}`, 'pending'),
    )}`,
  );

  lines.push(...llmUsageLines(stats));

  return `${lines.join('\n')}\n`;
}
