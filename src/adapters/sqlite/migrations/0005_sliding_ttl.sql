-- ── 记忆 TTL 改为滑动窗口：过期判据不再存成绝对时刻（架构文档 §11.7）──────
--
-- 旧判据是写入时算出的绝对时刻：`expires_at = updated_at + memory.ttl.defaultDays`。
-- 它把「这条记忆多久没人用」换成了「这条记忆多久以前写的」，于是天天被检索命中的
-- 记忆和从没打开过的记忆同时到期；改配置也只对之后写入的记忆生效，存量要另跑追平
-- 脚本。
--
-- 新判据在清扫时现算：`max(updated_at, last_accessed_at)` 早于 `now - defaultDays`
-- 才归档。`last_accessed_at` / `access_count` 本来就由 `recordAccess` 在检索命中时
-- 写入（§17.5 热度衰减的输入），不需要新增写入点；改配置立即对存量生效，也不存在
-- 「按旧配置算出的陈旧时刻」。
--
-- `expires_at` 因此失去全部读取方（写入点 `SqliteFtsIndex.upsert` 与运维入口
-- `TtlService.setExpiry` 一并删除），按 §1「配置项必须真的生效」的同一条准则删列，
-- 不留一列没人读的字段。默认值不变：`defaultDays = 0` / `retentionDays = 0`。
--
-- 索引 `idx_node_expires` 只为旧的 `WHERE expires_at < ?` 服务，随列一起删。
-- **不建表达式索引**：`MAX(updated_at, COALESCE(last_accessed_at, updated_at))` 的
-- 索引会在 `recordAccess`（每次检索命中的写路径）上多维护一条索引项，而默认配置
-- （TTL 关闭）根本不需要它。第一段的顺序扫描代价见 §11.7。

DROP INDEX IF EXISTS idx_node_expires;

ALTER TABLE node DROP COLUMN expires_at;
