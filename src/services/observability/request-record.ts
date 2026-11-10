/**
 * 请求记录（§17.6、§17.8）：写 `request_log` 并打一条结构化日志。
 *
 * 指标累加在 `metrics.ts`，归因在 `timing.ts`；这里负责采样判定、行映射与日志级别。
 */

import { randomUUID } from 'node:crypto';

import type {
  RequestLogRepository,
  RequestLogRow,
} from '../../adapters/sqlite/request-log-repository.js';
import type { Logger } from '../../domain/log.js';

import type { RequestLogEntry, RequestLogPolicy } from './contracts.js';
import { recordRequestDuration, type RequestMetricsState } from './metrics.js';
import { attributeRequest, type TimingState } from './timing.js';

/** `recordRequest` 的端口。 */
export interface RequestRecordPorts {
  readonly requestLog: RequestLogRepository;
  readonly logger: Logger;
  readonly now: () => Date;
  readonly policy: RequestLogPolicy;
  readonly timing: TimingState;
  readonly metrics: RequestMetricsState;
}

/** 记录一次请求：写 `request_log`（§17.6）+ 结构化日志（§17.8）。 */
export function recordRequestEntry(ports: RequestRecordPorts, entry: RequestLogEntry): void {
  const { requestLog, logger, now, policy, timing, metrics } = ports;
  // 指标先记：采样只影响请求记录表，不影响「系统刚才多慢」。
  recordRequestDuration(metrics, entry);

  // 作用域随请求结束一起被丢弃，不需要（也不能）在这里清空——清空会抹掉同进程
  // 里另一个正在跑的请求的阶段。归因顺手在这里跑一次：`attributeRequest()` 的超额
  // 检查只有在真实请求上才有意义，悬空的方法永远发现不了重复计时。空 Map 写 NULL
  // （§17.6：没有计时时为 NULL）。
  const attribution = attributeRequest(timing, entry.requestId, entry.durationMs);
  const phases = Object.keys(attribution.phases).length === 0 ? null : attribution.phases;

  if (!policy.enabled) {
    return;
  }
  // 错误请求永远全量（§17.6）：采样把错误采掉就等于没有错误数据。
  const failed = entry.statusCode >= 400 || entry.errorCode !== null;
  if (!failed && Math.random() >= policy.sampleRate) {
    return;
  }

  const row: RequestLogRow = {
    id: randomUUID(),
    requestId: entry.requestId,
    method: entry.method,
    path: entry.path,
    statusCode: entry.statusCode,
    durationMs: entry.durationMs,
    phases,
    errorCode: entry.errorCode,
    subject: entry.subject,
    createdAt: now().toISOString(),
  };
  requestLog.insert(row);
  logRequest(logger, row);
}

function logRequest(logger: Logger, row: RequestLogRow): void {
  const fields = {
    requestId: row.requestId,
    method: row.method,
    path: row.path,
    statusCode: row.statusCode,
    durationMs: row.durationMs,
    errorCode: row.errorCode,
    subject: row.subject,
  };
  if (row.statusCode >= 500) {
    logger.error('HTTP 请求失败。', fields);
    return;
  }
  if (row.statusCode >= 400) {
    logger.warn('HTTP 请求被拒绝。', fields);
    return;
  }
  logger.info('HTTP 请求完成。', fields);
}
