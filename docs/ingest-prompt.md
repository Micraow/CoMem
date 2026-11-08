# 把本机会话导入 CoMem

把下面这段提示词复制给能读本机文件的 Agent（Claude Code、Codex、DSH 等），它需要已经接上 CoMem 的 MCP 服务。

Agent 会自己找到本机的会话日志、筛掉命令历史和纯工具轮、把有结论的对话提炼成记忆写进 CoMem，最后给一份报告。跑第二遍不会产生重复记忆。

---

````text
# 任务：把本机历史会话提炼成 CoMem 记忆

你在一台开发机上，这台机器上有用户过去几个月的 AI 会话日志。把这些日志里有长期价值的东西提炼进 CoMem，让以后的会话不用从头问。

不是搬运原文。原始日志有 800 MB，绝大多数是一次性的命令、编译输出和工具结果，原样写进记忆库只会让检索变慢、变差。你要做的是从里面抽出三类东西：

1. **用户的偏好**——他喜欢怎么写代码、怎么组织项目、怎么被回复。
2. **项目的约定**——某个仓库里必须遵守的规则、架构决策、命名约定。
3. **踩过的坑**——某个报错的原因、某个方案为什么放弃、某个坑怎么绕过去。

一条记忆要能独立回答一个问题。写「用户偏好简洁的回复」没有用，写「提交信息用 conventional commits，scope 写模块名，正文说清为什么改」才有用。

## 第一步：确认服务和根 URI

1. 调 `health`。`status` 不是 `ok` 就停下来报告，不要继续。同时看 `index.nodes`，它说明库里已经有多少节点。
2. 调 `find`，`query` 传 `"偏好"`，`limit` 传 `1`。看返回的 URI 前缀：
   - 有命中：形如 `comem://user/{uid}/...`，记下 `comem://user/{uid}`，后面所有 URI 都用这个前缀。
   - 没有命中且 `index.nodes` 是 `0`：库是空的，单用户默认部署的根是 `comem://user/local`，用它。
   - 没有命中但 `index.nodes` 大于 `0`：库里有东西，只是探针没打中。换 `"约定"` 再试一次；还没有就问用户要 CoMem 的根 URI，不要猜。

不要用 `comem://~/...`。MCP 工具不接受 `~`，会报 `INVALID_URI`。

## 第二步：盘点本机会话

按下面的路径找。找不到的跳过——用户没装过那个工具是正常情况，不是错误。

| 工具 | 路径 | 格式 |
|---|---|---|
| Claude Code | `~/.claude/projects/*/*.jsonl` | 一行一个事件，`type` 是 `user` / `assistant` / `system` / `attachment` 等 |
| Claude Code | `~/.claude/projects/*/memory/*.md` | 已经是提炼好的记忆，直接读 |
| Codex | `~/.codex/sessions/**/rollout-*.jsonl` | 一行一个事件，正文在 `type === "response_item"` 且 `payload.type === "message"` 的行里 |
| DeepSeek | `~/Downloads/**/deepseek_data-*/conversations.json` | 数组，每个元素有 `mapping` 树，消息在 `mapping[*].message.fragments[]` |
| Qwen | `~/Downloads/**/Qwen-chat-export-*.json` | `{ success, data: [...] }`，消息在 `data[*].chat.history.messages` |
| ChatGPT | `~/Downloads/**/chatgpt/conversations-*.json` | 数组，每个元素有 `mapping` 树，消息在 `mapping[*].message` |

先把文件清单列出来（路径 + 字节数），再开始读内容。会话数量级：DeepSeek 约 900 个、Qwen 约 160 个、ChatGPT 约 150 个、Codex 约 90 个文件、Claude Code 3 个会话 + 13 个 memory 文件。

**文件可能不是合法 JSON。** 这些导出做过脱敏，数字被替换成了中文字符串 `密码保护`，例如 `"total_tokens":4密码保护811`。按行解析时遇到解析失败的行：跳过、计数、继续，不要把整个文件或整批任务判为失败。解析单个文件前可以先把 `密码保护` 替换成 `0` 再解析。

## 第三步：筛选哪些会话值得提炼

### 跳过

