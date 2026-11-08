-- 0007_embedding.sql —— 节点嵌入向量（架构文档 §8.1 的读模型、§18 的 `retrieval.engine`）
--
-- 与 `node` 表 1:1，但**独立成表**：换模型时要整表清空重建，独立表让这件事是
-- 一条 `DELETE` 而不是「给每行加一堆可空列再挨个判断」。1:1 的关系由 `uri` 主键
-- 表达，不需要额外的关联表。
--
-- **为什么没有外键。** `node_embedding.uri` 逻辑上指向 `node.uri`，但这里不声明
-- `REFERENCES node(uri)`：`node` 的删除走的是 `deleteByUri` 的应用层路径（`node` /
-- `node_fts` / `node_embedding` 三张表同一个事务里按段边界删），加外键会让「先删
-- 哪个」变成一条隐式约定——外键只保证「删 node 时子行不能剩」，剩下来的向量行要么
-- 让删除失败（ON DELETE RESTRICT 的默认行为），要么被级联删掉（ON DELETE CASCADE），
-- 两种都把「删节点」的语义绑到了这里。应用层路径已经保证三张表一致，外键只是把
-- 同一个不变量写两遍，还要靠 `PRAGMA foreign_keys = ON` 才生效。
--
-- 幂等：迁移框架按 `schema_version` 跳过已应用的版本，脚本本身也写成
-- `IF NOT EXISTS`（本地删库重建、并行分支合并后重跑都不会炸）。

CREATE TABLE IF NOT EXISTS node_embedding (
  uri            TEXT PRIMARY KEY,
  -- 嵌入用的模型标识。换模型后旧向量作废，靠它判断。
  model          TEXT NOT NULL,
  -- 向量的原始维度。冗余于 `length(vector)`：BLOB 读出来要先解包才知道长度，
  -- 而「这个模型该是几维」是检索前的第一道判断。
  dimension      INTEGER NOT NULL,
  -- int8 量化后的向量（BLOB）。1/4 体积，检索精度损失可忽略。
  vector         BLOB NOT NULL,
  -- 量化 scale：乘以它还原成浮点
  scale          REAL NOT NULL,
  -- 嵌入的源文本摘要（FNV-1a），用来判断「正文变了要不要重嵌」
  content_digest TEXT NOT NULL,
  created_at     TEXT NOT NULL
);

-- 按模型过滤：换模型后清空（`deleteByModel`）与「还有哪些节点没嵌入」（回填）。
-- 索引名与其它迁移同一套约定（`node_parent` / `task_claim` / `request_log_created`），
-- 不加 `idx_` 前缀。
CREATE INDEX IF NOT EXISTS node_embedding_model ON node_embedding(model);
