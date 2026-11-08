-- 0011_ingest.sql —— 本机 Agent 对话导入的游标（架构文档 §11.9）
--
-- **为什么必须有这张表**：用户机器上的日志是**追加式**的，今天导了一半，
-- 明天又多了 500 条。没有游标就只能全量重导——而重导会产生重复会话。
-- 游标让导入**幂等且可续跑**。
--
-- **为什么主键是 (harness, native_session_id)**：同一个原生会话 ID 在不同宿主里
-- 可以重名（UUID 空间不同），跨宿主去重会把两个不相干的会话并成一个。
--
-- **为什么 `session_uri` 也存**：导入成功之后，「这条日志对应 CoMem 里的哪个会话」
-- 没有别的地方可查。`locator` 只回答「从哪个文件来的」，重跑时要找的是会话 URI。
--
-- **`message_count` 是报告与排查用的**：已经导入了多少条。它从 0 开始只增不减；
-- 游标值本身回答「读到哪」，这个数回答「一共读了多少」。
--
-- 幂等：迁移框架按 `schema_version` 跳过已应用的版本，`CREATE TABLE IF NOT EXISTS`
-- 让脚本本身也能重放（本地删库重建、并行分支合并后重跑）。
CREATE TABLE IF NOT EXISTS ingest_cursor (
  harness            TEXT NOT NULL,
  native_session_id  TEXT NOT NULL,
  -- 源系统里的会话 ID → 我们创建的 session URI。重跑时要能找回同一个会话。
  session_uri        TEXT NOT NULL,
  cursor_kind        TEXT NOT NULL,
  cursor_value       TEXT NOT NULL,
  -- 已经导入了多少条消息。用于报告与「为什么这条会话没更新」的排查。
  message_count      INTEGER NOT NULL DEFAULT 0,
  updated_at         TEXT NOT NULL,
  PRIMARY KEY (harness, native_session_id)
);