| 跳过什么 | 怎么识别 |
|---|---|
| 命令历史 | `history.jsonl` 里的 `display` 是 `/model`、`/agents`、`/context`、`/skills` 这类斜杠命令；`.zsh_history`、`.bash_history`、`.zshrc`、`.bashrc` 整个跳过 |
| 旁支与合成记录 | Claude Code 里 `isSidechain === true` 或 `isMeta === true` 的行 |
| 非对话角色 | `role` 是 `system`、`developer`、`tool` 的消息 |
| 纯工具轮 | 一条消息的 `content` 只有 `tool_use` / `tool_result` / `thinking` / `reasoning` / `encrypted_content`，没有 `text` 部分。取完文本是空串就丢弃 |
| 机器人播报 | 全部消息 `role` 都是 `user` 的群聊（ChatGPT 的 `group_chats.json` 是自动推送的 CI 日报，3,000 多条，没有人类发言） |
| 元数据 | `user.json`、`user_settings.json`、`ads.json`、`export_manifest.json`、`library_files.json`、`pages/`、`sites/`、`conversation_asset_file_names.json` |
| 重复副本 | 同一个 `session_id` 的多个 rollout 文件（Codex 的 94 个文件只对应 20 个 `session_id`，文件名带 `_<threadId>` 后缀的是续写）；`chat.html` 是 `conversations-*.json` 的 HTML 副本，跳过 |

### 保留

一个会话值得提炼，看它有没有满足任一条件：

- 用户明确说了「以后都这样」「不要这样做」「记住」。
- 出现了一个结论性判断：「X 方案不行，因为 Y」「这个报错是 Z 引起的」。
- 用户在纠正 Agent 的做法，或 Agent 的第一次回答被否掉。
- 有一段可复用的操作步骤（不是一次性的路径，是可迁移的方法）。
- 项目里定下了架构决策、命名约定、目录结构。

一个会话抽出 0 条记忆是正常结果。宁可少写，不要为了凑数把「用户问了什么」写成记忆。

## 第四步：写记忆

### 4.1 记忆放在哪

CoMem 有 8 个内置记忆类型，每种对应固定的目录和文件名。URI 必须落在下面这些目录里——目录决定索引时的 `context_type`，frontmatter 里的 `memory_type` 必须和目录对应，不一致时记忆合并会跳过这条（`memory_type_mismatch`）：

| 类型 | 目录 | 文件名 | 什么时候用 |
|---|---|---|---|
| `preferences` | `memories/preferences/` | `{topic}.md` | 用户在某个话题上的偏好 |
| `entities` | `memories/entities/` | `{name}.md` | 项目、组织、人物的稳定描述 |
| `events` | `memories/events/` | `{event}.md` | 某次决策或里程碑，`addOnly` |
| `experiences` | `memories/experiences/` | `{topic}.md` | 从执行结果蒸馏的经验与教训 |
| `rules` | `memories/rules/` | `{scenario}/{rule}.md` | 必须遵守的约束与触发条件 |
| `profile` | `memories/` | `profile.md` | 用户画像，整个空间只有一份 |
| `identity` | `memories/` | `identity.md` | 代理自己的身份设定 |
| `soul` | `memories/` | `soul.md` | 不可违背的核心原则 |

`{topic}`、`{name}`、`{event}`、`{scenario}`、`{rule}` 统称 identity 值：**小写英文短横线**（`code-style`、`monorepo-migration`、`license-review`），不能含斜杠、`..`、反斜杠、控制字符。同一件事第二次必须得到同一个值——按语义取，不按原文取。

### 4.2 记忆文件的格式

CoMem 的记忆是带 YAML frontmatter 的 Markdown。正文必须以 `## content` 开头，否则读回来 `content` 字段是空的。

以 `preferences` 的 `code-style` 为例：

```
---
memory_type: preferences
status: active
created_at: 2026-11-08T00:00:00Z
updated_at: 2026-11-08T00:00:00Z
uri: comem://user/local/memories/preferences/code-style
topic: code-style
---

## content

提交信息用 conventional commits，scope 写模块名，正文说清「为什么改」而不只是「改了什么」。
```

各类型的 frontmatter 字段（除 `memory_type` / `status` / `created_at` / `updated_at` / `uri` 这五个公共键外）：

| 类型 | 额外字段 |
|---|---|
| `preferences` | `topic` |
| `entities` | `name`、`kind`（`project` / `organization` / `person`） |
| `events` | `event`、`occurredAt` |
| `experiences` | `topic` |
| `rules` | `scenario`、`rule` |
| `profile` | `name`、`role` |
| `identity` | `name`、`purpose` |
| `soul` | `name` |

