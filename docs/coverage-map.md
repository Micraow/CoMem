# CoMem 功能覆盖图

> 以代码为准。每个能力一行：**入口 → 实现 → 数据落到哪 → 哪条测试证明它成立**。
> 行号是快照时刻的值，不是引文。`§x` 指 `docs/architecture.md` 的节号，那份文档定架构边界与数据布局，这份只回答「在哪、怎么流、谁证明」。
>
> **快照**：HEAD `282990b`，时刻 `2026-11-10T09:41+08:00`。行号随代码移动，用例名是稳定锚点，按名字重新定位即可。见文末「快照与漂移」。

## 一、能力矩阵

### 1. 写入与提交

| 能力 | 需求（为什么存在） | 入口 | 实现（file:line） | 数据流 | 测试证据（file:行） |
|---|---|---|---|---|---|
| 会话消息落盘 | 对话要先进 live，才能被提交 | `POST /sessions/{id}/messages`；MCP `remember` | `services/session.ts:539` `addMessage` | 追加 `sessions/{sid}/messages.jsonl` 一行；`.meta.json` 的 `turn` / `pendingTokens`；按消息 `id` 在 live + 已归档范围内判等 | `tests/integration/services/session.test.ts:253`「追加 JSONL 并累加 turn 与 pendingTokens」；幂等 `:301` |
| 自动提交 | 攒够量就归档，不指望模型记得调 | 调度器职责（30 秒一轮） | `bootstrap/scheduler.ts:503` `#processSession`；判定 `services/session.ts:611` | 扫 `{user,group}/{id}/sessions/*` 读 `.meta.json` + live，命中阈值走阶段一 | `tests/integration/services/session-scheduler.test.ts:98`「写够 5000 token → tick → archive_001 出现」；空闲触发 `:187` |
| 阶段一归档 | live 固化进 `history/`，建后台任务 | `POST /sessions/{id}/commit`；MCP `remember`；自动提交 | `services/session.ts:680` `#commitPhase1` | 写 `history/archive_NNN/messages.jsonl`（原子）→ `.meta.json` `phase1: preparing→ready` + `taskId` → 重写 live → `task` 表插 `type=archive`；**不写 `.done`** | `tests/integration/services/session.test.ts:468`「六步落盘…不写 .done」 |
| 阶段二执行 | 流水线要有人跑，否则任务永远 pending | 常驻轮询（1 秒，`bootstrap/commit-runner.ts`） | `bootstrap/commit-runner.ts:179` `#runOne`；骨架 `services/commit/pipeline.ts:185`；步骤注册 `bootstrap/container.ts:1101`–`:1117` | `task` 表租约认领 → 逐步执行并写 `steps_done` → 全成功写 `archive_NNN/.done`。**注册五步**：归档摘要 → 记忆抽取 → 补丁合并 → 摘要失效 → 经验归纳（`ExperienceDistillStep`） | `tests/integration/services/commit-pipeline.test.ts:124`「五步按顺序执行」；`tests/integration/bootstrap/commit-runner.test.ts:397`「建会话 → 写消息 → 提交 → tick 跑完 → .done + pending 记忆」 |
| 归档摘要 / 工作记忆 | 归档目录要有 L1 概览给下次抽取看 | 阶段二第 1 步 | `services/commit/steps/archive-summary.ts:97` | 归档目录 `.overview.md`（`memory.workingMemory.enabled` 时 7 段）+ 目录 L1 | `tests/integration/services/commit-steps.test.ts:257`「开启工作记忆时生成 7 段并写归档目录的 .overview.md」 |
| 记忆抽取 | 从对话产出可执行的操作列表 | 阶段二第 2 步 | `memory-extract.ts:425` | 预取记忆编号成 `page_id` → 落 `archive_NNN/memory_operations.json`；重放由 `rehydrate` 读回 | `commit-steps.test.ts:353`「把预取记忆编号成 page_id，并把输出解析回 URI」；重放 `:949` |
| 补丁合并 | 同批多条操作合成一次写；SEARCH 按序应用 | 阶段二第 3 步 | `memory-merge.ts:205` | 逐 URI 分组 → `MemoryService.upsertMemory`（`exact` 锁内应用 patch）→ `archive_NNN/memory_diff.json`；并写 `memory_link` 的 `derived_from` 边 | `commit-steps.test.ts:715`「同 URI 的 5 条 patch 合并成一次写」；边 `:1100`「写盘成功后写入 derived_from 链接，指向本次归档」 |
| 摘要失效 | 正文变了，父目录摘要必须脏 | 阶段二第 4 步 | `commit/steps/summary-invalidate.ts:32` | `SummaryService.markStale(父目录)` → `node.summary_pending` / `summary_baseline` / `summary_entries` | `commit-steps.test.ts:1416`「同一目录下的 N 个文件只触发一次父目录标记」 |
| 复核通过 / 驳回 | 高风险类型要人放行才能进检索面 | `POST /memories/{uri}/approve`、`/reject`（仅 HTTP） | `services/memory.ts:1206` `approve` / `:1266` `reject`；路由 `routes/memories.ts:142` / `:143` | `approve`：`status: pending→active`（整份重写，`sources`、`valid_from`、`valid_until`、`supersedes` 原样保留）；`reject`：`supersedes` 指向的版本写回规范 URI 并清掉 `valid_until`，没有可回退的版本时删文件、原因进日志（§11.11） | `tests/integration/services/memory.test.ts:245`「…approve 后变 active」；`:884`「reject（有 supersedes）：规范文件恢复旧正文、valid_until 清空、pending 内容消失」；`:924`「reject（没有 supersedes）：维持删除」；`:941`「supersedes 指向的版本文件已被截断时，reject 退回删除而不是抛错」 |
| TTL 软归档 + 物理删除 | 不再被访问的记忆要退出检索面 | 调度器职责 | `services/ttl.ts:140`；`scheduler.ts:648` | `max(updated_at,last_accessed_at)` 起算 → `node.status='archived'` + `archived_at`；第二段 `filesystem.remove` 连带删索引 / 物化权限 / 向量行；两段 SQL 都带 `NOT_VERSION_FILE_SQL`（`uri NOT GLOB '*/memories/*/[.]history/*'`），版本文件不参与 TTL，数量由每 identity 5 份的截断兜住 | `tests/integration/services/ttl.test.ts:219`；豁免四类 `:333`；物理删除 `:448` |
| 记忆合并 | 多条相似记忆收敛，删掉的来源并进保留者 | `POST /memories/consolidate`（仅 HTTP） | `services/consolidation.ts:429` | agentic 循环（≤10 轮）→ 计划阶段校验全前移 → 逐条 upsert / 删除，`sources` 取并集 | `tests/integration/services/consolidation.test.ts:175`；`consolidation-enabled.test.ts:105` |
| 会话过期 | 空闲会话归档或删除，别一直挂着 | 调度器职责 | `bootstrap/scheduler.ts:552` `#expireSession` | `.meta.json` `status: open→archived`（`session.expiry.action: delete` 时删目录）；删前查 `memory_diff.json` 里的 pending 记忆 | `session-scheduler.test.ts:226` / `:252`；`bootstrap/scheduler.test.ts:398`「delete 跳过有 pending 记忆来源的会话」 |

### 2. 检索与组装

