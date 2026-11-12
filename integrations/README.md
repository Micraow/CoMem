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
│   ├── hook-runner.mjs   # 入口骨架：stdin → 归一化 → 预算 → 信封（两个 hook 宿主共用）
│   ├── lifecycle.mjs     # 总预算 / stdin 上限 / 诊断与兜底退出
│   ├── is-main.mjs       # 入口判定：被直接执行还是被测试 import（六个入口共用）
│   ├── values.mjs        # 载荷取值：asRecord / text / renderToolOutput / describeEntry
│   ├── events.json       # 事件名映射表（宿主 PascalCase ↔ 内部 snake_case）
│   ├── events.mjs        # 读上面那张表，导出 EVENT_NAMES / REPORTED_EVENT_NAMES
│   ├── dedup.mjs         # 事件去重（500ms 窗口）
│   ├── lock.mjs          # 跨进程会话锁
│   ├── cursor.mjs        # 消息游标
│   ├── recall.mjs        # 跨轮召回账本（已注入的 URI，防重复投喂）
│   ├── sanitize.mjs      # 捕获侧剥离（去掉自己注入的块）
│   ├── injection.mjs     # 注入侧渲染：转义 / 索引截断 / 字节上限
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
│   └── codex.mjs
├── dsh-plugin/           # DSH 原生插件（独立包，装进 profile）
│   ├── package.json      # main / engines.dsh
│   ├── lib/index.js      # 五个接缝的订阅者
│   └── README.md         # 安装、配置与已知限制
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

**能用 `install` 装的是两个宿主**，`--host` 取 `claude-code` / `codex`。DSH 用原生
插件接入（`integrations/dsh-plugin/`），不走 `install`：

```bash
co-mem install --host codex      # 写进 ~/.codex/hooks.json
co-mem uninstall --host codex
```

