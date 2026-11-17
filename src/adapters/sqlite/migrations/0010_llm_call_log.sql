-- ── LLM 调用日志（架构文档 §17.4、§17.6）────────────────────────────────
--
-- 一行 = 一次逻辑调用，包含 LlmService 的重试。正文、prompt、system message、
-- API Key 与供应商原始错误不进入本表；这里只保存判断用途、成本和失败所需的
-- 结构化字段。
CREATE TABLE llm_call_log (
  id                 TEXT PRIMARY KEY,
  request_id         TEXT,
  session_id         TEXT,
  subject            TEXT,
  purpose            TEXT NOT NULL,
  call_kind          TEXT NOT NULL CHECK (call_kind IN ('text', 'json')),
  model              TEXT NOT NULL,
  status             TEXT NOT NULL CHECK (status IN ('success', 'error')),
  started_at         TEXT NOT NULL,
  ended_at           TEXT NOT NULL,
  duration_ms        REAL NOT NULL,
  prompt_tokens      INTEGER,
  completion_tokens  INTEGER,
  cost_usd           REAL,
  error_code         TEXT,
  attempts           INTEGER NOT NULL
);

-- 最近的调用按主体读取，游标走 (started_at, id) 的稳定倒序。
CREATE INDEX llm_call_log_subject_started
  ON llm_call_log(subject, started_at DESC, id DESC);
-- 行数裁剪与全表时间窗口裁剪共用这条索引。
CREATE INDEX llm_call_log_started
  ON llm_call_log(started_at);
