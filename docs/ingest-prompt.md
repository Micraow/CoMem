# 把本机会话导入 CoMem

把下面这段提示词复制给能读本机文件的 Agent（Claude Code、Codex、DSH 等），它需要已经接上 CoMem 的 MCP 服务。

Agent 会自己找到本机的会话日志、筛掉命令历史和纯工具轮、把每个会话解析成消息数组，用 `remember` 原样上传。**抽取记忆是服务端的事**，Agent 不需要知道 CoMem 的记忆类型、目录布局或 frontmatter 格式。跑第二遍不会产生重复会话。

---

````text
# 任务：把本机历史会话上传到 CoMem

你在一台开发机上，这台机器上有用户过去几个月的 AI 会话日志。把这些会话**原样**上传到 CoMem。

CoMem 会在服务端把会话归档、抽取成记忆、走复核闸门。你只负责「找到会话、解析成消息、上传」这三件事。

## 为什么是上传原始会话，不是直接写记忆

- 记忆只有一条写入路径：阶段一归档 → 阶段二抽取 → 合并 → 复核。绕过它写进去的记忆，和正常流程产出的**不是同一种东西**。
- Agent 侧不知道自己该写哪种记忆类型、写到哪里；这些规则会变，让提示词去适配只会漂。
- 原样上传保留了完整上下文，服务端可以重新抽取。写死的「结论」丢了原文就找不回来。

## 第一步：确认服务

1. 调 `health`。`status` 不是 `ok` 就停下来报告，不要继续。
2. 记下返回里的 `subject` 与 `scopes`（报告里要写「上传到哪个根」）。
3. 不要调 `find` 去猜根 URI，也不需要自己拼 `comem://` 地址——`remember` 写进当前身份的个人空间。

## 第二步：盘点本机会话

按下面的路径找。找不到的跳过——用户没装过那个工具是正常情况，不是错误。

| 工具 | 路径 | 格式 |
|---|---|---|
| Claude Code | `~/.claude/projects/*/*.jsonl` | 一行一个事件，`type` 是 `user` / `assistant` / `system` / `attachment` 等 |
| Codex | `~/.codex/sessions/**/rollout-*.jsonl` | 一行一个事件，正文在 `type === "response_item"` 且 `payload.type === "message"` 的行里 |
| DeepSeek | `~/Downloads/**/deepseek_data-*/conversations.json` | 数组，每个元素有 `mapping` 树，消息在 `mapping[*].message.fragments[]` |
| Qwen | `~/Downloads/**/Qwen-chat-export-*.json` | `{ success, data: [...] }`，消息在 `data[*].chat.history.messages` |
| ChatGPT | `~/Downloads/**/chatgpt/conversations-*.json` | 数组，每个元素有 `mapping` 树，消息在 `mapping[*].message` |

先把文件清单列出来（路径 + 字节数），再开始读内容。会话数量级：DeepSeek 约 900 个、Qwen 约 160 个、ChatGPT 约 150 个、Codex 约 90 个文件、Claude Code 3 个会话。

**文件可能不是合法 JSON。** 这些导出做过脱敏，数字被替换成了中文字符串 `密码保护`，例如 `"total_tokens":4密码保护811`。按行解析时遇到解析失败的行：跳过、计数、继续，不要把整个文件或整批任务判为失败。解析单个 JSON 文件前可以先把 `密码保护` 替换成 `0` 再解析。整份文件仍然解析不了就跳过它，记进报告的「跳过」表。

## 第三步：解析成消息数组

每个会话产出一个 `{ role, content, createdAt }` 数组，按时间顺序。`role` 只能是 `user` / `assistant` / `system` / `tool`；`content` 是纯文本；`createdAt` 是源日志里的 ISO 8601 时间串。

### 跳过

| 跳过什么 | 怎么识别 |
|---|---|
| 命令历史 | `history.jsonl` 里的 `display` 是 `/model`、`/agents`、`/context`、`/skills` 这类斜杠命令；`.zsh_history`、`.bash_history`、`.zshrc`、`.bashrc` 整个跳过 |
| 旁支与合成记录 | Claude Code 里 `isSidechain === true` 或 `isMeta === true` 的行 |
| 纯工具轮 | 一条消息的 `content` 只有 `tool_use` / `tool_result` / `thinking` / `reasoning` / `encrypted_content`，没有 `text` 部分。取完文本是空串就丢弃 |
| 机器人播报 | 全部消息 `role` 都是 `user` 的群聊（ChatGPT 的 `group_chats.json` 是自动推送的 CI 日报，3,000 多条，没有人类发言） |
| 元数据 | `user.json`、`user_settings.json`、`ads.json`、`export_manifest.json`、`library_files.json`、`pages/`、`sites/`、`conversation_asset_file_names.json` |
| 重复副本 | 同一个 `session_id` 的多个 rollout 文件（Codex 的 94 个文件只对应 20 个 `session_id`，文件名带 `_<threadId>` 后缀的是续写）；`chat.html` 是 `conversations-*.json` 的 HTML 副本，跳过 |

### `createdAt` 必须来自源日志

它是幂等键的一部分：同一条消息（角色 + 正文 + 时间戳）第二次上传会被服务端跳过。**不要用「现在」当时间戳**——那样重跑会得到新的 ID，同一句话会重复上传。

