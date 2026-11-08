-- 0001_init.sql —— 初始 schema（架构文档 §8.1、§12）
--
-- 这是**唯一的建表脚本**：一次 `runMigrations` 从空库建出完整结构，版本号 1。
-- 早期的 18 个增量迁移（含 0016–0018 三份「修前面迁移 bug」的补丁）已经合并到
-- 这里——项目没有存量用户，不需要从 0001 一路 migrate 上来，也不保留补丁历史。
--
-- 此后每次 schema 变更**新增一个迁移文件**（`NNNN_描述.sql`），不再改本文件。
--
-- 表顺序：被引用的表先建。`app_user` 在 `app_group` / `group_member` / `api_key`
-- 之前；`app_group` 在 `group_member` 之前。SQLite 允许前向引用，但顺序清晰让
-- `foreign_key_check` 的排查更直观。
--
-- `schema_version` 表不在这里：它由 `runMigrations`（`database.ts`）自己创建。

-- ── 身份表（原 0008，外键由原 0017 / 0018 合并进来）────────────────────────
--
-- 表名加 `app_` 前缀：`user` 是 SQLite 关键字，`group` 是 `GROUP BY` 的关键字。
--
-- `password_hash` 来自 0013（用户名密码登录）。
-- `session_epoch` 来自 0016：session token 的身份版本，创建账号时生成；重建账号
-- 或改密码都会轮换它，让旧 token 立即失效（空串 = 版本未知，永不匹配任何 token）。
CREATE TABLE app_user (
  id            TEXT PRIMARY KEY,
  display_name  TEXT NOT NULL,
  email         TEXT,
  status        TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  password_hash TEXT,
  session_epoch TEXT NOT NULL DEFAULT ''
);

-- 组目录。`owner_user_id` 来自 0014，外键（ON DELETE SET NULL）来自 0018：
-- 删用户是删主体不是删组，组的成员、数据、授权都保留，只是暂时没有 owner。
CREATE TABLE app_group (
  id            TEXT PRIMARY KEY,
  display_name  TEXT NOT NULL,
  description   TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  owner_user_id TEXT REFERENCES app_user(id) ON DELETE SET NULL
);

-- 组成员关系。**不参与授权求值**——ACL 只认 `group:{gid}` 字符串。
-- 外键（ON DELETE CASCADE）来自 0017：级联清理绕过用例的直接删行留下的孤儿关系。
CREATE TABLE group_member (
  group_id TEXT NOT NULL REFERENCES app_group(id) ON DELETE CASCADE,
  user_id  TEXT NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  role     TEXT NOT NULL CHECK (role IN ('owner', 'member')),
  added_at TEXT NOT NULL,
  PRIMARY KEY (group_id, user_id)
);
CREATE INDEX idx_group_member_user ON group_member(user_id);

-- API Key（原 0013）。外键（ON DELETE CASCADE）来自 0017。
CREATE TABLE api_key (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  key_hash   TEXT NOT NULL,
  prefix     TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  revoked_at TEXT
);
CREATE INDEX idx_api_key_user ON api_key(user_id);

-- ── 会话导入游标（原 0011）────────────────────────────────────────────────
CREATE TABLE ingest_cursor (
  harness            TEXT NOT NULL,
  native_session_id  TEXT NOT NULL,
  -- 源系统里的会话 ID → 我们创建的 session URI。重跑时要能找回同一个会话。
  session_uri        TEXT NOT NULL,
  cursor_kind        TEXT NOT NULL,
  cursor_value       TEXT NOT NULL,
  -- 已经导入了多少条消息。用于报告与「为什么这条会话没更新」的排查。
  message_count      INTEGER NOT NULL DEFAULT 0,
  updated_at         TEXT NOT NULL,
  PRIMARY KEY (harness, native_session_id)
);

