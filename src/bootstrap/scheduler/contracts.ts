/**
 * 调度器的契约：端口、选项、结果。
 *
 * 这里只有类型，没有运行时代码。端口都是**消费方契约**（结构子集），不是存储抽象：
 * `SessionService` / `TtlService` / `ResourceService` / `RequestLogRepository` /
 * `ReconcileService` 的实例结构满足它们，单测可以只实现真正被调用的那一小块
 * （§4.4 不为只有一个实现的类型建接口）。
 */

import type { Logger } from '../../domain/log.js';
import type { Session } from '../../domain/session.js';
import type { Uri } from '../../domain/uri.js';
import type { MemoryService } from '../../services/memory.js';
import type { CommitPhase1Result, SessionRemoval } from '../../services/session.js';

/**
 * 自动提交与会话过期要用到的 `SessionService` 面。
 *
 * 只列真正调用的方法：`SessionService` 的结构满足它，而单测可以只实现这一小块
 * （§4.4 不为只有一个实现的类型建接口——这里的接口是**消费方契约**，不是存储端口）。
 */
export interface SessionAutoCommitPort {
  load(sessionUri: Uri): Promise<Session>;
  shouldAutoCommit(session: Session, now: Date): boolean;
  commitPhase1(sessionUri: Uri): Promise<CommitPhase1Result>;
  /** `history/` 下的归档目录。删除前的待复核记忆检查要用。 */
  listArchives(sessionUri: Uri): Promise<readonly Uri[]>;
  archive(sessionUri: Uri): Promise<void>;
  remove(sessionUri: Uri): Promise<SessionRemoval>;
}

/** TTL 清扫端口（`TtlService` 的结构子集）。 */
export interface TtlPort {
  sweep(options?: { readonly limit?: number }): Promise<{ readonly expired: number; readonly purged: number }>;
}

/**
 * 临时上传清理端口（`ResourceService` 的结构子集）。
 *
 * `_meta/tmp/` 只有写入口时，失败的上传会一直留着。清理挂在调度轮次上，不新建
 * 定时机制；调度器因三个主开关全关而不启动时，这里也不会跑（见容器里的
 * `schedulerEnabled`）。
 */
export interface StagedUploadSweepPort {
  sweepStaged(olderThanSeconds: number): Promise<number>;
}

/**
 * 请求记录裁剪端口（`RequestLogRepository` 的结构子集）。
 *
 * 挂在调度轮次上的理由与 `request_log` 的写入点一致：表只在进程活着的时候长，
 * 裁剪只在进程启动时跑一次就等于「常驻越久、表越大」。一次裁剪在 10 万行上的
 * 稳态成本约 1 ms（行数规则先数一次再决定删不删，见仓储的 `prune`），所以每轮
 * 都调，不另造定时器、不加频率参数。
 */
export interface RequestLogPrunePort {
  prune(options: {
    readonly retainDays: number;
    readonly retainRows: number;
    readonly now: Date;
  }): number;
}

/** `telemetry.requestLog.retainDays` / `retainRows`（§17.6、§18）。 */
export interface RequestLogRetention {
  readonly retainDays: number;
  readonly retainRows: number;
}

/**
 * 对账重放端口（`ReconcileService` 的结构子集）。
 *
 * 定期重放的理由：启动扫描只覆盖「上次进程退出前留下的记录」。一个跑几个月的
 * 服务如果只在启动时对账，运行期间发生的索引写失败会一直沉默到下次重启——
 * 那正是 §10.6 要消灭的「文件在、检索不到」。
 */
export interface ReconcileReplayResult {
  readonly resolved: number;
  readonly failed: number;
  readonly remaining: number;
  readonly corrupt: number;
  readonly unsupported: number;
}

export interface ReconcilePort {
  replay(): Promise<ReconcileReplayResult>;
}

/** 删除会话前检查「这个会话产出的记忆是否仍待复核」用的记忆读端口。 */
export type PendingMemoryPort = Pick<MemoryService, 'read'>;

/** `session.expiry.*`（§18）。`idleTimeoutSeconds = 0` 表示关。 */
export interface SchedulerExpiry {
  readonly idleTimeoutSeconds: number;
  readonly action: 'archive' | 'delete';
}

export interface SchedulerOptions {
  /** 轮询间隔，默认 `DEFAULT_INTERVAL_MS`（30 秒）。 */
  readonly intervalMs?: number;
  readonly logger: Logger;
  /** 数据根。会话目录由它扫出来（见文件头「为什么遍历会话要碰文件系统」）。 */
  readonly dataDir: string;
  readonly sessions: SessionAutoCommitPort;
  readonly ttl: TtlPort;
  readonly staged: StagedUploadSweepPort;
  readonly reconcile: ReconcilePort;
  readonly memories: PendingMemoryPort;
  /** `request_log` 的裁剪路径（§17.6）；与 TTL 清扫同样每轮调用。 */
  readonly requestLog: RequestLogPrunePort;
  /** `telemetry.requestLog.retainDays` / `retainRows`；保留窗口沿用配置，不新增。 */
  readonly requestLogRetention: RequestLogRetention;
  readonly expiry: SchedulerExpiry;
  /** `memory.ttl.sweepBatchSize`：每轮最多清扫多少条。 */
  readonly ttlSweepBatchSize: number;
  /** 注入时钟（测试用）；默认 `() => new Date()`。 */
  readonly now?: () => Date;
}

export interface SchedulerTickResult {
  /** 上一轮还没跑完（或已停止），这一轮什么都没做 */
  readonly skipped: boolean;
  /** 扫到的会话数（含被跳过的「建了一半」的会话） */
  readonly scanned: number;
  readonly committed: number;
  /** 过期处理掉的会话数（归档 + 删除） */
  readonly expired: number;
  /** 其中真的被物理删除的 */
  readonly deleted: number;
  /** 这一轮被 TTL 归档的节点数 */
  readonly ttlArchived: number;
  /** 这一轮被 TTL 物理删除（归档超保留期）的节点数 */
  readonly ttlPurged: number;
  /** 这一轮清理掉的超时临时上传数（`_meta/tmp/`） */
  readonly stagedSwept: number;
  /** 这一轮从 `request_log` 删掉的行数（超保留天数 + 超保留行数） */
  readonly requestLogPruned: number;
  /** 这一轮对账重放成功（或目标已不存在）的记录数 */
  readonly reconcileResolved: number;
  /** 这一轮重放失败的记录数，仍留在 `reconcile.log` */
  readonly reconcileFailed: number;
  /** 这一轮结束后日志里剩下的有效记录数 */
  readonly reconcileRemaining: number;
}

/** 单个会话这一轮的结局。`scanned` 之外只关心「做了什么」。 */
export type SessionOutcome = 'skipped' | 'committed' | 'archived' | 'deleted';

/**
 * 会话这一层要用的端口：会话 / 记忆 / 过期策略 / 日志，以及归档文件的磁盘位置
 * （删除前要读 `archive_NNN/memory_diff.json`）。
 *
 * 任一助手函数拿到的都是显式的这一束，不是 `this`。
 */
export type SessionRoundPorts = Pick<
  SchedulerOptions,
  'sessions' | 'memories' | 'expiry' | 'logger' | 'dataDir'
>;
