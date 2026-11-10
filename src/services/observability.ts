/**
 * 可观测性应用服务（架构文档 §17 全节）。
 *
 * 四个问题要能回答：**系统现在在干什么、刚才那次为什么慢、那次失败错在哪、用 CoMem
 * 让每个请求多花了多少时间。** 最后一个是核心——记忆系统的价值必须能证明大于它的
 * 成本（§17 开头）。
 *
 * ## 1. 延迟归因：阻塞与异步分开（§17.2）
 *
 * | 阶段 | 阻塞用户？ |
 * |---|---|
 * | `processStart`（`node hook.mjs` 的进程启动） | 是 |
 * | `recall`（`find` / `search`） | 是 |
 * | `serialize`（注入序列化） | 是 |
 * | `capture`（`Stop` 时的消息落盘） | 是 |
 * | `archive` / `extract` / `merge` / `summary` | 否（后台） |
 *
 * 单轮阻塞开销是前四个之和，典型 60–180ms；后台部分不算进去——用户没等它（§17.2）。
 * 分开统计是必须的：把进程启动藏在「检索 20ms」后面会误导人。
 *
 * ## 2. 阶段之和不超过总耗时（§20 的验收点）
 *
 * `attributeRequest()` 把阶段累加值与测量总耗时对比：**差额（`unattributedMs`）是正常的**，
 * 它覆盖身份解析、路由、请求体解析、响应编码这些没有被计时的部分。只有阶段之和
 * **超过**总耗时（`ATTRIBUTION_TOLERANCE_MS` 之外）才记 `warn`——那说明同一段被记了
 * 两次，或者这些阶段不是这次请求的。**不抛错**：观测代码不该让请求失败（§19「错误
 * 必须可解释」的反面——它也不该制造错误）。
 *
 * ## 2.1 四个阶段里哪些在服务端测得到（§17.2 的实现注记）
 *
 * `phase(name, fn)` 是唯一的记录入口，边界由调用方给定：
 *
 * | 阶段 | 服务端边界 | 备注 |
 * |---|---|---|
 * | `processStart` | 无 | hook 进程启动，只有 hook 自己知道（`performance.timeOrigin`） |
 * | `recall` | `/search/find`、`/search/search` 的服务调用 | `mode=context` 的组装与渲染在 `SearchService.context` 内部，随它一起计时 |
 * | `serialize` | 无 | 注入块的格式化在 hook 里（`formatRecallBlock`） |
 * | `capture` | `POST /sessions/{id}/messages` 的落盘 | hook 侧「写 worker 载荷 + spawn」不在这里 |
 *
 * 所以 `request_log.phases` 里通常只有 `recall` 或 `capture` 之一，`processStart` /
 * `serialize` 不会凭空出现。整轮的四阶段由 hook 上报到 `/telemetry/hook`，进
 * `/metrics` 的 gauge（`recordHookOverhead`）。
 *
 * ## 3. 低基数标签（§17.1、§18 的 `includeAccountLabel` 注释）
 *
 * `/metrics` 的 `event` 只认 §15.2 的七个生命周期点，未知事件归成 `other`。
 * **`sessionId` 不进标签**：每次会话一个值，抓取一次就把指标库撑爆。它只进日志与
 * `request_log`。
 *
 * ## 4. 健康度是诊断端点，不是全库扫描（§17.5）
 *
 * `degradedSummaries` 要读每个目录的 `.abstract.md`，目录数上界 `DEGRADED_DIRECTORY_LIMIT`；
 * 超了记 `warn` 并返回已统计数。画像格式自查（`profileFormatHealth`）同样要读文件
 * 正文，上界 `PROFILE_CHECK_LIMIT`，超了 `truncated: true` 并记 `warn`。
 *
 * ## 5. 为什么这里能直接写 SQL
 *
 * `services/` 不能 import `node:sqlite`（§4.2），而健康度与 `/metrics` 的计数是
 * 「一条 SELECT 就够」的只读聚合。为它们各建一个仓储只会把同一张表的读路径拆散，
 * 所以和 `SummaryService` 的 `SummaryDatabase` 一样，声明最小结构端口
 * `ObservabilityDatabase`，实例由 `bootstrap/` 注入 `DatabaseSync`。写入路径仍然
 * 走 `RequestLogRepository`——写要事务与列映射，读不要。
 *
 * ## 6. 拆分后的模块（本文件只是门面，导出面与原实现一致）
 *
 * 实现按职责放在 `services/observability/` 下，调用方的 import 路径
 * （`services/observability.js`）与导出符号都不变：
 *
 * - `contracts.ts`：公开契约（只读数据库端口、Hook 报告、归因报告、请求记录、采样）
 * - `deps.ts`：`ObservabilityServiceDeps`（装配契约）
 * - `queries.ts`：`NODE_SELF_ROW` 谓词与单行聚合
 * - `timing.ts`：阶段计时、请求作用域、归因
 * - `request-record.ts`：`request_log` 写入与请求日志
 * - `hook-overhead.ts`：Hook 上报白名单、最近一次的四阶段耗时
 * - `metrics.ts`：`/metrics` 文本渲染与请求耗时累加器
 * - `llm-usage.ts`：模型用量、成本与计价开关的样本
 * - `health.ts`：健康度聚合
 * - `profile-format.ts`：画像格式自查
 * - `service.ts`：`ObservabilityService` 的装配壳
 *
 * 这个文件只做 re-export：改实现不要加在这里，读代码从 `service.ts` 进。
 */

export type {
  HookOverheadReport,
  LatencyAttribution,
  ObservabilityDatabase,
  RequestLogEntry,
  RequestLogPolicy,
} from './observability/contracts.js';
export type { ObservabilityServiceDeps } from './observability/deps.js';
export type { MemoryHealth } from './observability/health.js';
export type { ProfileBodyReader, ProfileFormatHealth } from './observability/profile-format.js';
export type { AsyncPhase } from './observability/timing.js';
export { NODE_SELF_ROW } from './observability/queries.js';
export { ObservabilityService } from './observability/service.js';
