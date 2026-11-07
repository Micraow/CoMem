-- 0004_permission_effect.sql —— 物化权限的 deny 语义（架构文档 §12.2 不变量 2）
--
-- 只有 level 表达不了「同一主体在同一节点上既 allow 又 deny 时 deny 赢」：
-- 空集（被 deny 清空）与「从未被授权」都写不出行，读侧无法区分。
--
-- 已有行的 DEFAULT 'allow' 保证向后兼容：老库里能查到权限的节点在新谓词下行为不变。
-- ADD COLUMN 不支持 IF NOT EXISTS，幂等由 runMigrations 的版本表保证。

ALTER TABLE node_permission ADD COLUMN effect TEXT NOT NULL DEFAULT 'allow';
