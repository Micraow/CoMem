-- 0018_group_owner_foreign_key.sql —— 组的 owner 引用身份表（架构文档 §12.2、§12.6）
--
-- `app_group.owner_user_id` 在 0014 里是纯 TEXT，没有 `REFERENCES app_user(id)`。
-- 正常路径由 `IdentityService.deleteUser` 的 `clearOwnerOfUser` 清空；但仓储是公开
-- 入口，任何调用方都能绕过用例直接 `DELETE FROM app_user`，留下一串指向不存在用户
-- 的 owner 元数据。
--
-- 残留不是「多一列脏数据」：`POST /admin/groups/{id}/owner` 把「当前 owner」当成
-- 快速路径（`group.ownerUserId === 调用者` 时跳过组根求权）。同 ID 重建账号后，
-- 新账号立刻被当成当前 owner，可以给组根写 `user:{自己} = manage`——它从未被授予
-- 过任何东西，组的管理权却转移到了它手上（§12.2 的「ACL 条目是授权唯一来源」被
-- 元数据绕过）。
--
-- 修法是补 `REFERENCES app_user(id) ON DELETE SET NULL`。选 `SET NULL` 而不是
-- `CASCADE`：删用户是删主体，不是删组。组的成员、数据、子树里的授权都还在，只是
-- 暂时没有 owner；`CASCADE` 会连组目录行一起删掉，等于一次误操作不可恢复。置
-- `NULL` 的组没有 manage 持有者，恢复走 `pnpm group:owner`（§12.6）。
--
-- ## 为什么必须重建 app_group
--
-- SQLite 不支持 `ALTER TABLE ... ADD CONSTRAINT`（只有 `RENAME COLUMN` /
-- `ADD COLUMN` / `DROP COLUMN`）。标准流程是新建带约束的表、`INSERT INTO ...
-- SELECT`、`DROP` 旧表、`RENAME`，最后按原样重建索引。`app_group` 没有除主键之外
-- 的索引，所以这一步只需要一张表。
--
-- ## 孤儿 owner：置 NULL，不删组
--
-- 旧库里 `owner_user_id` 可能指向一个已经不存在、也不会再创建的用户。直接复制会
-- 让迁移撞在外键上、整次升级卡住。这里用 `CASE WHEN ... IN (SELECT id FROM
-- app_user) THEN ... ELSE NULL END` 把孤儿 owner 降级成「无 owner」——组的目录行、
-- 成员关系与数据都保留，只丢掉一个已经无法解释的元数据。
--
-- 升级前可以先数一下有多少组会被置空：
--
--   SELECT COUNT(*) FROM app_group
--   WHERE owner_user_id IS NOT NULL
--     AND owner_user_id NOT IN (SELECT id FROM app_user);
--
-- ## 外键强制在迁移期间是关的
--
-- `DROP TABLE app_group` 在 `foreign_keys = ON` 时会先做隐式 `DELETE FROM`，而
-- `group_member.group_id` 带 `ON DELETE CASCADE`（迁移 0017）——整张成员关系表会
-- 被这次重建清空。`PRAGMA foreign_keys` 在事务里是 no-op，所以开关由迁移框架
-- （`database.ts` 的 `runMigrations`）在事务外面负责：每个迁移执行前关掉、提交前
-- 用 `PRAGMA foreign_key_check` 确认没有留下悬空引用、再恢复原值。

CREATE TABLE app_group_new (
  id            TEXT PRIMARY KEY,
  display_name  TEXT NOT NULL,
  description   TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  owner_user_id TEXT REFERENCES app_user(id) ON DELETE SET NULL
);

INSERT INTO app_group_new (id, display_name, description, created_at, updated_at, owner_user_id)
SELECT
  g.id,
  g.display_name,
  g.description,
  g.created_at,
  g.updated_at,
  CASE
    WHEN g.owner_user_id IN (SELECT id FROM app_user) THEN g.owner_user_id
    ELSE NULL
  END
FROM app_group g;

DROP TABLE app_group;

ALTER TABLE app_group_new RENAME TO app_group;
