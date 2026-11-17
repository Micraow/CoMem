# 在 Hermes 使用 CoMem

CoMem 主线包含 Hermes Memory Provider 和 MCP 接入说明。可选的 [Hermes OpenUI](https://github.com/Micraow/hermes-openui/blob/main/README.md) 展示插件在独立仓库维护，单独安装。联调使用独立的工作树、数据根、端口和 Hermes 配置目录。

从主线创建独立工作树。`--detach` 让其他工作树仍可签出该分支：

```sh
git fetch origin master
git worktree add --detach ../CoMem-hermes origin/master
cd ../CoMem-hermes
pnpm install --frozen-lockfile
pnpm --dir web install --frozen-lockfile
```

已有联调工作树时可直接使用；`git worktree list` 会列出路径。

## 1. 启动隔离的 CoMem

首次试用控制台，可以用默认规则和独立数据根运行，无需模型凭据。下面的隔离示例后端用 `1934`，控制台用 `3082`；主线本地开发的默认端口是 `1933` 和 `3081`：

```sh
COMEM_SERVER_PORT=1934 COMEM_WEB_PORT=3082 pnpm dev --data-dir ./local/hermes-smoke/data
```

联调记忆提炼时，从 [配置模板](../config.example.yaml) 创建 `./local/hermes-smoke/config.yaml`，填写自己的模型配置。将 `--config ./local/hermes-smoke/config.yaml` 附在同一条命令末尾。`--data-dir` 让本次联调使用独立索引，避免读取其它版本创建的数据库。

`pnpm dev` 会把控制台代理指向实际配置的后端端口。打开 `http://127.0.0.1:3082/setup` 初始化账号。回环监听且保留默认 `auth.trustLoopback: true` 时，`/setup` 不要求初始化令牌；非回环请求或关闭回环信任时，使用启动日志里的一次性初始化令牌。控制台、Provider 和 MCP 必须使用同一组端口和同一个数据根；例如不要用 `3082` 查看指向 `1933` 的 Provider。

记录 Hermes 主机能访问的**后端**服务地址，例如 `http://127.0.0.1:1934`。如果关闭回环信任，登录控制台后从右上角「我的账户」进入 **API Keys**，为同一个隔离账号创建凭据。

## 2. 连接自动记忆

使用官方 Hermes Agent v0.23.1 或兼容的 v0.23.x（v0.23.2 已验证）。以下命令只写工作树内的隔离 Hermes 配置：

```sh
export HERMES_HOME="$PWD/local/hermes-smoke/hermes"
mkdir -p "$HERMES_HOME/plugins"
ln -s "$PWD/integrations/hermes-memory" "$HERMES_HOME/plugins/comem"
hermes memory setup
hermes memory status
```

在 `hermes memory setup` 中选择 **CoMem**，填入上面的隔离 CoMem 地址，并优先填写控制台当前账号所属的 API Key。表单默认使用 `COMEM_TOKEN` 作为密钥环境变量名，Hermes 会把它保存到隔离配置目录的 `.env`；`COMEM_BASE_URL` 可覆盖服务地址。推荐始终使用同一账号的 Key，包括回环连接。无 Key 且 `auth.trustLoopback: true` 时会以 `server.subject`（默认 `user:local`）写入，可能与控制台登录账号不同。不要读取、复制或展示现有配置里的密钥。非敏感配置也可按 [Memory Provider 说明](../integrations/hermes-memory/README.md) 手动写入。

启动这个隔离配置的 Hermes 网关并打开新会话，告诉它一条值得长期保留的偏好，例如「我的每周读书笔记标题固定用『纸舟』」。然后在 CoMem 控制台检查会话到达、归档和记忆复核；再在 Hermes 新开会话，问「我通常给每周读书笔记起什么标题？」。配置状态、会话归档和实际召回是三项不同的检查。归档完成后 live `messageCount` 可以是 0，`lastCommitAt` 才是提交成功的证据；不能用任务列表是否为空单独判断采集失败。

## 3. 在 CoMem 控制台完成接入设置

打开控制台的 [`/connect?host=hermes`](http://127.0.0.1:3082/connect?host=hermes)。这个页面是接入向导：它生成 MCP 配置、说明记忆插件，并显示最近会话与检查状态。它不是聊天入口，也不会替代 Hermes Webapp。

向导生成 MCP 配置时，在页面的「服务地址」中填写后端地址 `http://127.0.0.1:1934`；生成的 MCP URL 应为 `http://127.0.0.1:1934/mcp`。不要填写控制台地址 `3082`，它只提供页面和 `/api` 开发代理。

需要导入旧对话时，在向导里复制 MCP 配置，合并到**隔离的** Hermes `config.yaml` 的 `mcp_servers`。认证开启时按 [Memory Provider 认证说明](../integrations/hermes-memory/README.md#install)设置 `COMEM_TOKEN`。然后在 CoMem「会话与任务 → 导入历史会话」复制提示词，交给能够读取文件的 Agent；看完预览再确认。导入和自动捕获使用同一数据根，因此联调时只提供合成材料或明确授权的工作副本。格式与去重边界见[导入说明](ingest-prompt.md)。

## 4. 可选：在 Hermes Webapp 使用 OpenUI

聊天、工具执行和对结果继续追问都在官方 Hermes Webapp 中完成。CoMem 控制台只负责接入设置和事后查看。

OpenUI 是独立维护的可选展示插件，不随 CoMem 仓库安装，也不参与自动记忆。需要交互式卡片时，按 [Hermes OpenUI 安装说明](https://github.com/Micraow/hermes-openui/blob/main/docs/INSTALL.md#install-hermes-openui) 在独立仓库完成构建和链接，然后在官方 Hermes Webapp 的 **Capabilities → Plugins** 中启用 **hermes-openui**。在已有会话里发送：

```text
/hermes-openui:openui 把我上面的读书约定做成一个可切换「约定 / 核对」的卡片
```

普通对话继续显示文本回答；OpenUI 只改变一部分回答的展示。

## 如果结果没出现

| 看到的现象 | 下一步 |
|---|---|
| `hermes memory status` 没有 CoMem | 检查隔离配置的 `plugins/comem`，重新运行 `hermes memory setup` 并选择 CoMem。 |
| Hermes 有回复，但 CoMem 看不到会话 | 确认浏览器中的后端端口与 Provider `endpoint` 是同一实例；运行 `hermes memory status`，比较其中的 `subject` 与控制台当前空间。无 API Key 的回环连接通常写入 `user:local`，登录其他账号的人看不到这些数据。 |
| 会话、任务和 `sessions/` 文件树都为空 | 先看 `hermes memory status` 的 `subject` 是否等于控制台账号，再看 `pending_writes` 和 `last_error`；任务视图是否保留完成项取决于部署版本，不能用任务列表为空单独判断采集失败。 |
| 有归档，但还搜不到记忆 | 确认隔离配置里的生成模型可用，等待后台处理，再检查「记忆复核」里的待确认条目。 |
| Webapp 没有卡片 | 检查当前 Hermes Webapp 是否加载了 `hermes-openui`，再从 Hermes 会话明确发起 `/hermes-openui:openui` 请求。 |
