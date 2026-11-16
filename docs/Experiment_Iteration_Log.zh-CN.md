# 实验迭代记录

## 2026-11-16：Hermes、OpenUI 与 CoMem 历史会话导入

验证新用户能否借助已接入 CoMem 的 Agent 导入旧对话，并在新对话里用上提炼出的记忆。分别通过内置适配器导入合成 Codex 日志、通过网页复制的提示词导入无时间戳的 TXT；两者均进入真实归档与抽取流程。真实模型从 CoMem 取回了 Codex 日志里的约定，并在官方 Hermes Webapp 中边生成边显示 OpenUI 卡片。测试还检查了预览确认、同输入重跑和复核闸门。

[运行条件、核对方法和限制](experiments/1116-hermes-comem-import/report.md)。后续可用其它真实导出格式测解析稳定性；Hermes 自动捕获和召回仍需单独验证。

## 2026-11-16：记忆整理提示词

用合成反例比较抽取、经验归纳、记忆整理和查询重写。把时间优先级、已验证证据、保留冲突来源写进提示词，并把整理模板接入控制台编辑。DeepSeek V4.1 Flash 的抽取、归纳和重写合计从 12/14 到两轮 14/14；整理从 3/4 到两轮 4/4。见[输入条件、公开参考及结果](experiments/1116-memory-prompts/report.md)。

## 2026-11-16：Hermes 自动记忆

在保持原生记忆和模型相同的两份 Hermes 配置中，验证 CoMem Provider 的自动采集、归档、提炼与跨会话召回。开启配置回忆起测试专用代号，关闭配置回答不知道；没有调用 CoMem MCP。见[步骤与证据](experiments/1116-hermes-comem-import/provider.md)。
