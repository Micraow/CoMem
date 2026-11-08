-- 记忆之间的关联数据（架构文档 §11.10）。
--
-- `links` 是**索引/关联数据**，不是记忆正文：它不进 `node_fts`、不参与 `find`，
-- 也不展开邻居。这里只解决两件事——存下单向边、按 `to_uri` 反查 `backlinks`。
--
-- 为什么放 SQLite 而不是记忆 frontmatter：`backlinks` 是反查（`WHERE to_uri = ?`），
-- 一条索引就是一次查询；放进 frontmatter 就得扫全库记忆文件才能回答「谁指向我」。

CREATE TABLE memory_link (
  -- 边的起点。必须是已存在的记忆 URI（不做外键约束：记忆正文在文件系统里，
  -- 不在本库，跨存储外键无从校验；悬空边由写入方负责，读时容忍）。
  from_uri     TEXT NOT NULL,
  -- 边的终点。同上。
  to_uri       TEXT NOT NULL,
  -- 边的语义标签，如 'references' / 'derived_from' / 'related'。
  link_type    TEXT NOT NULL,
  -- 关联强度；重复写入时取 max，不累加（见 §11.10「去重」）。
  weight       REAL NOT NULL DEFAULT 1.0,
  -- 触发这条链接的原文片段（溯源用）。空串表示「没有具体出处」。
  -- 不用 NULL：NULL 在唯一索引里互不相等，会让同一条裸链接反复插入。
  match_text   TEXT NOT NULL DEFAULT '',
  -- 人/模型给出的一句话说明。
  description  TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL,     -- ISO 8601
  updated_at   TEXT NOT NULL      -- ISO 8601；weight 被 max 抬高时刷新
);

-- 去重键：同一起点 + 同一终点 + 同一出处视为同一条边（与参考实现的 url+to+match_text
-- 一致）。撞键时由写入方把 weight 取 max 更新，而不是新增一行。
CREATE UNIQUE INDEX memory_link_unique ON memory_link(from_uri, to_uri, match_text);

-- 反查 backlinks 的主索引：给一个 to_uri，列出所有指向它的边。
CREATE INDEX memory_link_to ON memory_link(to_uri);

-- 正向查询：给一个 from_uri，列出它指向的所有边。
CREATE INDEX memory_link_from ON memory_link(from_uri);
