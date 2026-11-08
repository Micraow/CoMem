-- 0014_group_owner.sql —— 组的 owner（架构文档 §12.6）
--
-- 修复：组根预置只有 `group:{gid} = write`（级别 3），而改 ACL 要求
-- `manage`（级别 7）。`levelSatisfies(3, 7)` 为 false，所以建组之后没有任何
-- 主体能对组空间求 manage——`setAcl` / `getAcl` 永远 403，组内成员既不能给
-- 同组另一人开只读，也不能设 restricted 或建子目录授权。
--
-- 修法是给组记一个 owner：组根预置写 `user:{owner} = manage`。owner 是组的
-- 属性而不是 ACL 条目的副产物——ACL 文件可以被手工改掉，组目录行是「这个组
-- 归谁管」的权威来源。
--
-- ## 存量回填规则
--
-- 迁移执行时没有「创建者」这个信息：`group_member` 只记录 `added_at`，没有
-- 审计日志。所以回填只能取**最早加入的成员**：
--
--   ORDER BY added_at ASC, user_id ASC LIMIT 1
--
-- 两点不确定性必须写清楚：
--
-- 1. **最早加入的成员未必是创建者。** 创建者可能先把别人加进来、自己后加入，
--    或者创建后从未加入。回填结果因此只是一个「有人能管这个组」的合理猜测，
--    不是身份事实。控制台应当把 owner 显示成可改的，管理员核对后可以用
--    `POST /api/v1/admin/groups/{id}/owner` 纠正。
-- 2. **一个成员都没有的组保持 NULL。** 没有候选可回填；这类组在改 owner
--    之前无人可管理（见 `docs/operations.md` 的升级说明）。
--
-- 时间戳相同（同一毫秒加入）时用 `user_id` 升序做确定性 tie-break：不这样
-- 做，同一份数据两次迁移可能给出不同 owner。
--
-- ## 幂等
--
-- `ALTER TABLE ... ADD COLUMN` 在 SQLite 没有 `IF NOT EXISTS`。迁移框架按
-- `schema_version` 跳过已应用的版本，所以不需要列级幂等；`WHERE owner_user_id
-- IS NULL` 也让回填在手工重跑时不会覆盖已经改过的 owner。

ALTER TABLE app_group ADD COLUMN owner_user_id TEXT;

UPDATE app_group
SET owner_user_id = (
  SELECT gm.user_id
  FROM group_member gm
  WHERE gm.group_id = app_group.id
  ORDER BY gm.added_at ASC, gm.user_id ASC
  LIMIT 1
)
WHERE owner_user_id IS NULL;
