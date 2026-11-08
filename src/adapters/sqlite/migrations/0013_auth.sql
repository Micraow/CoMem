-- 0013_auth.sql —— 凭据（架构文档 §12.7）
--
-- 两套凭据：
--
-- 1. 用户名 + 密码：`app_user` 加 `password_hash` 列。哈希是 `scrypt` 的
--    PHC 风格编码（`scrypt$N$r$p$<salt_b64>$<hash_b64>`），参数与编码见
--    `services/password.ts`。**不引入 argon2 原生依赖**：部署门槛按 AGENTS.md
--    §1 的判断标准是「别人按文档部署后能不能用」，`node:crypto` 开箱即有。
--
-- 2. API Key：独立的 `api_key` 表。一个用户可以有多把 key，`name` 区分用途
--    （「agent A 的 key 泄露只吊销 agent A 的」）。
--
-- ## 为什么 key 没有权限范围
--
-- 一把 key 就是 `(user_id)` 的完整凭证，**无 scope、无权限位**。范围靠路径级
-- ACL 表达，不靠 key：
--
-- - 两套范围求交（`min(key_scope, acl_grant)`）会让排障成本翻倍；
-- - key 带范围会撞 `domain/acl.ts` 的不变量 1「owner 恒 manage」——要么破例
--   要么特判，特例就是提权入口；
-- - 已经有 `user:*` + 组 + 路径三种表达力，缺的不是 key 范围。
--
-- ## 为什么 prefix 明文存
--
-- 校验要按 prefix 做等值索引查找（`UNIQUE`），secret 走 scrypt 比对。prefix
-- 是「这把 key 是哪一把」的标识，不是秘密；secret 才是。明文存 prefix 也让
-- 「列出 key」只返回 prefix 时不会泄露任何可用的东西。
--
-- ## 为什么 `user_id` 最初不建外键
--
-- 与 0008 的判据相同：删用户是账号管理，删 key 是凭据管理，两者的审计语义
-- 不同。「哪些行跟着删」由应用层显式决定（`IdentityService.deleteUser` 会清
-- key），DDL 里的级联删除是看不见的副作用。
--
-- **迁移 0017 补上了 `api_key.user_id -> app_user(id) ON DELETE CASCADE`**：绕过
-- `IdentityService.deleteUser` 直接删用户行时，key 不能留下——孤儿 key 在重建
-- 同 ID 用户后立刻可用，而它本来属于一个已经被撤销的账号。应用层的
-- `removeByUser` 保留（删除日志要计数）。
--
-- ## 幂等
--
-- `ALTER TABLE ... ADD COLUMN` 在 SQLite 没有 `IF NOT EXISTS`。迁移框架按
-- `schema_version` 跳过已应用的版本，所以这里不需要列级幂等；`CREATE TABLE` /
-- `CREATE INDEX` 仍然写 `IF NOT EXISTS`（并行分支合并后重跑不会炸）。

ALTER TABLE app_user ADD COLUMN password_hash TEXT;

-- API Key。
--
-- `expires_at` / `revoked_at` 为 `NULL` 表示「永不过期」/「未吊销」。时间用
-- ISO 8601（与其它表一致，§8.1：字典序等于时间序），比较直接按字符串。
CREATE TABLE IF NOT EXISTS api_key (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  key_hash   TEXT NOT NULL,
  prefix     TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  revoked_at TEXT
);

-- 管理面按用户列 key（`GET /admin/users/{id}/api-keys`）。prefix 的唯一索引
-- 覆盖校验热路径，用户维度要单独建。
CREATE INDEX IF NOT EXISTS idx_api_key_user ON api_key(user_id);
