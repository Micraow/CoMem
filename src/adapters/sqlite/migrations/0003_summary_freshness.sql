-- 0003_summary_freshness.sql —— 目录摘要的新鲜度（架构文档 §9.3、§7）
--
-- 为什么新鲜度在 SQLite 而不是 `.abstract.md` 的 frontmatter：§7 的判据表把
-- 「运行时状态（高并发写、需要原子性）」划给 SQLite。每次写节点都要给父目录的
-- 计数器加一，这是高频写；放进摘要文件意味着每次写都要重写摘要正文，还会和
-- 「生成摘要」这条低频路径抢同一个文件。
--
-- 三列只在 `kind = 'directory'` 的行上有意义。文件行保持 NULL / 0：文件摘要跟着
-- 自己的 frontmatter 走（§6.7），不参与目录级的失效传播。
--
-- 幂等：`ALTER TABLE ... ADD COLUMN` **不支持** `IF NOT EXISTS`（SQLite 会直接报
-- 语法错误）。迁移框架（`runMigrations`）按 `schema_version` 跳过已应用的版本，每个
-- 版本只执行一次，所以这里直接写 `ADD COLUMN`。不要为了让脚本「能重放」改成别的
-- 写法——重放由版本表保证，加 `IF NOT EXISTS` 只会让脚本语法错误。
--
-- `NOT NULL` 必须带 `DEFAULT`：SQLite 的 `ADD COLUMN` 不能给已有行补值，只能靠
-- 默认值。这两个默认值同时是「从未生成过摘要」的初始状态（§9.3 的「没有基线」）。

-- 当前摘要基于哪份 L0 正文（`stableDigest` 的 16 位十六进制串）。NULL = 从未生成。
ALTER TABLE node ADD COLUMN summary_baseline TEXT;

-- 未消费的变更次数。不是脏标记：同一个文件反复改，脏标记只算一次，永远到不了
-- 阈值（§9.3「为什么是事件计数而不是脏标记」）。
ALTER TABLE node ADD COLUMN summary_pending INTEGER NOT NULL DEFAULT 0;

-- 生成摘要时的直接子项数，作为 §9.3 阈值判定的分母。不实时数子节点：那样每次
-- 写都要走一遍目录。
ALTER TABLE node ADD COLUMN summary_entries INTEGER NOT NULL DEFAULT 0;
