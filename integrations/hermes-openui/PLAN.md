# Hermes Webapp 流式 OpenUI

目标：和普通文字共存的行内交互卡，在回答结束前可见，完成后仍是同一张卡；滑杆本地更新，显式操作回原会话；刷新能重开完整卡片，中断不能当成功渲染，换会话不串流。优先用 Hermes v0.23.1 公开 SDK 和 OpenUI Lang 1.1，不改 CoMem 或 Hermes 核心。

1. 接宿主：验证 `TRANSCRIPT_DIRECTIVE_AREA`、`message.*` 与存档对齐，固定挂载 ID，确认协议文本不会露到用户界面。无需先实现工具结果版。
2. 接 OpenUI：OpenUI Renderer 增量渲染，示例验证控件和模型动作。原型保留脚本及安装文档，暂不安装到日用 Hermes 或发布。
3. 验收：协议与状态测试、真实 Chromium 验证，然后尝试原版 Hermes Webapp 隔离联调。分别记录替身、实际宿主及真实模型证据。

分工：主 agent 负责设计、公开 API 验证、合并和验收；Comate DeepSeek V4.1 Flash 负责流处理和组件实现。若应用子 agent 发给同模型的工具 schema 被拒，尝试用同一路由以无工具请求委派源码草稿，先审核再应用。
