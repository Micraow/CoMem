/**
 * 可观测性服务的装配壳：把注入的端口与内存状态交给各职责模块。
 *
 * 方法体全部是「取端口 → 调一个模块函数」。逻辑分别在 `timing.ts`（阶段与归因）、
 * `request-record.ts`（请求记录）、`hook-overhead.ts`（Hook 上报）、`metrics.ts`
 * （指标渲染）、`health.ts`（健康度）里；本类只守住公开面。
 */

import type { MetadataFileStore } from '../../adapters/fs/metadata-file.js';
import type { RequestLogRepository } from '../../adapters/sqlite/request-log-repository.js';
import type { TaskRepository } from '../../adapters/sqlite/task-repository.js';
import type { Logger } from '../../domain/log.js';

import type { LlmService } from '../llm.js';

import type {
  HookOverheadReport,
  ObservabilityDatabase,
  RequestLogEntry,
} from './contracts.js';
import { DEFAULT_REQUEST_LOG_POLICY, type RequestLogPolicy } from './contracts.js';
import type { ObservabilityServiceDeps } from './deps.js';
import { healthSnapshot, type MemoryHealth } from './health.js';
import {
  createHookOverheadState,
  recordHookOverheadEntry,
  type HookOverheadState,
} from './hook-overhead.js';
import {
  createRequestMetrics,
  renderMetrics,
  type RequestMetricsState,
} from './metrics.js';
import type { ProfileBodyReader } from './profile-format.js';
import { recordRequestEntry } from './request-record.js';
import {
  createTimingState,
  runInRequestScope,
  timePhase,
  type TimingState,
} from './timing.js';

/** 见 `../observability.ts` 的文件头与各模块的文件头。 */
export class ObservabilityService {
  readonly #requestLog: RequestLogRepository;
  readonly #db: ObservabilityDatabase;
  readonly #metadata: Pick<MetadataFileStore, 'readSummary'>;
  readonly #llm: Pick<LlmService, 'stats'>;
  readonly #profileBodies: ProfileBodyReader;
  readonly #logger: Logger;
  readonly #now: () => Date;
  readonly #policy: RequestLogPolicy;
  /** 孤儿任务计数的端口（`TaskRepository`）。 */
  readonly #tasks: Pick<TaskRepository, 'countExpiredLeases'>;
  readonly #timing: TimingState;
  readonly #hooks: HookOverheadState;
  readonly #metrics: RequestMetricsState;

  constructor(deps: ObservabilityServiceDeps) {
    this.#requestLog = deps.requestLog;
    this.#db = deps.db;
    this.#metadata = deps.metadata;
    this.#tasks = deps.tasks;
    this.#llm = deps.llm;
    this.#profileBodies = deps.profileBodies;
    this.#logger = deps.logger;
    this.#now = deps.now ?? (() => new Date());
    this.#policy = deps.requestLogPolicy ?? DEFAULT_REQUEST_LOG_POLICY;
    this.#timing = createTimingState(deps.logger);
    this.#hooks = createHookOverheadState(deps.hookOverheadEnabled ?? true);
    this.#metrics = createRequestMetrics(deps.includeAccountLabel ?? false);
  }

  /** 在一个请求作用域里执行。见 `timing.ts` 的 `runInRequestScope`。 */
  withRequestScope<T>(fn: () => Promise<T>): Promise<T> {
    return runInRequestScope(this.#timing, fn);
  }

  /** 给一个阶段计时。见 `timing.ts` 的 `timePhase`。 */
  async phase<T>(name: string, fn: () => Promise<T>): Promise<T> {
    return timePhase(this.#timing, name, fn);
  }

  /** 记录一次请求：写 `request_log` + 结构化日志。见 `request-record.ts`。 */
  async recordRequest(entry: RequestLogEntry): Promise<void> {
    recordRequestEntry(
      {
        requestLog: this.#requestLog,
        logger: this.#logger,
        now: this.#now,
        policy: this.#policy,
        timing: this.#timing,
        metrics: this.#metrics,
      },
      entry,
    );
  }

  /** Hook 开销上报。见 `hook-overhead.ts` 的 `recordHookOverheadEntry`。 */
  async recordHookOverhead(report: HookOverheadReport): Promise<void> {
    recordHookOverheadEntry(this.#hooks, this.#logger, report);
  }

  /** §17.5 记忆健康度。见 `health.ts` 的 `healthSnapshot`。 */
  async health(): Promise<MemoryHealth> {
    return healthSnapshot(
      {
        db: this.#db,
        metadata: this.#metadata,
        tasks: this.#tasks,
        profileBodies: this.#profileBodies,
        logger: this.#logger,
      },
      this.#now(),
    );
  }

  /** Prometheus 文本。见 `metrics.ts` 的 `renderMetrics`。 */
  renderMetrics(): string {
    return renderMetrics({
      db: this.#db,
      stats: this.#llm.stats,
      timing: this.#timing,
      hooks: this.#hooks,
      metrics: this.#metrics,
    });
  }
}
