---
name: comem-memory
description: 用 CoMem 召回与持久化跨会话的上下文。用户提到以前的会话（「上次」「之前定过的」）、让你记住什么、给你文件或链接、或任务需要本会话没有的背景时用。闲聊、算术、一次性的公共事实不要用。
---

# CoMem Memory

CoMem 把上下文存在 `comem://` 地址下，跨会话、跨机器、跨队友共享。它有两种接入：**Hook**（宿主在生命周期点自动注入与采集）和 **MCP 工具**（你主动调用）。两条通道读写同一份数据。

## 上下文里已经有什么

`SessionStart` 和每次 `UserPromptSubmit` 都可能往对话里塞块。**先读完再决定要不要调工具**——这些都是已经付过延迟的信息：

| 块 | 谁注入 | 是什么 | 怎么用 |
|---|---|---|---|
| `<comem-profile>` | SessionStart | 用户档案：谁在用、什么背景 | 不用再查 |
| `<comem-preferences>` | SessionStart | 偏好与工作方式 | 与当前请求冲突时**以当前请求为准**；偏好是历史默认 |
| `<available-skills>` | SessionStart | 可用技能包的名字，可能只有名字 | 这是**技能**不是记忆，别拿去 `find` |
| `<comem-recall>` | UserPromptSubmit | 与本轮 prompt 相关的记忆，每条 `1. [类型] comem://…` 加缩进摘要 | 直接 `read` 那个 URI 拿正文 |

`<comem-recall>` 里的条目**不带分数**，别凭它排序——顺序就是相关度顺序。它没有出现只代表这一轮没命中，不代表库里没有。

## 什么时候主动召回

**满足任一条才召回**：要改文件 / 跑命令 / 多步交付；碰一台你或用户以前碰过的机器、仓库、服务；正在从失败里恢复；用户明确指向过去（「上次」「之前」「那个方案」）。

**这些情况不要召回**：闲聊与寒暄；模型自己能答的公共事实；`<comem-recall>` 已经给出答案；本轮已经为同一个问题 `find` 过（重复检索只会拿到同一批结果）。

按「你知道多少」选工具：

- 只知道大概是什么 → `find { "query": "…", "limit": 5 }`
- 有明确指代（「它」「继续」「上面那个」）→ `search { "query": "…", "sessionId": "<当前会话 id>" }`，代价是一次模型调用
- 已经知道确切路径 → `read { "uri": "…" }`，别绕 `find`
- 知道字面串（符号名、报错原文）→ `grep { "uri": "~/memories", "pattern": "…" }`
- 知道文件名 → `glob { "uri": "~/memories", "pattern": "**/*.md" }`
- 动手之前要知道有哪些硬性规则 → `rule_search { "taskContext": "…" }`，见 `comem-rules` 技能

**最多一次跟进检索。** 没命中就承认没有记忆，带着不确定性继续做；执行中出现**性质不同的**新失败才再查一次。

## 什么时候写

装了 Hook 时 `Stop` / `PreCompact` 会把整轮对话采集走、抽取在后台跑，**大部分时候你不需要写**：

- `remember` —— 用户说「记住这个」，或出现跨会话的持久偏好、决定、踩坑结论。它**立刻返回 `taskId`**，抽取在后台；不要马上 `find` 验证。
- `add_resource` —— 用户给的文档 / 图片 / 代码要变成可检索、可下载的资料节点。**不要**先 `read` 再 `write` 复制一份。
- `write` / `edit` —— 只在你要自己维护一份已知位置的笔记时用。
- `forget` —— 不可恢复。确认过再删，且只删你 `read` 过的那个确切 URI。

**该存**：稳定的偏好与约定、环境事实、带理由的决定、可复用的修复步骤。
**不该存**：密钥与凭据、临时状态、猜测、整段 transcript。

## 合规：最容易错的三处

- **URI 用 `~`，不要拼 uid。** `~` 展开成当前身份根：`~/memories/profile.md` 就是 `comem://user/<uid>/memories/profile.md`。需要绝对根时先 `health { }` 读 `subject`（形如 `user:alice`）与 `scopes`。组空间写 `comem://group/<gid>/…`，uid / gid 不要猜。
- **`remember` 的 `messages` 是对象数组**，每条 `{ "role": …, "content": … }`：`role` 只能是 `user` / `assistant` / `system` / `tool`，`content` 不能是空串。批量导入历史会话要传 `sessionId` 和每条源日志的 `createdAt`（ISO 8601）——两者一起构成幂等键，少一个就会重复写入。
- **`rule_search` 的 `threshold` 是相对值。** `0.65` 表示「只保留与最佳规则差距不到 35% 的」。`find` / `search` 返回的分数只在同一次检索的同一引擎内可比，不要当绝对阈值，也不要跨轮比较。

## 两条通道

| 装了什么 | 自动召回与采集 | 主动读写 |
|---|---|---|
| 只装 Hook | 有 | **无**——没有 MCP 工具可调 |
| 只配 MCP | 无 | 有 |
| 两个都配 | 有 | 有 |

以宿主实际注册的工具列表为准：没注册的工具不要调，也不要改用 HTTP 接口绕过。

## 例子

用户：「上次那个网关 502 是怎么修的？」

1. 上下文里没有 `<comem-recall>`（只配了 MCP），主动召回：
   `find { "query": "网关 502 上游超时 修复", "limit": 5 }`
2. 命中 `comem://user/alice/memories/experiences/ops/gateway-502.md`，摘要写的是上游 keepalive 超时。`read` 它，对着当前网关版本确认结论还成立——旧结论不自动作废，也不自动生效。
3. 照做，验证通过。
4. 这条记忆已经存在，用 `edit` 把「重启后恢复」补成实测结论，不新写一条。只有这是**新**知识时才 `remember`：
   `remember { "messages": [ { "role": "user", "content": "网关 502 怎么修" }, { "role": "assistant", "content": "根因是 upstream keepalive 300s 短于后端 idle timeout；调到 600s 并重启 nginx 后恢复" } ] }`
   拿到 `taskId` 就结束，不轮询。
