# CoMem Hook 插件

装进宿主的会话召回与采集插件。它是**独立于服务端的交付物**：纯 JavaScript（`.mjs`），
只依赖 Node 内置模块，不声明任何 `dependencies`。

这个目录交付三样东西：**六个 Hook**（自动召回与采集）、**一个 stdio MCP 代理**（给
只支持本地 stdio 服务器的宿主），以及**两份提示词**（教 agent 什么时候用 MCP 工具）。
MCP 工具本身不经过这里：CoMem 在 `/mcp` 暴露 Streamable HTTP，能直连的宿主直接配
URL 即可。分工与配置片段见下面的「[MCP 接入](#mcp-接入)」。

```
integrations/
├── package.json          # type: module；bin: co-mem
├── cli.mjs               # co-mem install / doctor / uninstall
├── lib/                  # 与宿主无关的共享模块
│   ├── config.mjs        # 配置 + 宿主解析 + bypass
│   ├── http.mjs          # 超时 / 重试 / 错误封套
│   ├── dedup.mjs         # 事件去重（500ms 窗口）
│   ├── lock.mjs          # 跨进程会话锁
│   ├── cursor.mjs        # 消息游标
│   ├── filter.mjs        # sed 风格查询过滤
│   └── telemetry.mjs     # 四阶段开销上报
├── servers/              # 七个可执行入口
│   ├── session-start.mjs      # ┐
│   ├── user-prompt-submit.mjs # │
│   ├── pre-tool-use.mjs       # │ 六个 Hook：stdin JSON → stdout JSON
│   ├── post-tool-use.mjs      # │
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
# 或装好后用 bin 名
co-mem install --host claude-code
co-mem doctor
co-mem uninstall --host claude-code
```

`install` 把六条 hook 写进宿主的 settings（默认 `~/.claude/settings.json`，可用
`--settings` 指定），改之前先备份成 `<settings>.bak`。`uninstall` 只删按脚本路径
匹配到的、我们自己加的条目，别人的 hook 一个不动。

三个宿主都能用同一套命令，`--host` 取 `claude-code` / `dsh` / `codex`：

```bash
co-mem install --host codex      # 写进 ~/.codex/hooks.json
co-mem uninstall --host codex
```

| 宿主 | 默认配置文件 | 备注 |
|---|---|---|
| `claude-code` | `~/.claude/settings.json` | `hooks` 是 matcher 组数组 |
| `dsh` | `~/.dsh/settings.json` | DSH 插件所依赖的 settings 形状 |
| `codex` | `~/.codex/hooks.json` | 见下节；**首次使用需在 Codex 里信任 Hook** |

### Codex

Codex 支持完整的生命周期 Hook（`config.toml` 的 `[features].hooks`，默认开启），
事件名与 CoMem 的六个一一对应，载荷字段与 Claude Code 同形（`session_id` /
`transcript_path` / `cwd` / `hook_event_name`）。官方文档：
<https://developers.openai.com/codex/hooks>。

Codex 从 `~/.codex/hooks.json`（用户级）或 `<repo>/.codex/hooks.json`（项目级）读取
Hook，也接受 `~/.codex/config.toml` 的内联 `[hooks]` 表。`co-mem install --host codex`
写的是 `~/.codex/hooks.json`；装到项目级时用 `--settings <repo>/.codex/hooks.json`。

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

## 六个 hook

| Hook | 做什么 | 阻塞还是异步 |
|---|---|---|
| `SessionStart` | 注入 profile、偏好、`<available-skills>` 技能目录 | 阻塞（一次读 + 一次列表） |
| `UserPromptSubmit` | 拿 prompt 去 `find`，把相关记忆注入上下文 | 阻塞（§15.9 的核心开销） |
| `PreToolUse` | 拦住把 `comem://` 当本地路径的 `Read` / `Write` / `Edit`，指回 MCP 工具 | 阻塞（纯内存判断） |
| `PostToolUse` | 把工具调用与结果采集为 `tool` 消息 | 阻塞（5–20ms 的采集写入） |
| `Stop` | 采集本轮 user / assistant 消息并提交 | **主进程立刻返回**，采集与提交在分离的 worker 进程里 |
| `PreCompact` / `SessionEnd` | 把待处理消息提交完 | 阻塞，等提交完成（最多 `commitTimeoutMs`） |

`SessionEnd` 在内部归一成 `PreCompact`：两者都是「对话要没了，把手上的消息交出去」。
默认只安装表格里的六个事件；要接 `SessionEnd` 时把 `pre-compact.mjs` 再加一条即可。

### 采集为什么不阻塞

`Stop` 卡住等于把用户的输入延迟绑在 LLM 抽取上——抽取一次几秒到几十秒。所以 `Stop`
只做去重、bypass、写 worker 载荷、`spawn(detached: true)` 然后退出。worker 负责
「读 transcript → 写消息 → 前进游标 → 触发提交」。

只有 `PreCompact` / `SessionEnd` 等提交完成：这两个时机之后对话就没了，后台 worker
会被宿主杀掉。

## MCP 接入

Hook 和 MCP 是两条独立的通道，**装完 Hook 不等于接上了 MCP 工具**。

| 通道 | 谁发起 | 负责什么 |
|---|---|---|
| Hook | 宿主在固定生命周期点自动调用 | 召回注入（`SessionStart` / `UserPromptSubmit`）、采集（`PostToolUse` / `Stop` / `PreCompact`） |
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

**与宿主无关的最小配置**只有两样——一个 URL，和（`auth.enabled: true` 时）一个认证头：

```json
{ "url": "http://127.0.0.1:1933/mcp", "headers": { "Authorization": "Bearer <凭据>" } }
```

`auth.enabled: false`（v1 默认）时 `headers` 整段可以省掉。下面两节是两个具体宿主的
写法；其它宿主按它的文档把这两样映射过去即可。

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
| `COMEM_TOKEN` | `Authorization: Bearer` 的值；`auth.enabled: false` 时留空 |
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

`auth.enabled: true` 的部署要带 API Key。`${VAR}` 会在 Claude Code 读取配置时展开，
key 不用写进仓库：

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
    # auth.enabled: true 时才有意义；false 时可以整段删掉
    headers:
      Authorization: !!js '`Bearer ${process.env.COMEM_API_KEY}`'
```

`serverName` 决定模型看到的工具前缀：`mcp__comem__find`、`mcp__comem__health`。
`transport` 是必填字段，没有「默认 stdio」这回事。

### 认证

| 部署 | 请求头 | 行为 |
|---|---|---|
| `auth.enabled: false`（默认，v1 单用户） | 不需要 | 身份取 `server.subject`；带 `x-comem-subject` 且与它不一致会 401 |
| `auth.enabled: true` | `Authorization: Bearer <凭据>` | 凭据是 `comem_` 开头的 API Key，或 `POST /api/v1/auth/login` 换来的 session token；缺失或非法一律 401 `UNAUTHENTICATED` |

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
写成了 HTTP 而不是默认的 stdio；`auth.enabled: true` 时 `Authorization` 头有没有真的发出去
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
| `timeoutMs` | `COMEM_TIMEOUT_MS` | `5000` | 单次请求超时 |
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
事件去重 `{tmpdir}/comem-events.json`、worker 载荷 `{tmpdir}/comem-stop-*.json`。
`COMEM_HOOK_TMPDIR` 可以整体换一个目录（测试与多实例隔离用）。

## 宿主载荷

### Claude Code

stdin 收 JSON，公共字段 `session_id` / `transcript_path` / `cwd` / `hook_event_name`。
事件 ID 只有工具类事件能拿到（`tool_use_id`），其余为 `null`——两轮合法的 `Stop`
载荷可以完全一样，拿载荷哈希去重会吞掉第二轮。

### DSH

这一份是本插件定义并依赖的约定（DSH 的插件 hook 没有公开规范）：

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
| 提交 | `POST /api/v1/sessions/{id}/commit` | 2xx；是否真的归档由服务端 `session.autoCommit` 决定 |
| 开销上报 | `POST /api/v1/telemetry/hook`，`{event, sessionId, phases}` | 任意；失败静默 |
| 自检 | `GET /health` | 2xx |

## 三层去重

1. **事件去重**：同一个 `eventId` 在 500ms 窗口内只处理一次。窗口落在
   `{tmpdir}/comem-events.json`——内存 Map 出了进程就没了，挡不住跨进程重投。
2. **消息去重**：游标之后的消息才提交。**游标只在服务端确认接收后前进**：没确认
   就重投，宁可重复不能丢。
3. **跨进程锁**：同一个 session 的多个 hook 进程用 `{tmpdir}/comem-{sid}.lock`
   串行化（`wx` 原子创建 + 过期时间，不做心跳）。

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

**stdio 代理报「拒绝了凭据（HTTP 401）」**：`COMEM_TOKEN` 没设或已失效。`auth.enabled:
false` 的部署不要设它（设了也不比对，但别让一个过期的 key 留在环境里误导排查）。

## 测试

```bash
node --test integrations/tests/
```

不依赖 vitest：`integrations/` 是独立包，不共享后端的 devDependencies。
