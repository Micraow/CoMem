-- ── 删掉 `request_log` 上三个没有查询用到的索引（架构文档 §17.6）────────────
--
-- `status_code` / `request_id` / `subject` 这三个索引是为「控制台的请求记录页」准备的：
-- 按时间、路由、状态码、用户筛选。那个页面没有实现，服务端也没有 `GET /stats/requests`
-- 之类的读出口，`/metrics` 与 `GET /health` 都不查这张表。
--
-- 代价不在磁盘那几 MB，而在**每一次 HTTP 响应**：写一行 `request_log` 要同步维护四个
-- 索引，这是系统里最热的写路径。为一个不存在的查询付这个代价，就是「为以后可能建的
-- 索引」——§6 明确不做这种预留。
--
-- `request_log_created` 保留：按天数裁剪（`WHERE created_at < ?`）与行数裁剪
-- （`ORDER BY created_at`）都靠它。
--
-- 将来真加 `GET /stats/requests` 时，按那个查询的过滤与排序列**重新**建需要的索引，
-- 不要一次把这三个都建回来；建之前先确认查询真的落到它上面（`EXPLAIN QUERY PLAN`）。

DROP INDEX IF EXISTS request_log_status;
DROP INDEX IF EXISTS request_log_request_id;
DROP INDEX IF EXISTS request_log_subject;
