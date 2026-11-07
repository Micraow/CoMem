/**
 * Hook 开销上报（架构文档 §17.2、§14）。
 *
 * Hook 插件在退出前 `POST /api/v1/telemetry/hook`，带 `{event, sessionId, phases}`。
 * 服务端把四阶段累加进直方图，「单轮阻塞开销」由 `comem_hook_overhead_total_seconds`
 * 回答——这是「用 CoMem 让每个请求多花了多少毫秒」的唯一证据（§17.2）。
 *
 * ## 校验为什么这么细
 *
 * 上报方是装进宿主的独立进程，它的内容是外部输入。一个 `NaN` 会让 Prometheus 抓取
 * 整段失败（§17.1 的低基数要求之外，还有「一个坏样本毁掉整条时间序列」）。四个
 * 阶段必须都是**有限非负数**：负数在时钟回拨时可能出现，按 0 记而不是拒绝整份报告
 * ——丢掉一次上报比丢一个样本更糟。
 */

import type { FastifyInstance } from 'fastify';

import { ComemError } from '../../../domain/errors.js';
import type { HookOverheadReport } from '../../../services/observability.js';
import { ok } from '../envelope.js';
import { requestContextOf } from '../middleware.js';
import { optionalString, requireRecord, requireString, type HttpRouteGroup } from '../server.js';

import type { HttpRouteServices } from './index.js';

/** 报告里的四个阶段字段（§17.2 表格）。 */
type PhaseField = 'processStartMs' | 'recallMs' | 'serializeMs' | 'captureMs';

function invalid(message: string, details: Record<string, unknown>): ComemError {
  return new ComemError('INVALID_ARGUMENT', message, details);
}

/** 有限非负数；非有限值（NaN / ±Infinity）直接拒绝。 */
function parsePhase(record: Record<string, unknown>, field: PhaseField): number {
  const value = record[field];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw invalid(`phases.${field} 必须是有限数字。`, { field: `phases.${field}` });
  }
  // 时钟回拨会产生负耗时；按 0 记，不拒绝整份报告。
  return Math.max(0, value);
}

function parseReport(body: Record<string, unknown>): HookOverheadReport {
  const event = requireString(body, 'event');
  const sessionId = optionalString(body, 'sessionId') ?? null;
  const phases = requireRecord(body['phases'], 'telemetry/hook.phases');
  return {
    event,
    sessionId,
    phases: {
      processStartMs: parsePhase(phases, 'processStartMs'),
      recallMs: parsePhase(phases, 'recallMs'),
      serializeMs: parsePhase(phases, 'serializeMs'),
      captureMs: parsePhase(phases, 'captureMs'),
    },
  };
}

export function createTelemetryRoutes(services: HttpRouteServices): HttpRouteGroup {
  const { observability } = services;

  return {
    prefix: '/telemetry',
    register(app: FastifyInstance): void {
      app.post<{ Body: unknown }>('/hook', async (request) => {
        requestContextOf(request);
        const body = requireRecord(request.body, 'telemetry/hook');
        const report = parseReport(body);
        await observability.recordHookOverhead(report);
        return ok({ recorded: true, event: report.event, sessionId: report.sessionId });
      });
    },
  };
}
