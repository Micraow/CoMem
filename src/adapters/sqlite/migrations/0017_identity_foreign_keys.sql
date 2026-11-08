-- 0017_identity_foreign_keys.sql —— 身份表的外键（架构文档 §12.2、§12.7）
--
-- `group_member` 与 `api_key` 的 `user_id` / `group_id` 在 0008 / 0013 里刻意没有
-- 建 `FOREIGN KEY`（那两份注释的理由是「级联删除是看不见的副作用」）。代价是：
-- 仓储是公开入口，任何调用方都能直接 `DELETE FROM app_user` 绕过
-- `IdentityService.deleteUser` 的清理，留下孤儿行；而孤儿行不是「多一行垃圾」——
-- 同 ID 重建用户会立刻获得 `group:{gid}` 主体，等于继承那个组的全部 ACL。
--
-- 应用层的清理仍然保留（`IdentityService.deleteUser` 显式调三个批量删除，删除
-- 日志要计数）。外键是防御纵深，不是替代：它保证「绕过用例直接删行」这条路径也
-- 收口。
--
-- ## 语义：ON DELETE CASCADE
--
-- 两张表都是「挂靠在身份上的关系」：组没了，成员关系失去意义；用户没了，key 与
-- 成员关系都不可解释。`RESTRICT` 会把「删用户」变成「必须先手动退组」，正常路径
-- 没这么用，只会让异常路径更难诊断。
--
-- ## 为什么必须重建表
--
-- SQLite 不支持 `ALTER TABLE ... ADD CONSTRAINT`（只有 `RENAME COLUMN` /
-- `ADD COLUMN` / `DROP COLUMN`）。标准流程是新建带约束的表、`INSERT INTO ...
-- SELECT`、`DROP` 旧表、`RENAME`，最后按原样重建索引。每个迁移在单独的事务里
-- 执行（`runMigrations`），失败时整份回滚，不会留下「一半新表一半旧表」。
--
-- ## 数据迁移的每一步
--
-- 1. 新建 `group_member_new`：列、类型、`CHECK`、主键与旧表一致，追加两条外键。
-- 2. `INSERT INTO group_member_new SELECT ... FROM group_member`，**只复制两端
--    都存在的行**：孤儿行（引用不存在的用户或组）在旧库里能存在，在新约束下
--    不可能。直接复制会让迁移在孤儿行上失败、整次升级卡住；而孤儿行正是这份
--    迁移要清掉的东西，没有保留价值。升级前可以先数一下会被丢掉多少：
--
--      SELECT COUNT(*) FROM group_member
--      WHERE user_id NOT IN (SELECT id FROM app_user)
--         OR group_id NOT IN (SELECT id FROM app_group);
--
-- 3. `DROP TABLE group_member`。它是子表，没有被任何表引用，`PRAGMA
--    foreign_keys = ON` 时删它不触发约束检查。
-- 4. `ALTER TABLE group_member_new RENAME TO group_member`。
-- 5. 重建索引 `idx_group_member_user`（`DROP TABLE` 会连旧索引一起删掉）。
--
-- `api_key` 走同一套流程（它只有 `user_id -> app_user` 一条外键）。
--
-- ## 幂等
--
-- 迁移框架按 `schema_version` 跳过已应用的版本。`CREATE TABLE` 写成 `_new` 后缀
-- 而不是 `IF NOT EXISTS`：这张表只在迁移中途存在，提交之后就没有了。

CREATE TABLE group_member_new (
  group_id TEXT NOT NULL REFERENCES app_group(id) ON DELETE CASCADE,
  user_id  TEXT NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  role     TEXT NOT NULL CHECK (role IN ('owner', 'member')),
  added_at TEXT NOT NULL,
  PRIMARY KEY (group_id, user_id)
);

INSERT INTO group_member_new (group_id, user_id, role, added_at)
SELECT gm.group_id, gm.user_id, gm.role, gm.added_at
FROM group_member gm
WHERE gm.user_id IN (SELECT id FROM app_user)
  AND gm.group_id IN (SELECT id FROM app_group);

DROP TABLE group_member;

ALTER TABLE group_member_new RENAME TO group_member;

CREATE INDEX IF NOT EXISTS idx_group_member_user ON group_member(user_id);

CREATE TABLE api_key_new (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  key_hash   TEXT NOT NULL,
  prefix     TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  revoked_at TEXT
);

INSERT INTO api_key_new (id, user_id, key_hash, prefix, name, created_at, expires_at, revoked_at)
SELECT k.id, k.user_id, k.key_hash, k.prefix, k.name, k.created_at, k.expires_at, k.revoked_at
FROM api_key k
WHERE k.user_id IN (SELECT id FROM app_user);

DROP TABLE api_key;

ALTER TABLE api_key_new RENAME TO api_key;

CREATE INDEX IF NOT EXISTS idx_api_key_user ON api_key(user_id);