| 能力 | 需求（为什么存在） | 入口 | 实现（file:line） | 数据流 | 测试证据（file:行） |
|---|---|---|---|---|---|
| find | 一句话找记忆 / 文件 | MCP `find`；`POST /search/find` | `services/search.ts:748`；工具 `tools/find.ts:63` | `node_fts` MATCH（bm25）或 `node_embedding`（vec0 余弦）或 hybrid RRF → `domain/ranking.ts:46` 层级加权 → `node_permission` 过滤（`permission-repository.ts:133`）→ 热度加权 | `tests/integration/services/search.test.ts:236`「中文双字词能命中」；`mcp/tools.test.ts:439` |
| search（意图重写） | 「那它呢」要先解析指代 | MCP `search`；`POST /search/search` | `services/search.ts:1147` | 先调模型拆 0–5 条 `TypedQuery`（失败降级为原 query，`plan.analyzed=false`）→ 各跑一次 find → 按 URI 去重取最高分 | `mcp/tools.test.ts:1025`「search 末尾附 Query plan」；`tests/integration/services/search-intent.test.ts:233`「模型返回 2 条 → 两次 find，合并去重后按分数降序」 |
| context 组装 | 注入模型的必须是预算内的正文 | MCP `search` 的 `mode=context`；`POST /search/search` 同 | `services/search.ts:1551`；`services/context-assembler.ts:152`；预算 `domain/assembly.ts:381` | 命中 → 按 `assembly.maxTokens` / `quotaPreset` 升级到 L0/L1/L2 正文 → `<memory>` 块；投放后写召回账本 | `context-assembler.test.ts:114`「目录候选读自己的 .overview.md」；`api/http.test.ts:710` |
| rule_search | 动手前取「必须遵守的规则」全文 | MCP `rule_search` | `tools/rule-search.ts:61` | 与 find 同一管道 + `contextTypes:['memory']`、`memoryTypes:['rules']` 下推；再按 `score >= top × threshold` 收窄、逐条读正文 | `mcp/tools.test.ts:1034`「rule_search 返回规则完整正文（默认阈值）」；hybrid 下仍召回 `:1049` |
| grep | 按正则找行，带上下文 | MCP `grep`；`POST /search/grep` | `services/search.ts:1388` | 候选集 = `index.glob`（`node` + 权限，上限 200）→ 逐文件读盘做行匹配 | `search.test.ts:331`「返回行号与前后文」；候选截断 `:417` |
| glob | 按通配列文件 URI | MCP `glob`；`POST /search/glob` | `services/search.ts:1489` | `node` 表 GLOB + 读权限过滤，服务层再过滤一遍（纵深防御） | `search.test.ts:451`「返回权限过滤后的 URI 列表」；`:458` |
| 召回账本 | 跨轮不重复投同一条 | `search` / `context` 传 `sessionId` 时 | 写 `services/search.ts:1651`，读 `:2001`；`services/recall-ledger.ts:298` | `_meta/recall/{scope}.recall_log.json`，键 = 会话 + turn；只记真的给了正文的条目 | `recall-ledger.test.ts:158`「只记账真的给了正文的条目」；`search.test.ts:514` |
| 层级加权 / 单条预算 | 摘要优先，正文不超预算 | 所有检索入口 | `domain/ranking.ts:46`；`domain/assembly.ts:464` | 分数 `bm25 × levelWeight`；单条上限 `maxTokens / 条数 × 2` | `unit/domain/ranking.test.ts:28`「按层级乘以默认权重」；`unit/domain/assembly.test.ts:132` |

### 3. 记忆

| 能力 | 需求（为什么存在） | 入口 | 实现（file:line） | 数据流 | 测试证据（file:行） |
|---|---|---|---|---|---|
| 8 种内置类型 | 每种记忆有自己的落点与字段 | 写入路径（抽取 / 合并） | `domain/memory-types/index.ts:29` | `profile` / `identity` / `soul` → `memories/*.md`；`preferences` / `entities` / `events` / `experiences` → `memories/{type}/{id}.md`；`rules` → `memories/rules/{scenario}/{rule}.md` | `unit/domain/memory-type.test.ts:109`「内置记忆类型」 |
| 记忆文件形态 | frontmatter 由服务端定值，模型只给字段 | 同上 | `services/memory.ts:945` `upsertMemory`；路径 `:878` `renderMemoryUri`；复核重写：`:1206` `approve`、`:1308` `#restoreSuperseded` | frontmatter 写 `memory_type` / `status` / `created_at` / `updated_at` / `uri` / `valid_from`（`upsertMemory` 写本次时刻；`approve` 沿用读到的值；`reject` 回退时用被恢复版本的起点，旧文件没有这个键就不写）+ schema 字段（有值才写）；`summary` / `sources` / `valid_until` / `supersedes` 同属保留键，只在有值时写入（`summary` 取正文首个非空行，正文为空不写；`sources` 为空不写；仍有效 → 不写 `valid_until`；覆盖写产生了版本文件 → `supersedes` 指向它）；`addOnly`（events）目标已存在抛 `ALREADY_EXISTS` | `memory.test.ts:109`「写盘是 §6.6 的 Markdown + frontmatter」；`addOnly` `:223` |
| sources 溯源 | 回答「这条记忆由哪次归档产生」 | 写入时服务端定值；`read` 末尾 `## provenance` | `memory.ts:707` `appendSources`；`tools/read.ts:78` | frontmatter 保留键，上限 20（`memory.ts:337`），超限丢最旧；`read` 在分页切片之后拼接整块 | `memory.test.ts:447`；`mcp/tools.test.ts:603`「记忆正文后追加 ## provenance」 |
| 经验归纳 | 会话里的做法要沉淀成「以后可以照做的整条结论」 | 阶段二第 5 步 | `services/commit/steps/experience-distill.ts:152` `run` | 预取同类型的已有经验 → 模型按 topic 输出完整正文 → `MemoryService.upsertMemory`（同 topic 落到同一 URI，正文整段覆盖）→ `sources` 指向归档 + `derived_from` 边；空数组是合法结论，不写盘 | `commit-steps.test.ts:1209`「归纳结果整段落盘：pending + sources 指向归档 + derived_from 链接」 |
| 复核队列 | 只让 `config.memory.reviewRequired`（默认 `experiences` / `rules`）落 pending | `GET /memories/pending` | `memory.ts:1380` `listPending`；路由 `routes/memories.ts:85` | `listPending` **递归扫盘**：从 `memories/` 逐层 list + 读文件，跳过 `.history`，再筛 `status='pending'`（不查 `node` 表）。路由先求 scope 根 read，再按每条记录 URI 求一次 read——`listPending` 走不传 `principals` 的 `rawFilesystem`，`restricted` 子目录会被列出；返回记录带 `sources` 与 `validFrom` / `validUntil` / `supersedes`（无值时显式 `null`） | `memory.test.ts:244`；`api/http.test.ts:962`「pending 列表带上 sources」 |
| 记忆关联边 | 从 `sources` 派生可反查的 `derived_from` 边 | 写：阶段二第 3 步（补丁合并）、第 5 步（`experience_distill`）；读：`GET /memories/{uri}/links?direction=links\|backlinks` | 写 `memory-merge.ts:331`、`experience-distill.ts:220`；读 `routes/memories.ts:178` + `services/memory-link.ts:72` | `memory_link` 表（迁移 `0003`），唯一键 `(from_uri,to_uri,match_text)`，`weight` 取 max | `commit-steps.test.ts:1100`「写盘成功后写入 derived_from 链接，指向本次归档」、`:1209`「归纳结果整段落盘：pending + sources 指向归档 + derived_from 链接」、`tests/integration/api/memories-links.test.ts:158`「归档后正向非空，且方向 backlinks 能从归档 URI 反查回这条记忆」、`:271`「backlinks：from 无读权限的边不返回，A 自己的边照常返回」、`:290`「links：to 无读权限的边不返回，A 自己的边照常返回」 |
| 预取 | 抽取前把相关记忆编号给模型 | 阶段二第 2 步 | `memory.ts:1423` `prefetch` | 单文件类型直读该文件；多文件类型走检索，`limit = max(5, topN)`；`pending` 不进预取 | `memory.test.ts:301`「单文件类型直接读该文件，不检索」；`:336` |

