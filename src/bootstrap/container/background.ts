/**
 * 装配阶段 6：后台循环（记忆 TTL → 调度器 → 健康观测）。阶段二提交器在
 * `commit.ts`。
 *
 * `CommitRunner` 的 `phase` 端口要调 `observability.phase`，而后者在下方才构造：
 * `createBackground` 把闭包作为回调传给 `createCommitRunner`，求值时机不变（只在
 * 认领到任务后调用）。
 */

import { memoryContentOf } from '../../domain/memory-type.js';
import { ObservabilityService } from '../../services/observability.js';
import { TtlService } from '../../services/ttl.js';
import { DEFAULT_INTERVAL_MS, Scheduler } from '../scheduler.js';
import { createCommitRunner } from './commit.js';
import type { Foundation } from './foundation.js';
import type { MemoryStack } from './memory.js';
import type { Models } from './models.js';
import type { Retrieval } from './retrieval.js';
import type { CommitRunner } from '../commit-runner.js';
import { MILLISECONDS_PER_SECOND } from '../../domain/time.js';

/** 后台产物。`close()` 要停 `scheduler` 与 `commitRunner`。 */
export interface Background {
  readonly commitRunner: CommitRunner;
  readonly ttl: TtlService;
  readonly scheduler: Scheduler;
  readonly observability: ObservabilityService;
}

/** 记忆 TTL 与调度器；拆开只为守住「函数体 ≤ 120 行」。 */
interface BackgroundLoops {
  readonly ttl: TtlService;
  readonly scheduler: Scheduler;
}

/** 记忆 TTL（§11.7，位置在 `MemoryService` 之后）与调度器四个开关的判定。 */
function createBackgroundLoops(
  core: Foundation,
  retrieval: Retrieval,
  memoryStack: MemoryStack,
): BackgroundLoops {
  const { config, logger, dataDir, nodes, requestLog } = core;
  const { filesystem, session } = retrieval;
  const { memory, principals, resource, reconcile } = memoryStack;

  const ttl = new TtlService({
    nodes,
    // 物理删除（第二段）复用 `FileSystemService.remove`：与 `forget` 同一条路径
    // （MANAGE、TREE 锁、删文件、通知观察者）。`principals` 与 API 请求同源。
    filesystem,
    principals,
    // 滑动窗口：从 `max(updated_at, last_accessed_at)` 起算的天数（§11.7）。
    ttlDays: config.memory.ttl.defaultDays,
    retentionDays: config.memory.ttl.retentionDays,
    logger,
  });

  const scheduler = new Scheduler({
    logger,
    dataDir,
    sessions: session,
    ttl,
    staged: resource,
    reconcile,
    memories: { read: (uri) => memory.read(uri) },
    // 每轮都裁一次（§17.6）：没超期也没超行数时只做一次查找与一次 `COUNT(*)`。
    requestLog,
    requestLogRetention: {
      retainDays: config.telemetry.requestLog.retainDays,
      retainRows: config.telemetry.requestLog.retainRows,
    },
    expiry: {
      idleTimeoutSeconds: config.session.expiry.idleTimeoutSeconds,
      action: config.session.expiry.action,
    },
    ttlSweepBatchSize: config.memory.ttl.sweepBatchSize,
  });

  // 「全关」指四个开关同时成立：`session.autoCommit.enabled` 为假、
  // `session.expiry.idleTimeoutSeconds` 为 0、`memory.ttl.defaultDays` 为 0、
  // `memory.ttl.retentionDays` 为 0。这时不起定时器：空转的 30 秒定时器是纯浪费。
  // `retentionDays > 0` 也算开关（只回收、不新增归档），漏判就等于物理删除永不发生。
  //
  // **临时上传清理（`_meta/tmp/`）与 `request_log` 裁剪都挂在调度轮次上**：全关时
  // 超时上传要等下次打开任一开关，`request_log` 只剩 `else` 分支的启动清理一次。
  // 这是有意的取舍，限制需要写进运维文档的「已知限制」。
  const ttlPurgeEnabled = config.memory.ttl.retentionDays > 0;
  const schedulerEnabled =
    config.session.autoCommit.enabled ||
    config.session.expiry.idleTimeoutSeconds > 0 ||
    config.memory.ttl.defaultDays > 0 ||
    ttlPurgeEnabled;
  if (schedulerEnabled) {
    scheduler.start();
    logger.info('调度器已启动。', {
      intervalSeconds: DEFAULT_INTERVAL_MS / MILLISECONDS_PER_SECOND,
      autoCommit: config.session.autoCommit.enabled ? '开' : '关',
      expiry:
        config.session.expiry.idleTimeoutSeconds > 0
          ? `开（${String(config.session.expiry.idleTimeoutSeconds)} 秒空闲后 ${config.session.expiry.action}）`
          : '关',
      ttl:
        config.memory.ttl.defaultDays > 0
          ? `开（默认 ${String(config.memory.ttl.defaultDays)} 天${ttlPurgeEnabled ? `，归档满 ${String(config.memory.ttl.retentionDays)} 天物理删除` : ''}）`
          : ttlPurgeEnabled
            ? `只回收（不新增归档，归档满 ${String(config.memory.ttl.retentionDays)} 天物理删除）`
            : '关',
    });
  } else {
    logger.info('调度器未启动：自动提交、会话过期、记忆 TTL 自动归档、归档物理删除全部关闭。', {});
    // 调度器不启动时，启动清理是 `request_log` 唯一的裁剪路径：删掉它表会无限长。
    requestLog.prune({
      retainDays: config.telemetry.requestLog.retainDays,
      retainRows: config.telemetry.requestLog.retainRows,
      now: new Date(),
    });
  }

  return { ttl, scheduler };
}

export function createBackground(
  core: Foundation,
  models: Models,
  retrieval: Retrieval,
  memoryStack: MemoryStack,
): Background {
  const { config, logger, db, metadata, taskRepository, requestLog } = core;
  const { llm } = models;
  const { memory } = memoryStack;

  // `observability` 在这里才构造，而 `phase` 闭包只在任务执行时调用。
  const commitRunner = createCommitRunner(
    core,
    models,
    retrieval,
    memoryStack,
    (name, fn) => observability.phase(name, fn),
  );
  const { ttl, scheduler } = createBackgroundLoops(core, retrieval, memoryStack);

  const observability = new ObservabilityService({
    requestLog,
    db,
    metadata,
    // 孤儿任务计数（§17.5）：谓词在仓储里，健康度不写 `WHERE`。
    tasks: taskRepository,
    llm,
    // 画像格式自查（§11.1）读正文：索引只说明「这是一条画像」，说明不了格式。
    profileBodies: {
      readContent: async (uri) => {
        const record = await memory.read(uri);
        return record === null ? null : memoryContentOf(record.fields);
      },
    },
    logger,
    hookOverheadEnabled: config.telemetry.hookOverhead.enabled,
    includeAccountLabel: config.telemetry.metrics.includeAccountLabel,
    requestLogPolicy: {
      enabled: config.telemetry.requestLog.enabled,
      sampleRate: config.telemetry.requestLog.sampleRate,
    },
  });

  return { commitRunner, ttl, scheduler, observability };
}
