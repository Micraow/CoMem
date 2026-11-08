-- 0012_prompt.sql —— 提示词的数据库覆盖（架构文档 §9.2、§11.3、§18）
--
-- **为什么覆盖存数据库、默认值存仓库文件。** 默认模板是代码的一部分：要 review、
-- 要 diff、要跟版本走。但「让服务端去改仓库里的 `.md`」在容器只读挂载、多副本
-- 部署、`git status` 被污染这三种场景下都出问题。所以优先级是
-- **仓库默认 < 数据库覆盖**，恢复默认 = 删掉这一行。
--
-- **为什么 `base_digest` 要存。** 保存覆盖时记下当时默认模板的摘要。换版本后
-- 仓库默认值变了，这个摘要就对不上——界面据此显示「默认值已更新，你的覆盖基于
-- 旧版本」。不存它的话，用户的覆盖会**静默盖住**新的默认值，而唯一的证据是
-- 「模型表现变了」这种事后也无法归因的现象。
--
-- **为什么没有 `created_at`。** 覆盖只有一条当前值，没有历史；`updated_at` 回答
-- 「最后一次改是什么时候」，这已经是界面需要的全部。保留 `created_at` 等于承诺
-- 一个没有任何读取方的字段（`pnpm check:config` 的 L1 规则反对的正是这一类）。
--
-- 幂等：迁移框架按 `schema_version` 跳过已应用的版本；`CREATE TABLE IF NOT EXISTS`
-- 让脚本本身也能重放（本地删库重建、并行分支合并后重跑）。
CREATE TABLE IF NOT EXISTS prompt_override (
  -- 与 `prompts/{id}.md` 的文件名一致，取值见 `domain/prompt.ts` 的 `PROMPT_IDS`
  prompt_id   TEXT PRIMARY KEY,
  -- 覆盖后的完整模板正文（已规范化，结尾没有多余换行）
  body        TEXT NOT NULL,
  -- 保存时默认模板的摘要（`domain/node.ts` 的 `stableDigest`）
  base_digest TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