`created_at` 用第一次提炼出这条事实的时间，`updated_at` 用当前时间，都是 ISO 8601。

`status` 默认写 `active`。如果这套部署开了记忆复核闸门（`memory.reviewRequired` 里含 `rules` 或 `experiences`），这两类写 `pending`——它们不会进检索，要等用户在控制台复核通过。其它类型仍然写 `active`。不确定部署配置时问用户，不要猜。

### 4.3 工具怎么调

只用到 5 个工具。参数名照抄，写错会直接报错：

```
health   { }
find     { query, targetUri?, limit=10, level?, contextType? }
read     { uri } 或 { uris: [...] }, offset=0, limit=-1
write    { uri, content, mode: "replace" | "append" | "create", wait=false }
edit     { uri, oldString, newString, replaceAll=false }
```

- `find` 的 `contextType` 传 `"memory"` 只搜记忆。
- `read` 返回的是去掉 frontmatter 的正文，所以你看到的第一行是 `## content`。
- `write` 的 `mode`：`create` 在目标已存在时报 `ALREADY_EXISTS`；`append` 只追加正文、保留 frontmatter；`replace` 覆盖正文、同样保留 frontmatter。
- 写完看返回里的 `Index:`。是 `indexed` 才算进检索，是 `pending` 说明后台还没建完索引，不要立刻去 `find` 查。

### 4.4 幂等：同一条事实只能有一条记忆

用户会跑好几次（今天导一点、明天导一点）。重跑不能产生重复记忆。

**每写一条记忆，走完这四步：**

**第 1 步：查重。** 用这条事实的核心句子调 `find`：

```
find { query: "提交信息用 conventional commits", contextType: "memory", limit: 5 }
```

看返回的 URI 和摘要。已经有同一个 URI 或同一条事实，就不要新建。

**第 2 步：按目标 URI 判断。** 目标 URI 由类型目录 + identity 值拼出来，例如：

```
comem://user/local/memories/preferences/code-style
comem://user/local/memories/rules/license-review/must-locate-license
comem://user/local/memories/experiences/monorepo-migration
```

先 `read` 这个 URI：

- 报 `NOT_FOUND` → 还没有，走第 3 步「新建」。
- 读到了 → 已经有，走第 4 步「更新」。

**第 3 步：新建。**

```
write {
  uri: "comem://user/local/memories/preferences/code-style",
  mode: "create",
  content: "---\nmemory_type: preferences\nstatus: active\ncreated_at: 2026-11-08T00:00:00Z\nupdated_at: 2026-11-08T00:00:00Z\nuri: comem://user/local/memories/preferences/code-style\ntopic: code-style\n---\n\n## content\n\n提交信息用 conventional commits，scope 写模块名，正文说清「为什么改」。"
}
```

返回 `ALREADY_EXISTS` 说明并发或前一次已经写过，回到第 4 步。

**第 4 步：更新，不要 `write` 新建。**

- 补充一条新事实 → `write` 的 `mode` 传 `"append"`，`content` 只写新的一行（前面带空行分隔）。frontmatter 会自动保留。
- 修正已有的一句话 → `edit`，`oldString` 必须是从 `read` 结果里逐字复制的原文，且在这份正文里唯一命中：

```
edit {
  uri: "comem://user/local/memories/preferences/code-style",
  oldString: "提交信息用 conventional commits，scope 写模块名。",
  newString: "提交信息用 conventional commits，scope 写模块名，正文说清「为什么改」。"
}
```

**不要用 `remember`。** 它每次调用都新建一个会话（新的随机 ID），跑两遍就是两份会话，不可能幂等。它是给「当前这段对话值得存」用的，不是给批量导入用的。

**不要用 `write` 的 `mode: "replace"` 去更新已有记忆。** 正文必须以 `## content` 开头，手写容易漏；`append` 和 `edit` 没有这个风险。

### 4.5 脱敏

写进记忆之前，把这些替换掉：

| 原始 | 替换成 |
|---|---|
| 绝对路径里的用户名（`/home/micraow/...`、`/Users/xxx/...`） | `~/...` |
| 邮箱 | `<email>` |
| 手机号、身份证、学号 | `<phone>` 等 |
| 内网 IP（`10.x`、`172.16–31.x`、`192.168.x`） | `<internal-ip>` |
| token、key、密码、cookie、`Authorization` 头 | `<secret>` |
| 数据库连接串里的凭据 | `<secret>` |
| 攻击命令与 hash 串 | 不要写进记忆 |

