# 实验迭代记录

## 2026-11-16：Hermes、OpenUI 与 CoMem 历史会话导入

验证新用户能否借助已接入 CoMem 的 Agent 导入旧对话，并在新对话里用上提炼出的记忆。分别通过内置适配器导入合成 Codex 日志、通过网页复制的提示词导入无时间戳的 TXT；两者均进入真实归档与抽取流程。真实模型从 CoMem 取回了 Codex 日志里的约定，并在官方 Hermes Webapp 中边生成边显示 OpenUI 卡片。测试还检查了预览确认、同输入重跑和复核闸门。

[运行条件、核对方法和限制](experiments/1116-hermes-comem-import/report.md)。后续可用其它真实导出格式测解析稳定性；Hermes 自动捕获和召回仍需单独验证。
