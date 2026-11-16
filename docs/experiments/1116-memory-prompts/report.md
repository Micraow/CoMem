# 记忆提示词质量实验

2026-11-16，在 `codex/hermes-openui` 分支上比较修改前后的抽取、经验归纳、记忆整理与查询重写提示词。目标不是让模型写得更长，而是减少错误长期记忆、旧导入覆盖新事实、把猜测写成经验、在冲突未决时误删来源，以及漏掉依赖历史参数的查询。

## 改动

- 抽取增加四项写入检查：未来有用、确有新增、可独立理解、证据允许。旧聊天晚导入时按消息时间判断新旧；用户明确说不要记时保持空操作；助手标题式复述和未确认猜测不能成为用户事实。
- 经验归纳只接收已经观察到的通过、失败、复现和回滚。未验证根因只能写排查边界，不能写成结论；较旧的验证不能覆盖较新的做法，临时环境限制必须进入前提。
- 记忆整理必须先读正文，只合并能证明属于同一对象、同一属性的条目；按来源时间解决当前值冲突，无法确定先后时保留适用范围和冲突双方；内容冲突尚未解决时不能删除。
- 查询重写区分普通动作和依赖历史参数的动作。「重新跑测试」不检索，「按我以前的方式部署」必须检索；人名、项目名、命令和文件名不做近义替换。

依据来自以下公开、可复查的主提示词或规范：

- [Mem0 memory triage（固定提交）](https://github.com/mem0ai/mem0/blob/2c796d144f67e955e4253a762dabe8936f8a1772/integrations/openclaw/skills/memory-triage/SKILL.md)：四项写入闸门，以及临时约束不覆盖长期偏好；可执行 `future utility / novelty / factual / safe` 判断。
- [Hindsight consolidation prompt（固定提交）](https://github.com/vectorize-io/hindsight/blob/6d9edd0d852c1a8f4161b302ce0ade4c83edd643/hindsight-api-slim/hindsight_api/engine/consolidation/prompts.py)：导入顺序不等于事实时间，旧事实不能覆盖后来更正；区分 repeating、changing、ending，禁止无依据计算。
- [OpenViking memory consolidation（固定提交）](https://github.com/volcengine/OpenViking/blob/1105f96ead8cf5aa62e07f019ceb32b2063de53b/docs/en/context-compilation/06-memory-consolidation.md)：保守合并、事实不丢失、不编造、同身份才合并；目标冲突时报冲突并保留双方独有事实。

## A/B 结果

使用本机 OpenAI 兼容网关的实际模型 `comate/600085158/deepseek/deepseek-v4.1-flash//public`，请求无需认证，输入全部是合成材料，没有使用个人聊天数据。提示词输入的今天固定为 `2026-11-16`。14 项检查覆盖抽取、经验与重写：

| 版本 | 通过 | 失败 |
|---|---:|---|
| 修改前 | 12/14 | 漏记“未来六周搬不了相册”的临时限制；用户否定猜测后生成了一条关于模型抽取策略的伪规则 |
| 修改后第一次 | 14/14 | — |
| 修改后第二次 | 14/14 | — |

关键合成案例：

- 用户把项目代号从 `雨燕-73` 改成 `雨燕-74`，同时声明未来六周骨折限制。旧提示词只改代号；新提示词更新当前代号，并保留每周六整理、原片和 EXIF 这些未撤销要求，同时把六周限制写成带时间的临时事件。
- 用户说 Vitest「也许不错、还没决定」，助手复述成偏好，用户随后说「别记那个结论」。旧提示词写了一条“不得记录未确认结论”的元规则；新提示词输出空操作。
- 2024-03-02 的旧聊天在已有 `2026-11-15` 新偏好之后导入。两个版本都没有用旧聊天的两空格、中文提交信息覆盖当前新事实；新提示词把这一时间规则写成了明确契约。
- 用户只说登录超时“先猜 Redis”，尚未复现或修改。两个版本都没有产出经验。已复现的 SQL 连接池耗尽、5 调到 20 后回归通过，则都保留为可用经验。
- 「按我以前的方式部署一下」在两个版本都能生成 procedure 查询；「重新跑测试」均保持空查询。新提示词补上了可断言的边界，避免以后只写“纯指令为空”。

自动检查只判断上述关键事实是否出现、禁止的猜测与注入是否消失。它不是通用记忆质量分数，也不判断改写是否比原句更优雅。

### 记忆整理 A/B

记忆整理使用同一模型和四个独立反例。旧版是合并前写死在 TypeScript 里的系统提示词；新版来自 `prompts/consolidation-system.md` 与 `prompts/consolidation-user.md`，通过控制台同一套模板覆盖机制渲染。

| 版本 | 通过 | 失败 |
|---|---:|---|
| 修改前 | 3/4 | 未决冲突被合并成一条并删除另一个来源 |
| 修改后第一次 | 4/4 | — |
| 修改后第二次 | 4/4 | — |

| 案例 | 通过条件 | 修改前 | 修改后 |
|---|---|---|---|
| 名称相近但对象不同 | `git-remote` 与 `git-remote-signing` 都不改、不删 | 通过 | 通过 |
| 新值替换当前状态 | Frankfurt 成为当前值，同时保留 2025 年 Singapore 历史和 2026-12-31 前的只读归档限制 | 通过 | 通过 |
| 来源同时、权威不明的冲突 | 发布窗口存在冲突时保留来源，不删除任一条 | **失败**：删除运维来源并把两值拼入一条 | 通过：输出空操作 |
| 正文完全相同的副本 | 只删除一个副本，理由指出正文完全相同 | 通过 | 通过 |

身份相近和时间替换案例在改动前后都通过，说明新提示词没有以牺牲正常收敛为代价换取“少删”。精确重复项允许只输出一条带理由的删除；“合并”不强制产生无意义的 update。

## 复跑与验证

浏览器、模型和原始输出位于忽略目录 `local/memory-prompts/`。测试脚本围绕现有 `buildExtractPrompt`、`buildExperiencePrompt`、`buildRewriteUserPrompt`，调用本机 `/v1/chat/completions`。仓库检查：

```bash
pnpm exec vitest run tests/unit/domain/prompt.test.ts tests/unit/services/prompts tests/unit/services/llm.test.ts
pnpm exec eslint tests/unit/services/prompts/memory-quality.test.ts
pnpm exec tsx local/memory-prompts/consolidation-eval.ts baseline
pnpm exec tsx local/memory-prompts/consolidation-eval.ts candidate
```

结果为目标测试文件全部通过。提示词快照已显式更新，另加四个契约测试，防止旧导入时间、猜测边界、依赖历史参数的查询和未决冲突删除规则被无意删掉。手动整理提示词另有集成测试，证明控制台保存的覆盖会进入真实的 `ConsolidationService` 模型调用。

## 限制

评测只有一个模型，候选各跑两轮，样本都是短合成对话。结果能证明提示词在这些反例上更好，不能证明所有真实长会话都变好。需要继续观察多事实长会话、互相矛盾的多个导入来源和用户长期纠错；模型输出的一个 +32 时间值、额外事件等冗余仍应通过服务端 schema 与真实产品指标发现。此次没有测摘要模板；记忆整理只覆盖四个关键决策，没有验收大规模整库合并的吞吐、成本和误删率。
