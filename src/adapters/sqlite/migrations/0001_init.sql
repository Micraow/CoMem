-- 0001_init.sql —— P1 骨架
-- 只建版本表。业务表由后续 wave 各自的迁移建（架构文档 §8.1），
-- 不在这里预埋，以免「表结构」和「引入它的 wave」两处真相。

CREATE TABLE IF NOT EXISTS schema_version (
  version    INTEGER PRIMARY KEY,
  applied_at TEXT    NOT NULL
);
