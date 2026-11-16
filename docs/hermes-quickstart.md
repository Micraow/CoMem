# 在 Hermes 使用 CoMem

Hermes 负责聊天和执行工具，CoMem 负责记忆。先接上自动记忆；需要让 Agent 导入旧对话时再加 MCP，想要网页里的交互卡片时再加 OpenUI。三项可以独立使用。

## 1. 准备一个能提炼记忆的 CoMem

按 [CoMem 快速开始](../README.md#-快速开始) 启动服务、打开控制台并登录。在「设置」确认已配置可调用的生成模型；未配置时 CoMem 仍会保存原始对话，但不会提炼记忆。记下 **Hermes 主机能访问的 CoMem 地址**：`pnpm dev` 默认用 `http://127.0.0.1:1933`，Docker Compose 默认用 `http://127.0.0.1:18080`。如果 Hermes 和 CoMem 不在同一台机器，使用 CoMem 在 Hermes 主机上可达的地址。

Docker 或关闭回环信任时，在 CoMem「用户与组」中为自己的账号创建 API Key。后续两处连接都用这个账号；如果服务记到另一个人的空间，当前页面看不到那些会话。

## 2. 装上自动记忆

需要官方 Hermes Agent v0.23.1。先在 CoMem 仓库根目录执行：

```sh
export HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"
mkdir -p "$HERMES_HOME/plugins"
ln -s "$PWD/integrations/hermes-memory" "$HERMES_HOME/plugins/comem"
hermes memory setup
hermes memory status
```

如果使用 Hermes 命名配置，请把 `HERMES_HOME` 指向该配置的目录。选择 **CoMem**，填前一步的服务地址（可以带 `/api/v1`）；需要认证时填 API Key。也可参照 [Memory Provider 的配置说明](../integrations/hermes-memory/README.md) 手动写入当前配置。`memory.provider` 同一时间只能选择一个外部提供方；选择 CoMem 后，Hermes 自己的 `MEMORY.md` 和 `USER.md` 仍可用。

重启**当前配置的** Hermes 网关，打开新会话。告诉它一条值得长期保留的偏好，例如「我的每周读书笔记标题固定用『纸舟』」。在 CoMem「接入 Agent → Hermes」检查会话到达，在「会话与任务」看归档，处理「记忆复核」里需要确认的内容。最后重新开一场新对话，问「我通常给每周读书笔记起什么标题？」。配置状态、会话归档和实际召回是三项不同的检查。

## 3. 把已经积累的对话带过来（可选）

导入由能够读取你文件的 Agent 执行。可以用同一个 Hermes，也可以用 Codex 等接入了同一 CoMem 账号的 Agent。在 CoMem「接入 Agent → Hermes」复制 MCP 配置，合并进 Hermes 当前配置的 `mcp_servers`。如果需要 API Key，按[认证配置](../integrations/hermes-openui/README.md#use-comem-from-the-same-chat)设置。回到「会话与任务 → 导入历史会话」复制提示词，给 Agent 指定文件，看完预览后确认。如果不希望预览聊天本身被自动归档，换到只接 MCP、未开自动采集的配置。见[导入说明](ingest-prompt.md)。

对话原文留在归档。想手写一条已确定的记忆时，可以直接在 CoMem 文件树点「新建记忆」。管理员可在 CoMem「提示词」调整抽取、经验归纳和记忆整理的模板；模板会在下一次相应处理时生效。已经使用模型生成摘要时，可以在「设置」开启「允许手动整理记忆」，再打开「记忆复核 → 整理建议」检查重复或冲突，原记忆不会被修改。

## 4. 打开交互式回答（可选）

按 [OpenUI 安装说明](../integrations/hermes-openui/README.md) 安装并在官方 Hermes Webapp 的 **Capabilities → Plugins** 中启用。试试 `/hermes-openui:openui 把我上面的读书约定做成一个可切换「约定 / 核对」的卡片`。普通对话照常使用文本回答。

## 如果结果没出现

| 看到的现象 | 下一步 |
|---|---|
| `hermes memory status` 没有 CoMem | 检查插件是否在当前配置的 `plugins/comem`，重新运行 `hermes memory setup` 并选择 CoMem。 |
| Hermes 有回复，但 CoMem 看不到会话 | 在回复完成后刷新「会话与任务」；确认服务地址、API Key 和网页账号。在 `hermes memory status` 检查上次传输错误和本地积压。 |
| 有归档，但还搜不到记忆 | 确认生成模型可用，等待后台处理；检查「记忆复核」里是否还有待确认条目。 |
| 网页没有卡片 | 先验证 OpenUI 已在当前 Hermes 网页启用，再在已有会话明确请求交互式回答。 |
