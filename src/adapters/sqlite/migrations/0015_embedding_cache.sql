-- 0015_embedding_cache.sql —— 嵌入结果的跨进程缓存（架构文档 §8.1）。
--
-- ## 为什么需要它
--
-- `node_embedding` 按 URI 去重（「这个节点已经是最新的向量了吗」），不按正文去重：
--
--   - 同一段正文出现在两个 URI 下（复制一份记忆、同一份规则挂在两个项目里）会被
--     嵌入两次；
--   - `pnpm eval` 每次用全新的临时数据根，52 篇语料 + 105 条查询每次都重嵌；
--   - 换模型后要全量重算时，没有任何可复用的结果。
--
-- 这张表按 `(model, content_digest)` 去重：嵌入一次，所有持有同一份正文的节点共用。
--
-- ## 为什么 `model` 进主键
--
-- 不同模型的向量空间不可比。`node_embedding` 已经有「换模型后旧行按 `model = ?`
-- 过滤」的语义，这里保持一致：主键里带 `model`，换模型时旧行自然全部未命中，不需要
-- 任何清理动作。跨模型复用会把两个空间的向量混在一起，余弦相似度全是噪音。
--
-- ## 为什么 `dimension` 单独一列
--
-- 主键是 `(model, content_digest)`，模型名没变但维度改了（同一个模型名下换量化版本、
-- 或者配置写错了维度）时，主键仍然命中，而向量长度已经对不上。读路径比对
-- `dimension` 与当前配置，不一致就当未命中并记 warn（见 `EmbeddingCacheRepository`）。
--
-- ## 为什么 `vector` 是裸 BLOB 而不是 `vec0` 虚拟表
--
-- 缓存的用途是「把供应商返回的向量原样取回来」，不做 KNN 检索——最近的邻居是
-- `node_embedding` 的职责。用 `vec0` 要按维度建表，而维度是配置项；缓存却是跨维度
-- 失效的（见上一段），一个静态表能同时容纳两种维度的行，正好让「维度变了」可诊断
-- 而不是建表时静默失败。存的是 `Float32Array` 的原始字节，与 `node_embedding` 的
-- BLOB 表示相同。
--
-- ## 为什么不是 `WITHOUT ROWID`
--
-- 淘汰（`DELETE ... WHERE rowid IN (SELECT rowid ... ORDER BY created_at LIMIT n)`）
-- 要按 rowid 定位。`WITHOUT ROWID` 表没有 rowid，退化成按复合主键删，子查询要
-- 重新拼两列。
--
-- ## 派生数据
--
-- 这张表可以随时清空：清空之后所有嵌入重新打供应商，结果与清空前逐位一致（同样的
-- 模型、同样的正文）。读失败 / 写失败一律降级成「没命中」，生产写入路径不受影响
-- （§7：文件是真相，索引是派生）。
--
-- ## 幂等
--
-- 迁移框架按 `schema_version` 跳过已应用的版本；脚本本身写成 `IF NOT EXISTS`，
-- 本地删库重建、并行分支合并后重跑都不会炸。

CREATE TABLE IF NOT EXISTS embedding_cache (
  -- 模型标识。进主键：不同模型的向量不可比，换模型必须全量重算。
  model          TEXT NOT NULL,
  -- 正文摘要（FNV-1a，与 `node.body_digest` 同一套）。进主键：同一份正文只嵌一次。
  content_digest TEXT NOT NULL,
  -- `Float32Array` 的原始字节。读取时按 `dimension` 解释。
  vector         BLOB NOT NULL,
  -- 向量长度。与当前配置不一致的行当未命中（见文件头）。
  dimension      INTEGER NOT NULL,
  -- 插入时刻。淘汰按它升序（FIFO），不按命中刷新——见 `EmbeddingCacheRepository`。
  created_at     TEXT NOT NULL,
  PRIMARY KEY (model, content_digest)
);

-- 淘汰按 `created_at` 升序取最旧的若干行。没有这条索引时，每次淘汰都要全表扫 +
-- 排序；有了它，`ORDER BY created_at LIMIT n` 是索引前缀扫描。rowid 是任何索引的
-- 隐含末列，`created_at` 相同（同一毫秒批量插入）时的 tie-break 也走索引。
CREATE INDEX IF NOT EXISTS idx_embedding_cache_created ON embedding_cache(created_at);
