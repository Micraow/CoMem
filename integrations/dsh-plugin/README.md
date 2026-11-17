# CoMem 的 DSH 原生插件

装进 DeepSeek Harness（DSH）profile 的 Cordis 插件。它取代了「用脚本 hook 接 DSH」
那条路：DSH **没有 hook 脚本面**，它的生命周期是同一进程内的 typed 事件，只能用
插件订阅。

插件在开局注入个人背景正文与技能目录，每轮请求服务端自动上下文，通过 `tools/post-execute` 采集工具调用与结果，`turn/end` 时归档消息，`agent/disposed` 时尽力补交，`compaction/start` 时重置召回上下文并提示压缩前不会额外归档。

| 接缝 | 等价于 | 行为 |
|---|---|---|
| `agent/created` | `SessionStart` | 调 `servers/session-start.mjs` 的 `handleSessionStart`，把返回的块 `agent.inject()` |
| `agent/pre-step`（waterfall） | `UserPromptSubmit` | 先 `await next()`；本步没有用户消息就原样返回；否则调 `handleUserPromptSubmit`，把块折进 `decision.messages` |
| `tools/post-execute` | `PostToolUse` | 采集调用与结果，保留底层 decision |
| `session/event` 的 `turn/end` | `Stop` | 本轮 user / assistant 消息过 `lib/sanitize.mjs` 的剥离，再 `POST /sessions/{id}/messages` + `POST /sessions/{id}/commit` |
| `agent/disposed` | `SessionEnd` 的近似物 | 把会话缓冲里还没交出去的消息发一次 |
| `session/event` 的 `compaction/start` | `PreCompact` | 不额外归档，重置 context epoch 并记 warn（见「已知限制」） |

**没有第二份渲染、预算、转义或剥离逻辑。** 块怎么拼、怎么截断、怎么转义、哪些
消息该剥，全部在 `integrations/lib/` 与 `integrations/servers/` 里；本插件只做
「DSH 载荷 ↔ 这些 handler 的事件形状」的翻译。改注入格式时改 `lib/`，插件不用动。

## 安装

插件以仓库内的 `link:` 方式装进 profile（它按相对路径引用 `integrations/lib/`，
不支持单独发布到 npm）：

```bash
# 1. 装进 profile（这会改 profile 的 package.json 与 node_modules）
dsh plugin --profile web add "link:$PWD/integrations/dsh-plugin"

# 2. 在 profile 的 patch 层里挂上插件（见下一节）
$EDITOR "${DSH_HOME:-$HOME/.dsh}/profiles/web/cordis.patch.yml"

# 3. 不启动也能验证组合成功
dsh --profile web --dump-config | grep -A6 'id: comem'
```

`--dump-config` 只证明条目被 loader 接受、组合进了 profile 树；它不证明插件被
`apply` 过。要验证运行时，起一次 DSH 会话，看日志里有没有 `comem:` 开头的 warn、
以及 CoMem 的游标 / 会话有没有变化。

## 配置

```yaml
# $DSH_HOME/profiles/<name>/cordis.patch.yml
- insert:
    - id: comem
      name: comem-dsh-plugin
      config: {}
```

| 键 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `baseUrl` | 否 | 共享配置或 `http://127.0.0.1:1933` | 显式覆盖共享 `config.yaml` / `COMEM_BASE_URL` |
| `token` | 否 | 配置文件里的值 | `Authorization: Bearer`。显式写空串会覆盖配置文件 / 环境变量里的 token |
| `timeoutMs` | 否 | `5000` | 普通请求的单次 HTTP 超时；每轮召回使用独立总预算 |
| `recallTimeoutMs` | 否 | `2000` | 每轮召回总预算（1000–29000ms）。不填时读客户端配置文件或环境变量 |

默认配置来自 `~/.config/comem/config.yaml`（或 `COMEM_CONFIG_FILE` 指定的文件；
`COMEM_*` 环境变量优先），与 Hook 和 stdio MCP 代理完全同一套。可放：
`baseUrl`、`token`、`recallTimeoutMs`、`recallLimit`、`queryFilters`、
`profileBudgetTokens`、`skillBudgetTokens`、`commitTimeoutMs`、`tmpDir`。
`token` 必须写真实值；这个加载器不做 `${ENV}` 插值。身份来自服务端认证，不需要
重复填写用户 ID。需要和其他 Agent 绑定同一账号时，把同一 API Key 写入共享文件，
再用 `co-mem doctor --expect-subject user:<id>` 核对。服务端与插件应同步升级以
支持 `/context`。

