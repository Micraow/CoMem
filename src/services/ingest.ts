/**
 * 本机 Agent 对话导入的编排（架构文档 §11.9）。
 *
 * ## 一条会话的流程
 *
 * ```
 * 游标之后读一批 → 建会话（首次）→ 逐条 appendMessages → 写回游标
 *                → 重复直到读完 → commitPhase1（归档 + 建任务）
 * ```
 *
 * **游标只在消息落盘之后前进。** 反过来（先写游标再写消息）时，一次磁盘满或进程
 * 被杀就会永久丢掉那一段——日志还在，但游标越过去了。
 *
 * **每条会话单独提交。** 攒在内存里等到全部会话结束再写，一次失败就全丢；而且
 * 908 个会话的正文不能同时留在堆里。
 *
 * **一条会话失败不影响其它会话。** 单个文件坏掉（格式变化、权限、磁盘）时，其余
 * 会话仍然导入，失败进 `report.errors`。
 *
 * ## 导入之后必须等阶段二
 *
 * `commitPhase1` 只写归档、建任务（阶段一，§10.1）。任务要由 `CommitRunner` 认领
 * 才会跑阶段二：生成摘要、抽取记忆、合并、摘要失效。导入完立刻退出时任务停在
 * `pending`，`find` 一条都搜不到——「导了 908 个会话，find 0 命中」。
 *
 * 所以 `waitForExtraction` **默认 `true`**：导入完一批会话就驱动执行器跑到这一批
 * 的任务结束。关掉它只在「先看报告、稍后跑服务」时有用，报告里的 `extraction` 为
 * `null`。
 *
 * **没有可用 LLM 时降级成「只归档」。** 阶段一不依赖模型：把会话归档进库、建好
 * 任务，本身就有价值（原始对话落盘、可按内容检索）。阶段二每个任务都要调模型，
 * `providers.llm.default.type: disabled` 时注定失败。所以此时**不报错**——「先把
 * 数据导进来、模型以后配」是合法的部署顺序——而是跳过阶段二，并在报告的
 * `extraction` 里写明 `{ skipped: true, reason: 'llm_disabled' }`，同时记一条
 * `warn` 日志。报告与日志必须说出来：跑完 1,076 个会话却不说「记忆没被抽取」，
 * 用户会以为 `find` 能搜到。
 *
 * **为什么要分批。** 908 个会话 × 每会话 1–2 次模型调用是 2–3 小时。等全部导完再
 * 等阶段二，用户几个小时看不到一行进度；而且一次超时就会把整批算失败。按
 * `extractionBatchSize`（默认 20）个会话一批，超时按批算，一批失败不阻塞后面。
 *
 * ## 幂等
 *
 * 同一个 `(harness, nativeSessionId)` 跑第二次：游标已经在末尾，`readMessages`
 * 不前进，`skipped + 1`，不建会话、不写消息、不提交。
 *
 * **游标之外还有一层去重。** 游标只在消息落盘之后前进，所以进程死在「写完这批
 * 消息、游标还没写」之间时，重跑会从**同一个**游标再读一遍。这时服务端必须能
 * 认出「这条已经落过盘」，否则整批重复导入（且重复的消息是新的随机 ID，去重没有
 * 判据）。
 *
 * 所以消息 ID 是**确定性**的：`sha256(role + text + createdAt)`
 * （`stableMessageId`，`remember` 与 `ingest` 同调这一个函数）。追加前先收集会话
 * 已有的消息 ID（live + 全部归档的 `archivedMessageIds`），命中就跳过。**源时间戳
 * 是幂等键的一部分**：源日志没有 `createdAt` 时只能填当前时刻，重跑会得到不同的
 * ID，这一段仍然会重复——已知窗口，写在这里而不是留给人踩。
 *
 * ## `dryRun` 不写
 *
 * `dryRun` 下不调 `SessionService` 的任何方法，也不调游标仓储的 `upsert`。它仍然
 * 读游标与源日志，所以报告里的「新建 / 跳过」是真实判断。游标仓储在 dry-run 时
 * 可以是只读连接，`services/` 不需要知道这一点。
 *
 * **`dryRun` 也忽略 `waitForExtraction`。** 没有任务可跑；为了「看看抽取效果」去
 * 真的调模型会产生费用且不可逆。报告里的 `extraction` 是 `null`。
 *
 * ## 溯源
 *
 * `SessionMeta` 是冻结契约（`domain/session.ts`），没有 `source` 字段，且
 * `metadata-file.ts` 读回时会丢弃未知字段。所以「这条会话从哪来」记在
 * `ingest_cursor` 行的 `(harness, nativeSessionId, locator → session_uri)` 上，
 * 而不是伪造一个读不回来的 `.meta.json` 字段。
 *
 * ## 模块分工
 *
 * 本文件只 re-export 公开契约与 `IngestService`；实现在 `services/ingest/`：
 *
 * - `service.ts` — 构造校验与 `run()`（按来源驱动一次导入，汇总报告）
 * - `session-ingest.ts` — 单个会话：拉取、去重、游标、阶段一
 * - `extraction.ts` — 阶段二的一批（执行器、计时、失败与超时写进报告）
 * - `options.ts` — 选项解析、来源筛选、两个默认值
 * - `ports.ts` — 编排端口与「必须注入」的判定
 * - `stats.ts` — 报告累加器；`support.ts` — 错误文本 / 时间戳 / URI 解析
 * - `types.ts` — 本文件 re-export 的全部公开类型
 */

export { IngestService } from './ingest/service.js';
export type {
  ExtractionRunner,
  IngestError,
  IngestExtractionBatch,
  IngestExtractionBatchReport,
  IngestExtractionReport,
  IngestExtractionSkipReason,
  IngestExtractionSkippedReport,
  IngestHarnessReport,
  IngestOptions,
  IngestReport,
  IngestServiceOptions,
} from './ingest/types.js';
