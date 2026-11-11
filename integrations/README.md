# CoMem Hook 插件

装进宿主的会话召回与采集插件。它是**独立于服务端的交付物**：纯 JavaScript（`.mjs`），
只依赖 Node 内置模块，不声明任何 `dependencies`。

这个目录交付三样东西：**七个 Hook 事件**（自动召回与采集，六个脚本）、**一个 stdio MCP
代理**（给只支持本地 stdio 服务器的宿主），以及**两份提示词**（教 agent 什么时候用 MCP
工具）。
MCP 工具本身不经过这里：CoMem 在 `/mcp` 暴露 Streamable HTTP，能直连的宿主直接配
URL 即可。分工与配置片段见下面的「[MCP 接入](#mcp-接入)」。

```
integrations/
├── package.json          # type: module；bin: co-mem
├── cli.mjs               # co-mem install / doctor / uninstall
├── lib/                  # 与宿主无关的共享模块
│   ├── config.mjs        # 配置 + 宿主解析 + bypass
│   ├── http.mjs          # 超时 / 重试 / 错误封套
│   ├── events.json       # 事件名映射表（宿主 PascalCase ↔ 内部 snake_case）
│   ├── events.mjs        # 读上面那张表，导出 EVENT_NAMES / REPORTED_EVENT_NAMES
│   ├── dedup.mjs         # 事件去重（500ms 窗口）
│   ├── lock.mjs          # 跨进程会话锁
│   ├── cursor.mjs        # 消息游标
│   ├── filter.mjs        # sed 风格查询过滤
│   └── telemetry.mjs     # 四阶段开销上报
├── servers/              # 七个可执行入口
│   ├── session-start.mjs      # ┐
│   ├── user-prompt-submit.mjs # │
│   ├── pre-tool-use.mjs       # │ 六个 Hook 脚本：stdin JSON → stdout JSON
│   ├── post-tool-use.mjs      # │ `pre-compact.mjs` 同时服务 PreCompact 与 SessionEnd
│   ├── stop.mjs               # │
│   ├── pre-compact.mjs        # ┘
│   └── mcp-proxy.mjs     # stdio → POST /mcp 的 MCP 代理
├── hosts/                # 宿主适配（信封与载荷）
│   ├── claude-code.mjs
│   ├── codex.mjs
│   └── dsh.mjs
├── skills/               # 提示词（装进宿主的技能目录）
│   ├── comem-memory/SKILL.md
│   └── comem-rules/SKILL.md
└── tests/                # node:test
```

## 安装

```bash
node integrations/cli.mjs install --host claude-code
# 也可以先 link，再用 bin 名：pnpm --dir integrations link
co-mem install --host claude-code
co-mem doctor
co-mem uninstall --host claude-code
```

**这个包不发布到 npm**（`integrations/package.json` 里是 `"private": true`），所以
`npx co-mem` 会拿到 `404 Not Found`。不 link 就用 `node integrations/cli.mjs`，命令都在
**仓库根目录**执行。

`install` 把七个 hook 写进宿主的 settings（默认 `~/.claude/settings.json`，可用
`--settings` 指定），改之前先备份成 `<settings>.bak`。`uninstall` 只删按脚本路径
匹配到的、我们自己加的条目，别人的 hook 一个不动。

**能装的是两个宿主**，`--host` 取 `claude-code` / `codex`：

```bash
co-mem install --host codex      # 写进 ~/.codex/hooks.json
co-mem uninstall --host codex
```

| 宿主 | 默认配置文件 | 备注 |
|---|---|---|
| `claude-code` | `~/.claude/settings.json` | `hooks` 是 matcher 组数组 |
| `codex` | `~/.codex/hooks.json` | 见下节；**首次使用需在 Codex 里信任 Hook** |
| `dsh` | —（`install` 直接失败） | 见「[DSH](#dsh)」：DSH 没有 settings 里的 hook 面 |

### DSH

**`co-mem install --host dsh` 会失败，这是刻意的。** DSH 0.2.2-rc.1 没有 settings
里的 hook 面：

- DSH 读的配置是 `$DSH_HOME/profiles/<name>/settings.yaml`，而它已经是遗留文件——
  启动时 `@deepseek-ai/dsh-settings` 的 `importLegacyDocument` 把它一次性导入
  profile、改名成 `settings.yaml.imported`（`lib/index.js:346-349`）。
- `~/.dsh/settings.json` 一个读者都没有。写它不报错，只是永远不生效：用户会以为
  装好了，实际一个 hook 都不会跑。
- DSH 的 hook 面**完全由插件提供**：`@deepseek-ai/dsh-hooks-claude-code`（Claude
  Code 方言）或 `@deepseek-ai/dsh-hooks-codex`（Codex 方言），挂在
  `$DSH_HOME/profiles/<name>/cordis.patch.yml` 里，用 `configPath` 指向一个
  `hooks.json`，或指向一个 `hooks` 键里放着配置的 settings 文件。

`install` 完不成这条链路：它要往 profile 里装插件、改一份 YAML，两件都不做。所以
它选择失败，而不是写一个没人读的文件。

**手动接**（这两步本仓库不替你做）：

```bash
# 1. 用 Claude Code 方言生成 hooks 文件（DSH 的桥读的就是这个形状）
node integrations/cli.mjs install --host claude-code --settings ~/.dsh/comem/hooks.json
```

```yaml
# 2. 在 $DSH_HOME/profiles/<name>/cordis.patch.yml 里挂上桥
- name: '@deepseek-ai/dsh-hooks-claude-code'
  config:
    configPath: ~/.dsh/comem/hooks.json
```

**未验证。** 本仓库没有安装这两个桥包，`configPath` 能否真的让 CoMem 的 hook 跑
起来没有做端到端验证；上面的字段名来自两个包 0.2.2-rc.1 的 README，不是实测。

两个已知限制，接之前先知道：

- **两个桥各只实现 5 个事件**，`PreCompact` 与 `SessionEnd` 的配置会被静默丢弃。
  想要完整的七个事件，用 `--host claude-code` 或 `--host codex` 直连宿主。
- **`Stop` 采集在 DSH 下采不到消息**：桥把 `transcript_path` 固定成空值（DSH 的
  持久化层不暴露文件路径），也没有 Claude Code 的 transcript 可读。`hosts/dsh.mjs`
  的 `parseTranscript` 本来就返回空数组并带一条 `note`，`Stop` 会把它写进
  `comem-capture.log` 的 `reason: "no-messages"`，不是静默早退。

**`--host dsh` 的适配器还在。** `hosts/dsh.mjs` 仍然可以通过 `COMEM_HOST=dsh`
选中（测试也覆盖它），但 CoMem 自己没有「装进 DSH」这条路径。DSH 上跑的是桥，
桥发的是 Claude Code 方言的载荷，所以用 `--host claude-code` 生成的命令。

### Codex

Codex 支持完整的生命周期 Hook（`config.toml` 的 `[features].hooks`，默认开启），
事件名与 CoMem 的七个一一对应，载荷字段与 Claude Code 同形（`session_id` /
`transcript_path` / `cwd` / `hook_event_name`）。官方文档：
<https://developers.openai.com/codex/hooks>。

Codex 从 `$CODEX_HOME/hooks.json`（默认 `~/.codex/hooks.json`）读取 Hook，也接受
`~/.codex/config.toml` 的内联 `[hooks]` 表。`co-mem install --host codex` 写的是
`~/.codex/hooks.json`。

**项目级 `<repo>/.codex/hooks.json` 未验证**：Codex 0.167 在非交互的 `codex exec`
里没有读它（git 仓库根目录、有效与无效配置都试过），可能要先经过交互式信任。用
`--settings <repo>/.codex/hooks.json` 之前先自己确认一次——没读的话 hook 不会报错，
只是不跑。

**安装不等于信任。** Codex 要求每个非托管 Hook 在运行前经过审查和信任：首次启动时
会弹确认，或打开 `/hooks` 逐条信任 `integrations/servers/*.mjs`。不信任就不运行
（Hook 与 MCP 分离：不信任 Hook 时 MCP 工具仍可用，但自动召回与采集不生效）。
若要关闭这些 Hook，在 `~/.codex/config.toml` 设 `[features].hooks = false`。

Codex 的 `PreToolUse` 没有 `Read` 工具，文件编辑走 `apply_patch`（matcher 别名
`Edit` / `Write`），命令走 `Bash`；`co-mem install` 为 Codex 写的 matcher 是
`apply_patch|Edit|Write|Read`，`apply_patch` 的 `comem://` 路径从补丁命令里提取。

`doctor` 检查四项，每项输出「通过 / 失败 + 一句怎么修」：

| 检查 | 失败时怎么修 |
|---|---|
| 服务端可达 | 启动服务端；`COMEM_BASE_URL` 或配置里的 `baseUrl` 指对地址 |
| 配置文件 | 在配置文件里写 `userId: <你的用户名>` |
| hook 脚本 | 重新运行 `co-mem install` |
| 游标文件可写 | 检查 `COMEM_HOOK_TMPDIR` 目录权限 |

## 七个 hook 事件

| Hook | 做什么 | 阻塞还是异步 |
|---|---|---|
| `SessionStart` | 注入 profile、偏好、`<available-skills>` 技能目录 | 阻塞（一次读 + 一次列表） |
| `UserPromptSubmit` | 拿 prompt 去 `find`，把相关记忆注入上下文 | 阻塞（§15.9 的核心开销） |
| `PreToolUse` | 拦住把 `comem://` 当本地路径的 `Read` / `Write` / `Edit`，指回 MCP 工具 | 阻塞（纯内存判断；**不发 HTTP，也不上报开销**） |
| `PostToolUse` | 把工具调用与结果采集为 `tool` 消息 | 阻塞（5–20ms 的采集写入） |
| `Stop` | 采集本轮 user / assistant 消息并提交 | **主进程立刻返回**，采集与提交在分离的 worker 进程里 |
| `PreCompact` | 把待处理消息提交完 | 阻塞，等提交完成（总预算 30s，见「每个 hook 的总预算」） |
| `SessionEnd` | 把待处理消息提交完 | 阻塞，等提交完成（总预算 1.2s：宿主只给这组 hook 1.5 秒） |

七个事件、六个脚本：`PreCompact` 与 `SessionEnd` 共用 `servers/pre-compact.mjs`，两者
都是「对话要没了，把手上的消息交出去」，但内部事件名不同（`pre_compact` /
`session_end`）、预算也不同。`co-mem install` 默认把七个都写进宿主的配置。

### 事件名与开销上报

两套事件名分居两侧，对应关系只写在 `lib/events.json`：

| 字段 | 含义 |
|---|---|
| 键（对象键） | 内部事件名，`session_start` 等 snake_case，也是 `/telemetry/hook` 的 `event` |
| `hostEventName` | 宿主发的名字，`SessionStart` 等 PascalCase |
| `reportsOverhead` | 这个事件是否上报阻塞开销 |

`lib/events.json` 是这张表的唯一一份，`lib/events.mjs` 从它导出 `EVENT_NAMES`（7 个）
与 `REPORTED_EVENT_NAMES`（6 个）。三个宿主共享这张表——各写一份时，事件名对不上会
让 `/metrics` 里的样本全部塌进 `event="other"`。

**「宿主会调的事件」是 7 个，「进 `/metrics` 的事件」是 6 个。** `pre_tool_use` 的
`reportsOverhead` 是 `false`：它的判定全在本地，没有 HTTP 往返可归因，上报一个
全是 0ms 的样本只会稀释「每轮阻塞开销」的分布。它的预算（1000ms）仍然是真实的，
超时排查看宿主自己的日志。

### 采集为什么不阻塞

`Stop` 卡住等于把用户的输入延迟绑在 LLM 抽取上——抽取一次几秒到几十秒。所以 `Stop`
只做去重、bypass、写 worker 载荷、`spawn(detached: true)` 然后退出。worker 负责
「读 transcript → 写消息 → 前进游标 → 触发提交」。

只有 `PreCompact` / `SessionEnd` 等提交完成：这两个时机之后对话就没了，后台 worker
会被宿主杀掉。

### 每个 hook 的总预算

**预算是「每个 hook 一个」，不是「每个请求一个」。** `timeoutMs`（默认 5s）只约束
一次 HTTP 尝试；一个 hook 里顺序发三次请求就会变成三倍，GET 还有两次重试。用户在
`UserPromptSubmit` 上等的是这个端口上所有请求加起来的时间。

预算从**进程启动**算起（`performance.timeOrigin`），读 stdin、检索、采集、上报都
从同一个 deadline 里扣。子请求共享同一个 `AbortSignal`（`AbortSignal.any` 合并单
请求超时与总 deadline），预算用尽后不再开新请求、不再重试，错误码是
`HOOK_BUDGET_EXCEEDED`（与单请求超时的 `HOOK_TIMEOUT` 分开）。

| 事件 | 总预算 | 依据 |
|---|---|---|
| `SessionStart` | 4000ms | 会话开局一次；三次 GET 并发。宿主上限 600s 不构成约束，按「开局多等 4 秒还能接受」定；本机空载实测 57ms |
| `UserPromptSubmit` | 2000ms | **每轮按回车都付**。宿主默认给 30s（Claude Code 官方），30s 与挂住没有区别；§15.9 典型 60–180ms、本机实测 54ms，2s 是典型值的 ~10 倍，超了退化成「本轮没有记忆」 |
| `PreToolUse` | 1000ms | 纯本地判断、不发请求；本机实测 29ms。它出现在**每次工具调用**前，取实测的 ~30 倍 |
| `PostToolUse` | 2000ms | 两次顺序 POST；§17.2 的采集写入 5–20ms，2s 是 100 倍 |
| `Stop` | 1000ms | 主进程只写载荷 + spawn；`tests/stop.test.mjs` 实测 44ms |
| `PreCompact` | 30000ms | 数据可能丢，必须等提交完成；与 `commitTimeoutMs`、§17.2 的 `rewriteTimeoutMs` 同一个数（宿主默认 600s） |
| `SessionEnd` | 1200ms | Claude Code 给 `SessionEnd` 一组 hook 只有 **1.5 秒**共享预算，留 300ms 给启动与退出。等 30s 等于被宿主先杀掉、留下半截提交 |

值在 `lib/lifecycle.mjs` 的 `HOOK_BUDGETS_MS`，**没有配置项**：它表达的是「用户最多
等多久」，不是部署差异。调大时别超过宿主给该事件的 hook 超时（上表最后两行就是反
例）：宿主会先杀掉进程并丢弃输出，预算就成了空话。

**stdin 读取有 800ms 上限**（`STDIN_READ_CAP_MS`），超时按「没有事件」处理——宿主
不写也不关 stdin 时，`for await` 永远不会返回。800ms 小于最短的事件预算，保证
「stdin 卡住」不会把任何 hook 拖过它的总预算。

**错误路径的契约（七个事件一致）**：

| 性质 | 实现 |
|---|---|
| stdout 一个字节都不写 | 只有 handler 正常返回且 `formatOutput` 产出信封时才写；任何异常都不进写路径 |
| stderr 一行诊断 | `co-mem hook <事件>: <消息>` 或一行 JSON `warn`；不含 prompt 正文、工具输出、凭据 |
| 退出码 0 | 宿主把非 0 当失败；Claude Code 配了 `onFailure: "block"` 时还会**阻断**这次调用（官方文档「Block the action when a hook fails」）。`--host` 拼错、配置文件坏、未捕获异常也走同一条路 |
| 进程会退出 | 逻辑结束后安排一个 **unref 的**兜底定时器：没有残留句柄时它不触发（自然退出）；有未关的 stdin / socket / 定时器时它到点 `process.exit(0)`。安排之前已经 `await` 过 stdout 的写回调，不会截断输出 |

`PreToolUse` 的判定完全在本地（只看 `file_path` 是否以 `comem://` 开头），不发
HTTP——后端不可达既不会让它变慢，也不会让它改主意。任何内部错误都收敛成「没有输出
+ 退出码 0」，宿主按「没有决定」处理，工具调用继续走正常权限流程。

回归测试在 `tests/hook-resilience.test.mjs`：真起子进程，分别对着**永不响应的服务
端**、**无人监听的端口**、**不关闭的 stdin** 断言「预算 + 余量内退出、退出码 0、
stdout 为空、stderr 一行」。

## MCP 接入

Hook 和 MCP 是两条独立的通道，**装完 Hook 不等于接上了 MCP 工具**。

| 通道 | 谁发起 | 负责什么 |
|---|---|---|
| Hook | 宿主在固定生命周期点自动调用 | 召回注入（`SessionStart` / `UserPromptSubmit`）、采集（`PostToolUse` / `Stop` / `PreCompact` / `SessionEnd`） |
| MCP | 模型主动调用 | 16 个工具：`find` / `search` / `read` / `write` / `remember` / `forget` / `add_resource` 等 |

两者互补：**只装 Hook** 时，agent 能拿到自动注入的记忆，但不能主动 `remember` /
`write`；**只配 MCP** 时，agent 能主动读写，但没有任何自动召回与采集。两个都配，
记忆才会「该出现时自己出现，需要时能查能写」。

服务端在 `POST /mcp` 暴露 **Streamable HTTP**，无状态模式：不返回
`Mcp-Session-Id`，每个请求独立。

### 两条路

| 宿主 | 用哪条 | 配置里写什么 |
|---|---|---|
| 支持 Streamable HTTP（Claude Code、DSH 等） | **HTTP 直连** | 一个 URL |
| 只支持本地 stdio 服务器（只给 `command` + `args` 配置位） | **stdio 代理** | `command: node` + `args: [integrations/servers/mcp-proxy.mjs]` |

判据只有一个：**宿主能不能填一个 URL**。能就直连——少一个常驻进程、少一份配置。不能
就起代理：`servers/mcp-proxy.mjs` 把 stdin 的每一行 JSON-RPC 转发到 `POST /mcp`，再把
响应写回 stdout。两条路走同一个端点、同一套凭据、同一份 16 个工具。

**与宿主无关的最小配置**只有两样——一个 URL，和（跨网络访问时）一个认证头：

```json
{ "url": "http://127.0.0.1:1933/mcp", "headers": { "Authorization": "Bearer <凭据>" } }
```

**访问本机服务端时 `headers` 整段可以省掉**：`auth.trustLoopback` 默认打开，来源是回环
地址、`Host` 也指向本机的请求被认证成 `server.subject`（`~/.config/comem/config.yaml`
里的 `server.subject`，默认 `user:local`）。这就是本机进程的信任模型——能连上本机端口的
人本来就能读这个数据根，与 `~/.ssh` 同级。下面两节是两个具体宿主的写法；其它宿主按它的
文档把这两样映射过去即可。

#### stdio 代理

```json
{
  "mcpServers": {
    "comem": {
      "type": "stdio",
      "command": "node",
      "args": ["<仓库绝对路径>/integrations/servers/mcp-proxy.mjs"]
    }
  }
}
```

代理**不需要参数**，宿主的 MCP 配置里**也不需要出现密钥**：它按 Hook 的同一套顺序读
环境变量与配置文件，换 key 只改一处。

| 环境变量 | 说明 |
|---|---|
| `COMEM_BASE_URL` | 服务端地址；代理拼成 `<baseUrl>/mcp` |
| `COMEM_TOKEN` | `Authorization: Bearer` 的值；`baseUrl` 是回环地址时留空（走回环信任），经 nginx 等非回环地址访问时必须填 |
| `COMEM_MCP_TIMEOUT_MS` | 等 MCP 响应的超时，默认 `30000`。**别照 hook 的 5 秒配**：`find` 开了重排时 p95 就有 9.35 秒 |
| `COMEM_DEBUG` | `1` 时把转发日志写到 **stderr**（stdout 只走协议） |

**为什么不是「两个宿主都支持 HTTP，所以不需要代理」。** 那只看过两个宿主。MCP 规范里
`stdio` 是一等公民，只支持本地 stdio 服务器的宿主不会因为另外两个支持 HTTP 就不再存在；
而代理顺带把凭据从宿主配置里挪走了。

### Claude Code

项目根目录的 `.mcp.json`（可提交，团队共享）或 `~/.claude.json`（个人）：

```json
{
  "mcpServers": {
    "comem": {
      "type": "http",
      "url": "http://127.0.0.1:1933/mcp"
    }
  }
}
```

`type` **不能省**：Claude Code 把「只有 `url`、没有 `type`」的条目当成 stdio 服务器
并跳过，报告 `MCP server "comem" has a "url" but no "type"`。`"streamable-http"` 是
`"http"` 的别名，两种写法都认。

**跨网络访问**（Docker 经 nginx、远程开发机）要带 API Key：容器绑 `0.0.0.0`，回环
信任被关掉，来源不是回环地址。`${VAR}` 会在 Claude Code 读取配置时展开，key 不用写进
仓库：

```json
{
  "mcpServers": {
    "comem": {
      "type": "http",
      "url": "http://127.0.0.1:1933/mcp",
      "headers": {
        "Authorization": "Bearer ${COMEM_API_KEY}"
      }
    }
  }
}
```

等价的 CLI 写法：

```bash
export COMEM_API_KEY=comem_...
claude mcp add --transport http comem http://127.0.0.1:1933/mcp \
  --header "Authorization: Bearer $COMEM_API_KEY"
```

### DSH

编辑 `$DSH_HOME/profiles/<name>/cordis.patch.yml`，加一个 `dsh-mcp-client` 条目
（插件本身用 `dsh plugin --profile <name> add @deepseek-ai/dsh-mcp-client` 装进 profile）：

```yaml
- id: mcp-comem
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: comem
    transport: streamable-http
    url: http://127.0.0.1:1933/mcp
    # 跨网络访问时才有意义；访问本机服务端时可以整段删掉（回环信任）
    headers:
      Authorization: !!js '`Bearer ${process.env.COMEM_API_KEY}`'
```

`serverName` 决定模型看到的工具前缀：`mcp__comem__find`、`mcp__comem__health`。
`transport` 是必填字段，没有「默认 stdio」这回事。

### 认证

| 访问方式 | 请求头 | 行为 |
|---|---|---|
| 本机（`http://127.0.0.1:1933`、`http://localhost:1933`） | 不需要 | 回环信任：身份取 `server.subject`（默认 `user:local`）。判定要求来源是回环地址 **且** `Host` 指向本机 |
| 跨网络（容器经 nginx、远程主机） | `Authorization: Bearer <凭据>` | 凭据是 `comem_` 开头的 API Key，或 `POST /api/v1/auth/login` 换来的 session token；缺失或非法一律 401 `UNAUTHENTICATED` |

**`x-comem-subject` 不是凭据。** 服务端不读它；本机的身份只由回环信任决定，不能靠一个
请求头换成别人。

API Key 从管理端点签发（明文只在创建响应里出现一次）：

```bash
curl -sS http://127.0.0.1:1933/api/v1/admin/users/alice/api-keys \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"name":"claude-code"}'
```

Hook 的 `token`（`COMEM_TOKEN`）和 MCP 的 `Authorization` 是同一套凭据：一个服务端、
一套认证。**凭据会同时出现在 Hook 配置和宿主 MCP 配置里**；想让换 key 只改一处，
两边都引用同一个环境变量（Claude Code 用 `${COMEM_API_KEY}`，DSH 用
`process.env.COMEM_API_KEY`）。不要提交进仓库。

### 验证

1. 服务端：`curl -sS http://127.0.0.1:1933/health` 返回 `{"status":"ok",...}`。
2. Claude Code：`claude mcp list` 显示 `comem: http://127.0.0.1:1933/mcp (HTTP) - ✔ Connected`；
   会话里 `/mcp` 能看到 16 个工具。
3. DSH：启动日志里 `mcp-client(comem)` 没有连接错误；模型工具列表出现 `mcp__comem__*`。
4. 让 agent 调一次 `health`：返回内容与 `GET /health` 相同（`status: ok`、`subject`、
   `index.nodes`）。调用失败时错误进服务端日志的「MCP 工具拒绝」/「MCP 工具执行失败」，
   带工具名与 `requestId`（取自 `x-request-id`，没有就生成）。

**没有 `✔ Connected` 时先看三处**：`url` 有没有带 `/mcp`；`type` / `transport` 是不是
写成了 HTTP 而不是默认的 stdio；跨网络访问时 `Authorization` 头有没有真的发出去
（Claude Code 的 `claude mcp get <name>` 会列出发送的头，DSH 看启动日志里的连接失败原因）。

### 提示词

`integrations/skills/` 下有两份 `SKILL.md`，装进宿主的技能目录（Claude Code：
`~/.claude/skills/`；DSH：profile 的 skills 目录）：

| 技能 | 什么时候加载 | 讲什么 |
|---|---|---|
| `comem-memory` | 用户提到以前的会话、让你记住什么、给你文件或链接 | 上下文里已经有哪些注入块、什么时候主动 `find`、什么时候**不要**召回、`remember` 的参数格式 |
| `comem-rules` | 动手之前 | `rule_search` 的 `taskContext` 怎么构造、`threshold` 是相对值、返回值是规则正文 |

分成两份不是按工具数，是按**触发条件**：主技能靠「用户提到记忆」触发，`rule_search`
必须在「用户压根没提记忆、但你即将动手」时触发——一份 description 覆盖不了两个触发器。

**提示词必须和 Hook 注入的格式对得上**，否则 agent 会重复召回或误解内容：

| 注入块 | 来源 | 格式 | 提示词里的定位 |
|---|---|---|---|
| `<comem-profile>` | `SessionStart` | 纯文本 | 一次性档案，不用再查 |
| `<comem-preferences>` | `SessionStart` | 纯文本 | 历史默认，与当前请求冲突时以当前请求为准 |
| `<available-skills>` | `SessionStart` | `- 名字: 描述` | 技能目录，不是记忆 |
| `<comem-recall>` | `UserPromptSubmit` | `1. [类型] comem://…` + 缩进摘要 | 本轮召回结果，直接 `read` |

**`<comem-recall>` 里没有分数。** 分数只在同一次检索的同一引擎内可比（§13.2），写进
注入块会暗示一个不存在的精度；顺序是这里唯一稳定的信息，所以只编号。

**偏好按目录读，不能拼 `.overview.md`。** `.abstract.md` / `.overview.md` 是保留名
（`src/domain/uri.ts` 的 `RESERVED_SEGMENT_NAMES`），`Uri.parse` 对它们抛
`INVALID_URI`（HTTP 400）。`SessionStart` 因此走
`GET /api/v1/content/overview?uri=comem://user/{uid}/memories/preferences`（参数是
**目录**），由服务端 `SummaryService.read` 读那个文件。曾经这里直接 `content/read`
文件名、再用 `.catch(() => null)` 吞掉 400——`<comem-preferences>` 从上线起就没注入
过，而文件一直在盘上。读取失败（不是 403 / 404）现在记一条 stderr 的 `warn`。

### 注入预算契约

`SessionStart` 的三个块（`<comem-profile>` / `<comem-preferences>` / `<available-skills>`）
都有硬上限。超过宿主上限不是「多一点上下文」，而是**整段被转存成文件、模型只看到
预览**——注入静默失效。

| 约束 | 值 | 超了怎么办 |
|---|---|---|
| 画像 token 预算 | `profileBudgetTokens`，默认 2000 | 保留前 8 行 / 句 + 尾部，中间插 `[… 已省略中间 N 行；完整内容用 read 取回 <URI> …]` |
| 偏好 token 预算 | 画像预算的 1/4，默认 500 | 同上（偏好通常只有几行，按句截断） |
| 技能目录 token 预算 | `skillBudgetTokens`，默认 400 | 全放 → 只名字 → 一行计数 |
| 宿主字节上限 | Claude Code 9,500 / Codex 9,500 / DSH 20,000 | 按「画像 > 技能目录 > 偏好」丢块，stderr 记一条 `warn` |

**只注入正文。** `profile.md` 的 YAML frontmatter 是噪声：`memory_type` /
`created_at` / `uri` 模型用不上，`summary` 是正文前 256 字的副本。服务端
`content/read` 已经剥过一次（`ContentStore.readText` 返回 `document.body`）；Hook
再剥一次是因为它是独立部署的交付物，对端不一定是同一个版本，而半截 YAML 混进
上下文比多一段噪声更难发现。

**token 估算按文本自身的 CJK 密度**：`ceil(CJK 码点数 × 1 + 其余码点数 × 0.25)`。
常用的 `chars / 4` 对中文**低估 6 倍**（1000 个汉字约 1000–1500 token，不是 250），
用它判预算会让中文画像超上限 4–6 倍。公式与 `src/domain/session.ts` 的
`estimateTokens` 是同一份（Hook 不依赖 `src/`，所以有一份副本；**改一处要改两处**）。

**为什么偏好排在技能目录之后丢。** 偏好是目录的 L1 概览，模型能用 `find` /
`content/overview` 按需取回；技能目录是模型发现「存在哪些能力」的唯一入口，丢了
没有恢复路径。画像是唯一不可恢复的（「这个用户是谁」），只受 token 预算约束，
不参与丢块。

**宿主字节上限的来源是宿主的实现细节，不是公开规范。** Claude Code / Codex 在 hook
输出超过约 10,000 字符时转存文件、只放预览，这里取 9,500 留余量；DSH 没有公开上限，
取 20,000 的保守值。两个数在 `hosts/*.mjs` 的 `MAX_CONTEXT_BYTES`，**没有独立复测**
——真实上限更低时调小，不要指望宿主报错，它只会静默降级成预览。

### 为什么不用 `mcp-remote` 这类现成代理

生态里已经有一个成熟的 stdio → 远程 MCP 代理（`npx mcp-remote <url>`，支持
`--header` / `--header-file` / `--transport http-only`），CoMem 的这个端点它能直接连。
不推荐它做默认路径的理由只有一条：**它要求把凭据写进宿主的 MCP 配置**（`--header
"Authorization: Bearer …"`），而 CoMem 自己的代理复用 Hook 的配置链，`~/.config/comem/config.yaml`
改一次两边都生效。已经用 `mcp-remote` 的部署不需要迁移——`mcp-remote <url> --transport
http-only` 是等价物，只是多一处 key 副本。

## 关掉记忆（bypass）

生效位置在 hook 层：注入与采集都跳过，服务端不知道有这回事（它只是没收到请求）。

```bash
# 整个会话关掉
COMEM_BYPASS_SESSION=1

# 按路径 glob 关掉（匹配当前工作目录，PreToolUse 匹配文件路径）
COMEM_BYPASS_SESSION_PATTERNS="*/scratch/*,*/tmp/*"
```

glob 里的 `*` 跨 `/`（与 shell 的路径展开不同）：`*/scratch/*` 能匹配
`/home/alice/scratch/exp`，这是 §8.9 示例的语义。

bypass 不影响 `PreToolUse` 的路径守卫：`comem://` 不管开没开 bypass 都不是本地路径。

## 延迟开销的四个阶段

Hook 在退出前 `POST /api/v1/telemetry/hook` 上报阻塞部分。四个阶段与
`comem_hook_overhead_seconds{event, phase}` 的 `phase` 一一对应：

| 阶段 | 字段 | 典型值 | 来源 |
|---|---|---|---|
| 进程启动（`node hook.mjs`） | `processStartMs` | 30–50ms | §15.9 |
| 检索（`find`） | `recallMs` | 20–100ms | §17.2 |
| 注入序列化 | `serializeMs` | < 5ms | §17.2 |
| 采集写入 | `captureMs` | 5–20ms | §17.2 |

归档 / 抽取 / 合并 / 摘要在后台跑，**不计入阻塞开销**。控制台的「监控」页按这四段
画柱状图。

`Stop` 的 worker 上报的是**父进程**在 spawn 前算出的 `processStartMs`——worker 自己的启动
时刻晚于 hook，用它会把 30–50ms 的进程启动开销算丢。一次事件只上报一次。

## 配置

插件读 `~/.config/comem/config.yaml`（可用 `COMEM_CONFIG_FILE` 改，容器里通常
`/etc/comem/config.yaml`），环境变量优先。

**只支持扁平结构。** 没有引入 YAML 库，所以只认顶层的 `key: value` 与顶层序列
（`- item`）。服务端配置里的嵌套段（`server:`、`retrieval:` 等）被整段跳过——
hook 读不到，也不该读。需要嵌套的配置去服务端配。

| 配置键 | 环境变量 | 默认 | 说明 |
|---|---|---|---|
| `baseUrl` | `COMEM_BASE_URL` | `http://127.0.0.1:1933` | 服务端地址 |
| `userId` | `COMEM_USER_ID` | 空 | 个人根标识；为空时不召回、不采集，`doctor` 报失败 |
| `token` | `COMEM_TOKEN` | 空 | 可选的 Bearer token |
| `timeoutMs` | `COMEM_TIMEOUT_MS` | `5000` | 单次请求超时；实际生效值是 `min(它, 事件总预算的剩余)`，见「每个 hook 的总预算」 |
| `commitTimeoutMs` | `COMEM_COMMIT_TIMEOUT_MS` | `30000` | `PreCompact` 等提交的超时（§17.2 的 `rewriteTimeoutMs`） |
| `mcpTimeoutMs` | `COMEM_MCP_TIMEOUT_MS` | `30000` | stdio 代理等 MCP 响应的超时。**不是** `timeoutMs`：MCP 工具不占用户输入延迟，`find` 开重排时 p95 就有 9.35 秒 |
| `recallLimit` | `COMEM_RECALL_LIMIT` | `10` | `find` 的条数 |
| `recallScoreThreshold` | `COMEM_RECALL_SCORE_THRESHOLD` | `0.5` | 相对阈值：只保留分数不低于本次最高分 × 该值的命中（§15.9 的「三条前提」之二） |
| `skillBudgetTokens` | `COMEM_SKILL_BUDGET_TOKENS` | `400` | 技能目录的独立 token 预算（§15.2） |
| `profileBudgetTokens` | `COMEM_PROFILE_BUDGET_TOKENS` | `2000` | 用户画像的注入 token 预算。超了保留前 8 行 / 句 + 尾部，中间插带 URI 的省略标记（见「注入预算契约」） |
| `queryFilters` | `COMEM_QUERY_FILTERS`（换行分隔） | §8.8 的五条 | sed 风格正则 |

```yaml
baseUrl: http://127.0.0.1:1933
userId: alice
queryFilters:
  - 's|^/\w+.*$||'
  - 's|@[\w/\.\-]+||g'
  - 's|```[\s\S]*?```||g'
  - 's|https?://\S+||g'
  - 's|^(ok\|yes\|继续\|好\|嗯)$||i'
```

**过滤后为空就不检索。** 空查询返回的是随机结果，比不返回更糟——模型会以为它真的
对应某条记忆，还会写进召回账本。

**阈值是相对于本次最高分的比例，不是绝对分数下限。** 三种检索引擎的分数量纲不同：
`fts5` 是取负的 bm25，`vector` 是余弦，`hybrid` 是 RRF 融合分（`Σ 1 / (60 + rank)`，
只有 `0.016–0.033`）。绝对阈值跨引擎不可比，`0.5` 在默认引擎 `hybrid` 下会把全部
命中丢掉，hook 静默返回「没有记忆」。`recallScoreThreshold: 0.5` 表达的是「只保留
与最佳命中差距不到一半的」；最高分为 0 或负（分数不可用）时全部保留，不静默丢数据。

注入块的行首只编号、不写绝对分数：RRF 下 rank 1 与 rank 5 的比值是 `0.938`，
两位小数会把两条都渲染成 `0.02`，既不携带「哪条更相关」，又暗示不存在的精度。

**宿主名**：`co-mem install` 写进 hook 命令的 `--host` 参数（或 `COMEM_HOST`），
`lib/config.mjs` 按名字动态 import `hosts/<name>.mjs`。加第三个宿主只加一个文件，
`servers/` 里一行都不用改。

**临时文件**：锁 `{tmpdir}/comem-{sessionId}.lock`、游标 `{tmpdir}/comem-cursors.json`、
事件去重 `{tmpdir}/comem-events.json`、worker 载荷 `{tmpdir}/comem-stop-*.json`、
采集诊断 `{tmpdir}/comem-capture.log`（超过 256 KiB 整份重写）。
`COMEM_HOOK_TMPDIR` 可以整体换一个目录（测试与多实例隔离用）。

## 宿主载荷

### Claude Code

stdin 收 JSON，公共字段 `session_id` / `transcript_path` / `cwd` / `hook_event_name`。
事件 ID 只有工具类事件能拿到（`tool_use_id`），其余为 `null`——两轮合法的 `Stop`
载荷可以完全一样，拿载荷哈希去重会吞掉第二轮。

### DSH

这一份是本插件定义并依赖的约定。**DSH 本身不派发 hook**——它没有 hook 面，hook
由 `@deepseek-ai/dsh-hooks-claude-code` / `dsh-hooks-codex` 两个桥插件提供，桥发
的是 Claude Code / Codex 方言的载荷（见上面的「[DSH](#dsh)」）。下面这个形状只有
在手工用 `COMEM_HOST=dsh` 选中 `hosts/dsh.mjs` 时才会被用到：

```json
{
  "event": "UserPromptSubmit",
  "sessionId": "0b1c",
  "eventId": "evt_7f3a",
  "cwd": "/repo",
  "data": { "prompt": "…", "toolName": "Read", "filePath": "comem://…", "messages": [] }
}
```

返回 `{"status":"ok","result":{...}}`，`result.context` 注入、`result.block` +
`result.reason` 拦截。同时兼容 Claude Code 的扁平形状。

### transcript 格式与采集诊断

`Stop` / `PreCompact` / `SessionEnd` 采集的是**宿主自己写出的 transcript 文件**，
格式按宿主不同，由各自的 `hosts/<host>.mjs` 里的 `parseTranscript` 解析，
`servers/stop.mjs` 不内置任何一种：

| 宿主 | transcript 在哪 | 行形状 |
|---|---|---|
| Claude Code | 载荷里的 `transcript_path` | 每行 `{uuid, type, message: {role, content: [{type: 'text', text}]}}`；`isSidechain`（子 agent）与工具调用跳过 |
| Codex | `~/.codex/sessions/<日期>/rollout-*.jsonl` | 每行 `{timestamp, ordinal, type, payload}`；只取 `type: "response_item"` 且 `payload.type: "message"` 的行，`content[*].text`（`input_text` / `output_text`）按换行拼接；`developer`、空文本与 `function_call` / `reasoning` 跳过 |
| DSH | 不读文件 | 会话累积列表在 hook 载荷的 `data.messages` 里；transcript 文件格式**未验证**。DSH 的桥插件把 `transcript_path` 固定成空值，也不填 `data.messages`，所以 **DSH 下 `Stop` 采不到消息**——`comem-capture.log` 会记 `reason: "no-messages"` |

**Codex 的 rollout 没有顶层 `message` 字段**，与 Claude Code 的 transcript 不是一种
格式。只实现其中一种时，另一种宿主的每一行都被跳过，`Stop` 拿到空数组后直接返回——
不发 `POST /sessions`、不建会话、不提交、不建任务，进程还退出 0。

解析出 **0 条消息**时，`Stop` 往 `{tmpdir}/comem-capture.log` 写一行 JSON：`host` /
`transcript` / `lines`（非空行数）/ `skipped`（跳过行数）/ `sample`（第一行被跳过
内容的形状，只有键名与 `type`，**不含正文**）。诊断落在文件里而不是 stderr：
`Stop` 的采集跑在 `stdio: 'ignore'` 的分离 worker 里，stderr 被丢弃。

按文档装完 hook、跑完一轮对话后，用下面的命令验证「最近一次 `Stop` 采到了几条消息」：

```bash
# 游标值 = 该会话已经提交的消息条数，跑一轮后应该变大
cat "${COMEM_HOOK_TMPDIR:-${TMPDIR:-/tmp}}/comem-cursors.json"
```

游标没动或采集为 0 时看诊断（`reason` 区分「宿主没给路径」`no-transcript-path`、
「给了但解析不出」`no-messages`、「读不到文件」`transcript-read-failed`）：

```bash
tail -n 1 "${COMEM_HOOK_TMPDIR:-${TMPDIR:-/tmp}}/comem-capture.log"
```

## 插件依赖的 HTTP 契约

插件是独立交付物，服务端接口以架构文档 §14 为准。这里列出**实际用到**的形状——
服务端改路由时对照这张表：

| 用途 | 请求 | 期望响应 |
|---|---|---|
| 读 profile / 偏好 | `GET /api/v1/content/read?uri=<uri>` | `{status:'ok', result:{text}}` 或纯文本 |
| 技能目录 | `GET /api/v1/skills` | `result: {skills: [{name, description?}]}` 或 URI 数组 |
| 召回 | `POST /api/v1/search/find`，`{query, limit}` | `result` 为命中数组或 `{hits}`；每条含 `uri` / `score` / `abstract?` / `memoryType?` |
| 建会话 | `POST /api/v1/sessions`，`{sessionId, userId}` | 200 新建；409 已存在，复用（消息原样保留） |
| 写消息 | `POST /api/v1/sessions/{id}/messages`，`{messages: [...]}` | 2xx 后才前进游标 |
| 提交 | `POST /api/v1/sessions/{id}/commit` | 2xx；**无条件**归档（直接调 `commitPhase1`），与 `session.autoCommit` 无关 |
| 开销上报 | `POST /api/v1/telemetry/hook`，`{event, sessionId, phases}` | 任意；失败静默 |
| 自检 | `GET /health` | 2xx |

## 四层去重

1. **事件去重**：同一个 `eventId` 在 500ms 窗口内只处理一次。窗口落在
   `{tmpdir}/comem-events.json`——内存 Map 出了进程就没了，挡不住跨进程重投。
2. **消息去重**：游标之后的消息才提交。**游标只在服务端确认接收后前进**：没确认
   就重投，宁可重复不能丢。
3. **跨进程锁**：同一个 session 的多个 hook 进程用 `{tmpdir}/comem-{sid}.lock`
   串行化（`wx` 原子创建 + 过期时间，不做心跳）。
4. **服务端按消息 `id` 幂等**：同一条消息重复提交时返回已有的那条，不新增、不推进
   轮次、不改会话状态（活会话与已归档会话都查）。第 2 层的「宁可重投」靠这一层收口，
   两道合起来才是「不丢也不重」。

插件给的消息 `id` 是稳定值：对话消息取 transcript 里的消息 ID（Claude Code 的
`uuid`、Codex 的 `msg_…`），工具消息取 `tool_${toolUseId}`。**服务端只在调用方给了
`id` 时才能去重**：`POST
/sessions/{id}/messages` 在缺 `id` 时补一个随机 UUID，重投会变成两条——自己写客户端
时不要省这个字段。

## 故障排查

**`doctor` 报「服务端可达」失败**：`curl $COMEM_BASE_URL/health` 确认服务端起了；
检查 `baseUrl` 是否带了协议与端口。

**`doctor` 报「配置文件」失败**：`userId` 为空。它决定 `comem://user/{uid}/` 这个
根，拼不出来就既不召回也不采集。

**装完宿主里没有任何变化**：`cat ~/.claude/settings.json` 看 `hooks` 里有没有
`integrations/servers/*.mjs`；没有就重新 `co-mem install`。宿主对 settings 的语法
错误通常只打一行日志。

**每一轮都很慢**：看监控页的四阶段柱子。`processStartMs` 占大头是正常的（30–50ms）；
`recallMs` 高说明检索慢，先看服务端的日志；`captureMs` 高说明消息写入慢，检查
SQLite 的写锁。

**hook 报 `HOOK_BUDGET_EXCEEDED`**：不是某个端点慢，是这个 hook 的总预算用完了
（`lib/lifecycle.mjs` 的 `HOOK_BUDGETS_MS`）。先看服务端日志确认请求有没有到、卡在
哪一步；`HOOK_TIMEOUT` 才指向单个请求。**不要靠调大预算解决**——预算是用户最多等
多久，不是服务端的性能上限。

**hook 报「等宿主写 stdin 超时」**：宿主没有在 800ms 内写完 stdin 并关闭。多数是
宿主侧的插件运行器出了问题；这条路径按「没有事件」放行，不会阻断对话。

**`Stop` 跑了但没有采集到消息**：看
`tail -n 1 "${COMEM_HOOK_TMPDIR:-${TMPDIR:-/tmp}}/comem-capture.log"`。`reason:
"no-messages"` 说明 transcript 里一条 user / assistant 消息都没解析出来，`sample`
是第一行被跳过内容的形状——对照「transcript 格式与采集诊断」的表，确认解析器是不是
选错了宿主；`reason: "no-transcript-path"` 说明宿主没给 `transcript_path`；`reason:
"transcript-read-failed"` 说明文件读不到（`error` 是 errno）。

**同一段记忆被注入两次**：召回账本由服务端维护（§8.7），hook 侧只负责发请求。
检查 `dedupTurns` 配置。

**消息重复**：游标文件被删或目录不可写（`COMEM_HOOK_TMPDIR`）。重复会被服务端按
消息 ID 去重，不影响正确性，但会多一次抽取。

**hook 报「未支持的 hook 事件」**：宿主发了一个插件不认识的事件名。到
`hosts/<host>.mjs` 的 `EVENT_NAMES` 里补一项；补之前它会被写进 stderr 并放行，
不会打断对话。

**接的是 stdio 代理，宿主报 `JSON-RPC parse error`**：stdout 被非协议内容污染了。
设 `COMEM_DEBUG=1` 重跑，日志会写到 stderr；如果 stdout 里出现了 `{"stage":…}`，
是代理的 bug（`integrations/tests/mcp-proxy.test.mjs` 的「stdout 只走协议」用例
会先挂）。

**stdio 代理报「连不上」**：`curl $COMEM_BASE_URL/health`。代理只读环境变量与
`~/.config/comem/config.yaml`，不读仓库根的 `config.yaml`——那是服务端的配置。

**stdio 代理报「拒绝了凭据（HTTP 401）」**：`COMEM_TOKEN` 没设或已失效，而 `baseUrl`
不是回环地址（回环地址会自动走回环信任）。`COMEM_BASE_URL` 是 `127.0.0.1` /
`localhost` 时不需要 token；经 nginx 或远程主机访问时必须带一把有效的 API Key。

## 测试

```bash
node --test integrations/tests/
```

不依赖 vitest：`integrations/` 是独立包，不共享后端的 devDependencies。