### 4. 身份与权限

| 能力 | 需求（为什么存在） | 入口 | 实现（file:line） | 数据流 | 测试证据（file:行） |
|---|---|---|---|---|---|
| 登录与凭据解析 | 多用户部署要知道每个请求是谁 | `POST /auth/login`、`POST /auth/logout`、`GET /auth/config` | `services/auth.ts:69` / `:97`；`services/identity.ts:399` | 密码比对 → HMAC session token（载荷 `userId` + `session_epoch`）→ `Authorization: Bearer`；三种凭据同一条出口 | `tests/integration/api/auth.test.ts:79`「正确密码换到可用的 session token」；`:148` 删账号重建后旧 token 401 |
| API Key | 不进浏览器的长期凭据 | `GET|POST /admin/users/{id}/api-keys`、`DELETE /admin/api-keys/{keyId}` | `services/api-key.ts:60` / `:77`；`services/identity.ts:508` | `comem_<prefix8>_<secret>`，`api_key` 表存 prefix 明文 + scrypt 哈希 + `expires_at` / `revoked_at` | `tests/integration/api/auth.test.ts:232`「创建、使用、撤销一条链路；列表不返回明文」 |
| ACL 求值 | 一个节点某人能不能读 / 写 / 管 | 所有服务的 `authorizer` 出口 | `services/acl.ts:393` → `:943` → `:962`；规则 `domain/acl.ts:189` | 查 `node_permission` 的 `MAX(level)`，存在 deny 即拒；`InheritingAuthorizer`（`bootstrap/container.ts:456`）遇缺行先物化再求权 | `tests/integration/services/acl.test.ts:393`「求值不变量」 |
| 权限物化 | 检索时不能逐节点穿 ACL | 写盘后的观察者；`PUT /acl` | `services/acl.ts:1094` `materializeNode`、`:1026` 子树重算；`index-observer.ts:646` | `.acl.json`（真相）→ `node_permission`（求权用）+ `acl_entry`（反查用） | `services/acl.test.ts:460`「物化」；`tests/integration/sqlite/permission-repository.test.ts:155`「只返回主体命中且 level >= read 的 URI」 |
| 用户与组管理 | 身份目录 | `/admin/users*`、`/admin/groups*` | `routes/admin.ts:276`–`:608`；`services/identity.ts:166`–`:377` | `app_user` / `app_group` / `group_member` / `api_key`；`role` 读取时由 `app_group.owner_user_id` 派生（`services/identity.ts:144`） | `api/admin.test.ts:161`「创建 → 列表 → 更新 → 删除」；`admin-access-control.test.ts:387` |
| 管理员名单 | 没有目标资源的操作只能认显式名单 | 用户 / 组目录、`/tasks`、提示词写 | `routes/admin.ts:247`；`api/http/middleware.ts:275`；`config/schema.ts:411` | `auth.adminUserIds`，默认 `[]` → 这些端点对所有人 403 | `admin-access-control.test.ts:260`「auth.enabled: true 且 adminUserIds 为空：已登录用户调用户 / 组目录都 403」 |
| 根预置 | 新建的 user / group 根要有 owner | 首次访问、`pnpm group:owner` | `services/acl.ts:572`；规则 `domain/acl.ts:257` | 写 `.acl.json` 预置条目并物化：user 根 owner 恒 manage；group 根 owner manage + 组员 write | `unit/domain/acl.test.ts:275`「user 根预置 owner = manage」；`services/acl.test.ts:227`「根预置」 |

### 5. 会话与调度

| 能力 | 需求（为什么存在） | 入口 | 实现（file:line） | 数据流 | 测试证据（file:行） |
|---|---|---|---|---|---|
| 会话生命周期 | 会话是提交的单位 | `POST /sessions`、`GET /sessions`、`GET /sessions/{id}` | `services/session.ts:351` / `:412` / `:440` / `:631` / `:660` | `sessions/{sid}/.meta.json` + `messages.jsonl` + `history/`；**不建 `session` 表**，磁盘是真相 | `tests/integration/services/session.test.ts:145`「建完之后 list(sessions) 能看到会话目录，且它有自己的物化权限行」 |
| 调度器六职责 | 维护性动作要有人定期做 | `bootstrap/scheduler.ts`（30 秒） | `scheduler.ts:414` `#runOnce` | 自动提交 `:503`、会话过期 `:552`、TTL `:648`、临时上传 `:666`、请求记录裁剪 `:736`、对账重放 `:755` | `bootstrap/scheduler.test.ts:268`/`:398`/`:487`/`:538`/`:593`/`:773` 各一条；容器级 `session-scheduler.test.ts:98` |
| 任务队列与重试 | 阶段二要能重放、能恢复僵尸 | `GET /tasks`、`GET /tasks/{id}`、`POST /tasks/{id}/retry` | `services/task.ts:102` / `:128` / `:196`；`task-repository.ts:177` `tryClaim` | `task` 表（`status` / `steps_done` / `attempts` / `lease_until` / `error`）；租约即认领；僵尸由 `bootstrap/main.ts:134` `recover()` 回收 | `services/task.test.ts:82`「认领并执行成功」；`:95`「已被别人认领（租约未过期）返回 false」；`task-attempts.test.ts:52`「必然失败的任务配 maxAttempts = 3」 |
| 本机会话导入 | 把宿主历史对话变成归档 | `pnpm ingest` | `services/ingest.ts:415`；源装配 `ingest/registry.ts:20` | 四源（claude-code / codex / deepseek / qwen）读宿主日志 → 建或复用会话 → 阶段一 → 抽取；游标在 `ingest_cursor` 表 | `commands/ingest.test.ts:44`；`unit/ingest/claude-code.test.ts:43` |

### 6. 接口面

**MCP：16 个工具，不多不少**（`api/mcp/tools/index.ts:29`，启动自检 `api/mcp/registry.ts:273`，注册表测试 `mcp/registry.test.ts:53`）。

