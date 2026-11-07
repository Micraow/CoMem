-- 0002_index.sql —— 索引与检索的完整 schema（架构文档 §8.1、§8.2）
--
-- 五张表是同一份设计（节点读模型 + 全文索引 + 物化权限 + 授权反查 + 运行时任务），
-- 拆成多个迁移只会制造「谁先建」的假耦合：检索 SQL 一次 JOIN 到 node / node_fts /
-- node_permission，任何一张迟到都会让这段 SQL 无法落地。
--
-- 幂等：runMigrations 按版本号跳过已应用的脚本，但脚本本身也要能重放
-- （本地删库重建、并行分支合并后重跑），所以一律 IF NOT EXISTS。
--
-- 重要：node_fts.abstract / node_fts.content 存的是 domain/text.ts 的 segmentCjk()
-- 处理之后的文本，不是原文。CJK 连续字在 unicode61 下是单个巨型 token，不切分就
-- 查不到双字词（§8.1 的实测表）。原文在磁盘上：read 走文件系统，snippet() 也不用
-- 这两列——检索只返回 node 表里的 uri / level / abstract。

-- 节点索引：检索与 stat 的读模型。一行对应磁盘上一个文件或目录。
CREATE TABLE IF NOT EXISTS node (
  uri            TEXT PRIMARY KEY,
  parent_uri     TEXT NOT NULL,
  scope          TEXT NOT NULL,      -- user | group
  kind           TEXT NOT NULL,      -- directory | document
  context_type   TEXT NOT NULL,      -- memory | resource | skill | session
  memory_type    TEXT,               -- profile | preferences | entities | ...（非记忆文件为 NULL）
  -- §8.1 写的是 INTEGER 0 | 1 | 2，但冻结的领域契约（domain/level.ts 的 Level）是
  -- 'L0' | 'L1' | 'L2'，IndexRecord / SearchHit 都按后者收发。存领域字面量可以省掉一层
  -- 有损映射，排序与过滤也仍然正确（同层级字符串相等，IN 过滤照常走索引）。
  level          TEXT NOT NULL,      -- L0 | L1 | L2
  abstract       TEXT,               -- 原文摘要；node_fts 里存的是切分后的版本
  body_digest    TEXT NOT NULL,      -- 正文摘要，失效传播用（§9.3）
  size           INTEGER NOT NULL,
  updated_at     TEXT NOT NULL,      -- ISO 8601
  status         TEXT NOT NULL       -- active | pending | archived
);
CREATE INDEX IF NOT EXISTS node_parent ON node(parent_uri);
CREATE INDEX IF NOT EXISTS node_scope  ON node(scope, context_type);

-- 全文检索：实际匹配的是 abstract + content 两列。
-- unicode61 的处理顺序是「先按类别切词，再去变音符号」，remove_diacritics 2 让
-- café 与 cafe 互相命中；CJK 的单字切分在写入前由 segmentCjk() 完成，不依赖
-- tokenizer 本身。
CREATE VIRTUAL TABLE IF NOT EXISTS node_fts USING fts5(
  uri UNINDEXED,
  abstract,
  content,
  tokenize = 'unicode61 remove_diacritics 2'
);

-- 物化的有效权限：写 ACL 时算好，检索时是一个普通 EXISTS 子查询（§8.2）。
-- 不存 deny 行：deny 在物化阶段已经把结果清空，读侧只需要「级别 >= read」。
CREATE TABLE IF NOT EXISTS node_permission (
  node_uri   TEXT NOT NULL,
  principal  TEXT NOT NULL,          -- user:alice | group:eng | user:*
  level      INTEGER NOT NULL,       -- 1 read | 3 write | 7 manage（§12.1）
  PRIMARY KEY (node_uri, principal)
);
-- 覆盖 readableUris 的两条等值条件（node_uri IN (...) + principal IN (...)），
-- 顺带给「某个主体被授权过什么」的反查留一条走索引的路径。
CREATE INDEX IF NOT EXISTS node_permission_principal ON node_permission(principal, level);

-- 授权反查：谁被授权过什么。原始 ACL 条目，物化前的真相。
CREATE TABLE IF NOT EXISTS acl_entry (
  uri        TEXT NOT NULL,
  principal  TEXT NOT NULL,
  level      INTEGER NOT NULL,
  effect     TEXT NOT NULL,          -- allow | deny
  PRIMARY KEY (uri, principal)
);
CREATE INDEX IF NOT EXISTS acl_principal ON acl_entry(principal);

-- 运行时任务（§10.4 任务恢复、§18 租约）。W3 只建表，状态机由 W5 落地。
CREATE TABLE IF NOT EXISTS task (
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
-- 领取任务：找 status = 'pending' 或租约过期的 running 行（§18 task.leaseSeconds）。
CREATE INDEX IF NOT EXISTS task_claim ON task(status, lease_until);
