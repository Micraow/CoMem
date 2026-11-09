-- ── 一个 URI 最多两行：目录的 L0 摘要行与 L1 概览行（架构文档 §8.5、§8.6）────
--
-- 索引行原来以 `uri` 为主键，等于假设「一个节点只有一行」。三层摘要落地之后这个
-- 假设不成立：目录的可检索文本有两段——L0 摘要（一句话，`abstract` 列）与 L1 概览
-- （`overviewMaxChars` 的正文，`content` 列）。两段文本的信噪比不同，必须各自成为
-- 一条 FTS 行，`bm25 × levelWeight` 的层级权重才有作用对象（§8.5 的 L1 = 1.05
-- 在此之前没有任何行可乘）。
--
-- 新的主键是 `(uri, level)`：
--
-- | 节点 | level | abstract | content |
-- |---|---|---|---|
-- | 文件 | L2 | frontmatter 摘要 | 正文 |
-- | 目录自身 | L0 | L0 摘要 | 空 |
-- | 目录概览 | L1 | L0 摘要（展示用，与 L0 行相同） | L1 概览正文 |
--
-- 「节点自身那一行」= `NOT (kind = 'directory' AND level = 'L1')`。按 URI 读一个节点（`get` / `children` /
-- `stat` / 计数 / TTL）必须带上这条谓词，否则一个目录会变成两条节点；各仓储调用
-- `node-repository.ts` 的 `nodeSelfRowSql()`。`services/observability.ts` 另存一份
-- 同名常量（`services/` 不能 import `adapters/` 的值，架构文档 §4.2），两份由
-- `tests/integration/sqlite/node-self-row-consistency.test.ts` 对拍。
--
-- `node_fts` 也要跟着加 `level`：它原来只靠 `uri` 与 `node` 关联，一个 URI 两行时
-- 两行会互相 join 成四条。`level` 同样是 `UNINDEXED`——它只用于对齐，不参与匹配。
--
-- 重建方式按 SQLite 官方的「新表 + INSERT ... SELECT + DROP + RENAME」：`ALTER
-- TABLE` 改不了主键。`runMigrations` 已经在事务外关掉外键强制（`database.ts` 的
-- `withForeignKeysDisabled`），`node_permission` / `acl_entry` 也没有指向 `node`
-- 的外键，所以 DROP 不会级联删掉任何行。

CREATE TABLE node_level_rows (
  uri            TEXT NOT NULL,
  parent_uri     TEXT NOT NULL,
  scope          TEXT NOT NULL,      -- user | group
  kind           TEXT NOT NULL,      -- directory | document
  context_type   TEXT NOT NULL,      -- memory | resource | skill | session
  memory_type    TEXT,               -- profile | preferences | entities | ...（非记忆文件为 NULL）
  -- 这一行自己的层级：文件 L2；目录两行分别是 L0（摘要）与 L1（概览）
  level          TEXT NOT NULL,      -- L0 | L1 | L2
  abstract       TEXT,               -- 原文摘要；node_fts 里存的是切分后的版本
  body_digest    TEXT NOT NULL,      -- 正文摘要，失效传播用（§9.3）
  size           INTEGER NOT NULL,
  updated_at     TEXT NOT NULL,      -- ISO 8601
  status         TEXT NOT NULL,      -- active | pending | archived
  -- 目录摘要的新鲜度（§9.3）。只在目录的 L0 行上有意义
  summary_baseline TEXT,
  summary_pending  INTEGER NOT NULL DEFAULT 0,
  summary_entries  INTEGER NOT NULL DEFAULT 0,
  -- 访问热度（§11.7 的热度衰减输入）
  access_count     INTEGER NOT NULL DEFAULT 0,
  last_accessed_at TEXT,
  -- 记忆的过期时间。NULL = 永不过期；存绝对时刻（§11.7）
  expires_at     TEXT,
  -- TTL 清扫第一段的归档时刻（0002）
  archived_at    TEXT,
  PRIMARY KEY (uri, level)
);

INSERT INTO node_level_rows (
  uri, parent_uri, scope, kind, context_type, memory_type, level, abstract,
  body_digest, size, updated_at, status, summary_baseline, summary_pending,
  summary_entries, access_count, last_accessed_at, expires_at, archived_at
)
SELECT
  uri, parent_uri, scope, kind, context_type, memory_type, level, abstract,
  body_digest, size, updated_at, status, summary_baseline, summary_pending,
  summary_entries, access_count, last_accessed_at, expires_at, archived_at
FROM node;

DROP TABLE node;
ALTER TABLE node_level_rows RENAME TO node;

CREATE INDEX node_parent ON node(parent_uri);
CREATE INDEX node_scope  ON node(scope, context_type);
CREATE INDEX idx_node_last_accessed ON node(last_accessed_at);
-- 部分索引：只收录有过期时间的行（§11.7）
CREATE INDEX idx_node_expires ON node(expires_at) WHERE expires_at IS NOT NULL;
-- 第二段清扫按「已归档且归档时刻早于某个截止」找候选（0002）
CREATE INDEX idx_node_archived ON node(archived_at) WHERE status = 'archived';

-- `node_fts` 加 `level`，并保留已有的切分文本。
--
-- 旧行的 `abstract` / `content` 是**已经切分过**的中文（§8.1「中文必须单字切分」），
-- 直接丢掉重建会让所有存量节点在 `reindex` 之前搜不到中文——所以走一张普通表把
-- 旧数据搬过去，而不是从 `node.abstract` 重新切分。
CREATE TABLE node_fts_backup AS SELECT uri, abstract, content FROM node_fts;
DROP TABLE node_fts;
CREATE VIRTUAL TABLE node_fts USING fts5(
  uri UNINDEXED,
  level UNINDEXED,
  abstract,
  content,
  tokenize = 'unicode61 remove_diacritics 2'
);
INSERT INTO node_fts (uri, level, abstract, content)
  SELECT b.uri, n.level, b.abstract, b.content
    FROM node_fts_backup b
    JOIN node n ON n.uri = b.uri;
DROP TABLE node_fts_backup;