| 能力 | 需求（为什么存在） | 入口 | 实现（file:line） | 数据流 | 测试证据（file:行） |
|---|---|---|---|---|---|
| 检索 | 找记忆 / 文件 | MCP `find` | `tools/find.ts:63` | 见 §一.2 find | `mcp/tools.test.ts:439`「中文检索按 §13.2 的格式返回」 |
| 检索换写 | 指代要先解析 | MCP `search` | `tools/search.ts:140` | 意图重写 → find；`mode=context` 时走组装 | `mcp/tools.test.ts:1025`「search 末尾附 Query plan」；`http.test.ts:758`「MCP search 工具支持 mode=context」 |
| 规则召回 | 动手前取规则全文 | MCP `rule_search` | `tools/rule-search.ts:61` | 见 §一.2 rule_search | `mcp/tools.test.ts:1034`「rule_search 返回规则完整正文（默认阈值）」 |
| 读正文 | 分页读文本，图片返回二进制 | MCP `read` | `tools/read.ts:112` | `filesystem.read` / `readBytes`；`offset`/`limit` 按码点切片；截断标记 `api/mcp/text.ts` | `mcp/tools.test.ts:526`「offset / limit 按码点切片，还有内容时标记截断」；`:569`「图片返回 binary」 |
| 列目录 | 只看一层 | MCP `list` | `tools/list.ts:72` | `filesystem.list`，`recursive` 时走 `tree`（深度 64 / 1000 节点） | `mcp/tools.test.ts:668`「默认只列直接子项并按 name 升序」；`:682`「recursive 超过节点上限时标记截断」 |
| 目录树 | 一次看清结构 | MCP `tree` | `tools/tree.ts:40` | `filesystem.tree`（`levelLimit` 默认 3） | `mcp/tools.test.ts:720`「levelLimit 控制层数」 |
| 行匹配 | 按正则找行 | MCP `grep` | `tools/grep.ts:44` | `index.glob` 候选 → 读盘匹配 | `mcp/tools.test.ts:751`「大小写敏感与不敏感」 |
| 通配 | 按模式列文件 | MCP `glob` | `tools/glob.ts:34` | `node` GLOB + 权限过滤 | `mcp/tools.test.ts:805`「按扩展名匹配并遵守 nodeLimit」 |
| 下载 | 给宿主一个可直接取的地址 | MCP `download` | `tools/download.ts:77` | 签名 URL（`expires` + HMAC-SHA256，10 分钟），`GET /content/download` 校验后回流字节 | `mcp/tools.test.ts:1286`「download 返回签名 URL」 |
| 健康 | 一次拿到状态、身份、可寻址根 | MCP `health` | `tools/health.ts:45` | `ObservabilityService.health()` + `task` 计数 + 索引计数；状态判定与 HTTP 共用 `api/health-status.ts:37` | `mcp/tools.test.ts:899`「返回索引条数与摘要降级标记」；与 HTTP 一致 `mcp-http-parity.test.ts:170`「只有降级摘要时，MCP 与 HTTP 都给出 degraded」 |
| 写文件 | 整份替换 / 追加 / 新建 | MCP `write` | `tools/write.ts:55` | `filesystem.write` → 观察者写 `node` + `node_permission` + 摘要失效 | `mcp/tools.test.ts:827`「三种 mode」；`:841` 逐字节快照 |
| 改文件 | 行级替换，保留 frontmatter | MCP `edit` | `tools/edit.ts:38` | `filesystem.edit`（`applyPatch` + `expectedDigest` 乐观并发） | `mcp/tools.test.ts:850`「edit 默认唯一命中，replaceAll 替换全部」 |
| 记对话 | 模型主动提交一段对话 | MCP `remember` | `tools/remember.ts:201` | 合成或复用会话 → `addMessage`（`stableMessageId` 去重）→ 阶段一 → 返回 `taskId` | `mcp/tools.test.ts:1187`「remember 走提交管线并返回 taskId」 |
| 删节点 | 删文件 / 整棵子树 | MCP `forget` | `tools/forget.ts:32` | `filesystem.remove`（MANAGE 权）→ 观察者删 `node` / `node_permission` / `node_embedding` | `mcp/tools.test.ts:870`「非空目录需要 recursive」 |
| 导入资料 | 附件 + 正文批量落成资源 | MCP `add_resource` | `tools/add-resource.ts:83` | 先 `POST /resources/temp-upload` 拿 `uploadId`；写 `resources/.../` + 同级 `.attachments/`，一次 `index.upsert` | `mcp/tools.test.ts:1304`；`http.test.ts:997` |
| 装技能 | 技能包 = 目录 + `SKILL.md` | MCP `add_skill` | `tools/add-skill.ts:60` | 写 `skills/{name}/`，入口固定 `SKILL.md`（缺则 `INVALID_ARGUMENT`），一次 `index.upsert` | `mcp/tools.test.ts:1315`「add_skill 安装技能」；`tests/integration/services/skill.test.ts:128`「正常安装：入口与脚本落盘并进索引」 |

**HTTP 路由**（前缀 `/api/v1`，`api/http/server.ts:48`；分组装配 `routes/index.ts:135`；运维端点同时挂根路径，`api/http/server.ts:329`）。