配置文件不存在时使用默认值；文件存在但解析失败时，插件只记录一条 warn 并停用
注入与采集，不会退回默认地址写入别的身份。

总预算沿用 hook 的那张表（`integrations/lib/lifecycle.mjs` 的 `HOOK_BUDGETS_MS`）：
开局注入最多 4s，每轮召回最多 2s，提交用 `commitTimeoutMs`（默认 30s）。区别是
**进程内没有 30–50ms 的进程启动开销**，上报里的 `processStartMs` 是 0。

## 实现要点

- **只处理顶层会话。** 子 agent 会话（`session.header.origin === 'subagent'`）不注入、
  不采集；否则每次委派都会把画像再投一遍，子 agent 的对话也会作为独立会话入库。
- **注入消息的来源 `kind` 是 `comem`。** 下一轮取 prompt 时只认 `source.kind === 'user'`，
  注入块不会被当成用户说的话再检索一次。采集侧还有 `lib/sanitize.mjs` 的二次剥离。
- **召回块由服务端去重。** `/context` 按会话、epoch 和内容指纹记账；`agent/pre-step` 的空批次判断只负责
  「同一轮的 tool step 不重复检索」。
- **提交失败不丢消息。** `turn/end` 的 POST 失败时缓冲保留，下一次 `turn/end` 重投；
  服务端按消息 `id` 幂等（DSH 的消息 ID 原样用作 CoMem 消息 ID）。`agent/disposed`
  是最后一次尝试，失败就丢并在日志里留一条 warn。
- **异常不外溢。** `agent/created` 监听器抛错会让会话创建失败，`agent/pre-step`
  抛错会让这一轮失败。所有接缝都吞异常并 `ctx.logger.warn`，然后返回底层 decision。

## 已知限制

这些是 DSH 的事件面本身决定的，不是实现没做完：

1. **压缩前不会额外归档。** DSH 用 `compaction/start` 标记压缩开始；订阅者只能观察
   到这个事件已经发生，没有可拦截的 pre-compact 接缝。压缩前没交出去的消息仍在会话
   里，下一次 `turn/end` 会提交；但「压缩前强制提交一次」这件事做不到。插件在
   `compaction/start` 记一条 warn。
2. **没有 `SessionEnd` 的真等价物。** DSH 的 `agent/disposed` 是 emit 模式、没有人
   等它，进程退出时也不保证调用。它只能尽力补交；真正的保证仍是每条 `turn/end`。
   进程被强杀时，最后半轮消息会丢。
3. **工具采集使用 `tools/post-execute` typed 接口。** 调用名、callId、arguments 与结果配对，保留后续策略决定；文本经过公共注入剥离。只有限定 shell 环境命令可进入长期事实抽取，任意工具输出不会直接交给抽取模型。
4. **压缩更新上下文 epoch。** 不同会话按 session.id 隔离；agent.id 不作为持久会话 ID。既有已投放内容无法从宿主历史中撤回。
5. **跨会话的状态只在本进程内。** 采集缓冲、提交队列都在内存里；DSH 重启即丢。
   这是「尽力」而不是「至少一次」——hook 那条路的游标可以做到至少一次，插件不在
   磁盘上维护游标。
6. **CoMem 不可达时，会话创建最多多等 4 秒。** `agent/created` 是 serial 事件，
   监听器返回的 Promise 会被 awaited（这是把画像排进第一步的代价）；超时预算是
   `HOOK_BUDGETS_MS.session_start`。每轮召回同理最多 2 秒，之后退化成「本轮没有记忆」。
7. **不含 MCP 工具。** 插件只做自动召回与采集；MCP 仍按
   `integrations/README.md` 的「MCP 接入」单独配（`dsh-mcp-client`）。只装插件时
   agent 拿不到 `remember` / `find` 这类工具。

## 卸载

```bash
dsh plugin --profile web remove comem-dsh-plugin
```

再从 `cordis.patch.yml` 删掉 `comem` 那条 `insert`。两边都做完才算卸载：只删依赖
时 patch 里会留下一条找不到插件的条目（DSH 启动时会报 patch 错误）。