路径里的项目名可以留（`~/workspace/nexus`），用户名不行。

## 第五步：分批

**一次处理 10–20 个会话，或者累计读入 20 万字符源文本，先停下来写记忆、再继续下一批。**

理由：

- 上下文窗口装不下整个语料。Codex 单个 rollout 文件最大 108 MB、1.2 万条记录，一次读进上下文不可能。
- 失败重试的粒度。一批 15 个会话里第 12 个读不出来，丢的是这一批；一批 200 个，丢的是全部。
- 写记忆和读日志是两种负载。读完一批立刻写，记忆里不会堆着一批「待写」的中间结果。

每批处理完，往 `~/.comem-ingest-state.json` 追加一条记录（这个文件在 CoMem 之外，自己维护）：

```json
{
  "root": "comem://user/local",
  "done": [
    { "locator": "~/.codex/sessions/2026/08/25/rollout-2026-08-25T11-05-36-01a036e1.jsonl", "bytes": 1325044, "memories": 2 },
    { "locator": "~/.claude/projects/-tmp/d724d22f.jsonl", "bytes": 9762, "memories": 0 }
  ]
}
```

重跑时先读这个文件，`done` 里 `memories > 0` 的会话跳过；`memories === 0` 的可以重看，因为上次可能只是没抽出来。

## 第六步：失败处理

| 情况 | 做法 |
|---|---|
| 单个文件不存在 | 跳过 |
| 目录不存在 | 跳过，这在没装过该工具的机器上是正常的 |
| 某一行不是合法 JSON | 跳过这一行，计数，继续 |
| 整个文件解析失败 | 跳过这个文件，记进报告的「跳过」表，继续下一个 |
| 单个会话读不完（文件太大） | 只读前 2,000 行和最后 500 行，中间跳过。在报告里注明「截断」 |
| `write` 报 `ALREADY_EXISTS` | 回到第 4 步走更新分支，不要重试新建 |
| `read` 报 `NOT_FOUND` | 正常，说明还没有这条记忆 |
| `write` 报权限错误 | 停下来报告。这说明根 URI 或身份不对，继续写只会全部失败 |
| MCP 服务连不上 | 停下来报告 |

任何单个会话的失败都不能中断整批。只有「服务连不上」和「权限错误」可以中断。

## 第七步：报告

跑完给用户一份报告，不要贴记忆正文。格式：

```
导入完成

根 URI：comem://user/local

盘点
  文件              153 个（809.4 MiB）
  会话              1,318 个
  处理                128 个
  跳过              1,190 个

提炼（按会话计）
  产出记忆            54 个会话
  没有产出            74 个会话

记忆（按条数计）
  新建                37 条
  更新                 5 条
  已存在未改动        12 条

按类型
  preferences         18
  experiences          9
  rules                6
  entities             4

跳过（按会话计）
  命令历史           146   history.jsonl 里全是 /model 这类斜杠命令
  纯工具轮         1,020   没有人类可读文本
  重复副本            24   同一 session_id 的续写 rollout

数据质量
  非法 JSON 行        77   脱敏伪影（密码保护），已跳过
  非法 JSON 文件       3   Qwen 导出 / conversations-000 / library_files

需要留意
  Codex 的 94 个文件只对应 20 个 session_id，已按 session_id 去重
  ChatGPT 的 chat.html 与 conversations-*.json 是同一批 150 个会话，只导一次
```

数字要来自实际计数，不要估算；对不上的地方宁可写「未统计」。报告里不出现 `page_id`、`digest`、`pendingChanges` 这类内部术语，也不贴记忆正文。

## 不要做的

- 不要为了「导全」把原始对话写进记忆。记忆库不是日志仓库。
- 不要一条会话写一条记忆。一个会话可能产出 3 条，也可能 0 条。
- 不要把「用户问过什么」写成记忆。只有结论、偏好、约定、教训值得写。
- 不要 `forget` 任何东西。这次任务只新建和补充，不删除。
- 不要修改 `~/Downloads/` 下的任何文件。只读。
- 不要在没有 `read` 过的情况下 `edit`。`oldString` 必须来自真实的正文。
````
