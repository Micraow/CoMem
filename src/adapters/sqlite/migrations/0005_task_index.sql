-- 0005_task_index.sql —— 任务表的查询索引（架构文档 §8.1 的 `task` 表、§10.4）
--
-- 表本身在 0002 已经建好，`task` 上的 `task_claim(status, lease_until)` 也已经在
-- 那里。本迁移只补两条**查询用**的索引：`task_claim` 服务「领取下一个任务」，
-- 这两条服务「按类型/状态统计」与「按创建时间排序」。
--
-- 幂等：迁移框架按 `schema_version` 跳过已应用的版本，脚本本身也写成
-- `IF NOT EXISTS`（本地删库重建、并行分支合并后重跑都不会炸）。

-- 会话的归档序号反查（§10.2：archive_001、archive_002……单调递增，从不复用）。
-- 归档任务按 `type = 'archive'` + `status` 过滤，`task_claim` 只覆盖 status 前缀，
-- 带上 type 才能免掉一次全表过滤。
CREATE INDEX IF NOT EXISTS task_type_status ON task(type, status);

-- 「这个会话有没有未完成的任务」：按创建时间升序取最早的待处理任务。
CREATE INDEX IF NOT EXISTS task_created ON task(created_at);
