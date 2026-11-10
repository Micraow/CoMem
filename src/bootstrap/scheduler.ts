/**
 * 后台调度器（架构文档 §10.2.1 的自动提交、§11.7 的会话过期与记忆 TTL、§10.6 的对账重放、
 * §17.6 的请求记录裁剪）。
 *
 * ## 为什么需要它
 *
 * `session.autoCommit.*` 的六个字段此前**没有任何生产调用点**：`SessionService` 的
 * `shouldAutoCommit` 与 `domain/session.ts` 的策略函数都写好了，但没人调。后果不是
 * 「慢」而是「永不触发」——运维把 `pendingTokenThreshold` 从 150000 调到 5000，期待
 * 更早归档，实际一条都不会自动提交。同样地，会话空闲多久该归档、记忆多久该过期，
 * 都需要一个常驻循环去扫。
 *
 * 单元测试看不出来：它们直接构造服务再同步 `await`，绕过了「谁在什么时候调它」
 * （`local/notes/decisions.md` 的 W10 一条，同一个结构性盲区）。
 *
 * ## 六个职责
 *
 * | 职责 | 判定 | 动作 |
 * |---|---|---|
 * | 自动提交 | `SessionService.shouldAutoCommit`（token / 消息数 / 空闲） | 走**现有的**阶段一 `commitPhase1` |
 * | 会话过期 | `now - 最后活动时间 >= session.expiry.idleTimeoutSeconds` | `archive`（默认）或 `delete` |
 * | TTL 清扫 | `max(updated_at, last_accessed_at) < now - memory.ttl.defaultDays` | `status = 'archived'`（软过期） |
 * | 临时上传清理 | `stagedAtMs < now - 24 小时` | 删除 `_meta/tmp/` 下的文件与元数据 |
 * | 对账重放 | `_meta/reconcile.log` 里有未解决记录 | 重做 `index` / `permission`，成功后原子清理日志（§10.6） |
 * | 请求记录裁剪 | `created_at < now - telemetry.requestLog.retainDays` 或超出 `retainRows` | 删除 `request_log` 的行（§17.6） |
 *
 * ## 幂等
 *
 * 六个动作都幂等，所以「上一轮刚做完、这一轮又被扫到」不会产生重复产物：
 * `commitPhase1` 用路径锁 + 归档序号单调（§10.2），`archive` 对已归档的会话是空操作，
 * `sweep` 的 `status <> 'archived'` 让同一条过期记忆只计数一次，`sweepStaged` 删掉的行
 * 下一轮自然不再出现，`reconcile` 的索引与权限物化都是 upsert，`prune` 的两条 DELETE
 * 只按时间与行数删、删过的行不会再被匹配。间隔与重叠保护是
 * 「省一次扫描」，不是正确性前提。
 *
 * ## 为什么遍历会话要碰文件系统
 *
 * 会话不是 SQLite 行：`sessions/sess_xxx/` 是磁盘目录，`.meta.json` 是真相（§7），
 * `GET /sessions` 也是列目录再逐个 `load`（`api/http/routes/sessions.ts` 的文件头）。
 * 所以「有哪些会话」只能从数据根扫出来，而这一层是唯一允许同时碰 `node:fs` 与服务
 * 的层（§4.2）。**不建 `session` 表**：那会造出第二个真相来源。
 *
 * ## 拆分后的模块（本文件只是门面，导出面与原实现一致）
 *
 * 实现按职责放在 `scheduler/` 下，调用方的 import 路径（`bootstrap/scheduler.js`）
 * 与导出符号都不变：
 *
 * - `constants.ts`：轮询间隔、临时上传保留期、磁盘布局名
 * - `contracts.ts`：端口、选项、轮次结果（只有类型）
 * - `helpers.ts`：错误文本与 fs 错误码
 * - `session-scan.ts`：从数据根扫出会话 URI
 * - `session-round.ts`：单个会话的自动提交 / 过期分发
 * - `session-expiry.ts`：空闲判定、归档或删除、删除前的待复核记忆检查
 * - `memory-diff.ts`：`archive_NNN/memory_diff.json` 的读取与形状校验
 * - `maintenance.ts`：TTL、临时上传、请求记录裁剪、对账重放、轮次摘要
 * - `round.ts`：一轮的顺序与汇总
 * - `service.ts`：`Scheduler`（定时器与轮次状态）
 */

export { DEFAULT_INTERVAL_MS } from './scheduler/constants.js';
export type {
  PendingMemoryPort,
  ReconcilePort,
  ReconcileReplayResult,
  RequestLogPrunePort,
  RequestLogRetention,
  SchedulerExpiry,
  SchedulerOptions,
  SchedulerTickResult,
  SessionAutoCommitPort,
  StagedUploadSweepPort,
  TtlPort,
} from './scheduler/contracts.js';
export { Scheduler } from './scheduler/service.js';