| 能力 | 需求（为什么存在） | 入口 | 实现（file:line） | 数据流 | 测试证据（file:行） |
|---|---|---|---|---|---|
| 文件系统 | 控制台与脚本不用 MCP 也能列目录 | `GET /fs/ls`、`/fs/tree`、`/fs/stat`；`POST /fs/mkdir`、`/fs/mv`、`/fs/cp`；`DELETE /fs` | `routes/fs.ts:112` | 直接调 `FileSystemService`，与 MCP 同一条写路径 | `api/http.test.ts:377`「mkdir → write → ls → tree → stat → read → edit → mv → cp → delete」 |
| 内容读写 | 附件下载、摘要、正文分页 | `GET /content/read`、`/abstract`、`/overview`、`/download`；`POST /content/write`、`/edit` | `routes/content.ts:107` | 文本 + frontmatter；`/abstract` 的文件级摘要来自索引的 `abstract` 列，目录来自 `.abstract.md` | `http.test.ts:449` 截断；`:526`「文件的 abstract 从索引读」 |
| 检索 | 四个检索面（HTTP 侧） | `POST /search/find`、`/search/search`、`/search/grep`、`/search/glob` | `routes/search.ts:283`；上限包装 `:285` / `:322` | 前两个套 30 秒 `runWithDeadline`；后两个不套（见 §四） | `http.test.ts:575`「find / search / grep / glob 四个面」；上限只在两个路由上 `search-deadline.test.ts:207`「模型请求挂住时，三个端点都在预算内返回 503 超时错误」 |
| 会话 | 建会话、加消息、提交 | `POST /sessions`、`/sessions/{id}/messages`、`/sessions/{id}/commit`；`GET /sessions`、`/sessions/{id}` | `routes/sessions.ts:177` | `SessionService`；`POST /sessions` 已存在返回 409（不重置） | `http.test.ts:812`「create → messages → get → list → commit → tasks」 |
| 任务 | 运维查看与重试 | `GET /tasks`、`GET /tasks/{id}`、`POST /tasks/{id}/retry` | `routes/tasks.ts:89` | `task` 表；列表只返回 `claimable`（见 §四） | `admin-access-control.test.ts:583`「非管理员读 / retry 都是 403；系统管理员能读、能 retry」 |
| ACL | 管理层改授权（不进 MCP） | `GET /acl`、`PUT /acl`、`POST /acl/grant`、`POST /acl/revoke` | `routes/acl.ts:107` | `.acl.json` 真相 + `node_permission` / `acl_entry` 重算 | `http.test.ts:898`「get → grant → get → revoke」 |
| 记忆 | 复核队列与合并 | `GET /memories/pending`、`POST /memories/consolidate`、`POST /memories/{uri}/approve`、`/reject`、`GET /memories/{uri}/links` | `routes/memories.ts:85` | `MemoryService` / `ConsolidationService` / `MemoryLinkService` 读端口 | `http.test.ts:934`；`consolidation-enabled.test.ts:105` |
| 资源与技能 | MCP 两个 ingest 工具的 HTTP 面 | `POST /resources`、`POST /resources/temp-upload`、`POST /skills`、`GET /skills` | `routes/resources.ts:106`；`routes/skills.ts:78` | 临时上传落 `_meta/tmp/`；`GET /skills` 列已装技能 | `http.test.ts:985`–`:1058` |
| 用户与组 | 管理面 | `/admin/users*`、`/admin/groups*`、`/admin/api-keys/{keyId}` | `routes/admin.ts:272` | `app_user` / `app_group` / `group_member` / `api_key`；跨主体操作认 `adminUserIds` | `admin.test.ts:161`「创建 → 列表 → 更新 → 删除」；`admin-access-control.test.ts:114`「A 改 B 的密码 → 403」 |
| 认证 | 登录 / 探测 / 登出 | `GET /auth/config`、`POST /auth/login`、`POST /auth/logout` | `routes/auth.ts:52` | `AuthService`；`auth.enabled: false` 时登录端点 404 | `api/auth.test.ts:132`；`:306` |
| 提示词 | 内置提示词的可视化编辑（八条，含经验归纳两条） | `GET /prompts`、`GET /prompts/{id}`；`PUT` / `DELETE` / `POST /prompts/{id}/preview` | `routes/prompts.ts:105` | `prompt_override` 表覆盖仓库默认正文；渲染器进程级热替换 | `api/prompts.test.ts:92`「列出八条提示词，初始都没有覆盖」；`prompt-service.test.ts:61`「初始状态：每条提示词都使用默认值」 |
| MCP 清单 | 控制台展示模型看到的那份说明 | `GET /mcp/tools` | `routes/mcp.ts:46` | 直接序列化 `ToolRegistry`（不重写文本） | `http.test.ts:1228`；`mcp/registry.test.ts:53` |
| 遥测 | Hook 上报阻塞开销 | `POST /telemetry/hook` | `routes/telemetry.ts:63` | 进 `ObservabilityService` 的 `Map`（每事件最近一次）→ `/metrics` | `http.test.ts:1131`「telemetry/hook 上报后 /metrics 里能看到」 |
| 运维 | 探活与抓取 | `GET /health`、`GET /metrics` | `routes/ops.ts:82` | `/health` 聚合 `ObservabilityService.health()` + 任务计数 + 重排健康度 | `http.test.ts:217`；`:1197` metrics 关闭时 404 |

**CLI**

| 能力 | 需求（为什么存在） | 入口 | 实现（file:line） | 数据流 | 测试证据（file:行） |
|---|---|---|---|---|---|
| 重建索引 | 索引坏了要能从磁盘重建 | `pnpm reindex` | `commands/reindex.ts:720` `runReindex` | 只读磁盘 → 重写 `node` / `node_fts` / `node_embedding`，`--only=links` / `all` 时按 `sources` 整批替换 `memory_link` 的 `derived_from`；`--only` 分段、断点续跑 | `commands/reindex.test.ts:146`「磁盘有文件、索引为空 → reindex 后能检索到」 |
| 设密码 | 没有注册页，账号靠命令行引导 | `pnpm password <uid>`（密码走 stdin） | `commands/password.ts:45` `setPassword` | `app_user.password_hash` + 轮换 `session_epoch`（旧 token 全失效） | `commands/password.test.ts:81`「--data-dir 覆盖 COMEM_DATA_DIR：密码写到 --data-dir 指向的数据根」 |
| 指定组 owner | 组 owner 丢失时的恢复入口 | `pnpm group:owner <gid> <uid>` | `commands/group-owner.ts:63` `setGroupOwner` | `app_group.owner_user_id` + 组根 `.acl.json` 预置 | `commands/group-owner.test.ts:79` |
| 导入本机对话 | 存量对话批量进系统 | `pnpm ingest --source ...` | `commands/ingest.ts:534` `runIngest` | 见 §一.5 本机会话导入 | `commands/ingest.test.ts:24`「--config 坏 YAML 必须报错，不能静默用默认值」 |
| 检索质量评估 | 改动检索要能量化前后 | `pnpm eval --dataset ...` | `commands/eval.ts:223` `runEval`；指标 `eval/metrics.ts` | 数据集跑 `find`，算 recall@k / MRR，输出报告 | `commands/eval.test.ts:25`「--config 坏 YAML 必须报错」；`unit/eval/metrics.test.ts:32` `recallAtK` |
| 配置自检 | 加了配置项必须有人读 | `pnpm check:config` | `scripts/check-config.ts:272` `main` | L1 叶子被读 / L2 注入属性必填 / L3 与 `config.example.yaml` 双向一致；L4 变体差集在测试里 | `config-coverage.test.ts:132` |
| 可达性检查 | 符号存在不等于有人调 | `pnpm check:reachability` | `scripts/check-reachability.ts` | 从 6 个进程入口沿值导入算模块与符号可达，再按成员方法调用点判 `method-no-caller` | `unit/scripts/check-reachability.test.ts` |
| 形状检查 | 文件只能变短，结构不能回涨 | `pnpm check:shape` | `scripts/check-shape.ts` | 单文件行数（基线内按记录值，其余 250）、函数体 > 120 行个数、`src/` 总行数、禁用指令硬零 + `as any` / `: any` 计数，全部上限 ratchet | `unit/scripts/check-shape.test.ts` |
| 门禁 | 本地跑完再提交 | `pnpm verify` | `package.json:21` `verify` | typecheck → lint → check:config → check:reachability → check:shape → build:web → test → test:integrations | — |

### 7. 集成与控制台

