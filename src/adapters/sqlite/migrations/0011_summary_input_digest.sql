-- ── 目录摘要输入的稳定 digest（架构文档 §9.3）─────────────────────────────
--
-- 非 force 刷新在调用模型前先比较当前目录输入与这里记录的上次生成输入。相同就
-- 消费 pending，不再调用模型。旧行保持 NULL：无法证明现有摘要是由当前输入生成，
-- 因此升级后的第一次非 force 刷新仍会生成一次并建立基线。
ALTER TABLE node ADD COLUMN summary_input_digest TEXT;
