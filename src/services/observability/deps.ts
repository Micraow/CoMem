/**
 * `ObservabilityService` 的构造入参。
 *
 * 形状即装配契约：适配器实例、时钟、开关全部由 `bootstrap/` 注入，服务自己只
 * `import type` 引用适配层（§4.2、§4.4）。
 */

import type { MetadataFileStore } from '../../adapters/fs/metadata-file.js';
import type { RequestLogRepository } from '../../adapters/sqlite/request-log-repository.js';
import type { TaskRepository } from '../../adapters/sqlite/task-repository.js';
import type { Logger } from '../../domain/log.js';

import type { LlmService } from '../llm.js';

import type { ObservabilityDatabase, RequestLogPolicy } from './contracts.js';
import type { ProfileBodyReader } from './profile-format.js';

export interface ObservabilityServiceDeps {
  /** `request_log` 的写入路径（§17.6） */
  readonly requestLog: RequestLogRepository;
  /** 健康度与 `/metrics` 的只读聚合（§17.5、§17.9）；`DatabaseSync` 结构上满足它 */
  readonly db: ObservabilityDatabase;
  /** 读目录的 `.abstract.md`，判定降级摘要（§17.5） */
  readonly metadata: Pick<MetadataFileStore, 'readSummary'>;
  /**
   * 孤儿任务计数（§17.5 的 `orphanTasks`）。
   *
   * 用仓储的方法而不是在这里再写一条 `WHERE`：「租约过期」这个谓词只有一份
   * （`task-repository.ts` 的 `LEASE_EXPIRED_SQL`），健康度报的数字必须等于
   * `recoverExpired` 下次启动能捞回的集合。
   */
  readonly tasks: Pick<TaskRepository, 'countExpiredLeases'>;
  /** §17.4 的模型用量；`LlmService.stats` 是累加器 */
  readonly llm: Pick<LlmService, 'stats'>;
  /**
   * 画像正文读取。必须有：缺了它 `health()` 返回的 `memory.profileFormat` 会永远
   * 报 0 违规，「服务端校验画像」就变成假实现。
   */
  readonly profileBodies: ProfileBodyReader;
  readonly logger: Logger;
  /**
   * 是否记录 Hook 阻塞开销（`telemetry.hookOverhead.enabled`）。
   *
   * 关闭时 `recordHookOverhead` 直接返回，`comem_hook_overhead_seconds` 不出现在
   * `/metrics` 里。默认 `true`——它是控制台「监控」页的主要数据源，关掉就没有数据。
   */
  readonly hookOverheadEnabled?: boolean;
  /** 时钟；默认 `() => new Date()` */
  readonly now?: () => Date;
  /** §17.6 的采样；默认全量 */
  readonly requestLogPolicy?: RequestLogPolicy;
  /**
   * 是否在 `/metrics` 里按账号拆分请求耗时（`telemetry.metrics.includeAccountLabel`）。
   *
   * 默认 `false`：单账号部署没必要，开了会放大标签基数。打开后
   * `comem_http_request_duration_seconds` 的样本带 `account` 标签。
   */
  readonly includeAccountLabel?: boolean;
}
