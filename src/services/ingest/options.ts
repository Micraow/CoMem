/**
 * 选项解析、来源筛选与两个默认值（架构文档 §11.9）。
 *
 * 判定都保持原样：非法值抛 `INVALID_ARGUMENT`，未知 harness 抛错，`since` 只接受
 * 可解析的 ISO 时间。默认值的来源见常量注释。
 */

import { ComemError } from '../../domain/errors.js';
import type { IngestHarness } from '../../domain/ingest.js';
import type { LogSource } from '../../ingest/source.js';

/**
 * 每批等多少个会话的阶段二。
 *
 * 20 的来源是 W25 任务约定：一批 20 个会话 × 每会话 1–2 次模型调用 ≈ 20–40 次
 * 调用，按 5 秒/次约 100–200 秒。用户在终端里按「批」看到进度，而不是等 908 个
 * 会话全部导完才出第一行；批量再小会让执行器每几个任务空转一次，且批次日志过多。
 *
 * 测试与批量脚本可以覆盖，生产从 `ingest.extractionBatchSize` 传。
 */
export const DEFAULT_EXTRACTION_BATCH_SIZE = 20;

/**
 * 每批阶段二的最长等待：30 分钟。
 *
 * 来源是「908 个会话 × 1–2 次模型调用 × 5 秒/次 ≈ 2–3 小时」的总量，换算到一批
 * 20 个会话约 3–7 分钟。30 分钟留了 4–10 倍余量覆盖供应商尾延迟与单步重试；更
 * 短会把「供应商慢一点」误判成超时，更长会让一次卡住的导入拖住终端。
 *
 * 超时按**批**算，不是按总量：总耗时可以是「批数 × 30 分钟」。
 */
export const DEFAULT_EXTRACTION_TIMEOUT_MS = 30 * 60 * 1000;

export function selectSources(
  sources: readonly LogSource[],
  harnesses: readonly IngestHarness[] | undefined,
): readonly LogSource[] {
  if (harnesses === undefined) {
    return sources;
  }
  const known = new Set(sources.map((source) => source.harness));
  for (const harness of harnesses) {
    if (!known.has(harness)) {
      throw new ComemError('INVALID_ARGUMENT', `未知的导入来源：${harness}`, { harness });
    }
  }
  const selected = new Set(harnesses);
  return sources.filter((source) => selected.has(source.harness));
}

export function parseBatchSize(
  limitPerSession: number | undefined,
  batchSize: number,
): number {
  if (limitPerSession === undefined) {
    return batchSize;
  }
  if (!Number.isInteger(limitPerSession) || limitPerSession <= 0) {
    throw new ComemError(
      'INVALID_ARGUMENT',
      `limitPerSession 必须是正整数：${limitPerSession}`,
      { limitPerSession },
    );
  }
  return limitPerSession;
}

export function parseSince(since: string | undefined): string | null {
  if (since === undefined || since === '') {
    return null;
  }
  if (Number.isNaN(Date.parse(since))) {
    throw new ComemError('INVALID_ARGUMENT', `--since 不是合法时间：${since}`, { since });
  }
  return since;
}