| 能力 | 需求（为什么存在） | 入口 | 实现（file:line） | 数据流 | 测试证据（file:行） |
|---|---|---|---|---|---|
| 安装 Hook | 把七个生命周期点接进宿主 | `co-mem install --host <claude-code\|dsh\|codex>`、`doctor`、`uninstall` | `integrations/cli.mjs:198` / `:281` / `:227` | 改写宿主 settings（Claude Code）/ `hooks.json`（Codex）；`doctor` 四项自检 | `integrations/tests/cli.test.mjs:45`「install 写七个 hook（含 SessionEnd），并备份原 settings」；doctor `:160` |
| 七个事件 | 每个生命周期点一个脚本 | 宿主回调 → `integrations/servers/*.mjs` | 映射表 `integrations/lib/events.json`；三宿主适配 `integrations/hosts/*.mjs` | 内部名 snake_case ↔ 宿主名 PascalCase 只在这张表对应；`reportsOverhead: false` 的 `pre_tool_use` 不上报 | `integrations/tests/event-names.test.mjs:86`「事件名表：内部名 snake_case、宿主名 PascalCase，两个方向都能查」；`codex.test.mjs:124`「SessionEnd 是一等事件」 |
| 召回注入 | 每轮把相关记忆塞进上下文 | `UserPromptSubmit` / `SessionStart` | `integrations/servers/user-prompt-submit.mjs:136`、`session-start.mjs:250` | `POST /api/v1/search/find` → 相对阈值过滤 → `<comem-recall>` 块进宿主上下文 | `integrations/tests/user-prompt-submit.test.mjs:58`「命中渲染成 <comem-recall> 块」；`session-start.test.mjs:35`「预算放得下时列出名字 + 描述」 |
| 会话采集 | 对话与工具消息落进 CoMem | `PostToolUse` / `Stop` / `PreCompact` / `SessionEnd` | `servers/post-tool-use.mjs:72`、`servers/stop.mjs:180` | 读宿主 transcript → `POST /sessions` + `/messages` → `Stop` 时 `POST /commit`；去重靠事件 ID + 游标 | `post-tool-use.test.mjs:45`「工具调用与结果合成一条 tool 消息」、`stop.test.mjs:149`「Stop 不等待采集」、`pre-compact.test.mjs:51`「等提交完成：消息写入 + 触发提交都在返回之前」 |
| 控制台十页 | 人要看、要改、要复核 | `web/pages/*.vue`（概览 `/health`+`/tasks`、文件树 `/fs/ls`+`/content/*`、检索 `/search/*`、复核 `/memories/pending`+`/content/read`、ACL `/acl`、用户与组 `/admin/*`、会话与任务 `/sessions`+`/tasks`、监控 `/health`+`/metrics`、提示词 `/prompts`、工具 `/mcp/tools`） | 概览 `web/pages/index.vue:140` `load`；复核 `review.vue:124`；工具页 `tools.vue:107` | 全部走 `/api/v1` 封套；身份由 `web/plugins/console-identity.ts` 探测 `/auth/config` 后决定；概览页的 `/health` 与 `/tasks` 各自独立加载（`index.vue:103` / `:116`），`/tasks` 403 时任务卡显示「需要管理员权限」空态（`:189`），不影响健康徽标与指标卡 | **无测试**（只有身份引导单测 `tests/unit/web/console-identity.test.ts:49`） |

### 8. 可观测

| 能力 | 需求（为什么存在） | 入口 | 实现（file:line） | 数据流 | 测试证据（file:行） |
|---|---|---|---|---|---|
| 指标 | 运维要知道慢在哪 | `GET /metrics`（根路径与 `/api/v1` 下都有） | `services/observability.ts:717` `renderMetrics` | `comem_http_request_duration_seconds{account?}`（summary）、`comem_hook_overhead_seconds{event,phase}`、`comem_hook_overhead_total_seconds{event}`、`comem_hook_async_seconds{phase}`、`comem_index_nodes`、`comem_pending_review`、`comem_llm_tokens_total{kind}`、`comem_llm_cost_usd_total`、`comem_llm_pricing_configured` | `services/observability.test.ts:278`「输出能被 Prometheus 文本格式解析，且指标齐全」；开关 `http.test.ts:1205`「includeAccountLabel 打开后请求耗时按账号拆标签」 |
| 结构化日志 | 错误要能定位 | 进程内调用 | `adapters/log/file.ts:57` `FileLogger`（`error.log` + 轮转 `.1`） | JS 对象日志；`requestId` 贯穿（`api/http/middleware.ts`） | `unit/adapters/log.test.ts:60`「一行一个 JSON 对象，带 level / time / msg 与调用字段」 |
| request_log | 逐请求留证（含四阶段归因） | 无查询端点（只写） | 写 `services/observability.ts:499`；表 `adapters/sqlite/request-log-repository.ts:85`；裁剪 `:131` | `request_log`（`request_id` / `method` / `path` / `status_code` / `duration_ms` / `phases` / `error_code` / `subject` / `created_at`）；错误请求全量、成功请求按 `sampleRate` | `sqlite/request-log-repository.test.ts:71`；裁剪接入调度器 `bootstrap/scheduler.test.ts:593`「一轮 tick 后超过保留窗口的行被删除，窗口内的保留」 |
| 健康判定 | 两个入口必须给同一个结论 | `GET /health`、MCP `health` | `api/health-status.ts:37`；HTTP `routes/ops.ts:84`；MCP `tools/health.ts:45` | 信号：规则摘要、重排降级、降级摘要数、索引计数失败 → 只有 `ok` / `degraded` | `http.test.ts:217`「/health 的字段与 §17.9 一致」；`mcp-http-parity.test.ts:170`「只有降级摘要时，MCP 与 HTTP 都给出 degraded」 |

### 无测试的能力（单列）

| 能力 | 现状 | 为什么没有测试 |
|---|---|---|
| 控制台十个页面 | 只有 `web` 的合成式单测（`tests/unit/web/console-identity.test.ts:49`「控制台身份引导」），页面本身无测试 | 页面只做「取数 + 渲染」，断言要拉浏览器；当前门禁不跑浏览器 |
| `pnpm dev` / `dev:server` / `dev:web` | 无 | 开发入口靠人点；`test:e2e` 起的是独立进程与临时数据根 |
| `pnpm test:e2e`（`scripts/demo.sh` + `scripts/demo.mjs`） | 有断言（每步失败即 throw），但**不在 `pnpm verify` 里**，需要活服务与模型 key | 依赖外部模型供应商；不在本地门禁内 |
| Hook 在真实宿主里的安装 | `integrations/tests/cli.test.mjs` 只对临时目录里的 fixtures 断言，不碰真实宿主配置 | 改真实 `~/.claude/settings.json` 不可在测试里做 |
| `pnpm verify` 自身 | 无 | 它只是串起其它命令 |

## 二、代码写好了但没人用的地方

**结论：无。**

工作区当前状态下 `pnpm check:reachability` 的实测输出（exit 0）：

```
目标 324 个（services/adapters 的 public 方法 245 个，domain 函数 79 个）
孤儿 0 个，清单 0 条
新增孤儿 0 个
清单过期 0 个（已不再报孤儿，请删掉对应行）
清单指向不存在的目标 0 个（拼写错误或方法已删除）
✓ 没有清单外的孤儿
```

这一节上一轮只列过一条候选：`EmbeddingRepository` 上一个「按游标列未嵌入 URI」的方法，当时只有测试在调，属于「有生产者没消费者」。判断后按重复实现删除。理由是同一判定在生产侧已经有一份主：`commands/reindex.ts:519` 的 `hasDocumentsMissingVectors`，启动自检 `bootstrap/main.ts:92` 的 `warnIfVectorsMissing` 与启动后台回填 `bootstrap/main.ts:172` `startVectorBackfill` 复用它，补齐入口（自动回填与 `pnpm reindex`）因此只有一份口径。留第二份口径不会有新消费者，只会让「什么算缺向量」有两个答案。

**关于 `check:reachability` 自身的限制**（判断上面结论时要扣除）：它只认 AST 层面的导入与 `.m(` 调用表达式，不认字符串派发、动态注册、默认关闭的分支，也不认「调用存在但执行无效」；它读的是磁盘上的源码文件，不是某个提交的树。

## 三、这一轮砍掉了什么

依据 `e47b576`、`2efb658`、`210a06f` 三个提交逐条按代码复核。四类判据：**有消费者没生产者 / 恒为同一值 / 假维度 / 不可达状态**。

