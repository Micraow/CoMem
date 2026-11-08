-- 0008_identity.sql —— 用户与组的身份表（架构文档 §12.1、§12.5、§12.6、§18）
--
-- 三张表补的是「主体从哪来」：0002 的 `acl_entry` / `node_permission` 存的是
-- `user:{uid}` / `group:{gid}` 字符串，组员的成员关系此前没有落库，所以
-- `GET /admin/*` 只能返回 501。这一份是那组端点的数据来源。
--
-- ## 为什么表名是 `app_user` / `app_group` 而不是 `user` / `group`
--
-- `user` 是 SQLite 的关键字，`group` 是 `GROUP BY` 的关键字。加引号能用，但每次
-- 写 SQL 都要记得加，漏一次就是语法错误——而且这类错误在演示前最后一次改 SQL 时
-- 最不容易被发现。统一加 `app_` 前缀，SQL 里不需要任何引号。
--
-- ## 为什么不加外键
--
-- `group_member` 的 `group_id` / `user_id` 引用 `app_group` / `app_user`，但这里
-- 刻意**不**建 `FOREIGN KEY ... ON DELETE CASCADE`：
--
-- 1. **删用户不等于级联删一切。** 成员关系要显式清（否则 `listMembers` 会返回
--    不存在的用户，孤儿行没有任何查询方还能解释它）；ACL 里的 `user:{uid}` 条目
--    不能跟着删——删用户是账号管理，撤权是另一件事，两者的审计语义不同。
--    「哪些行跟着删」是应用层的决策，交给外键只会让删除范围变成 DDL 里看不见的
--    副作用。
-- 2. **删除要留痕。** 应用层可以在删之前记日志、对账；级联删除没有这个插入点。
--
-- 所以成员关系由 `services/identity.ts` 显式删除（`GroupRepository` 的两个批量
-- 删除方法），不靠 DDL。
--
-- ## 幂等
--
-- 迁移框架按 `schema_version` 跳过已应用的版本，脚本本身也写成 `IF NOT EXISTS`
-- （本地删库重建、并行分支合并后重跑都不会炸）。

-- 用户目录。`status` 只有两个值：`disabled` 的用户不能通过 `resolve` 拿到身份
-- （§17 的 401），但行还在——禁用不是删除，权限与历史记录都保留。
CREATE TABLE IF NOT EXISTS app_user (
  id           TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  email        TEXT,
  status       TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

-- 组目录。组的显示名与描述只是控制台展示用；授权仍然只认 `group:{gid}` 字符串
-- （§12.5：ACL 存组 principal，不展开成员列表）。
CREATE TABLE IF NOT EXISTS app_group (
  id           TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  description  TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

-- 组成员关系。主键 `(group_id, user_id)` 保证「同一个人在一个组里只有一行」，
-- `addMember` 的幂等（已存在时更新 role）就建立在这个约束上。
CREATE TABLE IF NOT EXISTS group_member (
  group_id TEXT NOT NULL,
  user_id  TEXT NOT NULL,
  role     TEXT NOT NULL CHECK (role IN ('owner', 'member')),
  added_at TEXT NOT NULL,
  PRIMARY KEY (group_id, user_id)
);

-- 身份展开的热路径（`listGroupIdsOfUser`：每个请求一次）。主键的前缀是
-- `group_id`，按用户反查组走不到它，必须单独建。
CREATE INDEX IF NOT EXISTS idx_group_member_user ON group_member(user_id);
