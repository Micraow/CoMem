# CoMem Hook 插件

装进宿主的会话召回与采集插件。它是**独立于服务端的交付物**：纯 JavaScript（`.mjs`），
只依赖 Node 内置模块，不声明任何 `dependencies`。

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
├── servers/              # 六个可执行入口，stdin JSON → stdout JSON
│   ├── session-start.mjs
│   ├── user-prompt-submit.mjs
│   ├── pre-tool-use.mjs
│   ├── post-tool-use.mjs
│   ├── stop.mjs
│   └── pre-compact.mjs
├── hosts/                # 宿主适配（信封与载荷）
│   ├── claude-code.mjs
│   └── dsh.mjs
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
| `recallLimit` | `COMEM_RECALL_LIMIT` | `10` | `find` 的条数 |
| `recallScoreThreshold` | `COMEM_RECALL_SCORE_THRESHOLD` | `0.5` | 相对阈值：只保留分数不低于本次最高分 × 该值的命中（§15.9 的「三条前提」之二） |
| `skillBudgetTokens` | `COMEM_SKILL_BUDGET_TOKENS` | `400` | 技能目录的独立 token 预算（§15.2） |
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
| 建会话 | `POST /api/v1/sessions`，`{sessionId, userId}` | 2xx；409 视为已存在 |
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

## 测试

```bash
node --test integrations/tests/
```

不依赖 vitest：`integrations/` 是独立包，不共享后端的 devDependencies。