-- ── 提示词覆盖（原 0012，架构文档 §18.1）──────────────────────────────────
CREATE TABLE prompt_override (
  -- 与 `prompts/{id}.md` 的文件名一致，取值见 `domain/prompt.ts` 的 `PROMPT_IDS`
  prompt_id   TEXT PRIMARY KEY,
  -- 覆盖后的完整模板正文（已规范化，结尾没有多余换行）
  body        TEXT NOT NULL,
  -- 保存时默认模板的摘要（`domain/node.ts` 的 `stableDigest`）
  base_digest TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- ── 嵌入模型元数据（原 0007）──────────────────────────────────────────────
-- 虚拟表 `node_embedding` 的维度建表时固化，而维度来自配置，所以单独一行记
-- 「库里存的是哪个模型、多少维」。启动时比对：不一致就报错提示跑 reindex。
CREATE TABLE embedding_model (
  id         INTEGER PRIMARY KEY CHECK (id = 1),   -- 单行表
  model      TEXT NOT NULL,
  dimension  INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

-- ── 嵌入缓存（原 0015）────────────────────────────────────────────────────
-- **不是索引**，是「这份正文嵌过没有」的跨进程记忆。派生数据：可以随时清空。
-- 缓存不跨模型也不跨维度，`model` 进主键；淘汰按 `created_at` 升序（FIFO）。
CREATE TABLE embedding_cache (
  model          TEXT NOT NULL,   -- 进主键：不同模型的向量不可比，换模型必须全量重算
  content_digest TEXT NOT NULL,   -- 进主键：同一段正文只嵌一次
  vector         BLOB NOT NULL,   -- Float32Array 原始字节
  dimension      INTEGER NOT NULL,  -- 与配置不一致的行当未命中
  created_at     TEXT NOT NULL,   -- 淘汰按它升序（FIFO）
  PRIMARY KEY (model, content_digest)
);
CREATE INDEX idx_embedding_cache_created ON embedding_cache(created_at);

-- ── 节点索引（原 0001 / 0002 / 0003 / 0009 / 0010 合并）──────────────────
-- 检索与 stat 的读模型。
CREATE TABLE node (
  uri            TEXT PRIMARY KEY,
  parent_uri     TEXT NOT NULL,
  scope          TEXT NOT NULL,      -- user | group
  kind           TEXT NOT NULL,      -- directory | document
  context_type   TEXT NOT NULL,      -- memory | resource | skill | session
  memory_type    TEXT,               -- profile | preferences | entities | ...（非记忆文件为 NULL）
  -- 存领域字面量 'L0' | 'L1' | 'L2'：IndexRecord / SearchHit 都按它收发。
  level          TEXT NOT NULL,      -- L0 | L1 | L2
  abstract       TEXT,               -- 原文摘要；node_fts 里存的是切分后的版本
  body_digest    TEXT NOT NULL,      -- 正文摘要，失效传播用（§9.3）
  size           INTEGER NOT NULL,
  updated_at     TEXT NOT NULL,      -- ISO 8601
  status         TEXT NOT NULL,      -- active | pending | archived
  -- 目录摘要的新鲜度（原 0003，§9.3）。只在 kind = 'directory' 的行上有意义。
  summary_baseline TEXT,             -- 当前摘要基于哪份 L0 正文（digest）；NULL = 从未生成
  summary_pending  INTEGER NOT NULL DEFAULT 0,   -- 未消费的变更次数
  summary_entries  INTEGER NOT NULL DEFAULT 0,   -- 生成摘要时的直接子项数
  -- 访问热度（原 0009，热度衰减的输入）。
  access_count     INTEGER NOT NULL DEFAULT 0,
  last_accessed_at TEXT,
  -- 记忆的过期时间（原 0010，§11.7）。NULL = 永不过期；存绝对时刻。
  expires_at       TEXT
);
CREATE INDEX node_parent ON node(parent_uri);
CREATE INDEX node_scope  ON node(scope, context_type);
CREATE INDEX idx_node_last_accessed ON node(last_accessed_at);
-- 部分索引：只收录有过期时间的行。默认配置（memory.ttl.defaultDays = 0）下整张
-- 索引是空的，不为「没人用 TTL」的部署付索引维护成本（§11.7）。
CREATE INDEX idx_node_expires ON node(expires_at) WHERE expires_at IS NOT NULL;

-- 全文检索。content / abstract 存的是「切分后」的文本，不是原文（见中文切分）。
CREATE VIRTUAL TABLE node_fts USING fts5(
  uri UNINDEXED,
  abstract,
  content,
  tokenize = 'unicode61 remove_diacritics 2'
);

-- 物化的有效权限：写入 ACL 时算好，检索时直接查。`effect` 来自原 0004。
CREATE TABLE node_permission (
  node_uri   TEXT NOT NULL,
  principal  TEXT NOT NULL,                      -- user:alice | group:eng | user:*
  level      INTEGER NOT NULL,                   -- 1 read | 3 write | 7 manage
  effect     TEXT NOT NULL DEFAULT 'allow',      -- allow | deny
  PRIMARY KEY (node_uri, principal)
);
CREATE INDEX node_permission_principal ON node_permission(principal, level);

-- 授权反查：谁被授权过什么。
CREATE TABLE acl_entry (
  uri        TEXT NOT NULL,
  principal  TEXT NOT NULL,
  level      INTEGER NOT NULL,
  effect     TEXT NOT NULL,          -- allow | deny
  PRIMARY KEY (uri, principal)
);
CREATE INDEX acl_principal ON acl_entry(principal);

-- ── 运行时任务（原 0001 / 0005 合并）──────────────────────────────────────
CREATE TABLE task (
  id           TEXT PRIMARY KEY,
  type         TEXT NOT NULL,
  status       TEXT NOT NULL,        -- pending | running | done | failed
  payload      TEXT NOT NULL,
  steps_done   TEXT NOT NULL,        -- JSON 数组
  attempts     INTEGER NOT NULL DEFAULT 0,
  lease_until  TEXT,
  error        TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX task_claim ON task(status, lease_until);
CREATE INDEX task_type_status ON task(type, status);
CREATE INDEX task_created ON task(created_at);

-- ── 请求日志（原 0006）────────────────────────────────────────────────────
CREATE TABLE request_log (
  id           TEXT PRIMARY KEY,       -- 行标识（不是 requestId：同一请求重放会写多行）
  request_id   TEXT NOT NULL,          -- §17.7，从 X-Request-Id 读，没有就生成
  method       TEXT NOT NULL,          -- GET | POST | ...
  path         TEXT NOT NULL,          -- 请求路径（示例 JSON 里的 route）
  status_code  INTEGER NOT NULL,       -- HTTP 状态码
  -- 毫秒。用 REAL 而不是 INTEGER：阶段计时是浮点，四舍五入会让
  -- 「四阶段相加等于总耗时」在 0.5ms 容差边界上抖动。
  duration_ms  REAL NOT NULL,
  phases       TEXT,                   -- §17.2 的四阶段，JSON 对象；没有计时时为 NULL
  error_code   TEXT,                   -- §19 的 ComemErrorCode；成功请求为 NULL
  subject      TEXT,                   -- 请求身份（示例 JSON 里的 userId）
  created_at   TEXT NOT NULL           -- ISO 8601；字典序等于时间序
);
CREATE INDEX request_log_created ON request_log(created_at);
CREATE INDEX request_log_status ON request_log(status_code, created_at);
CREATE INDEX request_log_request_id ON request_log(request_id);
CREATE INDEX request_log_subject ON request_log(subject, created_at);