| 能力 | 为什么砍 | 证据（现状） |
|---|---|---|
| `scoreThreshold`（find / search 的绝对分数下限） | 四种引擎量纲不可比（`-bm25` 无界、余弦 `[-1,1]`、RRF 约 `0.016–0.033`、重排未归一化），同一个值在三种引擎里分别是清空 / 放行 / 随机；唯一接过它的调用点结果恒 0 条 | `domain/retrieval.ts:48` 起的 `SearchQuery` 无该字段；`services/search.ts:764` `findWithDiagnostics` 的入参里没有阈值；`docs/architecture.md:1100` 记录了这条判断 |
| `write` / `add_resource` 的 `wait` | 只写进日志、不改行为；写入本来就是同步完成的 | `tools/write.ts:55` 与 `tools/add-resource.ts:83` 的 schema 无 `wait`；`mcp/tools.test.ts:428`「write / add_resource 不再暴露 wait」 |
| `tree.includeAbstract` 与恒 `null` 的 `TreeEntry.abstract` | 描述承诺「目录行后附 L0 摘要」，而 `StoredStat` 没有 `abstract`，转换函数恒返回 null —— 有消费者、没生产者 | `tools/tree.ts:32` 的 schema 只有 `uri` / `levelLimit`；`domain/node.ts` 的 `TreeEntry` 无该字段 |
| `add_skill.files[].executable` | 描述承诺「加执行位」，schema 接收、`toFileInput` 透传，服务层明写不设置（MCP 与 HTTP 都删） | `services/skill.ts:301` 只调 `writeBytes`；`http.test.ts:1058`「skills 的 files[].executable 已不是参数」 |
| `excludeDelivered` / `maxQueries` / `readConcurrency` / `quotaPreset` 的逐请求覆盖 | 与全局配置重复；逐请求覆盖那一半没有调用方 | `grep` 全仓无 `excludeDelivered` / `readConcurrency`；`quotaPreset` 只在 `config/schema.ts:194`（配置项保留）与 `domain/assembly.ts:85` 出现 |
| `SessionStatus` 的 `committing` / `committed` / `failed` | 三个值没有写入点，会话本身从不进入这些状态（归档失败表达在 `task.status`） | `domain/session.ts:23` 收敛为 `open` / `archived` |
| `ArchivePhaseStatus.failed` | 阶段二终态失败只写 `task.status=failed`，归档停在 `ready`（同时是已知限制） | `domain/archive.ts:20` 的 `ArchivePhaseStatus` 只有 `preparing` / `ready`；`services/commit/pipeline.ts:185` 起无失败写入 |
| `SummaryState` 与两个从不写入的 frontmatter 字段（`summary_state` / `summary_digest`） | 描述成活的失效机制，实际失效走索引三列 | `node.summary_baseline` / `summary_pending` / `summary_entries`（`migrations/0001_init.sql:132`）；`services/summary.ts:359` `markStale` |
| `GroupMember.role` 的存储语义 | 列只写常量 `'member'`、永不参与授权，却让返回值出现「owner 但没有任何 owner 能力」 | `services/identity.ts:144` `roleOf` 从 `app_group.owner_user_id` 派生；显式写 `role` 现在 `INVALID_ARGUMENT`（`admin-access-control.test.ts:430`） |
| `GET /stats/memories` | 零调用方：实现、SQL、测试都在，路由表里没有它（`210a06f` 的提交说明给了删除前的行数） | `src/api/http/routes/` 下无该路由文件与 `/stats` 前缀；`docs/architecture.md` 的 §14 路由表已无该端点 |
| `request_log` 上三个无查询使用的索引 | 只写不读的表，多维护三棵 B 树 | `migrations/0006_drop_request_log_indexes.sql`，只保留 `request_log_created` |
| `comem_hook_async_seconds{event}` 的 `event` 标签 | 假维度：进程级快照被贴到每个事件上，同一份数据被复制成七份 | `services/observability.ts:755` 起按 `phase` 输出 |
| `comem_llm_cost_usd_total` 的 `?? 0` | 「没配单价」被渲染成「确实花了 0 美元」 | 未配单价时整条序列不存在，另有 `comem_llm_pricing_configured`（`observability.ts:802`） |
| 控制台的四样展示 | 读不到或永远默认：`/memories/pending` 预取改读 `/health`；任务重试按钮（列表只返回可认领任务）；文档节点的 L1 概览档；置信度徽章（字段不存在）；API Key「最后使用」列（从未记录） | `web/pages/monitor.vue:226` 起说明请求明细无端点；`web/pages/review.vue:12` 起说明复核页改读内容 |
| `EmbeddingRepository.iterMissingUris`（按游标列未嵌入 URI） | 「什么算缺向量」的第二份实现：它按 `model` 判「这个模型没有向量」，而生产侧的主 `hasDocumentsMissingVectors` 按 `content_digest` 判过期（`commands/reindex.ts:519`），启动自检 `warnIfVectorsMissing` 与启动后台回填 `startVectorBackfill` 都转调它（`bootstrap/main.ts:105`、`:172`），补齐入口（自动回填与 `pnpm reindex`）共用这一份；两份口径并存会让启动告警说缺 X 条、补齐时补 Y 条 | `18526c5` 删除后，当时的孤儿检查（现已由 `check:reachability` 取代）从「1 个孤儿、1 条清单」变成「孤儿 0 个、清单 0 条」；用例数 2326 → 2322（少 4 条，全在被删的 describe 里） |
| 向量补全阶段的 `status !== 'active'` 复检 | 候选集来自 `#readableUris` → `index.glob`，而 glob 的 SQL 已经带 `ACTIVE_STATUS_PREDICATE`（与 FTS 臂同一条谓词，`adapters/sqlite/retrieval-index.ts:72`、`:537`）；`NodeRepository.get` 读的是同一行，`NodeStatus` 只有 `active` / `pending` / `archived` 三个成员（`domain/node.ts:19`），所以 SQL 的 `= 'active'` 与 TS 的 `!== 'active'` 对同一行等价，第二次判断不改变结果；`glob` 到 `nodes.get` 之间隔着一次 `vectors.search` 的 await，这期间状态被 TTL 清扫改掉时向量臂比 FTS 臂多挡一次，那是竞态窗口，不是第二份状态过滤的职责 | `5369219` 删前删后检索测试都是 57 passed、全量 2322 passed——「删了测试还绿」正是这处是兜底的证据（与接线类改动相反，接线类要求「删了测试变红」） |
| 死类型 `PendingMemoriesPayload` | 控制台声明过「待复核列表响应」的整套形状，但页面改成读 `/content/read` 的正文后就没人用了；留着它等于给一条不存在的响应继续做类型承诺 | `web/composables/useApi.ts` 无该类型；复核页从 `MemoryRecordPayload` 取字段（`web/pages/review.vue`） |
| 两份任务类型标签映射里的 `extract` / `merge` / `summary` / `index` | `TaskType` 只有 `archive`：抽取、合并、摘要失效都是归档任务内部的步骤（`stepsDone`），重建索引走命令不入队。四个键没有生产者，`/tasks` 的类型列却看起来像还存在别的任务 | `src/domain/task.ts:23`；剩下的收进 `web/utils/taskLabels.ts:17`，未知值原样显示 |
| `index.vue` 里的任务类型 / 状态映射 | 与 `TaskTable.vue` 逐字重复：改一处标签要记得改另一处，而两份里的死键也都各自留了一份 | `web/pages/index.vue` 改用 `web/utils/taskLabels.ts:21` / `:40` 的 `taskTypeLabelOf` / `taskStatusLabelOf`，只保留本页的徽章档位 |
| 各页面各写一遍的 403 判定 | `caught.statusCode === 403` 曾分散在概览页、会话页、用户与组页、复核页、ACL 页与提示词页；加一个错误码要改每一处，漏一处就把「不是管理员」显示成故障 | 判定收在 `web/composables/useApi.ts:291` `isForbidden`，「取文案」统一走 `:307` `forbiddenMessageOf`，「置 forbidden 状态」仍各处保留但共用同一判定 |