| 宿主 | 默认配置文件 | 备注 |
|---|---|---|
| `claude-code` | `~/.claude/settings.json` | `hooks` 是 matcher 组数组 |
| `codex` | `~/.codex/hooks.json` | 见下节；**首次使用需在 Codex 里信任 Hook** |
| `dsh` | —（`install` 直接失败） | 见「[DSH](#dsh)」：接缝是 Cordis 插件，不是 settings 里的 hook |

### DSH

**DSH 没有 hook 脚本面。** 它的生命周期点是**同一进程内 Cordis 插件订阅的 typed
事件**（`agent/created`、`agent/pre-step`、`tools/*`、`session/event`、`agent/disposed`），
宿主不会执行 `integrations/servers/*.mjs` 这样的命令。所以 CoMem 在 DSH 上的接入物
是 `integrations/dsh-plugin/` 这个独立包，**不是** `install --host dsh`。

**`co-mem install --host dsh` 会在写第一个字节之前失败，这是刻意的。** 报错指向
插件安装步骤，不再给桥接方案：把 Claude Code 的 `hooks.json` 翻译到 DSH 的
`@deepseek-ai/dsh-hooks-claude-code` / `dsh-hooks-codex` 只实现 5 个事件
（没有 `PreCompact` / `SessionEnd`），而且 `transcript_path` 恒空、`Stop` 采不到
消息——接完看起来像成功，实际上两件事没工作。

```bash
# 1. 装进 profile（link 到仓库，插件按相对路径引用 integrations/lib/）
dsh plugin --profile web add "link:$PWD/integrations/dsh-plugin"

# 2. 在 $DSH_HOME/profiles/web/cordis.patch.yml 里加一条 insert
```

```yaml
- insert:
    - id: comem
      name: comem-dsh-plugin
      config:
        baseUrl: http://127.0.0.1:1933
        token: ''            # 非回环时必须给
        timeoutMs: 5000
```

```bash
# 3. 不启动也能验证组合成功
dsh --profile web --dump-config | grep -A6 'id: comem'
```

插件在五个接缝上做与 hook 等价的事：

| 接缝 | 等价于 | 行为 |
|---|---|---|
| `agent/created` | `SessionStart` | 调 `handleSessionStart`，把画像 / 偏好 / 技能索引 `agent.inject()` |
| `agent/pre-step` | `UserPromptSubmit` | 先 `await next()`；本步没有用户消息就原样返回；否则调 `handleUserPromptSubmit` 并把块折进 `decision.messages` |
| `session/event` 的 `turn/end` | `Stop` | 本轮 user / assistant 消息过 `lib/sanitize.mjs` 剥离后 `POST /sessions/{id}/messages` + `/commit` |
| `agent/disposed` | `SessionEnd` 的近似物 | 尽力把还没交出去的消息发一次（emit 模式，没人等它） |
| `session/event` 的 `compaction/start` | `PreCompact` | **做不到**：压缩开始时才能观察到，只记一条 warn |

**已知限制**（细节见 `integrations/dsh-plugin/README.md`）：压缩前不能拦截；没有
真正的 `SessionEnd`，进程被强杀时最后半轮会丢；工具调用/结果不采集；召回账本按
进程共享一个文件，并发会话下去重变弱；采集缓冲只在内存里，DSH 重启即丢。子 agent
会话（`header.origin === 'subagent'`）不注入、不采集。

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

**这张表是「hook 脚本」这条路的七个事件。** DSH 上没有 hook 脚本，原生插件只覆盖
其中五个接缝（没有 `PreToolUse` / `PostToolUse`，`PreCompact` 只能事后 warn），
见「[DSH](#dsh)」。

### 事件名与开销上报

两套事件名分居两侧，对应关系只写在 `lib/events.json`：

| 字段 | 含义 |
|---|---|
| 键（对象键） | 内部事件名，`session_start` 等 snake_case，也是 `/telemetry/hook` 的 `event` |
| `hostEventName` | 宿主发的名字，`SessionStart` 等 PascalCase |
| `reportsOverhead` | 这个事件是否上报阻塞开销 |

`lib/events.json` 是这张表的唯一一份，`lib/events.mjs` 从它导出 `EVENT_NAMES`（7 个）
与 `REPORTED_EVENT_NAMES`（6 个）。两个 hook 宿主共享这张表——各写一份时，事件名
对不上会让 `/metrics` 里的样本全部塌进 `event="other"`。DSH 插件不经过这张表的
宿主名一侧，它直接用内部事件名调 handler。

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
| `<comem-profile>` | `SessionStart` | 索引：`- [profile] 摘要 · comem://…` | 一次性档案；要看细节用 `read` 取 URI |
| `<comem-preferences>` | `SessionStart` | 索引：一条偏好一行 | 历史默认，与当前请求冲突时以当前请求为准；细节用 `read` |
| `<available-skills>` | `SessionStart` | `- 名字: 描述` | 技能目录，不是记忆 |
| `<comem-recall>` | `UserPromptSubmit` | `1. [类型] comem://…` + 缩进摘要 | 本轮召回结果，直接 `read` |

**`<comem-recall>` 里没有分数。** 分数只在同一次检索的同一引擎内可比（§13.2），写进
注入块会暗示一个不存在的精度；顺序是这里唯一稳定的信息，所以只编号。

**偏好按目录列，不能拼 `.overview.md`。** `.abstract.md` / `.overview.md` 是保留名
（`src/domain/uri.ts` 的 `RESERVED_SEGMENT_NAMES`），`Uri.parse` 对它们抛
`INVALID_URI`（HTTP 400）。`SessionStart` 因此走
`GET /api/v1/fs/ls?uri=comem://user/{uid}/memories/preferences`（参数是**目录**），
再对每个直接子文件 `GET /content/abstract` 取摘要。曾经这里直接 `content/read`
文件名、再用 `.catch(() => null)` 吞掉 400——`<comem-preferences>` 从上线起就没注入
过，而文件一直在盘上。读取失败（不是 403 / 404）现在记一条 stderr 的 `warn`。

**注入的是索引，不是正文。** 块首固定一句「以下是记忆索引。需要细节时用 read 工具
按 URI 读原文」，之后每条记忆一行。摘要来自服务端 `GET /content/abstract`（文件的
L0 在索引里，目录的 L0 是 `.abstract.md`），**不在 hook 里截断正文**：那是第二个
摘要实现。没有 URI 的索引等于删数据，所以没有摘要时也保留 `- [类型] comem://…`。
偏好目录一次最多为 32 条拉摘要（`PREFERENCES_INDEX_ENTRY_LIMIT`，经验上界），超出
的部分写「（已截断，共 M 条）」。

### 注入预算契约

`SessionStart` 的三个块（`<comem-profile>` / `<comem-preferences>` / `<available-skills>`）
都有硬上限。超过宿主上限不是「多一点上下文」，而是**整段被转存成文件、模型只看到
预览**——注入静默失效。

| 约束 | 值 | 超了怎么办 |
|---|---|---|
| 画像 token 预算 | `profileBudgetTokens`，默认 2000 | 索引只有一条记忆（一行），实际不触发 |
| 偏好 token 预算 | 画像预算的 1/4，默认 500 | 按条目从后往前截，至少保留 1 条 + 「（已截断，共 M 条）」 |
| 技能目录 token 预算 | `skillBudgetTokens`，默认 400 | 全放 → 只名字 → 一行计数 |
| 宿主字节上限 | Claude Code 9,500 / Codex 9,500 / DSH 插件 9,500 | 按 `CONTEXT_BLOCK_DROP_ORDER` 降级：技能目录 → 召回 → 偏好 → 画像，记一条 `warn` |

**只注入摘要 + URI。** 画像与偏好的正文不再进上下文：`profile.md` 的 YAML
frontmatter 对模型是噪声，而正文按 157 字/归档增长。模型要细节时用 `read` 取
索引里的 URI——服务端 `content/read` 接受的就是这个地址。

**token 估算按文本自身的 CJK 密度**：`ceil(CJK 码点数 × 1 + 其余码点数 × 0.25)`。
常用的 `chars / 4` 对中文**低估 6 倍**（1000 个汉字约 1000–1500 token，不是 250），
用它判预算会让中文画像超上限 4–6 倍。公式与 `src/domain/session.ts` 的
`estimateTokens` 是同一份（Hook 不依赖 `src/`，所以有一份副本；**改一处要改两处**）。

**降级顺序是显式的，从最先丢到最不该丢。** 判据是「丢了之后还能不能拿回来」：
技能目录是可选能力清单，模型不靠它也能工作；`<comem-recall>` 每轮重新检索，下一轮
还有机会；偏好能用 `find` / `list` 按需取回，先截条目；画像（「这个用户是谁」）是
唯一不可恢复的，最后才动，且至少保留一条带 URI 的记录。顺序定义在
`integrations/lib/injection.mjs` 的 `CONTEXT_BLOCK_DROP_ORDER`，不靠块的插入位置。
索引化之后三个块的实际占用在 1–2 KB 量级，9,500 字节的上限正常不会触发；这条链
挡的是偏好目录异常增长与部署方调低宿主上限。

**宿主字节上限的来源是宿主的实现细节，不是公开规范。** Claude Code / Codex 在 hook
输出超过约 10,000 字符时转存文件、只放预览，这里取 9,500 留余量。两个数在
`hosts/*.mjs` 的 `MAX_CONTEXT_BYTES`，**没有独立复测**——真实上限更低时调小，不要
指望宿主报错，它只会静默降级成预览。**DSH 插件没有「hook 输出上限」这回事**（注入
发生在进程内），它仍用 `DEFAULT_MAX_CONTEXT_BYTES`（9,500）当保守上限，让显式的
降级顺序在偏好目录异常增长时照常生效。

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
| `profileBudgetTokens` | `COMEM_PROFILE_BUDGET_TOKENS` | `2000` | 画像索引的 token 预算（画像只有一条记忆，实际不触发）；偏好索引取它的 1/4，超了按条目截断并写「（已截断，共 M 条）」（见「注入预算契约」） |
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
`lib/config.mjs` 按名字动态 import `hosts/<name>.mjs`。加一个 hook 宿主只加一个
文件，`servers/` 里一行都不用改。宿主之间不互相 import（信封与 `parseTranscript`
各自独立），但**入口骨架与载荷取值共用 `lib/`**：`lib/hook-runner.mjs` 的
`createRunHook` 拿宿主的 `normalizeEvent` / `formatOutput` 当参数，`lib/values.mjs`
放四个取值助手。DSH 不在 `hosts/` 里——它是插件，不从 stdin 收载荷。

**临时文件**：锁 `{tmpdir}/comem-{sessionId}.lock`、游标 `{tmpdir}/comem-cursors.json`、
事件去重 `{tmpdir}/comem-events.json`、召回账本 `{tmpdir}/comem-recall-ledger.json`、
worker 载荷 `{tmpdir}/comem-stop-*.json`、采集诊断 `{tmpdir}/comem-capture.log`
（超过 256 KiB 整份重写）。`COMEM_HOOK_TMPDIR` 可以整体换一个目录（测试与多实例
隔离用）。

## 宿主载荷

### Claude Code

stdin 收 JSON，公共字段 `session_id` / `transcript_path` / `cwd` / `hook_event_name`。
事件 ID 只有工具类事件能拿到（`tool_use_id`），其余为 `null`——两轮合法的 `Stop`
载荷可以完全一样，拿载荷哈希去重会吞掉第二轮。

### DSH

**没有「host 载荷」这一层。** DSH 不发 hook JSON、不读 `transcript_path`、没有
返回信封；插件直接拿到 typed 事件（见上面的「[DSH](#dsh)」）。插件把事件翻成
`handleSessionStart` / `handleUserPromptSubmit` / `ensureSession` 认识的事件形状，
再把 `{context}` 折进 `agent.inject()` / `decision.messages`。所以 `hosts/dsh.mjs`
不存在，`--host dsh` 也不会被任何脚本用到。

### transcript 格式与采集诊断

`Stop` / `PreCompact` / `SessionEnd` 采集的是**宿主自己写出的 transcript 文件**，
格式按宿主不同，由各自的 `hosts/<host>.mjs` 里的 `parseTranscript` 解析，
`servers/stop.mjs` 不内置任何一种：

| 宿主 | transcript 在哪 | 行形状 |
|---|---|---|
| Claude Code | 载荷里的 `transcript_path` | 每行 `{uuid, type, message: {role, content: [{type: 'text', text}]}}`；`isSidechain`（子 agent）与工具调用跳过 |
| Codex | `~/.codex/sessions/<日期>/rollout-*.jsonl` | 每行 `{timestamp, ordinal, type, payload}`；只取 `type: "response_item"` 且 `payload.type: "message"` 的行，`content[*].text`（`input_text` / `output_text`）按换行拼接；`developer`、空文本与 `function_call` / `reasoning` 跳过 |
| DSH | 插件直接读事件 | 不走 transcript：插件的 `session/event` 监听器把本轮 `user/message` / `assistant/message` 收进内存缓冲，`turn/end` 时剥离并提交。没有文件路径，也没有 `comem-capture.log` 这条诊断（失败进 DSH 日志的 `comem:` warn） |

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

## 注入与捕获的去重

上面那四层解决的是「同一条消息别提交两次」。这里解决的是**另一个方向**：CoMem
往宿主上下文里注入的四个块（`<comem-recall>` / `<comem-profile>` /
`<comem-preferences>` / `<available-skills>`）会留在会话里，下一轮 `Stop` 读
transcript 时，它们与用户真的说过的话长得一模一样。原样处理有两个后果：

- **捕获侧**：上一轮注入的记忆被当成「用户这轮说的话」重新抽取一遍，跑几轮之后
  记忆库开始复读自己；
- **注入侧**：一条记忆的正文里若含 `</comem-recall>` 或 `</available-skills>`，
  模型会把它当成块边界，后面跟着的正文就成了伪造的指令。

三个机制各管一段，代码分别在 `lib/sanitize.mjs`、`lib/injection.mjs` 的
`escapeInjectionText`、`lib/recall.mjs`。

### 1. 捕获侧剥离（`lib/sanitize.mjs`）

在**发 HTTP 之前**对每条消息的文本做一次剥离，三种规则按固定顺序作用：

| 规则 | 匹配 | 为什么 |
|---|---|---|
| 块级 | `<comem-recall>…</comem-recall>`、`<comem-profile>`、`<comem-preferences>`、`<available-skills>`、`<system-reminder>` | 这些是 CoMem 与宿主写给模型看的，不是对话 |
| 行级 | 行首 `[2024-01-01T00:00:00Z]` | 宿主给消息加的时间戳，进抽取器是纯噪声 |
| 兜底 | 裸 epoch `\b1[6-9]\d{8}\b`、`\b1[6-9]\d{11}\b` | 同上；**只在整条消息剥完块之后**做，否则会吃掉正常数字 |

**块用「开标签 → 最近的闭标签」剥，不是贪婪正则。** `<comem-recall>[\s\S]*</comem-recall>`
会从第一个开标签吃到最后一个闭标签：同一段文本里有两个块时，中间用户真正写的
内容被一起删掉。开标签找不到闭标签时吃到消息末尾——留半截注入块比多删更糟。
嵌套剥离留下的孤立标签也会清掉。

剥完变空（或只剩空白）的消息**整条丢弃**，不发空串给服务端。游标按剥离后的
条数推进：下一轮同一份 transcript 会剥出同样的前缀，两个计数不会漂移。

**三个入口走同一个函数。** `servers/stop.mjs` 的 `captureSession` 剥对话消息
（两种来源：载荷里的累积列表、transcript 解析结果），`servers/post-tool-use.mjs`
的 `toToolMessage` 剥工具输出——`cat` 一份 transcript 时，里面的注入块不是工具
结果，原样落盘会让它以工具结果的身份回到记忆库；DSH 插件的 `turn/end` 也调同一个
`sanitizeCapturedMessages`。**不在宿主适配器里各剥一次**：宿主适配器只回答「怎么
解析」，剥离是「发出去之前」的一件事。

**五个标签按完整名字列，不靠前缀。** `available-skills` 不带 `comem-` 前缀，靠
`comem-*` 匹配兜不住它；注入侧的转义表（`INJECTION_TAG_PREFIXES`）必须与这里的
`BLOCK_TAGS` 同步，否则只剥一半（或者只转义一半）。

### 2. 注入侧转义（`lib/injection.mjs` 的 `escapeInjectionText`）

渲染块之前把记忆正文里的注入标签的 `<` 换成 `‹`（U+2039）。`INJECTION_TAG_PREFIXES`
里有两个前缀：`comem-`（三个 `comem-*` 块）与 `available-skills`（技能目录块）。
换完仍然可读（`‹/comem-recall>` 像引用了一段标签名），但不再是标签，块的边界
只有一个。用例钉住这条性质：正文含 `</comem-recall><comem-recall>` 或
`</available-skills>` 时，渲染结果里每种开标签与闭标签各只有一个。

为什么不是反斜杠、也不是删掉标签：反斜杠会把「转义链」引进来（Markdown 一层、
JSON 一层，模型对它是字面量还是转义的判断不稳定）；删掉标签则改变了记忆本身。

**转义覆盖两个前缀，宿主自己的标签不覆盖。** `<system-reminder>` 这类标签留给
宿主处理：转义它会让记忆正文里正常的引用变形，而伪造宿主标签的收益远低于伪造
召回块（模型按 `<comem-recall>` 判断「这是记忆」）。

### 3. 跨轮账本（`lib/recall.mjs`）

`UserPromptSubmit` 每轮检索 top-k 并注入；账本记「这个会话已经投喂过哪些 URI」，
下一轮检索后按 URI 排除。用户连续问三个相关问题时，同一段记忆不会被完整注入
三次。

- **位置**：`{tmpdir}/comem-recall-ledger.json`，与游标、事件去重同一个目录
  （`COMEM_HOOK_TMPDIR` 可整体替换）。hook 是短命进程，跨轮状态只能靠文件；
  hook 也拿不到服务端的 `dataDir`（插件可能装在另一台机器上）。账本丢了只影响
  去重强度，不影响正确性——放 `/tmp` 正好。
- **形状**：`{"sessionId": "cc-…", "uris": [...]}`。**只存一个会话**：`sessionId`
  变了就整份替换，这就是「会话切换 → 账本重置」，也把文件大小钉死在 200 条。
- **上限**：200 条，超出按 FIFO 淘汰（重复 URI 先删再追加，所以淘汰的是最早
  投喂的）。
- **关键规则：本轮一条都没注入时不写账本。** 「没给过」不等于「给过了」——写了
  会让这些记忆在去重窗口内被静默压制，下一轮真相关时召不回来。
- **欠额补偿**：客户端过滤不会让服务端补位，所以检索时多要
  `min(已投喂条数, recallLimit)` 条（最多多要一倍）。不能跟着账本上限 200 走：
  服务端按 `limit × candidateMultiplier` 取候选，210 条会把它放大到 840 条，把
  每轮按回车的延迟绑在检索上。

**服务端的「排除 URI」参数：`POST /search/find` 没有。** 服务端有召回账本
（`docs/architecture.md` §8.7），但它的去重入口只在 `POST /search/search` 的
`mode=context` 上；hook 走的 `find` 不接受排除列表。让 hook 改走 `mode=context`
是换一条出口（组装、预算、渲染全变），不是加一个参数。所以 v1 在 hook 侧记一份、
客户端过滤；服务端加参数属于 API 变更，另行决定。

### 误伤与已覆盖

剥离规则认的是字符串，不是「这是不是真的注入」。以下正常文本会被吃掉：

| 文本 | 结果 |
|---|---|
| 讨论 CoMem 时贴出的 `<comem-recall>…</comem-recall>` 示例 | 整段消失 |
| 行首的 `[2024-01-01T00:00:00Z]` 日志片段 | 时间戳消失，其余保留 |
| 恰好是 `16…`–`19…` 开头的 10 / 13 位数字（部分订单号、`1700000000000` 这类 epoch 毫秒） | 数字消失，两边的空格留下 |
| 只有开标签、没有闭标签的一段（用户手写了一半） | 从开标签吃到消息末尾 |

剥离失败的方向是「少吃」，不是「多吃」——多吃的代价是把用户的话当成注入。

**已覆盖**（都曾出现在残余清单里，现在两侧各有用例钉住）：

- **`<available-skills>` 两侧都处理。** 捕获侧把它列进 `BLOCK_TAGS`（技能目录以
  用户消息形式进 transcript 时整段剥掉），注入侧把它列进 `INJECTION_TAG_PREFIXES`
  （一条记忆作为技能描述时含 `</available-skills>`，渲染出来是
  `‹/available-skills>`，关不掉目录块）。
- **`PostToolUse` 的工具输出也剥离。** `toToolMessage` 调同一个
  `sanitizeCapturedText`。工具输出只由注入块组成时发空串——服务端的
  `requireStringField` 只校验 `typeof === 'string'`，空串是合法值；非字符串原样
  透传，形状由宿主决定。
- **`Stop` 的 worker 载荷文件存原始事件。** 载荷里是宿主给的未处理消息，剥离在
  `captureSession` 里做——那里同时要「剥离前的条数」区分「这一轮只有注入块」与
  「transcript 格式不匹配」。唯一读者是 `runCaptureWorker`，所以这不是缺陷；文件
  里的注释说明了外部工具读它时要自己调 `sanitizeCapturedMessages`。

**残留（设计取舍，不改）：**

- **`SessionStart` 注入的块不记账。** 账本记的是「`UserPromptSubmit` 这一轮已经
  以召回块形式投喂过哪些 URI」，它防的是同一段记忆每轮重复完整注入；画像、偏好与
  技能目录每局只注入一次，本来就没有重复。反过来把它们的 URI 记进账本，下一轮
  `find` 会按「已投喂」把它们过滤掉（`hits.filter((hit) => !deliveredSet.has(hit.uri))`）
  ——而画像往往正是会话开头最相关的命中，静默压制它等于让第一轮召回变空。

用例在 `tests/sanitize.test.mjs`（纯函数，含 1MB 输入耗时）、
`tests/post-tool-use.test.mjs`（工具输出剥离与非字符串透传）、
`tests/session-start.test.mjs`（技能目录的转义）、`tests/recall.test.mjs`（真落盘
的账本）、`tests/user-prompt-submit.test.mjs`（转义与跨轮去重的接入）与
`tests/stop.test.mjs`（发 HTTP 前剥离）。

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

**同一段记忆被注入两次**：hook 侧的账本是
`${COMEM_HOOK_TMPDIR:-${TMPDIR:-/tmp}}/comem-recall-ledger.json`（见上面的「注入与
捕获的去重」）。目录不可写时去重静默失效，stderr 有一行 `召回账本写入失败`。服务端
的召回账本（§8.7）只作用于 `POST /search/search` 的 `mode=context`，hook 走的是
`find`，`dedupTurns` 对它无效。

**记忆库开始复读自己**：上一轮的注入块被当成用户的话重新抽取了。检查
`lib/sanitize.mjs` 的块标签表是否覆盖了宿主实际写的标签——宿主新增一种带外提示
（像 `<system-reminder>` 那样）时，采集侧要一起加。

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
