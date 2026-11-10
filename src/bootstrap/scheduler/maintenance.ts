/**
 * 每轮的后台维护动作：TTL 清扫、临时上传清理、请求记录裁剪、对账重放、轮次摘要。
 *
 * 每个动作各自兜底：哪一个失败都只记 error，下一轮再试，不让整轮失败。理由是同一
 * 个——这一轮里已经做完的会话处理（提交 / 过期）是有产物的，为了一次维护动作的
 * 异常把它们一起判失败没有意义；调度器也不能因为一次磁盘抖动就停在自己的
 * rejection 上（`tick()` 不抛错，见 `service.ts`）。
 *
 * 每个函数只声明自己真正用到的那几个端口（`Pick<SchedulerOptions, …>`），调用方传
 * 整个选项对象即可，不多传一层参数、也不让助手函数看见 `intervalMs` 之类的无关字段。
 */

import type { ReconcileReplayResult, SchedulerOptions, SchedulerTickResult } from './contracts.js';
import { STAGED_UPLOAD_MAX_AGE_SECONDS } from './constants.js';
import { errorMessage } from '../../domain/errors.js';

/** 一轮 TTL 清扫的输入。 */
type TtlSweepPorts = Pick<SchedulerOptions, 'ttl' | 'ttlSweepBatchSize' | 'logger'>;
/** 临时上传清理的输入。 */
type StagedSweepPorts = Pick<SchedulerOptions, 'staged' | 'logger'>;
/** 请求记录裁剪的输入。 */
type RequestLogPrunePorts = Pick<SchedulerOptions, 'requestLog' | 'requestLogRetention' | 'logger'>;
/** 对账重放的输入。 */
type ReconcilePorts = Pick<SchedulerOptions, 'reconcile' | 'logger'>;
/** 轮次摘要的输入。 */
type RoundLogPorts = Pick<SchedulerOptions, 'logger'>;

/** TTL 清扫：一次 `sweep()` 同时做软归档与物理删除，`limit` 来自配置的批量上限。 */
export async function sweepTtl(
  ports: TtlSweepPorts,
): Promise<{ readonly archived: number; readonly purged: number }> {
  try {
    const { expired, purged } = await ports.ttl.sweep({ limit: ports.ttlSweepBatchSize });
    return { archived: expired, purged };
  } catch (error) {
    // 清扫失败不能让整轮失败：自动提交与过期判定已经做完了。
    ports.logger.error('TTL 清扫失败，下一轮重试。', { error: errorMessage(error) });
    return { archived: 0, purged: 0 };
  }
}

/**
 * 清理 `_meta/tmp/` 里超过保留期的临时上传。
 *
 * 与 TTL 清扫同样兜底：失败只记 error，下一轮再试；已经完成的会话处理不受影响。
 * 判定是「上传时间早于截止时刻」，不是「立刻全删」——刚上传、正在被
 * `addResource` 引用的文件不会被这一轮碰到。
 */
export async function sweepStaged(ports: StagedSweepPorts): Promise<number> {
  try {
    return await ports.staged.sweepStaged(STAGED_UPLOAD_MAX_AGE_SECONDS);
  } catch (error) {
    ports.logger.error('临时上传清理失败，下一轮重试。', { error: errorMessage(error) });
    return 0;
  }
}

/**
 * 请求记录裁剪（§17.6）。
 *
 * 失败只记 error，下一轮再试：裁剪是维护动作，它失败时这一轮的提交与过期处理
 * 已经做完了，没必要让整轮跟着失败。保留窗口来自
 * `telemetry.requestLog.retainDays` / `retainRows`，不在这里另设频率——仓储的
 * `prune` 在没有超期或超限时只做一次索引查找与一次 `COUNT(*)`，每轮调的成本可以
 * 忽略（10 万行实测约 1 ms）。
 */
export function pruneRequestLog(ports: RequestLogPrunePorts, now: Date): number {
  try {
    return ports.requestLog.prune({
      retainDays: ports.requestLogRetention.retainDays,
      retainRows: ports.requestLogRetention.retainRows,
      now,
    });
  } catch (error) {
    ports.logger.error('请求记录裁剪失败，下一轮重试。', { error: errorMessage(error) });
    return 0;
  }
}

/**
 * 对账重放。失败只记 error，下一轮再试。
 *
 * `ReconcileService.replay` 内部已经逐条兜底；这里再包一层是因为日志读取 / 重写
 * 也可能抛 IO 错误——调度器不能因为一次磁盘抖动就停在自己的 rejection 上。
 */
export async function replayReconcile(ports: ReconcilePorts): Promise<ReconcileReplayResult> {
  try {
    return await ports.reconcile.replay();
  } catch (error) {
    ports.logger.error('对账重放失败，下一轮重试。', { error: errorMessage(error) });
    return { resolved: 0, failed: 0, remaining: 0, corrupt: 0, unsupported: 0 };
  }
}

/**
 * 每轮的摘要。
 *
 * 空转记 `debug`：30 秒一轮，一天 2880 轮，全打 `info` 会把真正的动作埋掉。有动作
 * 时（提交了、过期了、清了 TTL、清了临时上传、裁了请求记录、重放了对账记录）记
 * `info`——那条才是运维要看的。
 */
export function logRound(ports: RoundLogPorts, result: SchedulerTickResult): void {
  const summary = {
    scanned: result.scanned,
    committed: result.committed,
    expired: result.expired,
    deleted: result.deleted,
    ttlArchived: result.ttlArchived,
    ttlPurged: result.ttlPurged,
    stagedSwept: result.stagedSwept,
    requestLogPruned: result.requestLogPruned,
    reconcileResolved: result.reconcileResolved,
    reconcileFailed: result.reconcileFailed,
    reconcileRemaining: result.reconcileRemaining,
  };
  if (
    result.committed +
      result.expired +
      result.ttlArchived +
      result.ttlPurged +
      result.stagedSwept +
      result.requestLogPruned +
      result.reconcileResolved +
      result.reconcileFailed ===
    0
  ) {
    ports.logger.debug('调度轮次完成（无动作）。', summary);
    return;
  }
  ports.logger.info('调度轮次完成。', summary);
}
