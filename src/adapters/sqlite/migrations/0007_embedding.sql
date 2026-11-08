-- 0007_embedding.sql —— 向量表使用的模型与维度（架构文档 §8.1 的读模型、§18 的
-- `retrieval.engine`）。
--
-- 嵌入向量本身不在迁移里建表：实际存储是 `sqlite-vec` 的 `vec0` 虚拟表
-- （`node_embedding`），而 `vec0` 的维度在 `CREATE VIRTUAL TABLE` 时固定
-- （`FLOAT[1024]`）。维度来自 `providers.embedding.dimension`，换模型就会变；
-- 写死在静态 SQL 里会让「换模型」变成「静默跳过所有行」——语义检索永久返回空，
-- 而且不报错。所以虚拟表由 `EmbeddingRepository.ensureSchema` 在启动时按配置建，
-- 迁移只建这张记录「库里的向量属于哪个模型、几维」的单行表。
--
-- 启动时比对这张表与配置，不一致抛 `CONFLICT` 并提示跑
-- `reindex --only=embeddings` 重建。
--
-- 幂等：迁移框架按 `schema_version` 跳过已应用的版本，脚本本身也写成
-- `IF NOT EXISTS`（本地删库重建、并行分支合并后重跑都不会炸）。

CREATE TABLE IF NOT EXISTS embedding_model (
  id         INTEGER PRIMARY KEY CHECK (id = 1),   -- 单行表
  -- 嵌入使用的模型标识。换模型后旧向量作废，靠它判断。
  model      TEXT NOT NULL,
  -- 虚拟表的维度。`vec0` 在 `CREATE` 时固化，改配置只能整表重建。
  dimension  INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
