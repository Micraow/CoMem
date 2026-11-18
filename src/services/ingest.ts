/**
 * 本机 Agent 对话导入的编排（架构文档 §11.9）。
 *
 * 一条会话：游标之后读一批 → 建会话 → 逐条 appendMessages → 写回游标 →
 * commitPhase1（归档 + 建任务）。**游标只在消息落盘之后前进**，反过来时一次
 * 进程被杀就永久丢掉那一段。每条会话单独提交，一条失败不影响其它，失败进
 * `report.errors`。
 *
 * **幂等**：消息 ID 是确定性的 `sha256(role + text + createdAt)`
 * （`stableMessageId`），重跑时先收集已有 ID 再跳过。源日志没有 `createdAt`
 * 时只能填当前时刻，这一段重跑会重复——已知窗口。
 *
 * **导入后要等阶段二**：`commitPhase1` 只建任务，记忆抽取由 `CommitRunner` 跑；
 * `waitForExtraction` 默认 `true`，否则导入完 `find` 一条都搜不到。没有可用
 * LLM 时跳过阶段二，报告里写 `{ skipped: true, reason: 'llm_disabled' }`。
 * `dryRun` 不写任何东西，也忽略 `waitForExtraction`。
 *
 * 实现按职责放在 `services/ingest/` 下；对外导出面与 import 路径不变。
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
