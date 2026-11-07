-- 0006_request_log.sql —— 请求记录（架构文档 §17.6、§17.7）
--
-- 每个 HTTP 请求一行。§17.6 的示例 JSON 是**控制台要展示的字段**，不是 DDL：
-- 示例里的 `at` / `route` / `status` / `userId` 在这里分别落成 `created_at` /
-- `path` / `status_code` / `subject`（列名用 snake_case，与其它表一致）。
-- 示例里的 `ttfbMs` / `responseBytes` 没有进表：v1 的 JSON 响应 TTFB 与总耗时相等
-- （§17.3），响应字节数没有查询方；等 MCP 的 SSE 流式接口落地再补，不为不存在的
-- 读路径预埋列。
--
-- 为什么用 SQLite 不用日志文件（§17.6）：控制台要按时间、路由、状态码、用户筛选，
-- `grep` 做不到。索引服务这几条查询，`error.log` 只留排障用的一行 JSON。
--
-- 保留策略（§17.6）：默认 7 天或 10 万条，先到先删。两条规则都由
-- `RequestLogRepository.prune` 在同一个事务里执行。
--
-- 幂等：迁移框架按 `schema_version` 跳过已应用的版本，脚本本身也写成
-- `IF NOT EXISTS`（本地删库重建、并行分支合并后重跑都不会炸）。

CREATE TABLE IF NOT EXISTS request_log (
  id           TEXT PRIMARY KEY,       -- 行标识（不是 requestId：同一请求重放会写多行）
  request_id   TEXT NOT NULL,          -- §17.7，从 X-Request-Id 读，没有就生成
  method       TEXT NOT NULL,          -- GET | POST | ...
  path         TEXT NOT NULL,          -- 请求路径（示例 JSON 里的 route）
  status_code  INTEGER NOT NULL,       -- HTTP 状态码
  -- 毫秒。用 REAL 而不是 INTEGER：阶段计时是浮点，四舍五入到整数会让
  -- 「四阶段相加等于总耗时」在 0.5ms 容差边界上抖动。
  duration_ms  REAL NOT NULL,
  phases       TEXT,                   -- §17.2 的四阶段，JSON 对象；没有计时时为 NULL
  error_code   TEXT,                   -- §19 的 ComemErrorCode；成功请求为 NULL
  subject      TEXT,                   -- 请求身份（示例 JSON 里的 userId）
  created_at   TEXT NOT NULL           -- ISO 8601；字典序等于时间序
);

-- 列表页：按时间倒序分页（§17.10 的监控页）。
CREATE INDEX IF NOT EXISTS request_log_created ON request_log(created_at);

-- 错误筛选与状态码分布：`status_code >= 400 OR error_code IS NOT NULL`。
CREATE INDEX IF NOT EXISTS request_log_status ON request_log(status_code, created_at);

-- §17.7「哪个请求触发的」：按 requestId 反查一次请求的全部记录。
CREATE INDEX IF NOT EXISTS request_log_request_id ON request_log(request_id);

-- 按用户筛选（§17.6：「按时间、路由、状态码、用户筛选」）。
CREATE INDEX IF NOT EXISTS request_log_subject ON request_log(subject, created_at);
