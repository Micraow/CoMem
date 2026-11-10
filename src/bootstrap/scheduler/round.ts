/**
 * 跑一轮：扫会话 → 逐个处理（自动提交 / 过期）→ 四个维护动作 → 汇总并记一行摘要。
 *
 * 顺序不是随便排的。会话处理在前，是因为它产出的动作（提交、归档、删除）是运维真正
 * 关心的；维护动作在后，且每一个都自己兜底（见 `maintenance.ts`），所以前者跑完后
 * 不会因为后者失败而回退。四个维护动作之间无依赖，按原实现的顺序依次 `await`。
 *
 * 时钟在一轮开头取**一次**（`const now = clock()`），后面全部复用同一个 `Date`：
 * 会话过期判定与请求记录裁剪用的是同一时刻。一轮内多次取时钟会让同一批数据被两个
 * 不同的「现在」判定，边界上会出现「刚过期 / 还没过期」的不一致。
 */

import type { SchedulerOptions, SchedulerTickResult } from './contracts.js';
import { logRound, pruneRequestLog, replayReconcile, sweepStaged, sweepTtl } from './maintenance.js';
import { processSessionSafely } from './session-round.js';
import { discoverSessionUris } from './session-scan.js';

/** 空转的一轮：上一轮还没跑完，或调度器已停止。 */
export const SKIPPED_RESULT: SchedulerTickResult = Object.freeze({
  skipped: true,
  scanned: 0,
  committed: 0,
  expired: 0,
  deleted: 0,
  ttlArchived: 0,
  ttlPurged: 0,
  stagedSwept: 0,
  requestLogPruned: 0,
  reconcileResolved: 0,
  reconcileFailed: 0,
  reconcileRemaining: 0,
});

export async function runRound(options: SchedulerOptions, clock: () => Date): Promise<SchedulerTickResult> {
  const now = clock();
  const sessionUris = await discoverSessionUris(options.dataDir, options.logger);

  let committed = 0;
  let expired = 0;
  let deleted = 0;

  // 逐个会话处理：一个会话的文件坏了不能让其它会话的自动提交停掉。
  for (const sessionUri of sessionUris) {
    const outcome = await processSessionSafely(options, sessionUri, now);
    if (outcome === 'committed') {
      committed += 1;
    } else if (outcome === 'archived' || outcome === 'deleted') {
      expired += 1;
      deleted += outcome === 'deleted' ? 1 : 0;
    }
  }

  const { archived: ttlArchived, purged: ttlPurged } = await sweepTtl(options);
  const stagedSwept = await sweepStaged(options);
  const requestLogPruned = pruneRequestLog(options, now);
  const reconcile = await replayReconcile(options);

  const result: SchedulerTickResult = {
    skipped: false,
    scanned: sessionUris.length,
    committed,
    expired,
    deleted,
    ttlArchived,
    ttlPurged,
    stagedSwept,
    requestLogPruned,
    reconcileResolved: reconcile.resolved,
    reconcileFailed: reconcile.failed,
    reconcileRemaining: reconcile.remaining,
  };
  logRound(options, result);
  return result;
}
