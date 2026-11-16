# Hermes Webapp 流式 OpenUI

目标：和普通文字共存的行内交互卡，从回答进行中一直可见到完成；控件本地更新，显式操作回原会话；刷新能重开完整卡片，中断不能当成功渲染，换会话不串流。使用 Hermes v0.23.1 公开 SDK 和 OpenUI Lang 1.1。按用户实际看到的连续性验收，允许 Hermes 在完成时替换底层节点；无需修改宿主。

1. 接宿主：验证 `TRANSCRIPT_DIRECTIVE_AREA`、`message.*` 与存档对齐，固定挂载 ID，确认协议文本不会露到用户界面。无需先实现工具结果版。
2. 接 OpenUI：OpenUI Renderer 增量渲染，示例验证控件和模型动作。原型保留脚本及安装文档，暂不安装到日用 Hermes 或发布。
3. 验收：协议与状态测试、真实 Chromium 验证，然后尝试原版 Hermes Webapp 隔离联调。分别记录替身、实际宿主及真实模型证据。

分工：主 agent 负责设计、公开 API 验证、合并和验收；Comate DeepSeek V4.1 Flash 负责流处理和组件实现。若应用子 agent 发给同模型的工具 schema 被拒，尝试用同一路由以无工具请求委派源码草稿，先审核再应用。

验收记录（2026-11-16）：

- 原版 Hermes v0.23.1 + 测试模型：卡片先于结束标记出现；标题在 411 个浏览器采样帧中持续可见。宿主替换了原节点，卡片仍可操作。刷新、会话切换、回原会话的追问及中断均通过。
- 真实 Comate DeepSeek V4.1 Flash + 同一版本 Webapp：独立生成了可本地切换的证据简报；在提问提供照片和位置来源时，生成了带署名照片和可切换地点的地图。Chrome 实际解码了照片并收到 OpenStreetMap 瓦片。未测模型自动搜图或路线规划。
- 完整组件库移植后，26 项 Node 测试、4 项 Python Query 桥接测试、8 项 Chromium 测试通过。原版 Webapp 再次通过增量、局部控件、刷新恢复、追问、换会话、中断和真实回环查询；卡片标题在 408 个采样帧中持续可见，宿主替换了底层节点。构建产物 `plugin.js` 为 3,186,168 字节，MapLibre worker 为 508,314 字节。见 [PARITY.md](docs/PARITY.md)。
- 完整新版在独立的 Comate DeepSeek V4.1 Flash 会话中也生成了交互式卡片，内容来自 CoMem 自动召回。见 [联合验收](../../docs/experiments/1116-hermes-comem-import/provider.md)。