源日志没有时间戳时，用会话的首条时间；整条都没有就留空，服务端会用当前时间（这条消息不参与去重）。

## 第四步：上传

每个会话一次 `remember` 调用：

```
remember {
  sessionId: "<harness>-<native-session-id>",
  messages: [
    { role: "user", content: "...", createdAt: "2026-08-25T03:13:44.000Z" },
    { role: "assistant", content: "...", createdAt: "2026-08-25T03:13:45.000Z" }
  ]
}
```

- `sessionId` 是**稳定 ID**：`<harness>-<原生会话 ID>`，例如 `claude-code-<uuid>`、`codex-<uuid>`、`deepseek-<id>`、`qwen-<id>`。只能用字母、数字、`.`、`_`、`@`、`-`，不能含斜杠。
- 同一个 `sessionId` 重跑会追加到同一个会话，已有的消息按稳定 ID 跳过。**这就是幂等**，不需要自己查重。
- 消息很多时**分批**：同一个 `sessionId` 多次调用，每次 200–500 条。不要把所有消息塞进一次调用（单个 rollout 文件 108 MB、1.2 万条记录）。
- 返回 `taskId: none` 表示这一批消息都已经上传过（幂等重跑的预期结果），不是错误。
- 返回 `taskId: <id>` 表示已归档、抽取在后台跑。**不要立刻去 `find` 查**——抽取要几秒到几十秒，且可能被复核闸门挡住。

### 不要做的

- 不要 `write` / `edit` 任何文件。上传只走 `remember`。
- 不要 `forget` 任何东西。这次任务只新建和补充，不删除。
- 不要修改 `~/Downloads/` 下的任何文件。只读。
- 不要为了「导全」把工具输出、编译日志、图片二进制塞进 `messages`。只传人类可读的对话轮。

## 第五步：分批与续跑

**一次处理 10–20 个会话，先传完再继续下一批。**

理由：

- 上下文窗口装不下整个语料。Codex 单个 rollout 文件最大 108 MB、1.2 万条记录，一次读进上下文不可能。
- 失败重试的粒度。一批 15 个会话里第 12 个读不出来，丢的是这一批；一批 200 个，丢的是全部。
- 上传和解析是两种负载。解析完一批立刻上传，内存里不会堆着一批「待传」的中间结果。

每批处理完，往 `~/.comem-ingest-state.json` 追加一条记录（这个文件在 CoMem 之外，自己维护）：

```json
{
  "subject": "user:local",
  "done": [
    { "sessionId": "codex-01a036e1-6764-77e0-b613-54e99ba2a761", "bytes": 1325044, "messages": 42 },
    { "sessionId": "claude-code-d724d22f-1f44-8a90-6dd2-e3a5c63f563", "bytes": 9762, "messages": 6 }
  ]
}
```

重跑时先读这个文件，`done` 里的 `sessionId` 跳过整个会话；`messages === 0` 的可以重看，因为上次可能只是没解析出来。

## 第六步：失败处理

| 情况 | 做法 |
|---|---|
| 单个文件不存在 | 跳过 |
| 目录不存在 | 跳过，这在没装过该工具的机器上是正常的 |
| 某一行不是合法 JSON | 跳过这一行，计数，继续 |
| 整个文件解析失败 | 跳过这个文件，记进报告的「跳过」表，继续下一个 |
| 单个会话读不完（文件太大） | 只读前 2,000 行和最后 500 行，中间跳过。在报告里注明「截断」 |
| `remember` 报 `INVALID_ARGUMENT` | 看 `details` 里的字段：多半是 `role` 不合法或 `sessionId` 含非法字符。修正后重试这一条 |
| `remember` 报权限错误 | 停下来报告。这说明身份不对，继续传只会全部失败 |
| MCP 服务连不上 | 停下来报告 |

任何单个会话的失败都不能中断整批。只有「服务连不上」和「权限错误」可以中断。

## 第七步：报告

跑完给用户一份报告，不要贴对话正文。格式：

```
导入完成

上传到：user:local

盘点
  文件              153 个（809.4 MiB）
  会话              1,318 个
  处理                128 个
  跳过              1,190 个

上传（按会话计）
  已归档             54 个
  没有新消息         74 个

上传（按消息计）
  归档              3,204 条
  去重跳过            512 条

跳过（按会话计）
  命令历史           146   history.jsonl 里全是 /model 这类斜杠命令
  纯工具轮         1,020   没有人类可读文本
  重复副本            24   同一 session_id 的续写 rollout

数据质量
  非法 JSON 行        77   脱敏伪影（密码保护），已跳过
  非法 JSON 文件       3   Qwen 导出 / conversations-000 / library_files

需要留意
  Codex 的 94 个文件只对应 20 个 session_id，已按 session_id 去重
  ChatGPT 的 chat.html 与 conversations-*.json 是同一批 150 个会话，只传一次
```

数字要来自实际计数，不要估算；对不上的地方宁可写「未统计」。报告里不出现 `page_id`、`digest`、`summary_pending` 这类内部术语，也不贴对话正文。

## 最后

记忆的抽取与复核在服务端后台进行。如果用户想确认「导进来的东西有没有变成记忆」，让他看 CoMem 控制台的「记忆复核」页——不要自己再写一遍记忆。
````
