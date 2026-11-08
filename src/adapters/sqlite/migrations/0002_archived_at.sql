-- ── TTL 两段式：归档时刻（架构文档 §11.7、§18）──────────────────────────────
--
-- TTL 清扫的第一段（`expires_at < now` → `status = 'archived'`）只标不删。
-- 第二段（归档后超过 `memory.ttl.retentionDays` → 物理删除文件与索引行）需要
-- 知道「这条记忆是什么时候归档的」，`expires_at` 只说明「它什么时候该过期」，
-- `updated_at` 是内容写盘时间、归档不写它（设置过期 / 归档都不是内容修改），
-- 两者都算不出「归档了多久」。所以补一列。
--
-- `archived_at` 只在 `sweepExpired` 把 `status` 置 `archived` 的同一句 UPDATE 里写。
-- 默认 NULL = 「不知道归档时刻」。对「本迁移之前就已是 archived 的行」这不是漏删：
-- 物理删除不可逆，把一批来历不明的旧归档当成「很久以前」立刻删，代价远大于多留
-- 一个保留周期。（`retentionDays` 默认 0 = 永不物理删，所以默认部署下这些 NULL 行
-- 永远不会被第二段碰到。）
ALTER TABLE node ADD COLUMN archived_at TEXT;

-- 第二段清扫按「已归档且归档时刻早于某个截止」找候选。部分索引只收录已归档的行，
-- 默认部署（从不产生 archived 行）下这张索引是空的，不为「没人用物理删除」的
-- 部署付维护成本——与 `idx_node_expires` 同一取舍。
CREATE INDEX idx_node_archived ON node(archived_at) WHERE status = 'archived';