**没有砍、但两侧结论已统一**（`210a06f` 的「契约」段，逐条按代码复核）：`timeoutMs` 从覆盖值改成上限（`adapters/llm/rerank-provider.ts`）；MCP 与 HTTP 空查询统一 `INVALID_ARGUMENT`；`health` 两侧共用 `ObservabilityService.health()`；默认条数统一到 `services/search.ts:405` `DEFAULT_SEARCH_LIMIT = 10`；token 估算统一到 `domain`（`domain/session.ts:125` `estimateTokens`）；hook 事件名统一到 `integrations/lib/events.json`；`edit` 补上派生数据通知（`services/filesystem.ts:335` 起）。本轮又统一一处：「可读」的判定从 `p.level >= 1` 改成读位测试 `(p.level & 1) = 1`（`c02970a`），两份 SQL（`adapters/sqlite/retrieval-index.ts:251`、`adapters/sqlite/permission-repository.ts:138`）与读路径的 `levelSatisfies` 现在同一语义，对拍用例在 `tests/integration/sqlite/permission-visibility-consistency.test.ts`（含 `level = 2` / `5` / `6`）。

## 四、已知缺口

写事实，不写计划。

| 缺口 | 事实 | file:line |
|---|---|---|
| `GET /tasks` 只列可认领任务 | 列表走 `claimable`（pending 或租约过期的 running），所以 `done` / `failed` 一条都不出现：`status=done` 的过滤恒空，控制台拿不到失败任务 id，`POST /tasks/{id}/retry` 只能手工给 id | `routes/tasks.ts:103`、`services/task.ts:180` |
| HTTP 两条检索路径没有时间上限 | `/search/grep`、`/search/glob` 不套 `runWithDeadline`（MCP 的 16 个工具全部在 30 秒闸门下） | `routes/search.ts:397`、`:416`，对照 `:285` / `:322` |
| 记忆合并没有墙上时钟上限 | `POST /memories/consolidate` 调模型且不套 deadline：上限是 10 轮 × 单次调用超时（默认 120 秒），最坏约 20 分钟无响应 | `routes/memories.ts:115`、`services/consolidation.ts:429`、`:172`（`DEFAULT_MAX_ITERATIONS`） |
| 两个写路径只校验身份、没有目标资源求权 | `temp-upload` 只解析身份（没有目标）；`telemetry/hook` 同样只解析身份 | `routes/resources.ts:117`、`routes/telemetry.ts:66` |
| 记忆关联边没有 HTTP 写入口 | 写 `derived_from` 的只有阶段二两个写点（补丁合并、经验归纳），重建走 CLI：`pnpm reindex --only=links`（`all` 也含）按 `sources` 整批替换这一类边，所以手工改 `sources` 之后可以修回来。仍然没有写端点；`references` / `related` 在 frontmatter 里没有真相，重建不动它们，写错的只能改 SQL | `routes/memories.ts:178`（只有读）、`memory-merge.ts:331`、`experience-distill.ts:220`、`services/memory-link.ts:94` `rebuildDerived` |
| `request_log` 只写不读 | 没有查询端点，控制台只列指标名；裁剪挂在调度器上，四个开关全关时只剩启动清理一次 | `services/observability.ts:499`、`bootstrap/scheduler.ts:736`、`bootstrap/container.ts:620` |
| ~~切换检索引擎后存量记忆不回填~~（已解决） | 服务监听之后启动后台回填（`startVectorBackfill`，不 await，不阻塞 listen）：候选集按 `model` / `content_digest` 判定，正文与 digest 都从磁盘读（不拿 `node.body_digest` 当输入，否则会写出「digest 与向量来自不同次读盘」的行），分批嵌入，每批一行 info 带 embedded / skipped / failed / remaining；失败记 warn 跳过继续，关闭时先 abort 在途调用再等当前批收尾。启动那一行 warn 仍然保留，只是现在说的是「服务会在后台自动补齐」；`pnpm reindex` 是手工全量入口 | `bootstrap/main.ts:172` `startVectorBackfill`、`:214` `backfillMissingVectors`；用例 `tests/integration/bootstrap/missing-vectors.test.ts` |
| 配置项只能手工核对 | `check:config` 四层都只证明「配置到达了代码」；3 处歧义匹配需人工看，17 处 `LEGACY_OPTIONAL_CONFIG_DEPS` 仍是可选属性 | `scripts/check-config.ts:272`、`docs/operations.md`「配置自检」 |
| 控制台与 Hook 插件没有静态检查 | 根 `eslint` 不覆盖 `web/` 与 `integrations/`；控制台十个页面无自动化测试（只有身份合成 composable 的单测） | `eslint.config.js`、`tests/unit/web/console-identity.test.ts:49` |
| 已生效记忆的结构化元数据在控制台仍无出口 | 待复核列表带出 `validFrom` / `validUntil` / `supersedes` / `sources`，但已生效（`active`）的记忆没有单条 GET，控制台只能读 `/content/read` 的正文；一条记忆被通过之后，字段、有效期与来源就从界面上消失了。要补得先加单条记忆读取端点（MCP 仍是 16 个工具，这属于 HTTP 面） | `src/api/http/routes/memories.ts:85`（只有 `/pending`）、`adapters/fs/content-store.ts:183`（`/content/read` 只回 `document.body`） |
| 多进程写同一 `dataDir` 会漏计已归档消息 | `totalMessageCount` 与消息幂等索引共用「单进程持有全量缓存」的假设 | `services/session.ts:499`；覆盖用例 `tests/integration/services/session.test.ts:452`「keepRecentCount: 0 全归档后仍是 3；换新实例懒加载后仍是 3」 |
| 阶段二终态失败不写 `ArchivePhaseStatus.failed` | 归档停在 `ready`，只能从 `task.status=failed` 看出失败 | `services/commit/pipeline.ts:185`、`domain/archive.ts:20` |

## 快照与漂移

- 本文的行号对应 `2026-11-10T09:41+08:00` 的 HEAD `282990b`。行号会随代码移动，**用例名是稳定锚点**：`grep -n '<用例名>' <测试文件>` 即可重新定位，行号只作快照。
- `tests/integration/services/commit-steps.test.ts` 被持续追加用例，行号最容易偏移；引用它时优先给用例名。
- 引用顺序：先看本文定位入口与测试，细节回 `docs/architecture.md` 对应节号；两侧冲突时以代码为准，并同步改文档。
