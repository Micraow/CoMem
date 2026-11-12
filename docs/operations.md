# 运维手册

面向要把 CoMem 跑起来的人：装什么、怎么配、数据落在哪、出问题看哪里。
架构与设计取舍在 [`architecture.md`](architecture.md)。

## 系统要求

| 项 | 要求 | 来源 |
|---|---|---|
| Node | ≥ 22.5 | `package.json` 的 `engines`。低版本没有 `node:sqlite`，服务起不来 |
| 包管理器 | pnpm | 仓库根与 `web/` 各有一份 `pnpm-lock.yaml`；本文在 pnpm 12.17.0 上验证 |
| 磁盘 | 内容文件 + SQLite 索引 | 没有实测上限。`request_log` 由调度器每轮按 `retainDays` / `retainRows` 裁剪；四个维护开关全关时只在启动时裁一次 |
| 内存 | 未测量 | 没有常驻缓存，每次请求现读。FTS5 的索引在 SQLite 里，不占 Node 堆 |
| 网络 | 只有摘要生成与记忆抽取需要出网 | `summary.generator: rule` 与 `find` / `grep` 全程离线 |

`node:sqlite` 是实验性 API，启动时 Node 可能打印一行 `ExperimentalWarning`。它不影响功能，
也没有关掉的开关（那需要 `--no-warnings`，会把真正的警告一起吞掉）。

## 安装

```bash
pnpm install              # 后端 + Hook 插件的开发依赖（tsx、vitest、eslint）
cd web && pnpm install    # 控制台单独装：web/ 有自己的 lockfile，不在根 workspace 里
```

第二行会跑 `web/package.json` 的 `postinstall`（`nuxt prepare`），在 `web/.nuxt/` 下生成
Nuxt 类型。**这一步不是可选的**：`web/tsconfig.json` 的 `extends` 指向
`.nuxt/tsconfig.json`，`pnpm test` 里的 `tests/unit/web/` 走 Vite 转译时会读它——没有
这个文件，`pnpm test` 在第一个控制台用例上就报 `Cannot find module './.nuxt/tsconfig.json'`。
`nuxt prepare` 只做类型生成，不产出 `.output/`，耗时约 1 秒。

`integrations/` 不需要安装：它是纯 `.mjs`，只依赖 Node 内置模块，`dependencies` 为空。

**`web/` 是独立包，不参与根 pnpm workspace。** 根 `pnpm-workspace.yaml` 只有 `allowBuilds`、没有 `packages`，所以 `pnpm --filter web <script>` 会打印 `No projects matched the filters` 并以**退出码 0** 结束——空操作，看起来成功但什么都没做。操作控制台必须用 `pnpm --dir web <script>`；控制台的类型检查与构建由根 `pnpm build:web` 承担（`nuxt build` 自身不做类型检查），该步骤已在 `pnpm verify` 里。不要往 CI 里写 `pnpm --filter web build`，那会得到一条永远绿色的步骤。

## 配置

配置来源的优先级（`src/config/index.ts`）：**命令行参数 > 环境变量 > 配置文件 > 内置默认值**。

```bash
pnpm dev -- --config /etc/comem/config.yaml --data-dir /var/lib/comem
```

- 不写 `--config` 时读当前工作目录的 `config.yaml`；**文件不存在不是错误**，全部走默认值。
- 环境变量形如 `COMEM_<SECTION>_<KEY>`，嵌套段用下划线连接：
  `COMEM_SERVER_PORT=8080`、`COMEM_RETRIEVAL_ASSEMBLY_MAX_TOKENS=3200`。两个供应商密钥的
  真实名字是 `COMEM_PROVIDERS_LLM_DEFAULT_API_KEY` 与 `COMEM_PROVIDERS_EMBEDDING_API_KEY`。
- 数值、布尔、数组都会按默认值的类型转换；转换失败直接报错，不静默取 0。
- 字符串里的 `${VAR}` 在加载时展开，**变量未设置就报错**——静默保留字面量会把错误推迟到
  第一次调用模型时才出现。这条判定是**无条件**的：即使对应的 provider 是 `disabled` 也会
  展开，所以「把 type 改成 disabled」并不能绕过它。

**「留空」与「不设置」是两回事。** 空串（`apiKey: ""`，或环境变量赋成空值）等于「没有
密钥」：服务照常启动，模型调用在第一次用到时才失败（`PROVIDER_UNAVAILABLE`）。而 `${VAR}`
引用的变量**没有设置**时启动直接失败。前者是配置值，后者是模板语法。

`config.example.yaml` 是全量模板，**复制完不需要任何密钥就能启动**：里面两个 `apiKey` 都是
空串（`providers.llm.default.apiKey`、`providers.embedding.apiKey`），接真实模型时才填。
没有模型凭据的部署（本地开发、CI、只用规则摘要）把 `providers.llm.default.type` 改成
`disabled`，同时把 `summary.generator` 改成 `rule`——两者不一致时启动期抛
`INVALID_ARGUMENT`，不会等到第一次写文件才静默失败。

### 配置项

| 键 | 默认值 | 是什么 / 什么时候改 |
|---|---|---|
| `dataDir` | `""` | 数据根。空串表示按运行形态推导（§6.5）：容器里 `/var/lib/comem`、root 运行 `/var/lib/comem`、其余 `$XDG_DATA_HOME/comem`。挂卷或备份到别处时显式写 |
| `providers.llm.default.type` | `openai-compatible` | 走哪个 AI SDK provider。`anthropic` 走 `@ai-sdk/anthropic`；`disabled` 表示没有模型、不产生任何调用。此时 `summary.generator` 必须是 `rule`、`memory.consolidation.enabled` 与 `memory.workingMemory.enabled` 必须是 `false`，否则启动失败；`ingest.enabled` 仍可打开，但阶段二会被跳过并在报告里标出来（见「导入本机 Agent 对话」） |
| `providers.llm.default.baseUrl` | `https://api.example.com/v1` | 兼容 OpenAI 协议的服务地址。**默认值是 IANA 保留域名（RFC 2606），永远不可达**；保持它启动时会打一条 `warn`，说明摘要、记忆抽取、合并与检索改写都不会工作。换成自建网关或真实供应商地址 |
| `providers.llm.default.model` | `gpt-4o-mini` | 模型名。摘要质量与成本由它决定 |
| `providers.llm.default.apiKey` | `""` | 密钥。空串 = 没有密钥：能启动，调用时抛 `PROVIDER_UNAVAILABLE`。用 `COMEM_PROVIDERS_LLM_DEFAULT_API_KEY` 覆盖，或直接在 `config.yaml` 里填 |
| `providers.llm.default.maxTokens` | `32768` | 单次生成的 token 上限。**截断（`finishReason = length`）不重试**，抽取被截断时调大它（§11.4） |
| `providers.llm.default.timeoutSeconds` | `120` | 单次调用超时。长摘要或慢网关时调大 |
| `providers.llm.default.pricing.inputPerMillion` | `0.15` | 每 100 万输入 token 的单价（美元）。`comem_llm_cost_usd_total` 用它换算（§17.4） |
| `providers.llm.default.pricing.outputPerMillion` | `0.6` | 每 100 万输出 token 的单价 |
| `summary.generator` | `llm` | `llm` 走模型（`providers.llm.default.type` 不能是 `disabled`）；`rule` 断网降级（子节点名字 + 摘要首句拼接）。**`rule` 的结果恒带 `degraded: true`**，`/health` 会把它报成 `degraded` |
| `summary.abstractMaxChars` | `256` | L0 摘要的字符预算（§9.1）。超了截断，不重试 |
| `summary.overviewMaxChars` | `4000` | L1 概览的字符预算 |
| `retrieval.engine` | `fts5` | 检索后端：`fts5` / `vector` / `hybrid`。后两者需要 `providers.embedding`，没配时 `loadConfig` 直接报错 |
| `retrieval.candidateMultiplier` | `4` | 先取 `limit × N` 候选再按权限过滤，避免过滤后不足数（§8.2）。候选被拦得多时调大 |
| `retrieval.levelWeights.l0` / `.l1` / `.l2` | `1.15` / `1.05` / `1.00` | 层级加权（§8.5）。只用来在 BM25 接近时打破平局 |
| `retrieval.queryFilters` | `[]` | sed 风格正则数组，作用在 prompt 上，产物才是查询（§8.8）。Hook 侧也有默认五条 |
| `retrieval.assembly.maxTokens` | `1600` | 注入模型的 token 预算（§8.6）。模型上下文窄时调小 |
| `retrieval.assembly.dedupTurns` | `3` | 同一会话这么多轮内投过的 URI 不再投（召回账本，§8.7） |
| `retrieval.assembly.quotaPreset` | `coding` | `chat`（记忆 5 / 资料 3 / 技能 2）或 `coding`（3 / 5 / 2） |
| `session.autoCommit.enabled` | `true` | 自动提交开关。关掉就只能手动 `commit` |
| `session.autoCommit.pendingTokenThreshold` | `150000` | 未提交 token **严格大于**该值才提交（§10.2.1） |
| `session.autoCommit.messageCountThreshold` | `100` | 未提交消息数严格大于该值才提交 |
| `session.autoCommit.minCommitIntervalSeconds` | `0` | 两次自动提交的最小间隔（全局闸门）。调小会让归档碎片变多 |
| `session.autoCommit.idleTimeoutSeconds` | `0` | 空闲多久后**提交**。0 = 关。由后台调度器执行（§10.7） |
| `session.autoCommit.keepRecentCount` | `0` | 归档时保留最近 N 条在 live 会话里 |
| `session.expiry.idleTimeoutSeconds` | `0` | 空闲多久后**归档**（或删除）。0 = 关。与上面那个是两个独立开关 |
| `session.expiry.action` | `archive` | `archive`（只改 `status`，可逆）或 `delete`（物理删除会话目录，不可逆） |
| `memory.ttl.defaultDays` | `0` | 滑动窗口长度：最后一次使用（写入或检索命中）后多少天过期。0 = 永不过期。改它对存量立即生效 |
| `memory.ttl.sweepBatchSize` | `100` | 每轮最多清扫多少条，防止一次清太多把库锁住 |
| `memory.ttl.retentionDays` | `0` | 归档后保留多少天才物理删除文件与索引行。`0` = 永不物理删除（默认），只软归档 |
| `memory.reviewRequired` | `["experiences","rules"]` | 走复核闸门的记忆类型（§11.6）。从列表里去掉某个类型，它的写入直接是 `active` |
| `memory.profile.maxChars` | `800` | 用户画像正文的字符上限（§11.1）。超过后抽取提示词要求这次输出整份重写，只保留稳定身份。**压缩不额外调用模型**——骑在本来就要跑的 `memory_extract` 上 |
| `memory.workingMemory.enabled` | `false` | 开它会多一次模型调用（6 段工作记忆，§10.5）。只在长会话场景值得。**没有可用 LLM 时启动失败**：工作记忆没有规则生成器，不像摘要可以降级 |
| `acl.groupDefaultLevel` | `write` | 组空间根的预置级别（`write` / `read`） |
| `auth.trustLoopback` | `true` | 回环信任（§12.7）：没有凭据、来源是回环地址、且 `Host` 指向本机的请求被认证成 `server.subject`。**只允许在 `server.host` 是回环地址时打开**（否则启动期拒绝）；容器部署必须设成 `false`。它不是「关闭认证」——认证恒开，见「认证与账号」 |
| `auth.sessionSecret` | `""` | session token 的 HMAC 密钥。空串 = 进程随机值（重启失效）。要跨重启保持登录就配一个随机串 |
| `auth.sessionTtlSeconds` | `86400` | session token 有效期（秒）。改密码会轮换身份版本，旧 token 立即失效 |
| `auth.adminUserIds` | `[]` | 额外的系统管理员名单（`app_user.id`）。跨主体端点（列全部用户 / 组、建用户、建组、`/tasks`）只认这份名单与引导管理员（`app_user.bootstrap_admin = 1`）。默认空 = 只有 `/setup` 创建的第一个管理员；其它账号要管这些页面就显式列进来 |
| `server.host` | `127.0.0.1` | 监听地址。容器里改 `0.0.0.0` |
| `server.port` | `1933` | 监听端口。控制台的 devProxy 写死转 `1933`，改端口要同时改 `web/nuxt.config.ts` |
| `logging.level` | `info` | `debug` / `info` / `warn` / `error` / `fatal`（没有 `trace`：`Logger` 上不存在 `trace()`，留着会是一个不产生行为的配置值） |
| `logging.file` | `""` | 填路径则在 stdout 之外**额外**写一份 `error` 及以上级别的日志。10MB 轮转到 `<path>.1`（§17.8） |
| `telemetry.metrics.enabled` | `true` | 关掉时 `GET /metrics` 返回 404 并说明「指标已关闭」（空文本会被抓成「指标全为 0」） |
| `telemetry.metrics.includeAccountLabel` | `false` | 单账号部署没必要，开了会放大标签基数 |
| `telemetry.requestLog.enabled` | `true` | 是否写 `request_log` 表。这张表**只写不读**，没有查询端点，只能用 `sqlite3` 查（架构文档 §17.6） |
| `telemetry.requestLog.retainDays` | `7` | 请求记录保留天数。调度器每轮裁剪；调度器不启动时只在构造期执行一次 |
| `telemetry.requestLog.retainRows` | `100000` | 请求记录保留行数。同上 |
| `telemetry.requestLog.sampleRate` | `1.0` | 采样率。**错误请求永远全量记录** |
| `telemetry.hookOverhead.enabled` | `true` | 关掉时 Hook 阻塞开销直接丢弃，不累加指标 |
| `telemetry.hotness.weight` | `0` | 热度对最终排序的影响：`finalScore = score × (1 + weight × hotness)`（§17.5）。`0` = 不算热度、不参与排序。**记访问与是否参与排序是两件事**：无论 `weight` 是几，检索命中与按 URI 读取都会写 `node.access_count` / `last_accessed_at`（TTL 的滑动窗口读后者）；`weight` 非 0 只是让 `find` 多查一次访问统计并把它算进排序 |
| `telemetry.hotness.halfLifeHours` | `168` | 热度半衰期（一周，§17.5）。调小让热度掉得更快 |
| `task.leaseSeconds` | `60` | 任务租约。到期未续租会被启动扫描回收（§10.4） |
| `task.maxAttempts` | `3` | 单个任务最多执行 3 次，超限置 `failed` |
| `task.concurrency` | `4` | 阶段二执行器同时跑几个任务。每个任务会调模型，调太高会把供应商的速率限制打满 |
| `ingest.enabled` | `false` | 本机对话导入的总开关。关着时 `pnpm ingest` 拒绝真正写入，只允许 `--dry-run` |
| `ingest.batchSize` | `100` | 每个会话一次读多少条。100 与 MCP 单次批量写入的量级一致（§10.6 的验收场景） |
| `ingest.extractionBatchSize` | `20` | 阶段二每批等多少个会话。20 的来源见 `src/config/schema.ts` 的注释 |
| `ingest.extractionTimeoutMs` | `1800000` | 每批阶段二的最长等待（30 分钟）。`0` = 不等。超时按批算，不是按总量 |
| `ingest.paths.<harness>` | `[]` | 源路径覆盖。留空用默认路径：Claude Code `~/.claude/projects`、Codex `~/.codex/sessions`、DeepSeek `~/Downloads/**/conversations.json`、Qwen `~/Downloads/**/Qwen-chat-export-*.json` |

### 在控制台里改设置

服务端的配置只在**启动时读一次**。控制台不能热改内存里的快照，但可以把修改写进
第二份配置文件，重启后生效：

```
环境变量 COMEM_* > {dataDir}/_meta/config.override.yaml > config.yaml > 内置默认值
```

覆盖文件固定叫 `config.override.yaml`，位置由 `dataDir` 决定（默认数据根下的
`_meta/`，容器里是 `/var/lib/comem/_meta/config.override.yaml`）。

**加载顺序是两阶段。** `dataDir` 本身在配置里，覆盖文件的位置又由它决定，所以
`loadConfig` 先合并 `config.yaml` + 环境变量 + 默认值、只解析出 `dataDir`，再读
覆盖文件、把它合并进**文件层**（仍在环境变量之下），最后完整校验一次。合并是深
合并：只写 `providers.llm.default.pricing.outputPerMillion` 不会把同段的
`inputPerMillion` 清掉。

**覆盖文件里不能写 `dataDir`。** 它决定覆盖文件自己在哪里，改它等于换库；出现即
启动失败，并提示改用 `--data-dir` 或 `COMEM_DATA_DIR`。覆盖文件里的未知键（拼写
错误）与类型错误同样在启动期失败，错误消息带覆盖文件路径与字段。

#### 三个端点

| 端点 | 权限 | 说明 |
|---|---|---|
| `GET /api/v1/config` | 系统管理员 | 全部 84 个叶子。每项带 `path` / `value` / `source`（`default` / `file` / `override` / `env`）/ `envName` / `group` / `editable`；密钥类只回 `configured` 与 `masked`（`****abcd`，末 4 位），`value` 是 `null` |
| `PATCH /api/v1/config` | 系统管理员 | 请求体 `{ "values": { "providers.llm.default.baseUrl": "http://127.0.0.1:8089/v1" } }`；先完整校验，合法才原子写入（同目录临时文件 + `rename`，权限 `0600`） |
| `POST /api/v1/config/test` | 系统管理员 | 请求体 `{ "target": "llm" \| "embedding" \| "rerank" }`，回 `{ ok, latencyMs, detail }` |

`GET /api/v1/config` 顶层另有 `overridePath` 与 `overrideWritable`（`fs.access`
的结果）。`PATCH` 成功回 `{ written, overridePath, restartRequired: true }`——
**写了覆盖文件不等于生效**，必须重启进程。

**密钥的写入口只有 `apiKey`（以及不可编辑的 `auth.sessionSecret`）。** 写空串
等于清除（`apiKey: ""`），不写这个键等于不改。`GET` 的响应里永远没有明文；
`masked` 只保留末 4 位。

**这些值不可编辑，而且 `value` 恒为 `null`**（只回 `reason`）：`dataDir`、
`auth.sessionSecret`、`auth.adminUserIds`、`auth.trustLoopback`、`server.host`、
`server.port`、`logging.file`、`ingest.paths.*`、`task.*`。它们是部署拓扑、认证
边界或任务队列内部参数，暴露出去不会让控制台多出可用的设置，只会多出提权目标。
`retrieval.queryFilters` 的值可见但也不可写：schema 只校验它是字符串数组，非法
正则要等到检索时才报错。

**`POST /api/v1/config/test` 测的是当前进程已生效的配置，不是刚写到磁盘、还没
重启的覆盖文件。** 三个探针分别是：LLM 发一条 `maxTokens: 1` 的普通 completion
（不走结构化输出，非 JSON 网关也能测）；Embedding 嵌一个唯一短串，同时检查
`degraded` / `reason` 与 `vectors[0].length === dimension`（`type: disabled` 不抛
错，只回 `degraded`）；Rerank 直接 `POST <baseUrl>/rerank`。失败一律
`ok: false` 并带 `detail`。

#### Docker 下怎么写

容器里 `dataDir` 默认是 `/var/lib/comem`，`/var/lib/comem/_meta` 在数据卷里。
只要卷不是只读挂载，控制台的 `PATCH` 就能写；镜像里的 `USER node` 需要有该目录
的写权限。若数据根不可写，`GET /config` 的 `overrideWritable` 为 `false`，`PATCH`
以 `INTERNAL` 失败，不会留下半截文件。

```yaml
services:
  comem:
    volumes:
      - comem-data:/var/lib/comem   # 不要加 :ro；覆盖文件要写在这里
```

#### 回滚

覆盖文件是普通的 YAML，回滚等价于删键或删文件：

```bash
# 删掉一条（或几条）覆盖，保留其余
$EDITOR /var/lib/comem/_meta/config.override.yaml

# 全部回滚到 config.yaml / 环境变量
rm /var/lib/comem/_meta/config.override.yaml
```

两种操作都要重启进程。没有热重载：没有 `SIGHUP`，也没有 `fs.watch`。`PATCH` 不会
假装成功，响应里的 `restartRequired: true` 是固定值。

`pnpm check:config` 也会读覆盖文件：里面的每个键必须是 schema 里存在的节点，拼错
（zod 默认会安静剥掉未知字段）会让检查失败；覆盖文件**不需要**被 `config.yaml`
覆盖，它就是用来覆盖的。

### Hook 的注入预算

`SessionStart` 往对话里注入三个块（`<comem-profile>` / `<comem-preferences>` /
`<available-skills>`），各有 token 预算。这几项是 **Hook 插件**的配置（读
`~/.config/comem/config.yaml` 的**顶层**键，不是服务端配置的嵌套段；见
`integrations/README.md` 的「配置」），环境变量优先：

| 键 | 环境变量 | 默认 | 说明 |
|---|---|---|---|
| `profileBudgetTokens` | `COMEM_PROFILE_BUDGET_TOKENS` | `2000` | 用户画像的注入预算。注入的是索引（一条一行「摘要 + URI」），超了按 `CONTEXT_BLOCK_DROP_ORDER` 降级：技能清单 → 召回 → 偏好 → 画像 |
| `skillBudgetTokens` | `COMEM_SKILL_BUDGET_TOKENS` | `400` | 技能目录的预算。三档降级：全放 → 只名字 → 一行计数 |

**画像只注入正文。** `profile.md` 的 YAML frontmatter（`memory_type` / `created_at` /
`uri` / 256 字的 `summary`）在这条路径上被剥掉：前三个字段对模型是噪声，`summary`
是正文首行的副本。

**还有一层宿主字节上限。** Claude Code / Codex 在 hook 输出超过约 10,000 字符时
把整段转存成文件、只把预览放进上下文（9,500 是留余量的取值）。超限时 Hook 按
`CONTEXT_BLOCK_DROP_ORDER` 丢块（技能目录 → 召回 → 偏好 → 画像），记一条
`注入上下文超过宿主字节上限` 的 `warn`——看到它说明这次注入少了块，不是正常状态。
数字在 `integrations/hosts/*.mjs` 的 `MAX_CONTEXT_BYTES`，**没有独立复测**。
DSH 插件是进程内注入、不存在宿主输出上限，它仍用默认的 9,500 当保守上限。

### 没有可用 LLM 时

`providers.llm.default.type: disabled` 表示这次部署里没有模型。各功能的处理**不完全
相同**，这是有意为之，不是漏了校验：

| 功能 | 没有 LLM 时 | 为什么 |
|---|---|---|
| 目录摘要 | 降级成 `summary.generator: rule`，结果标 `degraded: true` | 规则生成器能直接产出可用的 L0 / L1，只是质量差 |
| 记忆合并 | 启动失败（`INVALID_ARGUMENT`） | 合并是 agentic 循环，规则生成器产不出操作列表 |
| 工作记忆 | 启动失败（`INVALID_ARGUMENT`） | 工作记忆没有规则生成器 |
| 归档提交（阶段二） | 降级：跳过 `memory_extract` / `memory_merge`，归档照常完成。`.meta.json` 的 `skippedSteps` 写明原因，记一条 `warn` 日志，`GET /health` 的 `memoryExtract.skipped` 为真 | 阶段一（归档落盘、建任务、`session` 关联）不依赖模型；跳过比让每个任务失败更诚实 |
| 本机对话导入（阶段二） | 降级：只归档，报告的 `extraction` 是 `{ skipped: true, reason: "llm_disabled" }` | 阶段一（归档 + 建任务 + 游标）不依赖模型，先导进来本身有价值 |

**为什么导入能降级、工作记忆不能。** 导入有两个独立的产物：阶段一（会话进库、能按
内容检索）和阶段二（生成摘要、抽取记忆）。缺少模型只让第二个产物消失，第一个仍在，
所以拒绝启动等于为了第二阶段的缺失丢掉第一阶段。工作记忆没有这个「阶段一」——它在
`archive_summary` 步骤的末尾，前面只有目录摘要（规则生成器也能做），后面只有工作记忆
本身。开了它却没有模型，这一步就只剩下「跳过一个空步骤」，配置项等于在撒谎。所以
`memory.workingMemory.enabled` 与 `providers.llm.default.type: disabled` 同时出现时
启动期失败，错误消息里带 `field: memory.workingMemory.enabled`。

**归档提交与导入走同一条判据。** 没有 LLM 时，`CommitRunner` 认领的归档任务同样
跳过 `memory_extract` 与 `memory_merge`：任务以 `done` 结束，`.meta.json` 的
`skippedSteps` 记下 `{ step: "memory_extract", reason: "llm_disabled" }`，并记一条
`warn` 日志。**跳过的归档不会补抽取**——它在阶段二结束时就已经是完成态，配好模型
之后重跑归档也不会再抽取一次。要保留补抽取的可能，只能让任务停在 `pending`，而那
与「阶段二不执行」是同义反复。

### 配置自检

```bash
pnpm check:config
```

三层静态检查，退出码非 0 表示有问题：

| 层 | 检查 | 抓什么 |
|---|---|---|
| L1 | `src/config/schema.ts` 的每个叶子都必须在 `src/**/*.ts` 里被读 | 加了配置项没接线 |
| L2 | `createContainer` 里 `new X({ ... config.a.b ... })` 的目标属性不能是可选 | 可选 = 忘了传也能编译 = 静默失效 |
| L3 | `config.example.yaml` 与 `configSchema` 的叶子集合双向一致 | 文档漂移 |

**L4（变体读取差集）在 `pnpm test` 里**：`tests/integration/config-coverage.test.ts` 按
`retrieval.engine` 的 `fts5` / `vector` / `hybrid` 各启动一次容器、各跑
`find` / `search` / `context` / `grep` / `glob`，差集非空即失败。它抓的是「只在某个
引擎分支被读」——L1 只能看到「有人读」，看不到「某个分支不读」。

四层都只证明「配置到达了代码」，不能证明「配置到达了行为」。「重排候选文本恒为空」
那一类（整条路径空转、模型一次都没被调用）只有人写的行为契约测试能抓。**`check:config`
全绿不代表配置生效。**

脚本会打印「歧义匹配」：手写的配置切片（`RetrievalSettings` 之类）与配置树是两份声明，
只能靠「属性名子集」的形状对上。当前 3 处（`workingMemory` 与 `telemetry.hookOverhead`
等都是 `{ enabled: boolean }`，静态不可区分），需要人工核对。改成 `z.infer` 派生类型
之后才能归零。

**遗留债务**：`LEGACY_OPTIONAL_CONFIG_DEPS` 记录 17 处已经存在的「配置值进入可选属性」。
清单只允许缩小，新增项直接报错。全部改必填要动 10 个接口与 62 处构造点，排在后续 wave。

### 孤儿检查

```bash
pnpm check:reachability
```

静态检查 `src/services/` 与 `src/adapters/` 里 exported 类的 public 方法、`src/domain/`
里 exported 的函数，在 `src/`（不含 `tests/`）里是否至少有一个值引用。退出码非 0
表示出现清单外的新孤儿。已接入 `pnpm verify`。

它抓的形态是「代码、类型、测试都在，生产链路不经过它」：

| 类别 | 含义 |
|---|---|
| 零引用 | `src/` 里一个值引用都没有（同类内部调用不算） |
| 只被测试引用 | 生产没有调用方，只有 `tests/` 在调 |
| 只有同类内部引用 | public 方法只被自己的类调用，公开面没有外部消费方 |

排除：`import type` / `typeof` / 类型注解不算引用；只被 `api/`、`bootstrap/`、
`commands/`、`ingest/`、`eval/` 调用算有调用方；端口实现（显式 `implements`，或结构上
满足只声明方法的消费方契约）按接口另一端的调用判定，另一端没人调仍算孤儿。

**遗留债务**：`scripts/reachability-baseline.json` 只记两个上限数字（`testOnly` / `methodTestOnly`），
每条带一句
判断（待删 / 该接线 / 待收窄）。条数以该文件的 `BASELINE` 为准，不在这里写死——这个数字每轮
都在变，抄进文档就成了一份会漂移的副本。清单只允许缩小：修掉一条删一行，留着会报「清单过期」。
新增孤儿直接失败——不要为了让检查通过而加白名单。

**残余**：它只证明「有人写了这个方法名」，不证明「调用真的发生并产生效果」。字符串
派发（`phase('archive', ...)` 的 `'archive'` 不在 `ASYNC_PHASES` 里）、默认关闭的配置
分支、传空参数导致早退、只被另一个孤儿调用，以及「有调用方但返回值恒空」都抓不到。
这些需要行为契约测试或调用图可达性分析。

### 形状检查

```bash
pnpm check:shape
```

静态检查四类结构指标，全部是**上限 ratchet**（只能降，不能升）：

| 项 | 口径 | 失败条件 |
|---|---|---|
| 单文件行数 | `wc -l`（含空行与注释），默认上限 250 | 不在基线里的文件 > 250；基线里的文件 > 记录值 |
| 超长函数 | 函数体行数 > 120 的个数 | 个数 > 基线 `functionsOver120` |
| src 总行数 | `src/` 下全部 `.ts` 的 `wc -l` 合计 | 合计 > 基线 `srcLines` |
| 禁用指令 / any | `@ts-ignore`、`@ts-expect-error`、`eslint-disable` 必须为 0；`as any`、`: any` 记数 | 指令出现即失败；any 计数 > 基线 |

基线在 `scripts/shape-baseline.json`：只记录当前超过 250 行的文件（路径 → 行数）与
`functionsOver120` / `srcLines` / `asAny` / `typeAny` 四个数字。没有文件级白名单——例外
只有基线里那一行数字，而它只能降。

检查**只读**：文件被拆小或删除、数字下降时只打印「基线可收紧」，写文件要显式跑
`pnpm check:shape --update-baseline`，而它拒绝任何让上限变大的写入（exit 2）。基线存在
之后，新文件一律按 250 行判：一个 260 行的新文件不能靠更新基线进来，先拆到 250 以内。

**残余**：文件行数不是职责划分（1500 行拆成 6 个 250 行的文件，检查全绿，耦合没变）；
函数长度可以靠拆私有方法绕过，超长表达式、超长类、超长 `switch` 不统计；`any` 只认
`as any` 与 `: any` 两种写法（`Array<any>`、`<any>x` 不算）；「注释掉的代码」刻意不检查
——「看起来像代码」没有可执行的判据，高频误报的硬零项只会训练人绕过检查。

## 质量门禁

`pnpm verify` 依次跑下面大部分命令。每一层保护什么、不保护什么：

| 命令 | 覆盖 | 不覆盖 |
|---|---|---|
| `pnpm typecheck` | `src/`、`tests/`、`scripts/`（根 `tsconfig.json` 的 `include`） | `web/`、`integrations/` |
| `pnpm lint` | `src/`、`tests/`、`scripts/`、根配置文件 | `web/`、`integrations/`、`docs/`（eslint ignores） |
| `pnpm build:web` | `web/` 的类型检查（`nuxt typecheck`）+ 构建 | 没有 lint |
| `pnpm check:config` | 配置项是否真的有消费方（L1–L3，加上 `pnpm test` 里的 L4） | 配置到达行为 |
| `pnpm check:reachability` | `src/` 的生产引用图 | 字符串派发、默认关闭的分支、返回值恒空 |
| `pnpm check:shape` | 文件行数、超长函数、`src/` 总行数、禁用指令与 `any` 计数的 ratchet | 职责划分、超长表达式 / 类 / `switch`、注释掉的代码 |
| `pnpm test` | `tests/**/*.test.ts`（unit + integration） | `integrations/` |
| `pnpm test:integrations` | `integrations/tests/*.test.mjs` | `src/` |
| `pnpm test:e2e`（不在 `verify` 里） | `scripts/demo.sh` 用临时数据根走一遍六条核心链路（演示脚本，失败即非零退出） | 不是单元测试，没有断言库 |

**`web/` 与 `integrations/` 没有 lint**，这是已知空洞。控制台的类型错误由 `build:web`
抓，Hook 插件的正确性由 `test:integrations` 的 173 条断言抓。

## 认证与账号

认证恒开：控制台只有一个入口（登录），每个非公开端点都要求
`Authorization: Bearer <凭据>`。回环信任（`auth.trustLoopback`，默认 `true`）让本机的
`curl`、hook 插件、MCP 客户端不必存凭据——它不是第二个模式，被认证的身份仍然是一个
真实的用户账号。

```yaml
auth:
  # 回环信任：没有凭据的本机请求认证成 server.subject（默认 user:local）。
  # 只允许在 server.host 是回环地址时打开；容器部署必须设成 false。
  trustLoopback: true
  # 留空 = 进程随机值：重启后已签发的 token 全部失效。要跨重启保持登录就配一个
  # 足够长的随机串（`openssl rand -base64 48`），并保证它不泄露。
  sessionSecret: ""
  sessionTtlSeconds: 86400
  # 额外的系统管理员（app_user.id）。第一个管理员由 /setup 的引导流程自动获得管理权；
  # 这份名单是给第二个及以后的管理员用的。默认空 = 只有引导管理员。
  adminUserIds: []
```

- 还没有任何账号设过密码时，控制台整页进 `/setup` 创建第一个管理员（见「建第一个账号」）。
  这是唯一一条首跑路径：单用户部署第一次打开浏览器也走它。
- 凭据有两种：登录拿到的 session token，或 `POST /api/v1/admin/users/{id}/api-keys`
  签发的 API Key（`comem_...`）。缺失或无效一律 401 `UNAUTHENTICATED`；带凭据的请求
  每个独立求权，仍然拒绝 `group:` 主体——组永远不能当认证主体。
- **`x-comem-subject` 不是凭据**，服务端不读它。本机进程用回环信任，跨网络用 Bearer。
- **信任模型**：能连上本机端口的人本来就能读这个数据根，与 `~/.ssh` 的权限模型同级。
  判定要求来源地址是回环地址 **且** `Host` 指向本机（挡 DNS rebinding）；带了凭据就按
  凭据解析，无效不会回退到回环信任。
- **容器部署必须关掉它**（`COMEM_AUTH_TRUST_LOOPBACK=false`）：容器绑 `0.0.0.0`，而
  回环信任只允许回环监听。关掉之后所有请求都带 Bearer——回环信任是一个全局开关，不按
  来源地址部分生效，所以容器内进程访问 `127.0.0.1:1933` 也需要凭据。

### 谁能管用户与组

两类判定（架构文档 §12.4）：

- **对目标资源求 `manage`**：改密码、改资料、启用禁用、删除用户、签发 / 列出 / 吊销
  API Key、改组资料、删除组、加退成员。吊销 API Key 的请求里只有 key ID，服务端先反查
  持有者再对持有者的根求权。
- **只认系统管理员名单**：`GET` / `POST /admin/users`、`GET` / `POST /admin/groups`、
  `GET /tasks`、`GET /tasks/{id}`、`POST /tasks/{id}/retry`。这些端点没有目标资源可求权
  （`task` 表没有 scope 或 uri 列），按 `auth.adminUserIds` 判定。

系统管理员有两个来源：`POST /api/v1/bootstrap/admin` 创建的第一个管理员
（`app_user.bootstrap_admin = 1`，端点随后永久关闭），以及 `auth.adminUserIds` 里显式
列出的用户 ID。两者都不是隐式规则：引导管理员只写一次，名单默认空。

**回环信任给出的 `server.subject` 不是管理员。** 本机 `curl` 以这个身份发请求，但跨
主体端点不认「请求来自本机」这个事实。要把管理面开放给其它账号，把它的 ID 写进
`auth.adminUserIds` 并重启；否则控制台的「用户与组」页、概览页的待处理任务卡与会话页的
任务表都会一直报 403。

**升级时必须补这份名单（破坏性变更）。** 早期版本的用户与组管理对任何已认证身份开放；
现在只有引导管理员和名单里的人能管。从旧配置升上来、且已经初始化过（`/setup` 返回
`BOOTSTRAP_CLOSED`）时补 `adminUserIds: [<uid>]`，否则这些页面一直 403。

**先跑过 `pnpm password` 的部署最容易踩。** 那个账号有密码，所以 `/setup` 认为初始化
已经完成（返回 `BOOTSTRAP_CLOSED`），但它**不是**引导管理员（引导标记只在
`POST /bootstrap/admin` 里写入）。把它的 ID 写进 `auth.adminUserIds` 再重启，否则登录
成功却管不了任何人。

### 建第一个账号

一条路径：起服务 → 从启动日志拿初始化令牌 → `/setup` 建管理员 → 登录。本地开发、
Docker、纯 SSH 都走它，区别只在地址与端口。

**Docker（docker compose）**

```bash
docker compose build                  # 镜像里要带当前代码；换过代码就必须重新构建
docker compose up -d
docker compose logs comem | grep 初始化令牌
```

首次启动的日志里会有一行（令牌每次进程启动重新生成，只存在内存里）：

```
初始化令牌：xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx（用于首次创建管理员账号；创建完成后失效）
```

打开 http://127.0.0.1:18080/setup ，填三个字段：

| 字段 | 填什么 |
|---|---|
| 用户名 | 默认 `local`（取自 `server.subject`），也可以改成别的合法用户 ID |
| 密码 | 至少满足服务端的弱口令规则 |
| 初始化令牌 | 上面日志里那一串 |

提交后页面直接去 `/login`，用刚才的用户名和密码登录。这个管理员通过
`app_user.bootstrap_admin` 标记直接获得系统管理员权限，不用再配 `adminUserIds`。

**本地开发（`pnpm dev`）**

```bash
pnpm install
cd web && pnpm install && cd ..
pnpm dev
```

打开 http://127.0.0.1:3081/setup 。从回环地址打开时**不需要令牌**（令牌是给经 nginx
转发的 Docker 请求用的），填用户名与密码创建；然后到 `/login` 登录。

默认用户名是 `local`（`server.subject` 的默认值）。**建议就用它**：本机的 `curl` 与
hook 插件通过回环信任拿到的身份也是 `user:local`，建同一个 ID 才不会出现「两个都是我的
账号」的分裂。要换成别的 ID，把 `server.subject` 一起改。

**没有浏览器（纯 SSH）时**，用同一个端点创建第一个管理员：

```bash
curl -sS -X POST http://127.0.0.1:1933/api/v1/bootstrap/admin \
  -H 'content-type: application/json' \
  -d '{"userId":"local","password":"你的密码","setupToken":"日志里的令牌"}'
```

回环请求可以省略 `setupToken`；容器部署把端口换成 compose 映射的 `18081`（直连后端）。

**之后加账号。** 在控制台「用户与组」页的「新建用户」建账号。**新账号建出来没有密码，
要打开该用户的详情抽屉，在「密码」页签里设一次**——不设的话，用它登录会得到「用户名或
密码错误」。`POST /admin/users` 只收 `id` / `displayName` / `email`，密码走
`POST /admin/users/{id}/password`。新账号不是系统管理员；要给它管理面权限，把它的 ID
写进 `auth.adminUserIds` 并重启。

#### 忘记密码 / 没有浏览器：`pnpm password`

管理面设密码的端点自己也要认证，所以「已经有了账号、但密码忘了或拿不到浏览器」时用
命令（密码从 stdin 读，不进 shell history / ps）：

```bash
# 宿主机（在仓库根目录执行）
printf '%s' '新密码' | pnpm password local

# 容器（docker compose 部署）
printf '%s' '新密码' | docker compose exec -T comem node dist/commands/password.js local
```

两个前置条件：

- **数据根已经初始化。** 服务启动过一次才会建 `_meta/comem.sqlite`；在从未启动过的
  数据根上跑，报的是「数据根还没有初始化：先启动一次服务」，不是密码设错了。
- **用户已经存在。** 命令只改密码，不建账号。没有账号时先走 `/setup`（浏览器）或上面
  的 `POST /bootstrap/admin`（无浏览器）；否则报「用户不存在：… 先用 POST /admin/users
  或控制台的「用户与组」页创建账号」。

认证恒开，命令写完就能登录。也可以不开控制台，直接用登录端点换 token：

```bash
curl -sS http://127.0.0.1:1933/api/v1/auth/login \
  -H 'content-type: application/json' \
  -d '{"username":"local","password":"..."}'
```

响应里的 `token` 就是后续请求的 `Authorization: Bearer <token>`。容器部署把 `1933`
换成 compose 映射的宿主端口（默认 `18081`，正常入口 `18080` 走代理也一样）。

### 恢复组的 owner

删账号会把该用户持有的组 `owner_user_id` 清成 `NULL`（架构文档 §12.2、§12.6）。组里如果
没有第二个组根 `manage` 持有者，`POST /admin/groups/{id}/owner` 会在求权阶段 403——这个
组不能再改 ACL、不能加成员，控制台的组列表会用「无所有者」标出来。恢复用命令：

```bash
pnpm group:owner eng alice
```

`groupId` 是组 ID（不是 `comem://` URI），`userId` 是要接手的人（必须已存在）。

**为什么不走 HTTP。** 改 owner 的端点自己要求「当前 owner 或组根 manage」。owner 已经被
删、组里又没有第二个 manage 持有者时，这个前提不成立，HTTP 永远是 403。命令直接打开
数据库写行，再补组根的 `.acl.json`，与 `pnpm password` 解决的是同一类引导循环。

命令做两件事：把 `app_group.owner_user_id` 写成目标用户，替换组根 `.acl.json` 里的
`user:{owner} = manage` 条目；其它条目与 `mode` 保留。通配主体 `*` 与非 `user` 格式
（例如 `group:eng`）在写盘之前就被拒绝。

### 管理 API Key

```bash
# 签发（明文 key 只在这一次响应里出现）
curl -sS http://127.0.0.1:1933/api/v1/admin/users/alice/api-keys \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"name":"ci"}'

# 列出（只有 prefix，永不回哈希）
curl -sS http://127.0.0.1:1933/api/v1/admin/users/alice/api-keys \
  -H "authorization: Bearer $TOKEN"

# 撤销
curl -sS -X DELETE http://127.0.0.1:1933/api/v1/admin/api-keys/key_xxxxxxxx \
  -H "authorization: Bearer $TOKEN"
```

一把 key 就是那个用户的完整凭证，没有 scope。共享范围靠路径级 ACL（架构文档
§12.5）。

### 已知限制

- **登出只是客户端丢弃 token。** token 是无状态 HMAC，服务端没有「已签发」的
  表，无法提前作废某一个 token。要让某个用户的全部 token 失效走改密码（轮换
  `app_user.session_epoch`），要只作废一把 key 走吊销。
- **`sessionSecret` 留空时重启会让所有登录失效。** 这是刻意的默认值：不配置就
  不需要运维记住一个密钥，代价是重启后重新登录。
- **组关系每请求查库。** 退组、加组立即生效，不需要重启。
- **删组保留数据，但清空该子树内的全部 ACL 条目。** `DELETE /admin/groups/{id}`
  删的是组目录行与组子树里的授权，`comem://group/{gid}/` 下的文件不删。重建同 ID
  的组不会继承任何旧授权；旧文件对谁都不可读，直到新的组根预置与后续授权生效。
  要连数据一起删，用文件系统显式删除该目录（不可逆，不在 HTTP 管理面）。响应里的
  `clearedAclFiles` 是这次清空了几个 `.acl.json`。
- **删账号不删数据。** `comem://user/{uid}` 下的文件、`node` / `node_fts` 行、
  `request_log` 的历史行都保留；删除的是身份行、成员关系、API Key、组 owner 元数据、
  该主体与命名空间里的 ACL 条目，以及召回账本。同 ID 重建的账号会重新拿到自己命名
  空间的根预置（owner 恒 manage），所以它仍能读旧数据——这是「数据是资产，账号是
  主体」的有意设计，不是漏删。要连数据一起删，用文件系统显式删除该目录（不可逆，
  不在 HTTP 管理面）。
- **召回账本是缓存，删账号 / 组时一起删。** `_meta/recall/*.recall_log.json` 记的是
  「这个作用域投过哪些 URI」。`DELETE /admin/users/{id}` 与 `/admin/groups/{id}` 在撤权
  之前先删对应账本（`src/api/http/routes/admin-users.ts:114`、`src/api/http/routes/admin-groups.ts:181`），同 ID 重建的账号不会继承
  去重状态。账本是缓存，删除的代价只是「多投一次」；先删它，失败时什么都没动。
- **`node_embedding` 按 URI 留旧向量。** 向量行带 `content_digest`：正文变了就重算，
  正文没变就复用。它只回答「这段正文的向量是什么」，不携带授权信息，所以删账号不清
  向量**不算越权**。要回收空间，删账号后用文件系统删目录、再重建索引。
- **`embedding_cache` 是内容寻址。** 缓存键是正文摘要，不是路径或主体。命中的唯一
  含义是「这段正文之前算过」——只说明正文相同，**不泄露授权信息**，也不因为账号删除
  而失效。
- **`request_log.subject` 的历史行保留。** 审计日志本来就该保留：删账号是「以后不能
  用」，不是「历史没发生过」。按主体查历史请求仍会看到被删的 ID。
- **删账号不取消已入队的后台任务。** 归档任务（`task` 表）的 payload 只有
  `sessionUri` / `archiveUri` / `archiveId`，不记录入队者的主体；阶段二执行时按装配
  层的服务图身份跑，**不做二次求权**。这是设计：任务是对「入队时已经授权过的写入」
  做延迟执行。执行期重新求权会引入另一类问题——入队后撤销权限会让归档停在
  `phase1.status = ready` 且永远没有 `.done`，消息已经移出 live、记忆永远不会被抽取。
  删账号不删数据（见上一条），任务写回的是同一个保留的数据树，不构成新的越权。要阻止
  某个作用域的后台写入，停服后删 `task` 表里对应 `sessionUri` 的行。

## 提示词

内置提示词的静态骨架在仓库的 `prompts/` 下，随代码一起发布：

| 文件 | 什么时候发给模型 |
|---|---|
| `extract-system.md` / `extract-user.md` | 记忆抽取（§11.3、§11.4） |
| `experience-system.md` / `experience-user.md` | 经验归纳（§10.1 第 5 步） |
| `summarize-system.md` / `summarize-user.md` | 目录摘要（§9.2） |
| `rewrite-system.md` / `rewrite-user.md` | 查询重写（§8.4） |

**优先级：仓库默认 < 数据库覆盖。** 控制台的「提示词」页改的是 SQLite 的 `prompt_override`
表（`0001_init.sql`），「恢复默认」就是删掉那一行。不让服务端直接改仓库文件，是因为
容器只读挂载、多副本部署、`git status` 被污染这三个场景下「改仓库文件」都不成立。

**改 `.md` 不需要重启。** 默认模板每次渲染都读一次磁盘（几 KB，而一次模型调用是秒级），
没有缓存要失效——改完发下一条请求就生效。

**读与写分权限。** `GET /prompts` 与 `GET /prompts/{id}` 任何已认证身份都能读；
`PUT` / `DELETE` / `POST /prompts/{id}/preview` 要系统管理员（`auth.adminUserIds`，
架构文档 §12.4）。提示词是全局的，改它等于改所有身份的注入行为，没有「目标资源」可以
表达这件事。名单为空时控制台的「提示词」页只能看不能改。

### 校验会拦住什么

| 情况 | 什么时候报 | 报什么 |
|---|---|---|
| 变量拼错（`{{pagess}}`） | 保存时、启动时 | `INVALID_ARGUMENT`，带提示词标识、行号与可用变量 |
| `{{` 没有配对的变量名 | 保存时、启动时 | 同上，带行号 |
| 模板需要的变量没有传 | 渲染时 | `INVALID_ARGUMENT`，带变量名 |

**不会「尽量渲染」。** 一条渲染出 `{{pages}}` 字面量的提示词会让模型把占位符当成正文，
而错误只会在模型的输出里出现。

### 升级之后「我的覆盖落后了」

保存覆盖时会记下当时默认模板的摘要（`prompt_override.base_digest`）。新版本改过默认值
之后摘要对不上，控制台的「提示词」页会在这一条上显示「默认值已更新」——覆盖仍然生效，
但它基于的是旧版本的默认值。点「恢复默认」回到新默认值，或者对照 `prompts/*.md` 重新改。

**数据库里的覆盖不合法时服务起不来。** 一条引用了不存在变量的覆盖会让每一次模型调用
失败，而失败只出现在后台任务里，所以启动时直接报错。处理方式：

```bash
sqlite3 "$COMEM_DATA_DIR/_meta/comem.sqlite" \
  "DELETE FROM prompt_override WHERE prompt_id = 'extract-user';"
```

### 已知限制

- **多副本部署不同步。** 覆盖在进程启动时读进内存，一个副本保存不影响另一个。多副本要给
  每个副本各改一次。
- **只支持 `{{name}}` 变量替换，没有条件与循环。** 动态部分（记忆类型清单、页面列表）
  由代码渲染成字符串后注入。模板引擎表达不了「空列表要说一句明确的话」这类领域判断——
  而那条判断决定了模型会不会自己编造 `page_id`。

## 启动

### 开发

```bash
pnpm dev                 # 后端 + 控制台一起起（端口跟着 COMEM_SERVER_PORT 走）
pnpm dev:server          # 只起后端 127.0.0.1:1933，tsx 直接跑 TypeScript
pnpm dev:web             # 只起控制台 127.0.0.1:3081，devProxy 把 /api 转到 1933
bash scripts/demo.sh     # 一条命令跑完六条链路，用 /tmp/comem-demo 这个临时数据根
```

### 生产

```bash
pnpm build                # tsc -p tsconfig.build.json → dist/（含 SQL 迁移）
node dist/bootstrap/main.js --config /etc/comem/config.yaml
```

`pnpm start` 等价于上面第二条命令。**开发仍用 `tsx`**（`pnpm dev` / `pnpm dev:server`），
生产跑编译产物。

**为什么需要 `tsconfig.build.json`。** 根 `tsconfig.json` 是 `noEmit: true` 的类型门禁，
且用 `moduleResolution: Bundler`；产物要交给 Node 直接跑，模块解析必须按 Node 的 ESM
语义来。构建配置改成 `module: NodeNext` + `moduleResolution: NodeNext`、`rootDir: src`、
`outDir: dist`。源码的 import 本来就带 `.js` 扩展名（`import ... from '../domain/errors.js'`），
所以不需要改任何源码。

**SQL 迁移是 `.sql`，`tsc` 不会复制。** `database.ts` 用
`new URL('./migrations', import.meta.url)` 定位它们，所以 `build` 脚本最后跑
`scripts/copy-build-assets.mjs` 把 `src/adapters/sqlite/migrations/` 复制到
`dist/adapters/sqlite/migrations/`。漏掉的表现是启动时 `ENOENT`，不是「少一张表」。

`tsx` 仍是 devDependency，`pnpm test`（vitest）与 `pnpm dev` 用它。生产镜像里没有它：
`pnpm start` 现在只是 `node dist/bootstrap/main.js` 的别名。

### 退出

`SIGINT` / `SIGTERM` 走优雅退出：先 `app.close()` 停收新请求，再停后台调度器
（会等在途的一轮跑完），再等后台摘要失效跑完（`indexObserver.drain()`），最后关数据库。
10 秒没退完就强退（`process.exit(1)`）——「优雅但可能挂住」不如「确定会结束」
（`src/bootstrap/main.ts` 的 `SHUTDOWN_TIMEOUT_MS`）。

## Docker 部署

生产镜像定义在仓库根的 [`Dockerfile`](../Dockerfile)，[`.dockerignore`](../.dockerignore)
控制构建上下文。`docker-compose.yaml` 是可选的完整拓扑（后端 + 控制台 + 反向代理 +
可选的本地推理）。

### 两种镜像：核心与本地推理

镜像里**只有核心是必需的**。本地推理（`llama.cpp` + Vulkan + Mesa + Python venv）
是一个显式 target，默认不构建：

| 镜像 | 构建命令 | 大小 | 什么时候需要 |
|---|---|---:|---|
| 核心 `comem:local` | `docker build -t comem:local .` | **285 MB** | 默认。嵌入 / 重排走远程 OpenAI 兼容 API（OpenAI、智谱、自建网关） |
| 推理 `comem:local-inference` | `docker build --target inference-runtime -t comem:local-inference .` | **932 MB** | 容器内跑 embedding / rerank（`providers.embedding.type: openai-compatible` 指向本镜像的 `/v1/embeddings`） |

两者只差推理运行时（+647 MB）：Vulkan loader + Mesa + `vulkan-tools`（257 MB）、
Python 3.12 解释器（32 MB）、`llama-cpp-python` venv（358 MB）。**后端代码与 MCP 工具
完全相同**，核心镜像不是「功能删减版」。

`docker compose build` 只构建核心镜像；推理服务在 `inference` profile 里，不指定
`--profile inference` 时既不构建也不启动。

镜像**在目标机上构建**：`llama.cpp` 默认按构建机的 CPU 指令集编译
（`-DGGML_NATIVE=ON`），编译机与运行机同一台时性能最优。CI 构建再分发到别的机器
必须打开可移植开关，见「可移植构建」。

### 阶段划分

| 阶段 | 基础镜像 | 职责 | 缓存键 |
|---|---|---|---|
| `base` | `node:24-bookworm-slim` | `ca-certificates`（pnpm 只在构建链里装） | 基础镜像 |
| `deps` | `base` | 固定版本的 pnpm + 后端与控制台两份完整依赖（含 devDependencies） | 两个 `package.json` + 两个 `pnpm-lock.yaml` + 两个 `pnpm-workspace.yaml` |
| `build` | `deps` | `pnpm typecheck` + `pnpm check:config` + `pnpm --dir web build` + `pnpm build`（`dist/`） | 全部源码 |
| `test` | `build` | `pnpm lint` + `pnpm test` + `pnpm test:integrations`（**只在 `--target test` 时构建**） | 全部源码 |
| `prod-deps` | `deps` | `pnpm prune --prod` 裁出生产依赖子集 | 同 `deps` |
| `inference` | `python:3.12-slim-bookworm` | 源码编译 `llama-cpp-python`（CPU + Vulkan 后端） | 只有版本 ARG，**与 CoMem 源码无关** |
| `core` | `base` | `dist` + 生产依赖 + `prompts` + `integrations` + `web/.output` | 上面各阶段的产物 |
| `inference-runtime` | `core` | `core` + Vulkan / Mesa 运行库 + Python + 推理 venv | `inference` 阶段 + apt 包版本 |
| `runtime` | `core` | **默认目标**，等于核心镜像（放在最后，`docker build .` 产出核心） | — |

`inference` 阶段不 `COPY` 任何仓库文件，所以改一行 TypeScript 不会重编 `llama.cpp`
（冷编译约 105 秒，热缓存 0 秒）。核心镜像的构建完全不碰这个阶段。

### 构建

```bash
# 核心镜像（默认目标 = runtime）
docker build -t comem:local .

# 本地推理镜像：核心 + llama.cpp / Vulkan / Mesa / Python
docker build --target inference-runtime -t comem:local-inference .

# 测试镜像：生产镜像按定义不带 vitest / eslint，全量门禁要单独构建
docker build --target test -t comem:test-suite .

# 可移植：多 ISA 变体，编译时间与体积都更大
docker build --target inference-runtime --build-arg COMEM_PORTABLE_CPU=1 -t comem:portable .
```

实测（16 核 / 30GB，本机）：

| 场景 | 耗时 | 镜像大小 |
|---|---|---|
| 核心镜像冷构建（`--no-cache`） | 见 `local/env-log.md` | 285 MB |
| 核心镜像热构建（改一行 `src/`） | 约 26 秒 | 285 MB |
| 推理镜像（`inference` 阶段命中缓存） | 约 11 秒 | 932 MB |
| 只重编 `llama.cpp`（`pip` 层缓存失效） | 约 105 秒 | — |

依赖层只依赖两个 lockfile：改源码不会重装依赖。`pnpm` 的 store 用 BuildKit
cache mount（`--mount=type=cache,id=comem-pnpm-store`），换 lockfile 才会重新下载。

### 启动

```bash
docker run -d --name comem \
  --init \
  --restart unless-stopped \
  -p 127.0.0.1:1933:1933 \
  -v comem-data:/var/lib/comem \
  -v "$PWD/config.yaml:/etc/comem/config.yaml:ro" \
  comem:local
```

- `--init`：让 `tini` 当 PID 1，回收僵尸进程。镜像的 entrypoint 是
  `exec "$@"`，`node` 直接拿到 SIGTERM；实测 `docker stop` 到进程退出 220ms，
  日志里有 `CoMem 已退出。`
- 默认命令是 `node dist/bootstrap/main.js --config /etc/comem/config.yaml`。
  `--config` 指向的文件**可以不存在**（`loadConfig` 把「文件不存在」当默认值），
  挂载进来就生效。
- 覆盖命令：`docker run --rm comem:local node dist/commands/ingest.js --source all`。
  `ENTRYPOINT` 是 `exec "$@"`，所以直接写 `node dist/commands/*.js` 即可。
  **镜像里没有 pnpm**（运行期不需要包管理器），`pnpm <script>` 的写法在容器里不可用。
- 镜像里只有编译产物 `dist/`，没有 `src/`。要调试就改源码后重新构建；不要试图
  在容器里直接跑 `.ts`（源码的 import 是 `.js` 扩展名，Node 的类型剥离解析不到）。

### 环境变量

配置的优先级是 **CLI 参数 > 环境变量 `COMEM_<SECTION>_<KEY>` > 配置文件 > 内置默认值**
（`src/config/index.ts`）。

| 变量 | 镜像默认 | 说明 |
|---|---|---|
| `COMEM_SERVER_HOST` | `0.0.0.0` | 监听地址。**镜像把它设成了 0.0.0.0**，因为 `config.schema.ts` 的默认值是 `127.0.0.1`，容器里绑 loopback 时 `-p` 端口转发不可达 |
| `COMEM_SERVER_PORT` | `1933` | 监听端口。`HEALTHCHECK` 与 `EXPOSE` 都跟它走 |
| `COMEM_AUTH_TRUST_LOOPBACK` | `false` | **镜像默认关掉回环信任。** 容器必须绑 `0.0.0.0`，而回环信任只允许回环监听，两者冲突；设成 `true` 会让服务在启动期拒绝（`server.host` 非回环 + 回环信任）。关掉之后，经 nginx 来的请求走 Bearer，容器内进程访问 `127.0.0.1:1933` 仍走回环信任。第一个管理员用启动日志里的初始化令牌在 `/setup` 创建 |
| `COMEM_DATA_DIR` | `/var/lib/comem` | 数据根。容器内按 `/.dockerenv` 推导，显式覆盖见「数据卷」 |
| `COMEM_PROVIDERS_LLM_DEFAULT_API_KEY` / `COMEM_PROVIDERS_EMBEDDING_API_KEY` | 无 | 两个供应商密钥的**真实**环境变量名（`COMEM_<SECTION>_<KEY>`）。模板里的 `apiKey` 是空串，用它们覆盖。`docker-compose.yaml` 透传的是旧的 `COMEM_LLM_KEY` / `COMEM_EMBEDDING_KEY`——只有在你自己的 `config.yaml` 里写 `${VAR}` 引用时才生效 |
| `TZ` | 未设置（UTC） | 日志时间戳是 UTC ISO 8601。需要本地时间就 `-e TZ=Asia/Shanghai` |
| `VK_ICD_FILENAMES` | 不需要 | Mesa 的 ICD 在默认搜索路径里，不用手工指定 |
| `GGML_BACKEND_PATH` | `/opt/comem-inference/backends/libggml-vulkan.so` | **只存在于 `comem:local-inference`**。DL 构建里 ggml 不会自动加载 Vulkan 后端（见「踩过的坑」第 14 条），这个变量是唯一入口。native 构建里它指向已载入的同一个 `.so`，重复 dlopen 是幂等的 |

**`server.host` 的坑。** 因为镜像把 `COMEM_SERVER_HOST` 设成了 `0.0.0.0`，而环境
变量优先于配置文件，**`config.yaml` 里写 `server.host` 不会生效**。要改监听地址用
`-e COMEM_SERVER_HOST=...`。这是 `loadConfig` 的优先级语义，不是镜像的 bug；但它是
「配置改了不生效」那一类，所以单独写出来。

### 配置：镜像里没有 `config.yaml`

`config.yaml` 在 `.gitignore` 里（部署方的配置 + 密钥），`.dockerignore` 把它排除在
构建上下文之外。三种提供方式：

1. **挂载文件**（推荐）：`-v "$PWD/config.yaml:/etc/comem/config.yaml:ro"`。
   文件里的 `${VAR}` 在加载时展开，变量未设置直接报错。
2. **纯环境变量**：不挂文件，所有配置项都能用 `COMEM_*` 覆盖，例如
   `-e COMEM_SERVER_SUBJECT=user:alice -e COMEM_RETRIEVAL_ENGINE=hybrid`。
3. **两者混用**：环境变量覆盖文件里的同名叶子。

`config.example.yaml` 在镜像里（`/app/config.example.yaml`），可以
`docker run --rm comem:local cat /app/config.example.yaml > config.yaml` 取出来改。

### 数据卷

| 挂载点 | 内容 | 说明 |
|---|---|---|
| `/var/lib/comem` | 内容文件（`user/`、`group/`、`resources/`…）+ `_meta/comem.sqlite` + 提示词覆盖 | 备份、恢复、迁移都只针对它 |

- **命名卷**：`-v comem-data:/var/lib/comem`。Docker 从镜像继承属主（`node:node`，
  uid 1000），开箱可写。
- **bind mount**：宿主目录的 uid 必须是 1000，否则启动自检 `assertDataDirWritable`
  直接失败：`chown -R 1000:1000 /srv/comem-data`。
- **不要挂 `:ro`**：SQLite 的 WAL 与内容写入都需要写权限。

### 控制台

`web/.output` 在镜像里（`/app/web/.output`，Nuxt 3 的 Node server，自包含）。
**后端不代理静态文件**（架构文档里没有这条），控制台的 `apiBase` 是相对路径
`/api/v1`，浏览器会打到控制台自己的 origin 上。Nitro 的生产 server 对未知路径返回
SPA 的 HTML（HTTP 200），所以直连控制台端口时每个 API 请求都会拿到一段 HTML：

```
$ curl -s -D- http://127.0.0.1:18082/api/v1/health | head -3
HTTP/1.1 200 OK
content-type: text/html;charset=utf-8
x-powered-by: Nuxt
```

**必须有一层反向代理把 `/api`、`/health`、`/metrics`、`/mcp` 转给后端。**
`docker-compose.yaml` 里的 `proxy` 服务就是干这个的（内联 nginx 配置，把其余路径
转给控制台）。单独部署控制台：

```bash
docker run -d --name comem-console -p 127.0.0.1:3081:3081 \
  -e NITRO_HOST=0.0.0.0 -e NITRO_PORT=3081 \
  comem:local node web/.output/server/index.mjs
```

### 本地推理（可选镜像）

只有 `comem:local-inference`（`--target inference-runtime`）里有编译好的
`llama-cpp-python`（CPU + Vulkan 两个后端）与 `local-inference/` 的源码。核心镜像
（`comem:local`）没有 Python、没有 Vulkan、没有 venv，不能用来跑推理服务。
**模型权重（两个 GGUF，1.28GB）不进镜像**，运行时挂载：

```bash
docker run -d --name comem-inference \
  --device /dev/dri --group-add "$(stat -c '%g' /dev/dri/renderD128)" \
  -p 127.0.0.1:8089:8089 \
  -v "$PWD/local-inference/models:/models:ro" \
  comem:local-inference \
  /opt/comem-inference/.venv/bin/python /app/local-inference/server.py \
    --device gpu --host 0.0.0.0 --port 8089 \
    --embedding-model /models/Qwen3-Embedding-0.6B-Q8_0.gguf \
    --rerank-model /models/qwen3-reranker-0.6b-q8_0.gguf
```

推理镜像**没有内置健康检查**（`HEALTHCHECK NONE`）：默认 CMD 是 Node 后端，跑
Python 推理时 core 的 1933 探活会一直报 unhealthy。`docker-compose.yaml` 的
`inference` 服务自己定义了 8089 的探活；单独 `docker run` 需要探活时加
`--health-cmd`。

**Vulkan 的设备可见性在容器里是独立问题**，和镜像里有没有 Vulkan 后端无关：

| 要求 | 为什么 |
|---|---|
| `--device /dev/dri` | 容器默认看不到 render 节点 |
| `--group-add <render GID>` | 容器的 `node` 用户（uid 1000）要能打开 `renderD128` |
| `mesa-vulkan-drivers` = backports 的 25.0.7 | **Debian 12 自带的 22.3.6 不认识 Intel Arc（ARL，PCI ID `0x7d51`）**，见「踩过的坑」 |

实测（`--device /dev/dri --group-add 989`，`--user node`）：

```
$ docker run --rm --user node --device /dev/dri --group-add 989 comem:local-inference vulkaninfo --summary
Devices:
GPU0:
	apiVersion         = 1.4.305
	deviceID           = 0x7d51
	deviceName         = Intel(R) Graphics (ARL)
	driverName         = Intel open-source Mesa driver
GPU1:
	deviceName         = llvmpipe (LLVM 15.0.6, 256 bits)
```

推理服务的 `/health` 里 `device` 是**实际生效**的设备；纯 CPU 部署不需要
`--device` / `--group-add`，`server.py` 会自动设 `GGML_VK_VISIBLE_DEVICES=""`
（否则 CPU 推理会退化到单线程，见 `local-inference/README.md`）。

模型加载实测：GPU 8 秒 ready（含预热），常驻内存约 4GB（两个 Q8_0 + 8K ctx）。

### 可移植构建

```bash
docker build --target inference-runtime \
  --build-arg COMEM_PORTABLE_CPU=1 -t comem:portable .
```

| `COMEM_PORTABLE_CPU` | CMake 参数 | 产物 | 什么时候用 |
|---|---|---|---|
| `0`（默认） | `-DGGML_VULKAN=ON -DGGML_NATIVE=ON` | 单套 `libggml-cpu.so`，绑定构建机指令集 | **在目标机上 `docker build`** |
| `1` | `-DGGML_VULKAN=ON -DGGML_CPU_ALL_VARIANTS=ON -DGGML_NATIVE=OFF` | 多套 ISA 变体，运行期按 CPU 选择 | CI 构建 + 推 registry + 多台不同 CPU 的部署机 |

**在 CI 里构建再分发镜像时必须打开 `COMEM_PORTABLE_CPU=1`**，否则部署机执行到
构建机有、部署机没有的指令（AVX-512 等）会 SIGILL（非法指令，进程直接死）。
`GGML_CPU_ALL_VARIANTS=ON` 与 `GGML_NATIVE=ON` 不能同时开，Dockerfile 里是互斥分支。

可移植构建实测：29 秒（`inference` 阶段命中缓存；冷编译约 105 秒），
镜像 867MB（**比 native 的 932MB 小 65MB**：变体各自按基线指令集编译，代码体积
比 `-march=native` 展开 AVX-512 后小）。
编出 14 个 CPU 变体：

```
libggml-cpu-{alderlake,cannonlake,cascadelake,cooperlake,haswell,icelake,
ivybridge,piledriver,sandybridge,sapphirerapids,skylakex,sse42,x64,zen4}.so
```

运行期 `ggml` 按当前 CPU 选一套，实测容器日志：

```
load_backend: loaded CPU backend from /usr/local/bin/libggml-cpu-alderlake.so
```

### 镜像体积

核心镜像（`comem:local` = 默认 target）：

| 层 | 大小 | 来源 |
|---|---:|---|
| `node:24-bookworm-slim` | 230 MB | 基础镜像 |
| `base`：`ca-certificates` | 9.4 MB | 运行期 HTTPS |
| 生产 `node_modules`（`pnpm prune --prod`） | 40.9 MB | 后端 |
| `web/.output` | 2.3 MB | 控制台 |
| `dist` | 1.46 MB | 后端编译产物 |
| `prompts` + `integrations` + `package.json` | 0.2 MB | — |
| **`comem:local` 合计** | **285 MB** | `docker image ls` |

推理镜像（`comem:local-inference` = `core` + 推理运行时）：

| 额外层 | 大小 | 来源 |
|---|---:|---|
| 运行期 apt：Mesa 25.0.7 + Vulkan loader + `vulkan-tools` + OpenMP / Python 动态库 | 257 MB | 本地推理的 GPU 设备枚举 |
| 推理 venv（`llama-cpp-python` + fastapi / uvicorn + ggml 后端库） | 358 MB | 本地推理 |
| Python 3.12 解释器（从 `python:3.12-slim` 复制） | 32.2 MB | 推理 venv 的解释器 |
| `local-inference/` 源码 | 0.1 MB | 推理服务 |
| core 之外的小计 | 647 MB | — |
| **`comem:local-inference` 合计** | **932 MB** | `docker image ls` |

各目标阶段的镜像大小（同一份代码）：`deps` 约 750 MB、`build` 约 770 MB、
`test`（含 vitest / eslint）759 MB、`inference` 1.04 GB、`core` / `runtime` 285 MB、
`inference-runtime` 932 MB、可移植的 `inference-runtime` 867 MB。**默认目标从 1.06 GB 降到 285 MB**：去掉全局 tsx（123 MB）、
把推理从默认形态里拆出去（647 MB），再把 `src/` 换成 `dist/`（1.6 MB）。

推理 venv 与 Mesa 是 932 MB 里的 615 MB。**只有需要容器内跑 embedding / rerank 时才
构建这个镜像**；远程 API 的部署只付核心的 285 MB。

还能再削的地方（都**没做**，按收益排序）：

| 项 | 省 | 代价 |
|---|---:|---|
| venv 去重：`llama_cpp/lib/` 与 `site-packages/lib/` 是同一批 `.so` 的两份真实拷贝（`libggml-vulkan.so` 一个文件就有 6 份，每份 28 MB） | 约 150 MB | 必须逐个确认 loader 用的是哪一份；用硬链接最安全 |
| CPU-only 推理镜像：不装 Mesa / Vulkan loader / `vulkan-tools` | 257 MB | 没有 GPU 加速，`--device gpu` 不可用 |
| 删掉 core 里的 npm | 17 MB | 容器里不能再用 `npm`（当前运行时也不需要它） |
| 删掉 venv 里的 pip | 13 MB | 容器里不能 `pip install` |
| `dist/` 压缩、`node_modules` 去掉 `*.md` / `types` | 5–10 MB | 堆栈与类型跳转变差 |
| 删掉 `vulkan-tools`（`vulkaninfo`） | 0.6 MB | 少一个 GPU 排查入口 |

基础镜像换成 alpine 不在列表里：`sqlite-vec` 是 glibc 扩展，省下的约 100 MB 要换来
整条工具链与 `node:sqlite` 行为差异。

### 踩过的坑

1. **`node:24-bookworm-slim` 没有 `/etc/ssl/certs`。** 不装 `ca-certificates` 时服务
   能启动、`/health` 正常、离线路径全绿，但第一次调用模型供应商的 HTTPS 就失败：
   `Cannot connect to API: Client network socket disconnected before secure TLS
   connection was established`。`base` 阶段装。
2. **Debian 12 的 Vulkan 头文件太旧。** `libvulkan-dev` 是 1.3.239，而
   `llama-cpp-python` 0.3.36 vendor 的 `llama.cpp` 用了 `VK_EXT_layer_settings`：
   ```
   ggml-vulkan.cpp:5214:21: error: ‘LayerSettingEXT’ is not a member of ‘vk’
   ggml-vulkan.cpp:5218:17: error: ‘vk::LayerSettingTypeEXT’ has not been declared
   ```
   只换头文件（GitHub 的 `Vulkan-Headers` v1.4.368）不够——还要
   `-DVulkan_INCLUDE_DIR=/opt/vulkan-headers/include`，否则 `find_package(Vulkan)`
   仍然用系统头文件。
3. **Debian 12 自带的 Mesa 22.3.6 认不出 Intel Arc。** 容器里 `vulkaninfo` 报：
   ```
   MESA: warning: Driver does not support the 0x7d51 PCI ID.
   ERROR: [../src/intel/vulkan/anv_device.c:848] Code 0 : VK_ERROR_INCOMPATIBLE_DRIVER
   Devices:   ← 空
   ```
   换成 `bookworm-backports` 的 25.0.7 才行。`libvulkan1`（loader 1.3.239）不用换。
4. **Python 解释器是从 `python:3.12-slim` 复制过来的，扩展模块的动态库要自己补。**
   `node` 镜像里没有 `libsqlite3.so.0`：
   ```
   ImportError: libsqlite3.so.0: cannot open shared object file: No such file or directory
   ```
   补 `libsqlite3-0 libncursesw6 libgdbm6 libnsl2 libtirpc3 libreadline8`
   （`libpanelw6` 在 bookworm 里不存在，`curses.panel` 用不到，不装）。
5. **`llama_supports_gpu_offload()` 在构建容器里是 `false`。** 构建容器没有
   `--device /dev/dri`，Vulkan 枚举不到物理设备。用它做构建期断言会误报「没编入
   Vulkan」。构建期只能断言「`libggml-vulkan.so` 在包里」，设备可见性在运行期用
   `vulkaninfo` 验证。
6. **pnpm 的 `node_modules` 是符号链接结构。** 直接 `COPY --from` 会保留
   `.pnpm/...` 的软链（生产依赖层 41MB），前提是整棵树一起复制；只复制顶层包会得到
   一堆悬空链接。镜像里 `node_modules/sqlite-vec` 仍是
   `-> .pnpm/sqlite-vec@0.1.9/node_modules/sqlite-vec`。
7. **`sqlite-vec` 是预编译的**（`optionalDependencies` 里的
   `sqlite-vec-linux-x64@0.1.9`，`vec0.so`），不需要编译。但它是**可选依赖**，
   装漏了不会报错，直到第一次向量检索 `CREATE VIRTUAL TABLE ... USING vec0` 才报
   `no such module`。`build` 阶段有断言：`getLoadablePath()` 指向的 `.so` 必须存在。
8. **控制台的 SPA 与 API 必须同源。** 直连控制台端口时 `/api/v1/health` 返回
   `200 text/html`（SPA 兜底），界面上表现为「请求失败」。反向代理是必需组件，
   不是可选优化。
9. **Compose 会插值 nginx 配置里的 `$host`。** `configs.content` 里的 nginx 变量
   要写成 `$$host`，否则 compose 把它们当环境变量展开成空串（启动时一串
   `The "host" variable is not set` 警告）。
10. **`config.yaml` 里的 `${VAR}` 是「全有或全无」。** 只要文件里任一 `${VAR}` 未
    设置，进程启动即失败——即使那个 provider 的 `type` 是 `disabled`。示例配置不用
    `${VAR}`（两个 `apiKey` 都是空串，复制完就能启动）；自己写 `${VAR}` 时要把两个
    key 都给上。
11. **`node:sqlite` 在 Node 24.22.2 上不再打 `ExperimentalWarning`**（docs 里那句
    警告是 Node 22 的行为）。容器里 `require('node:sqlite')` 干净通过，不需要
    `--no-warnings`。
12. **可移植构建必须同时开 `GGML_BACKEND_DL=ON`。** 只给
    `GGML_CPU_ALL_VARIANTS=ON` 时 CMake 在配置阶段就失败：
    ```
    CMake Error at vendor/llama.cpp/ggml/src/CMakeLists.txt:489 (message):
      GGML_CPU_ALL_VARIANTS requires GGML_BACKEND_DL
    ```
13. **可移植构建的 CPU 变体不在 `llama_cpp/lib/` 里。** 它们在
    `site-packages/bin/`（scikit-build 的 runtime 目录），而 `ggml_backend_load_all()`
    只扫「可执行文件所在目录」。`GGML_BACKEND_PATH` 不是目录参数——给它一个目录会报
    ```
    load_backend: failed to load /opt/.../bin: ...: cannot read file data: Is a directory
    ```
    它要的是单个 `.so` 文件路径。镜像里的做法是把 14 个变体 COPY 到
    `/usr/local/bin/`（venv 的 python 是它的符号链接，`/proc/self/exe` 解析到这里）。
    少了这一步时 `--device cpu` 会报
    `ValueError: Failed to load model from file`，看起来像模型文件坏了。
14. **DL 构建里 Vulkan 后端不会被自动加载。** `ggml_backend_load_best("vulkan")`
    只认 `libggml-vulkan-<变体>.so` 前缀，并且要求后端导出
    `ggml_backend_score` 符号（Vulkan 后端不导出，`hasattr(lib, "ggml_backend_score")`
    为 False）——两个条件都不满足，所以纯 DL 构建的镜像是**只有 CPU 后端**的，
    `--device gpu` 报
    `这个 llama-cpp-python 构建没有 GPU 后端`。
    绕开办法：`GGML_BACKEND_PATH` 直接指向 `libggml-vulkan.so` 文件（`ggml_backend_load`
    按单个文件 dlopen，不查前缀、不查 score）。镜像里这个变量指向
    `/opt/comem-inference/backends/libggml-vulkan.so`（符号链接）。
15. **时区是 UTC。** 日志时间戳（`time` 字段）是 UTC ISO 8601，容器里没有
    tzdata 之外的本地时区配置。`-e TZ=Asia/Shanghai` 可以改，但日志格式本身不变。

### 容器内验证

```bash
# 全量测试（105 个文件 / 1969 个用例）
docker run --rm comem:test-suite pnpm test

# Hook 插件测试（110 个）
docker run --rm comem:test-suite pnpm test:integrations

# 类型检查
docker run --rm comem:test-suite pnpm typecheck

# 原生模块
docker run --rm comem:local node -e "require('node:sqlite'); require('sqlite-vec')"
```

**容器内外结果一致**（`1968 passed | 1 skipped`，105 个文件）。`resolveDataDir` 仍用
`existsSync('/.dockerenv') || pid === 1` 判定容器，但 `loadConfig` 把 `container` /
`isRoot` 做成可注入参数（`src/config/index.ts:212`），`tests/unit/config.test.ts` 的
`dataDir` 用例显式传 `container: false`（`:132`）、`container: true`（`:156`）、
`isRoot: true`（`:166`），断言与运行环境无关——之前那 3 条「容器里 dataDir 推导成
XDG 路径」的失败因此不再出现。

### compose 拓扑

`docker compose up -d` 起四个服务：

| 服务 | 镜像/命令 | 端口（宿主） |
|---|---|---|
| `comem` | 默认命令（后端） | `127.0.0.1:18081 → 1933` |
| `console` | `node web/.output/server/index.mjs` | `127.0.0.1:18082 → 3081` |
| `inference` | venv 里的 `server.py` | 不发布 |
| `proxy` | `nginx:1.27-alpine`（内联配置） | `127.0.0.1:18080 → 80` |

正常入口是 `http://127.0.0.1:18080`：`/health`、`/api/*`、`/metrics`、`/mcp` 走后端，
其余走控制台。所有端口默认只绑 `127.0.0.1`，对外服务需要再前面加 TLS 入口。

**容器里的回环信任必须关掉。** 镜像绑 `0.0.0.0`（否则 `-p` 端口转发不可达），而
`auth.trustLoopback: true` 只允许回环监听——两者同时成立时 `loadConfig` 直接抛
`INVALID_ARGUMENT`，服务拒绝启动（`src/config/cross-checks.ts` 的交叉校验）。镜像因此
默认 `COMEM_AUTH_TRUST_LOOPBACK=false`。关掉之后：

- 所有请求都要带 `Authorization: Bearer`：经 nginx 来的来源是容器网段，容器内进程访问
  `127.0.0.1:1933` 也一样——回环信任是一个全局开关，不按来源地址部分生效。控制台登录
  之后本来就带它；hook 插件与 MCP 客户端要配 `COMEM_TOKEN` / API Key。

TLS 只加密传输，不区分身份——前置代理终止 TLS 之后，请求到达 CoMem 时仍然要看凭据。
第一个管理员用启动日志里的初始化令牌在 `/setup` 创建，见「建第一个账号」。

> 首次 `docker compose up` 如果遇到端口冲突，容器可能以「未连接网络」的状态留下
> （`docker inspect` 里 `Networks` 为空），后续 `up -d` 只会启动它、不会重建。
> 用 `docker compose up -d --force-recreate proxy` 重建。

### 没覆盖的部署场景

- **多副本。** 内容存储是本地文件系统、索引是本地 SQLite，没有共享存储抽象。
  多副本会让每个副本看到不同的数据（架构文档 §2 明确不做多租户与分布式）。
- **只读根文件系统。** `node:sqlite` 与内容写入都需要写数据根；只读根需要
  `--read-only --tmpfs /tmp` 加可写数据卷，未验证。
- **TLS 终止。** 镜像里没有证书与 TLS 配置，必须由前置代理终止。
- **离线构建。** 构建需要 npm registry、PyPI、GitHub（Vulkan-Headers）与 Debian
  源。没有做 vendor 化。
- **非 x86_64。** `sqlite-vec` 的平台包只覆盖 linux/darwin 的 x64 与 arm64；
  `Vulkan-Headers` 的版本是固定的。arm64 构建未验证。
- **认证。** 认证恒开，镜像默认 `COMEM_AUTH_TRUST_LOOPBACK=false`；第一个管理员用启动
  日志里的初始化令牌在 `/setup` 创建。`sessionSecret` 必须显式给值，否则每次重启已签发
  的 token 全部失效。
- **备份与告警。** 镜像只提供 `/health` 与 `/metrics`，没有内置备份任务。

## 后台调度器

`src/bootstrap/scheduler.ts` 每 30 秒跑一轮，做六件事（架构文档 §10.7、§11.7、§17.6；TTL 清扫在一次 `sweep()` 里同时做软归档与物理删除，下表拆成两行）：

| 职责 | 打开它的配置 | 动作 |
|---|---|---|
| 自动提交 | `session.autoCommit.enabled`（默认开） | 走阶段一，产出 `sessions/<id>/history/archive_NNN/` |
| 会话过期 | `session.expiry.idleTimeoutSeconds > 0` | `archive`（默认，只改 `status`）或 `delete`（物理删除） |
| 记忆 TTL 清扫 | `memory.ttl.defaultDays > 0` | 最后使用时刻超出滑动窗口的记忆 `status` 置 `archived`（`profile` / `identity` / `soul` / `rules` 除外） |
| 归档物理删除 | `memory.ttl.retentionDays > 0` | 归档满保留期的记忆删文件 + 索引行 |
| 临时上传清理 | 跟随调度器（无独立开关） | 删 `_meta/tmp/` 里超过 24 小时的暂存文件与元数据 |
| 对账重放 | 跟随调度器（无独立开关） | 重做 `_meta/reconcile.log` 里的索引 / 权限记录，成功后原子清理日志（§10.6） |
| `request_log` 裁剪 | 跟随调度器（无独立开关） | 按 `retainDays` 与 `retainRows` 删行（§17.6） |

启动条件是下面四个开关任一打开（`session.autoCommit.enabled`、`session.expiry.idleTimeoutSeconds > 0`、
`memory.ttl.defaultDays > 0`、`memory.ttl.retentionDays > 0`）。**四个全关时不起定时器**，启动日志是
`调度器未启动：自动提交、会话过期、记忆 TTL 自动归档、归档物理删除全部关闭。`；
否则有一行 `调度器已启动。` 带间隔与四个开关的状态。**改了配置要重启**：开关在
`createContainer` 里读一次。

### 已知限制

- **定时维护只在服务端进程常驻时发生。** 自动提交、会话过期、记忆 TTL（含 `retentionDays`
  的物理删除）都由进程内的 30 秒定时器驱动。用 MCP stdio 代理、一次性 CLI，或只调
  `commitPhase1` 而没有进程持续轮询时，这些动作一次都不会发生。可观察到的现象是启动日志
  没有 `调度器已启动。`、会话不自动归档、`memory.ttl` 打开后 `status` 始终是 `active`、
  归档超期的文件不消失。规避方式：用 `pnpm dev:server` 或 Docker 服务把服务端作为长驻
  进程运行；一次性脚本需要清扫时显式 `await scheduler.tick()`。

- **调度器的定时器是 `unref()` 的，不能当成进程保活手段。** 30 秒轮询不会阻止 Node 进程
  退出，所以短命脚本里 `createContainer` 之后等它自动清扫，脚本会先退出，一轮都不会跑。
  可观察到的现象是日志有 `调度器已启动。`、进程随后正常退出，但没有任何
  `调度轮次完成。` 或清扫记录。

- **索引对账的重放同样挂在调度器上。** 运行期文件写成功、索引或权限物化失败时只记
  `_meta/reconcile.log`，由 `main.ts` 启动时重放一次，以及调度器每轮里的重放消费；
  调度器未启动或进程在重放前被终止，这条记录会一直留着。可观察到的现象是文件在、
  `find` / `glob` 却找不到，`_meta/reconcile.log` 行数只增不减，重启服务后恢复。
  规避方式：保持调度器运行（任一开关打开，包括只配 `retentionDays`），监控
  `_meta/reconcile.log` 与调度轮次日志里的 `reconcileResolved` / `reconcileRemaining`。

- **临时上传清理与 `request_log` 裁剪没有独立开关，跟调度器同生共死。** `_meta/tmp/`
  里超过 24 小时的暂存文件只在调度轮次里删；`request_log` 平时也由每轮裁剪，四个开关
  全关时只剩启动那一次。可观察到的现象是 `_meta/tmp/` 只增不减、`request_log` 行数在
  长驻进程里缓慢上涨。规避方式：打开任一维护开关让调度器起来，或手工删 `_meta/tmp/`。
  这两项没有单独的定时器是有意的——为一个低频清理再起一个生命周期与并发问题不划算。

### 怎么开自动提交

默认就开（`enabled: true`），阈值是 150000 token / 100 条消息。想更早归档就调小阈值：

```yaml
session:
  autoCommit:
    pendingTokenThreshold: 5000
    keepRecentCount: 20      # 归档后 live 里留最近 20 条
```

`minCommitIntervalSeconds` 别设成 0 以下（schema 拒绝），也别设得太小：它是「两次自动
提交的最小间隔」，设成 0 意味着每 30 秒一轮都可能提交一次，`history/` 会被刷成一堆
只含一两条消息的归档，而每个归档都要跑一遍阶段二（模型调用，花钱）。

**怎么确认生效**：聊到超过阈值之后最多等 30 秒，看 `sessions/<id>/history/archive_001/`
是否出现；`GET /api/v1/sessions` 的 `pendingTokens` 会降回阈值以下，`.meta.json` 的
`commitCount` 加一。

### 怎么开会话过期

```yaml
session:
  expiry:
    idleTimeoutSeconds: 86400   # 一天没消息
    action: archive             # 默认；改成 delete 才是物理删除
```

- **`archive` 只改 `.meta.json` 的 `status`**，消息、归档、`memory_diff.json` 全在。
  想恢复就把 `status` 改回 `open`。
- **`delete` 是真的 `rm -rf`**，日志里有 `会话已删除（空闲过期）。`，带 `messages` /
  `archives` / `removedEntries` 三个计数——删了什么必须能从日志回答。
- **有 `pending` 记忆来源的会话不会被删**。检查方式是读它每个归档的
  `memory_diff.json`，看里面提到的记忆现在还是不是 `pending`。命中时记
  `warn`（`…但产出的记忆仍在待复核，跳过删除。`）并跳过；`memory_diff.json` 读不出来
  时同样跳过——证明不了安全就不删。

### 怎么开记忆 TTL

```yaml
memory:
  ttl:
    defaultDays: 30       # 最后一次使用后 30 天归档（写入或检索命中都算「使用」）
    sweepBatchSize: 100   # 每轮最多清 100 条
    retentionDays: 90     # 归档后再保留 90 天，物理删除文件与索引（默认 0 = 永不删）
```

**判据是滑动窗口：`max(updated_at, last_accessed_at) + defaultDays`。** 检索命中会写
`last_accessed_at`（与热度衰减同一列），所以天天被读到的记忆不会到期；改 `defaultDays`
对存量**立即生效**，不需要追平脚本。

**四类永不过期**：`profile`（用户画像）、`identity`（agent 身份）、`soul`（原则）、
`rules`（规则）。它们承载稳定的身份与约束，「最近没人读」不等于「不再重要」。这个
豁免是硬编码的（`domain/memory-types/index.ts` 的 `TTL_EXEMPT_MEMORY_TYPES`），没有
配置项。

**两段式。** `defaultDays` 只负责归档（`status = 'archived'`，文件还在）。要把磁盘真正
省下来，配 `retentionDays` 一个正数：归档满这么多天后，文件 + 索引行一起删掉，删了不
可恢复。默认 `0` 表示永不物理删——只软归档。保留期配得很小（比如 1 天）时调度器日志会
打 warning；先按默认 `0` 观察一轮归档量，再决定保留期。

TTL 是统一策略，没有逐条设置过期时间的接口（`TtlService.setExpiry` 已删除）：想让某条
记忆不过期，改它的类型，或把 `defaultDays` 设回 0。

**版本文件不参与 TTL。** `memories/{type}/.history/` 下的旧值快照不在清扫范围：两段 SQL 都
带 `NOT_VERSION_FILE_SQL`（两条 GLOB，`*/memories/*/[.]history` 与
`*/memories/*/[.]history/*`；只写后一条会漏掉 `.history` 目录节点自身），`defaultDays` 与
`retentionDays` 配成什么都动不到它们。它们的数量由每次覆盖写的「每个 identity 只留 5 份」
截断兜住（架构文档 §11.11）。

### 怎么开记忆合并

```yaml
memory:
  consolidation:
    enabled: true        # 默认关：合并会 delete，是破坏性操作，必须显式开启
    maxIterations: 10    # 探索轮次上限；到上限还没给出操作就整次失败
```

`enabled: true` 而 `summary.generator` 不是 `llm` 时 `loadConfig` 抛
`INVALID_ARGUMENT`：规则生成器产不出操作列表。关着的时候端点返回 403（不是空结果——
那会让「没开」看起来像「没有可合并的记忆」）。

**先预览，再执行。** 端点的 `dryRun` 默认 `true`：

```bash
# 预览：返回 {adds, updates, deletes, trace}，不写任何东西
curl -s -X POST http://127.0.0.1:1933/api/v1/memories/consolidate \
  -H 'content-type: application/json' \
  -d '{"scope": "comem://user/alice"}'

# 真的执行（不可逆）
curl -s -X POST http://127.0.0.1:1933/api/v1/memories/consolidate \
  -H 'content-type: application/json' \
  -d '{"scope": "comem://user/alice", "dryRun": false}'
```

**成本**：一次合并至少一次模型调用，每多一个 `read` 轮就多一次，上限是
`maxIterations + 1` 次。`trace` 记录每一轮做了什么（读了哪些 URI、产出哪些操作、每条
操作的理由）；「为什么它删了这条」看 `trace`，删除同时进 `info` 日志。

**它不做什么**：

- 不展开组：`comem://group/eng/` 的记忆不会因为调用者有 `group:eng` 就被合并，
  scope 必须显式传。
- 不碰 `pending`（还在复核）与 `archived`（已被 TTL 归档）的记忆。
- 没有回滚：写盘前的校验全部前置，但 I/O 或加锁失败时已应用的操作不回退，错误
  `details` 里带清单（见「已知限制」）。
- 不进 MCP（§3：16 个工具，不多不少）。

## 本地推理

可选的本地 embedding / rerank 服务，源码在 [`local-inference/`](../local-inference/README.md)，
跑起来是一个 OpenAI `/v1/embeddings` + Cohere `/v1/rerank` 兼容的 HTTP 进程。

**为什么需要它**：远程供应商按 token 计费，导入 810MB 历史对话（900+ 会话）一次全量
回填就会打爆配额；而且 CoMem 的定位是本地数据库，把每条记忆的正文发给第三方做嵌入
与这个定位冲突。`reindex` 换模型时也会再触发一次全量嵌入。

### 装什么

| 组件 | 版本 | 说明 |
|---|---|---|
| Python | 3.12 | 系统 3.14 上没有 `llama-cpp-python` 的可用构建。`uv python install 3.12` |
| `llama-cpp-python` | ≥ 0.3.16 | **必须带 Vulkan 源码编译**，预编译 wheel 只有 CPU 后端 |
| 模型 | GGUF Q8_0 ×2 | `Qwen3-Embedding-0.6B` + `Qwen3-Reranker-0.6B`，合计 1.28GB |

完整命令见 `local-inference/README.md` 的「安装」。这里只强调三个会静默出错的点：

1. **`CMAKE_PREFIX_PATH=/usr/share/cmake`**（Arch 专有）：`spirv-headers` 的 CMake
   配置文件不在默认搜索路径里，不设这个变量会在 `find_package(SPIRV-Headers)` 处失败。
2. **`HF_ENDPOINT=https://hf-mirror.com`**：`huggingface.co` 直连在本机 401。国内
   也可直接用 ModelScope 的 `resolve/master` 直链。
3. **reranker 的 GGUF 只能用 `ggml-org` 那个仓库**。社区仓的 Q8_0 是坏转换器的产物
   （310 张量、`pooling_type` 不是 `RANK`），加载不报错、分数看起来正常、排序是垃圾。

### 跑起来

```bash
cd local-inference
nice -n 10 taskset -c 0-5 .venv/bin/python server.py --device cpu --threads 6
```

- `--device`：`cpu` / `gpu`。**`npu` 会被拒绝**——llama.cpp 上游没有 Intel NPU 的
  ggml backend（见「已知限制」）。
- `--threads` 默认 `min(6, cpu_count // 2)`，要和 `taskset` 的核集合一样大，否则
  `llama.cpp` 的 worker 线程会跑到集合之外。
- 启动后 `curl http://127.0.0.1:8089/health` 的 `ready` 为 `true` 才算就绪。它会先
  跑一次 `embed(["warmup"])`——不预热的话第一条真实请求要等几百毫秒。

**本机源码部署时，控制台可以直接启停。** 设置页的「本地推理服务」卡片（系统管理员）
调用 `/api/v1/inference/local/{start,stop}`，命令与 `pip` / `uv` 安装步骤由服务端生成；
「一键填入」只改表单、不保存。它只管理**自己启动的**进程（pid 在
`{dataDir}/_meta/local-inference.pid`），不会碰终端里手动启动的实例。核心镜像没有
`local-inference/`，推理镜像的虚拟环境与模型也不在卡片检查的路径上，所以容器部署下
卡片显示「本机不可用」，仍按上面的 `docker run` 启动。

### 接进 CoMem

```yaml
providers:
  embedding:
    type: openai-compatible
    baseUrl: http://127.0.0.1:8089/v1
    model: Qwen3-Embedding-0.6B
    apiKey: local          # 只检查 Authorization 头存在，值不校验
    dimension: 1024
    maxBatchSize: 32
    timeoutSeconds: 60
  rerank:
    type: http
    baseUrl: http://127.0.0.1:8089/v1
    model: Qwen3-Reranker-0.6B
    apiKey: local
    timeoutSeconds: 30
    topN: 50

retrieval:
  engine: hybrid
  rerank:
    enabled: true
```

`dimension` 必须是 1024（0.6B 的原生维度）。写错会在第一次嵌入时抛
`PROVIDER_UNAVAILABLE`。

### 重排：延迟 vs 质量

重排默认关（`retrieval.rerank.enabled: false`），打开后它是检索路径上一次**串行**的
模型调用，超时预算直接加在用户等待时间上。本地 0.6B 重排的实测（`eval/README.md`，
105 条查询 / 52 篇语料，超时 30 秒）：

| 变体 | Recall@10 | MRR | NDCG@10 | p50 | p95 |
|---|---:|---:|---:|---:|---:|
| hybrid | 0.904 | 0.852 | 0.829 | 1.6ms | 1.9ms |
| hybrid+rerank（本地 0.6B，30s） | 0.913 | 0.874 | 0.845 | 8.03s | 8.23s |

**105 条上重排略好，但差在置信区间内。** MRR +0.022、NDCG +0.016，而 105 条查询的
95% 置信区间约 ±0.02（`eval/README.md`「已知限制」），这个差不能当成真实提升。代价
是 p50 从 1.6ms 涨到 8.03s——**默认关的理由是延迟，不是质量回归**。

34 条查询的冻结集（`basic-v1.yaml`）上方向相反：MRR 0.895 低于不重排的 0.923，
召回从 0.985 提到 1.000。两份数据集的结论不一致，说明本地 0.6B 重排的净收益还测不
出来；远程 8B 重排在同一份 34 条上是 MRR 0.956，方向一致且幅度更大。

- **本地推理部署不建议打开重排。** 8 秒 p50 换一个落在噪声里的 MRR 差，不划算。
- **默认 `timeoutSeconds: 30` 是为了让「打开之后」不静默降级。** 50 条候选要
  8.05 秒 p50、9.35 秒 p95（含候选正文读取与查询嵌入），原来的 10 秒低于 p95：
  105 条里超过一半的查询在重排返回前被中止、退回融合分，而用户看不到任何提示
  （第一次跑出的 p50 恰好 10016.8ms 就是证据）。
- **延迟敏感时把 `topN` 降到 20。** 本地约 3.6 秒（50 条 8.0 秒 → 20 条 3.6 秒），
  30 秒超时对 20 条是 8 倍余量。**不要**反过来把 `timeoutSeconds` 压到 p95 以下：
  那会让「配置了重排」和「实际用了重排」变成两件事。
- **降级现在可见。** 超时/5xx/网络失败会在日志里记 `warn`（带 `reason`、`durationMs`、
  `topN`），并把最近一次失败写进 `GET /health` 的 `rerank.degraded` /
  `rerank.lastFailure`。排查「我的重排真的在跑吗」看这两个字段。

远程供应商（`Qwen3-Reranker-8B`）50 条只要 1.8–2.7 秒，30 秒超时同样够用；它在 34
条冻结集上 MRR 0.956，高于不重排的 0.923，是这组数据里唯一稳定的正收益。

### 已知限制

- **NPU 不可用。** 本机有 Intel AI Boost NPU（`00:0b.0`，`intel_vpu` 已加载），但
  llama.cpp 没有它的 ggml backend，`--device npu` 启动即退出（退出码 2）。要用 NPU
  只能换 OpenVINO，而那是另一套运行时与另一套分数语义。
- **重排分数是 `P(yes)`，在 [0, 1]。** 换量化档位（Q8_0 → Q4_K_M）时排序基本
  不变，但绝对分数会漂；如果开了阈值过滤，必须在选定的档位上重新标定。
- **单进程串行推理。** 模型实例不是线程安全的，并发请求排队。16 核机器上并行推理
  只会让每个请求都变慢。
- **`input_type: "query"` 是本地扩展。** 加 `Instruct:` 前缀在官方评估里提升
  1%–5%，但会改变向量分布，切换时必须全量重建索引。

## 数据布局

```
$COMEM_DATA_DIR/
├── _meta/
│   ├── comem.sqlite              # 索引 + 任务 + 授权反查 + 请求记录（可重建，见下）
│   ├── comem.sqlite-wal          # WAL（必须与 .sqlite 一起备份）
│   ├── comem.sqlite-shm
│   ├── reconcile.log             # 索引双写失败的对账日志（§10.6）
│   ├── tmp/                      # temp-upload 暂存：<uploadId> 与 <uploadId>.meta.json
│   └── recall/
│       └── <scope>.recall_log.json   # 召回账本：哪个会话在第 N 轮投喂过哪些 URI（§8.7）
├── user/
│   └── <uid>/
│       ├── .acl.json             # 个人根的权限
│       ├── .abstract.md          # 根的 L0 摘要
│       ├── .overview.md          # 根的 L1 概览
│       ├── memories/             # 跨项目记忆：profile / preferences / entities / events / …
│       ├── resources/            # 跨项目资料
│       ├── skills/               # 技能包：<name>/SKILL.md + 附属文件
│       ├── projects/<pid>/       # 项目作用域，结构与根同构（少 sessions/ 与 projects/）
│       └── sessions/
│           └── <sessionId>/
│               ├── messages.jsonl    # 当前（未归档）消息，一行一条
│               ├── .meta.json        # 会话元数据
│               ├── .abstract.md / .overview.md
│               └── history/
│                   └── archive_NNN/
│                       ├── messages.jsonl   # 归档消息
│                       ├── .meta.json       # phase1 状态 + stepsDone + taskId
│                       ├── memory_operations.json # 抽取步骤的产物（重放恢复用，§10.4）
│                       ├── memory_diff.json # 这次归档抽出了哪些记忆操作
│                       └── .done            # 完成信号，最后写（§10.1）
└── group/
    └── <gid>/                    # 组空间：memories / resources / skills / projects
```

**规则**：普通 `ls` 看不到 `.acl.json` / `.abstract.md` / `.overview.md` / `.meta.json` /
`.done` / `memory_diff.json` / `memory_operations.json`——它们是元数据，不是目录内容。想看内容用 `GET /content/*`，
想看元数据用 `GET /fs/ls` 之外的接口（§6.7）。

**删除行不会让 SQLite 文件自己缩小。** `request_log` 裁剪、TTL 物理删除只把页还回 freelist，
库文件保持历史峰值：稳态占用会收敛到上限附近并复用空闲页，但峰值不会自动下降。需要回收
磁盘时手工 `VACUUM`——它是全库重写，比裁剪贵几个数量级，应在停机或低峰执行；值得做的时机
是一次性删掉大量历史行之后（例如表曾被不裁剪的旧版本撑大）。

## 备份与恢复

**内容文件是真相，SQLite 是派生。** 判据是「这东西属于哪一类」（§7）。检索索引可以
重建（`pnpm reindex`）；`reconcile.log` 由启动扫描与调度器自动重放，不需要为它手工重建索引。

| 能丢 | 不能丢 |
|---|---|
| `_meta/tmp/`（还没被引用的上传暂存） | `user/`、`group/` 下的内容文件 |
| `_meta/reconcile.log`（只是失败线索；重放器会清理已解决的条目） | 目录里的 `.acl.json`（丢了等于所有人失去访问权） |
| `_meta/recall/*.recall_log.json`（丢了只多投一次） | `.abstract.md` / `.overview.md`（重算要调模型，花钱） |
| `request_log` 表（只是观测数据） | `_meta/comem.sqlite`（**见下面的警告**） |

> **警告：`reindex` 只重建检索索引、向量与关联边，不重建物化权限。** 它从磁盘重新遍历
> 全部节点，重写 `node` / `node_fts` / `node_embedding` 与 `memory_link` 的 `derived_from`
> （`--only=links` 或 `all`）；物化权限（`node_permission`）
> 由 `.acl.json` 与所有者推导，归属 `AclService` 的写路径，不在这个命令的职责里
> （`src/commands/reindex.ts` 的文件头）。所以**删掉 `comem.sqlite` 之后**：
> `pnpm reindex` 能把 `find` / `search` 的索引修回来，但物化权限行随库一起没了——
> 节点不可读，检索仍然返回空。ACL 回填没有命令。备份时把数据根整个打包。

重建索引（索引损坏、换 `providers.embedding.dimension`、换嵌入模型之后）：

```bash
pnpm reindex --dry-run                                   # 只遍历磁盘报数，不打开数据库
pnpm reindex --only=index                                # 只重建 node / node_fts
pnpm reindex --only=embeddings                           # 只回填 node_embedding
pnpm reindex --only=links                                # 只按 sources 重建 memory_link 的 derived_from
pnpm reindex --config /etc/comem/config.yaml --data-dir /var/lib/comem
```

- 参数：`--only=embeddings|index|links|all`（默认 `all`，`all` 含 links）、`--dry-run`、`--config <path>`、
  `--data-dir <path>`。两个路径参数和环境变量 `COMEM_DATA_DIR` 走同一套
  `loadCommandConfig`（`src/commands/config.ts`），不会静默回落到当前目录的
  `config.yaml`。
- **目录的两行都重建。** 有 `.overview.md` 的目录写 L0 摘要行 + L1 概览行（§8.1），
  概览正文从磁盘读，不从旧索引读；没有摘要文件的目录只写 L0 行。所以 `reindex`
  之后概览正文照样能被 `find` 命中，不需要先等一次摘要重算。`reindex` 不清理孤儿
  行（删掉的 `.overview.md` 留下的 L1 行会一直到下次摘要重算或删除该节点为止）——
  与它本来就不清理「文件已删除」的孤儿节点是同一条边界，删除走 `deleteByUri`。
- **`--only=links` 只重建 `derived_from`。** 从每份记忆文件的 `sources` 整批重算：先清空
  这一类边再依次写入，一个事务，重跑得到同一份边（读盘不在事务内）。`references` /
  `related` 在 frontmatter 里没有真相，重建不动它们。归档目录已被 TTL 清理时照写边、不查
  存在性——`sources` 是真相，查存在性会让同一份输入因磁盘现状不同得到不同的边。`sources`
  上限 20：一条记忆的 `sources` 被截断过时，重建会删掉写路径累积下来的更早的边（架构文档
  §11.10）。
- **只从磁盘读，不信任 SQLite。** 索引坏了才是要重建的理由，拿 `node` 表当输入
  等于假设「坏掉的东西还能用」。
- **断点续跑。** 按 URI 升序幂等 upsert；嵌入按 `content_digest` 判定「没变」直接
  跳过。中途被杀后重跑只处理剩下的。
- **换维度会备份旧向量。** 旧 `node_embedding` 复制成普通表 `node_embedding_backup`
  （`vec0` 的 shadow 表不跟 `ALTER TABLE RENAME` 改名，不能直接改名备份），回填
  成功后删除；中途失败回滚到旧维度。
- **进度写 stderr，stdout 只有最后一行结果**，可以直接 `reindex > report.txt`。

停服后打包最稳（WAL 会被合并回主文件）：

```bash
systemctl stop comem          # 或者 kill -TERM <pid>，等进程退出
tar -C "$(dirname "$COMEM_DATA_DIR")" -czf comem-$(date +%F).tar.gz "$(basename "$COMEM_DATA_DIR")"
```

不停服时要用 SQLite 自己的备份，别直接 `cp`（可能拿到半个事务）：

```bash
sqlite3 "$COMEM_DATA_DIR/_meta/comem.sqlite" ".backup /backup/comem.sqlite"
```

恢复：解包回同一个 `dataDir`（路径必须一致——URI 与磁盘路径是一一对应的），再启动。
启动时会跑迁移，幂等，不会重复建表。

### 版本与升级

**v0.1.0 是首个发布版本。** 此前的数据库 schema 只有一个初始建表脚本
`src/adapters/sqlite/migrations/0001_init.sql`（一次 `runMigrations` 从空库建出完整结构，
版本号 1），没有需要兼容的存量库——因此没有「从旧版本升级」的路径，也不需要
`ALTER TABLE` / 回填之类的迁移补丁。

**此后每次 schema 变更都新增一个迁移文件**（`NNNN_描述.sql`，`NNNN` 从 0002 起递增），
不改 `0001_init.sql`。`runMigrations` 按文件名前缀的数字解析版本号，启动时逐版应用未执行过
的迁移；`schema_version` 表记录已应用的版本，全新库为 0、应用 `0001` 后为 1。

**迁移期间外键强制是关的。** 如果某个迁移要重建被引用的表（SQLite 不支持 `ALTER TABLE
ADD CONSTRAINT`，只能新表 + `INSERT INTO ... SELECT` + `DROP` + `RENAME`），`DROP TABLE`
在 `foreign_keys = ON` 下会先做隐式 `DELETE FROM`，按 `ON DELETE CASCADE` 删掉子表行。
迁移框架（`runMigrations`）在每个迁移外面关掉外键强制、提交前用 `PRAGMA foreign_key_check`
确认没有悬空引用、再恢复原值。有冲突时整份迁移回滚并报 `INTERNAL`。

**从旧快照升级时要手改的地方。** 下面几条不兼容旧配置 / 旧调用，症状都是「没报错但行为
变了」，升级后逐条核对：

- **配 `auth.adminUserIds`。** 用户与组目录、`/tasks` 现在只认这份名单，默认空 = 对所有人
  403（见「多用户部署」）。不配的话控制台的「用户与组」页、概览页任务卡、会话页任务表
  全部 403。
- **MCP 的 `write` / `add_resource` 没有 `wait` 参数了。** 旧调用多传一个 `wait` 不会报错，
  也不会等待——写入本来就是同步完成的，参数已从 schema 删除。
- **调用上限的常量与路径都换了。** `MCP_TOOL_DEADLINE_MS` 与 `src/api/mcp/deadline.ts`
  不存在，改成 `src/api/deadline.ts` 的 `API_CALL_DEADLINE_MS`；HTTP 的 `/search/find`、
  `/search/search`（含 `mode=context`）也在同一上限下返回 503 `PROVIDER_UNAVAILABLE`
  （已知限制 28）。
- **`timeoutMs` 从覆盖值改成上限。** 适配器取 `min(配置秒数 × 1000, timeoutMs)`，把配置的
  超时放宽不再生效（架构文档 §19）。
- **Hook 装了 7 个事件。** `SessionEnd` 与 `PreCompact` 共用 `pre-compact.mjs`，内部事件名
  不同；`PreToolUse` 不做开销上报，所以 `/metrics` 里 `event` 的取值仍是 6 个。重装插件
  才会写入新的 `session_end` 条目。
- **控制台删掉了一批界面元素**（任务重试按钮、记忆置信度徽章、`/memories/pending`
  预取、文档的 L1 概览档等），另有一处改成显式说明（未配单价时成本卡显示「未配置单价，
  成本不可计算」）。这些都是取舍，不要当回归补回来，逐条原因见 `docs/architecture.md`
  §16 末尾。

## 监控

两个端点都不认证：探活系统没有 CoMem 身份，要求凭据只会让 `curl /health`
全部 401。它们也不读用户内容（`src/api/http/routes/ops.ts`）。

### `/health`

`GET /health` 与 MCP 的 `health` 工具返回同样内容（§17.9）。实测输出：

```console
$ curl -s http://127.0.0.1:1933/health | jq
{
  "status": "ok",
  "result": {
    "status": "degraded",
    "subject": "user:local",
    "scopes": ["comem://user/local"],
    "index": { "totalNodes": 4 },
    "queue": { "pending": 0, "processing": 0 },
    "summary": { "degraded": false, "pendingDirs": 0, "degradedDirs": 3 },
    "memoryExtract": { "skipped": false, "reason": null },
    "rerank": {
      "configured": true,
      "degraded": true,
      "failures": 12,
      "lastFailure": {
        "at": "2026-11-08T11:20:31.442Z",
        "reason": "timeout",
        "durationMs": 30004,
        "topN": 50,
        "code": "PROVIDER_UNAVAILABLE",
        "message": "重排调用超时（30000 毫秒），请检查供应商可用性或调大 timeoutSeconds。"
      }
    },
    "memory": {
      "pendingReview": 0,
      "orphanTasks": 0,
      "oldestPendingAgeSeconds": null,
      "profileFormat": { "checked": 1, "invalid": 0, "violations": 0, "truncated": false }
    },
    "version": "0.1.0"
  }
}
```

| 字段 | 含义 | 什么时候要管 |
|---|---|---|
| `result.status` | `ok` / `degraded` | `degraded` = 摘要走的是规则降级，或存在降级摘要的目录，或最近一次重排调用失败（已退回融合分）。降级必须可见（§17.9） |
| `result.subject` | 服务图绑定的主体（`server.subject`） | 回环信任用它认证本机请求。与 `config.yaml` 里写的不是同一个用户 = 配置没生效（见「控制台每个请求 401」） |
| `result.scopes` | 该主体可寻址且可读的根（个人根在前） | 为空 = 主体没有任何可访问的命名空间，控制台会明确说明 |
| `index.totalNodes` | 索引里的节点数（`node` 表全量，不是当前身份可见的条数——那个看 MCP `health` 的 `index.visibleNodes`） | 掉到 0 而磁盘上有文件 = 索引没写进去，看 `reconcile.log` |
| `queue.pending` / `processing` | 待执行 / 执行中的任务 | `processing` 长期不降 = 卡住的任务，看租约 |
| `summary.pendingDirs` | 待刷新摘要的目录数 | 长期不降 = 摘要失效在堆积 |
| `summary.degradedDirs` | 用规则摘要生成的目录数 | 模型不可用时会涨；恢复后需要重算 |
| `memoryExtract.skipped` | 归档提交是否跳过记忆抽取（`providers.llm.default.type` 是 `disabled` 时为 `true`） | 为真 = 归档照常完成，但 `memory_extract` / `memory_merge` 没跑，`find` 搜不到新记忆。`reason` 是 `llm_disabled` |
| `rerank.configured` | 是否配了重排（`retrieval.rerank.enabled` + `providers.rerank.type: http`） | 配了重排但这里是 `false` = 装配没接上 |
| `rerank.degraded` | 最近一次重排调用是否失败（已退回融合分） | 为真 = 这次检索用的是融合分。反复为真看 `lastFailure.reason`：「超时」调大 `timeoutSeconds` 或降低 `topN`，`http_5xx` 看供应商，`network` 看 `baseUrl` |
| `rerank.failures` | 进程启动以来重排失败的累计次数 | 与 `degraded` 一起看：`degraded: false` + `failures > 0` = 间歇性失败过，最近一次已成功 |
| `rerank.lastFailure` | 最近一次失败的 `reason` / `durationMs` / `topN` / `code` / `message` | 从未失败时为 `null`（「没有」不是全 0 对象） |
| `memory.pendingReview` | 待复核的记忆条数（`node.status = 'pending'`） | 控制台「记忆复核」页该清了 |
| `memory.orphanTasks` | 租约过期的 `running` 任务 | 有人认领却没续租 = 进程崩了。启动扫描会把它重置回 `pending` |
| `memory.oldestPendingAgeSeconds` | 最老的待复核记忆距今多少秒 | 没有待复核时是 `null`（「没有」不是 0 秒） |
| `memory.profileFormat` | 画像格式契约的自查结果（§11.1）：`checked` / `invalid` / `violations` / `truncated` | `invalid` > 0 = 有画像没按约定写，抽取提示词可能被改坏；`truncated` 为真时三个计数都是下界 |
| `version` | 服务版本 | 与 `package.json` 一致 |

外层还有一个 `status: "ok"`：那是**响应封套**的状态（§14），不是服务的健康状态。
判活用 `result.status`。

### `/metrics`

Prometheus 文本，`Content-Type: text/plain; version=0.0.4`。实测输出（节选）：

```console
$ curl -s http://127.0.0.1:1933/metrics
# HELP comem_http_request_duration_seconds HTTP 请求完整耗时
# TYPE comem_http_request_duration_seconds summary
comem_http_request_duration_seconds_sum 0.007015647999999601
comem_http_request_duration_seconds_count 1
# HELP comem_index_nodes 索引节点数
# TYPE comem_index_nodes gauge
comem_index_nodes 4
# HELP comem_pending_review 待复核的记忆条数
# TYPE comem_pending_review gauge
comem_pending_review 0
# HELP comem_hook_async_seconds 后台阶段最近一次耗时（秒）
# TYPE comem_hook_async_seconds gauge
comem_hook_async_seconds{phase="extract"} 0
# HELP comem_llm_pricing_configured 是否配了模型单价（1 = 配了，成本可计算）
# TYPE comem_llm_pricing_configured gauge
comem_llm_pricing_configured 1
# 下面这条只在 pricing_configured = 1 时输出
# HELP comem_llm_cost_usd_total 模型成本累计，美元（§18 的 pricing 换算）
# TYPE comem_llm_cost_usd_total counter
comem_llm_cost_usd_total 0
```

**没配单价时 `comem_llm_cost_usd_total` 整条不存在**，不是输出 0：序列缺失表示「算不出来」，`0` 表示「确实花了 0 美元」。抓取端用 `comem_llm_pricing_configured` 区分这两种情况。

v1 实际输出的全部指标（`src/services/observability.ts` 的 `renderMetrics`）：

| 组 | 指标 | 用途 |
|---|---|---|
| HTTP | `comem_http_request_duration_seconds_sum` / `_count` | 请求完整耗时的累加与次数。v1 是 summary 形态，没有分位数 |
| Hook 开销 | `comem_hook_overhead_seconds{event,phase}`、`comem_hook_overhead_total_seconds{event}`、`comem_hook_async_seconds{phase}` | 回答「用 CoMem 让每一轮多花了多少毫秒」。`phase` 是 `process_start` / `recall` / `serialize` / `capture`；`total` 是单轮阻塞合计；`async` 是后台部分，`phase` 是 `archive` / `extract` / `merge` / `summary` / `distill`，**不挂 `event`**（同一份进程级快照不属于任何事件） |
| 模型 | `comem_llm_tokens_total{kind="prompt"\|"completion"}`、`comem_llm_cost_usd_total`（配了单价才有）、`comem_llm_pricing_configured` | 钱花在哪。成本按 `providers.llm.default.pricing` 换算 |
| 业务 | `comem_index_nodes`、`comem_pending_review` | 索引规模与待复核积压 |

**进 `comem_hook_*` 的事件是 6 个，不是 7 个。** `pre_tool_use` 的判定全在本地、不发 HTTP，也不上报开销，所以它的 `event` 标签永远不会出现；宿主侧仍然会调它（7 个事件）。`event` 的合法值见 `integrations/lib/events.json` 的 `reportsOverhead`。

**§17.3 / §17.4 里的其余指标还没实现**：`comem_http_requests_total`、`comem_http_requests_per_second`、
`comem_http_inflight_requests`、`comem_http_ttfb_seconds`、`comem_llm_calls_total`、
`comem_llm_duration_seconds`、`comem_llm_errors_total`。设计文档写了标签与含义，代码里没有对应的
累加器——接 Grafana 之前先按这张表核对一遍，不要照文档写查询。

**阻塞与异步分开统计**（§17.2）：归档 / 抽取 / 合并 / 摘要 / 经验归纳在后台跑，用户没等它，
不能算进「CoMem 让请求慢了多少」。混在一起会把 12 秒的后台处理算成延迟。

`/health` 与 `/metrics` 同时挂在根路径与 `/api/v1` 下，两处都能抓（§17.1）。

### 统计端点

只有 `GET /health` 与 `GET /metrics`。`/stats/memories` 与 `/stats/sessions/{id}` 都没有实现，
`src/api/http/routes/` 里也没有 `stats.ts`：分类分布、冷热分桶、最老记忆年龄、单会话耗时
都需要全表或跨表聚合，没有调用方。全库规模看 `/health` 的 `index.totalNodes`，记忆健康度
看它的 `memory` 段（§17.5、架构文档 §17.9）；要按类型 / 冷热自己查库，用 `sqlite3` 直接查
`_meta/comem.sqlite` 的 `node` 表。

## 检索质量评估

`pnpm eval` 在临时数据根里跑一份带标注的数据集，给出各引擎的 Recall / MRR / NDCG
与延迟。它不碰 `dataDir` 里的真实数据，跑完自动清理。

```bash
pnpm eval                                   # eval/datasets/basic.yaml，三个引擎
pnpm eval --k 5                             # 只算前 5 名
pnpm eval --engines fts5,vector             # 只跑指定引擎
pnpm eval --json                            # 机器可读输出
pnpm eval --config local/eval-config.yaml --rerank   # 追加 hybrid+rerank 对照
```

输出是一张可以直接贴进文档的表格。**看三件事**：

1. **Recall 与 MRR 的差**。Recall 高、MRR 低说明「找到了但埋得很深」，通常是
   排序规则的问题；两者都低才是召回的问题。
2. **哪个引擎赢在哪类查询上**。FTS5 在专有名词 / 标识符（`URI_CHUNK_SIZE`、
   `pnpm verify`）上召回 1.0，在自然语言改写上接近 0；向量反过来。混合检索不是
   永远更好，它把两边的错误率平均掉。
3. **延迟的量级**。向量 / 混合变体的 `find` 里有一次查询嵌入的网络往返，p50 在
   几百毫秒是正常的。要比「索引本身多快」，看 `fts5` 变体。

### 数据集放在哪

`eval/datasets/*.yaml`。格式、标注规则与指标定义见 [`eval/README.md`](../eval/README.md)。
改检索参数（`retrieval.levelWeights`、`retrieval.rerank.*`、`retrieval.engine`）
之前先跑一遍留下基线，改完再跑一遍对比——没有基线的调参只是换了一个数字。

### 评估固定覆盖的配置

`summary.generator` 固定为 `rule`（摘要生成会调模型，与检索无关），
`session.autoCommit` / `session.expiry` 关闭（不启动后台调度器），
`logging.level` 固定为 `fatal`（容器日志走 stdout，会割裂表格 / JSON）。
这几项写在 `src/eval/runner.ts` 的 `FIXED_OVERRIDES` 里，评估不读用户配置。

### 已知限制

- **热度变体需要访问历史**。临时数据根里 `access_count` 全是 0，`--hotness-weight`
  对排序没有影响。要测它得先造访问记录，数据集格式目前没有这一列。
- **向量变体的延迟包含网络往返**，不能当作索引本身的延迟。
- **`group` 作用域不支持**：评估容器只绑定一个 `user` 身份。
- **没有统计显著性**：34 条查询上的小差距可能是噪声，报告给的是点估计。

## 导入本机 Agent 对话

`pnpm ingest` 把机器上的历史对话导进会话目录，逐条会话走阶段一提交，然后**默认等
阶段二（记忆抽取）跑完**——导进来的会话要变成 `find` 能搜到的记忆，才算完成。

```bash
pnpm ingest --source claude-code          # 只导一个（默认等阶段二）
pnpm ingest --source all                  # 全部
pnpm ingest --source all --no-wait        # 只导入，立即返回
pnpm ingest --source all --timeout 600    # 每批阶段二最多等 600 秒
pnpm ingest --source all --dry-run        # 只报告不写
pnpm ingest --source codex --since 2026-08-01
pnpm ingest --source all --json           # 机器可读
```

`--source` 接受 `all` 或逗号分隔的宿主名（`claude-code` / `codex` / `deepseek` /
`qwen`）。`ingest.enabled` 默认 `false`，真正写入之前必须显式打开（配置文件或
`COMEM_INGEST_ENABLED=true`）；`--dry-run` 不受这个开关限制，且只开只读数据库连接，
不创建 `_meta` 目录。

**幂等。** 同一个来源跑第二次，已导入的会话全部计入「跳过」，不会产生重复会话。
「读到哪」记在 `_meta/comem.sqlite` 的 `ingest_cursor` 表里；想重导某个会话，删掉
对应行即可（`DELETE FROM ingest_cursor WHERE native_session_id = '...'`）。

**导入之后 `find` 搜不到原始对话正文是正常的。** 会话消息按设计不进检索索引；
`find` 能搜到的是阶段二从归档里抽取出来的记忆。默认等待阶段二就是为了让这件事在
命令结束时就成立，而不是留一堆 `pending` 任务。

### 阶段二（记忆抽取）

导入只做阶段一：归档消息、建任务（`pending`）。任务要由 `CommitRunner` 认领才会
生成摘要、抽取记忆、合并、失效摘要。**不等阶段二 = 会话在磁盘上、`find` 搜不到。**

- 默认 `waitForExtraction: true`，每 `ingest.extractionBatchSize`（20）个会话等一批。
- 每批超时 `ingest.extractionTimeoutMs`（30 分钟），`--timeout <秒>` 覆盖。到点后
  不再认领新任务，**在途任务跑完再返回**；没跑完的任务留在队列里，下次继续。
- `--no-wait` 只导入。报告会明确写「`find` 暂时搜不到内容」。
- 执行器是全局 FIFO 队列，不按 `--source` 过滤；历史积压会被先认领。
- `--dry-run` 忽略等待：没有任务可跑。报告里的 `extraction` 是 `null`。
- **没有可用 LLM 时跳过阶段二并在报告里写明。** `providers.llm.default.type` 是
  `disabled` 时，阶段二每个任务都会停在 `DisabledLlmProvider`。此时阶段一照常：会话
  归档、任务建好（停在 `pending`），报告里的 `extraction` 是
  `{ "skipped": true, "reason": "llm_disabled" }`，同时记一条 `warn` 日志：

  ```text
  阶段二被跳过：providers.llm.default.type 是 disabled
  ```

  **这是合法的降级部署**（先把数据导进来、模型以后配），不是配置错误——所以不拒绝
  命令，只降级。阶段一不依赖模型：原始对话落盘、能按内容检索，本身就有价值。但
  报告与终端输出都会说明「记忆还没抽取，`find` 暂时搜不到内容」。

  **注意：同机有服务端在跑时，任务不会一直 `pending`。** 服务端的 `CommitRunner`
  默认启动并每秒轮询，它会认领这些任务。修复前这一步会停在 `memory_extract` 并置
  `failed`（`INVALID_ARGUMENT` 是终态错误，不重试）；现在归档提交与导入走同一条
  判据：跳过 `memory_extract` / `memory_merge`，任务以 `done` 结束，`.meta.json`
  的 `skippedSteps` 写明原因。两种形态都没有记忆抽取，区别是任务状态——`done` 的
  归档**不会**在配好模型后补抽取，要让「先归档、以后再抽取」成立，得在没有服务端
  共用数据目录时导入（任务停在 `pending`）。见「没有可用 LLM 时」一节。
- `--no-wait` 与降级是两件事：显式 `--no-wait` 时 `extraction` 仍是 `null`（「没
  等」），不会写成「跳过」。

### 输出怎么读

```text
来源 claude-code：发现 42 个会话
  ✅ 新建 38 个会话，共 1,204 条消息
  ⏭️  跳过 4 个（游标已到末尾）

阶段二（记忆抽取）：
  第 1 批（20 个会话）✅ 抽取 14 条记忆（12 条 active，2 条待复核） 95.2s
  第 2 批（18 个会话）✅ 抽取 11 条记忆（9 条 active，2 条待复核） 88.4s
  合计：完成 38 个任务，失败 0 个，抽取 25 条记忆（21 条 active，4 条待复核），耗时 183.6s
  待复核的记忆不会出现在检索结果里：用 `GET /api/v1/memories/pending` 查看，`POST /api/v1/memories/{uri}/approve` 通过。
```

没有可用 LLM 时阶段二不跑了，输出是这一行（`--json` 时是 `extraction` 字段）：

```text
来源 claude-code：发现 1,076 个会话
  ✅ 新建 1,076 个会话，共 12,004 条消息

阶段二（记忆抽取）：跳过——providers.llm.default.type 是 disabled，没有可用的模型。会话已归档、任务已建，但记忆还没抽取，`find` 暂时搜不到内容。配好 providers.llm 后重跑本命令，积压的任务会被执行器认领。
```

```json
{ "extraction": { "skipped": true, "reason": "llm_disabled" } }
```

退出码仍是 0：会话确实导进来了。要不要当成失败取决于调用方——`skipped` 是显式
字段，不是靠「`extraction` 为 `null`」猜。

失败会带 `locator`（源文件路径），单条会话的失败不影响其它会话。命令在有失败时以
退出码 1 结束，`--json` 的报告里 `harnesses[].errors` 是完整清单。

### 待复核的记忆

`experiences` / `rules`（`memory.reviewRequired`）写入时 `status = 'pending'`，**不
参与检索**。报告里的「待复核」就是这批记忆：

```bash
# 列表（scopeUri 省略时取当前身份的作用域根）
curl -s 'http://127.0.0.1:1933/api/v1/memories/pending' | jq '.result.memories'

# 通过（URI 要做 URL 编码；通过之后才会出现在 find 里）
curl -s -X POST \
  "http://127.0.0.1:1933/api/v1/memories/$(jq -rn --arg u 'comem://user/local/memories/rules/example.md' '$u|@uri')/approve"
```

只报总数会让人以为「导进来 100 条，100 条都能搜到」；实际有一部分要人工过闸门。

### 超时怎么调

30 分钟是「20 个会话 × 1–2 次模型调用 × 5 秒/次」的 4–10 倍余量。供应商慢或模型
上下文长时调大：

```bash
pnpm ingest --source all --timeout 3600   # 每批 1 小时
```

或改配置 `ingest.extractionTimeoutMs`（毫秒）。`0` 等价于 `--no-wait`。

### 源路径

默认路径见配置表。真实语料常常是导出的副本（例如 `~/Downloads/AI对话/`），这时用
`ingest.paths` 显式指定，不要改默认值——默认值服务的是「本机正在用的 Claude Code /
Codex」，导出目录是一次性的。

## 故障排查

### 模型调用失败时会不会重试

模型调用的重试由 `services/llm.ts` 决定，适配器自己不重试。按 `isRetryable`：429、
5xx、超时与网络不可达会重试；400 / 401 / 403 / 404 / 413 / 422 不重试——同一份请求
重发一次结果一样。结构化输出解析失败只重试一次；截断（`finishReason = length`）不重试，
要调大 `maxTokens`。完整映射见 `docs/architecture.md` §19。

**413 是「请求体 / 上下文超限」，不要靠重试解决。** 它映射成 `INVALID_ARGUMENT`
（不可重试）；看到它应该缩小单批输入，或换成上下文额度更大的模型。响应 body 里的
供应商错误码与 `retry-after` 头当前不参与判定。

### 摘要一直是「待刷新」

**症状**：`/health` 的 `summary.pendingDirs` 不降，控制台文件详情页一直显示「待刷新」，
`.abstract.md` 的时间戳不动。

**原因**（按可能性排序）：

1. `summary.generator: llm` 但模型不可用——失败会重试，重试完仍失败就停在待刷新。
2. 失效传播被「正文没变」拦住了。这是设计行为（§9.3 第 2 步），不是 bug：同一个内容重复写
   不该触发重算。**批量写入**必须走 `SummaryService.markStale` 而不是 `invalidate`——批量路径
   的顺序是「写文件 → 批量 `index.upsert` → 标脏」，等标脏被调用时索引里已经是新 digest，
   `invalidate` 的比较必然相等，整条传播链会被静默跳过。这条规则写在
   `src/services/summary.ts` 的 `markStale` 文档注释里。
3. 目录条目数 ≤ 32 或 `summary_pending / summary_entries ≥ 0.10` 才立刻重算，否则只记脏
   （§9.3 第 4 步）。条目多的目录要攒够比例。

**处理**：先看 `server.log` 里有没有 `PROVIDER_UNAVAILABLE`；把 `summary.generator` 临时改成
`rule` 能让摘要立刻生成（结果带 `degraded: true`，`/health` 会显示出来）。v1 没有「强制重算
某个目录」的接口，只能靠再写一次该目录下的文件来触发。

### 检索不到刚写的内容

**症状**：`POST /api/v1/content/write` 返回 200，`GET /api/v1/content/read` 读得到，
`POST /api/v1/search/find` 查不到。

**原因**：

1. **`status` 不是 `active`**。`experiences` / `rules` 写入时是 `pending`，检索 SQL 固定
   `status = 'active'`（`src/adapters/sqlite/retrieval-index.ts`）。先
   `POST /api/v1/memories/{uri}/approve`。
2. **中文查询没命中**。FTS5 索引的是 CJK 单字切分后的文本，查询侧同样切分再包成短语
   （§8.1）。短语匹配要求字符**相邻**：搜「门禁」不会命中「跑完全部门禁」，除非这两个字在
   原文里连续出现。
3. **索引写入失败**。看 `_meta/reconcile.log`——批量导入时写文件成功、写索引失败，那条记录
   会在这里。重放已经自动执行：启动时（HTTP 监听前）跑一次，调度器每一轮（默认 30 秒）也跑。
   文件还在的话通常不需要人工介入；如果同一 URI 的记录一直留着，日志里有
   `对账记录重放失败，保留待下次重试。` 的 warn，按上面的 `error` 字段排查。
   `op = write` / `attachment` 的记录没有可重放的输入，重放器会保留它们——需要重新提交那次
   导入。
4. **权限过滤**。`find` 只返回调用方有 `read` 的节点（§12.4），无权限节点完全不出现。

**处理**：先用 `grep` 按行确认内容在文件里，再确认 `status`，最后看 `reconcile.log`。

### 工具返回 `TOOL_DEADLINE_EXCEEDED` / 输出里有 `Degraded` 行

**症状**：MCP 工具返回 `isError`，文本以 `TOOL_DEADLINE_EXCEEDED:` 开头；或者 `find` /
`search` / `rule_search` 的正常返回末尾多出一行 `Degraded: …`。

**这两件事不一样**，判断方向也不同：

| 现象 | 含义 | 去哪看 |
|---|---|---|
| `TOOL_DEADLINE_EXCEEDED` +「最后进入的上游是 X」 | 一次工具调用到 30 秒总上限仍未返回（架构文档 §13.3）。有界失败，不是空结果 | `server.log` 里搜 `MCP 工具超过调用上限。`，按 `requestId` 定位这次请求；上游的降级记录是 `意图分析不可用` / `重排失败，使用融合分` |
| `…；卡住的位置在本地（索引 / 文件系统 / 锁）` | 到上限时没有任何上游上报：卡在 ACL 求权、本地 SQLite 或文件系统调用上 | 同上；这次不是供应商的问题 |
| `Degraded: 向量检索不可用（…）；已退回关键词检索（FTS5）` | `hybrid` 引擎拿不到查询向量，关键词命中的内容仍然返回 | 括号里带错误码；查嵌入供应商、地址与端口 |
| `Degraded: 向量检索不可用（…）；没有退回关键词检索，本次结果可能不完整。` | `retrieval.engine: vector` 显式选了语义检索，不退回 FTS5 | 同上。**空结果是「没查到」，不是「记忆里没有」** |
| `Degraded: 重排不可用（超时 / 网络不可达 / HTTP 5xx）；结果使用融合分。` | 重排失败，排序退回 RRF 融合分 | `GET /health` 的 `rerank.lastFailure`（`reason` / `durationMs` / `topN`） |

**先分清「失败」与「降级」。** `TOOL_DEADLINE_EXCEEDED` 表示这次调用没有等到答案，工具
不会返回半份结果；`Degraded` 表示结果照常返回、但有一路检索缺席。前者说明总上限或本地
I/O 出了问题，后者说明单个上游在预算内没答上来。

**调 `providers.*.timeoutSeconds` 不会让 MCP 工具等更久。** 30 秒是工具层与 HTTP 检索两条
路由的硬上限，上游预算（查询嵌入 6 秒、重排 12 秒）各自另有限制；调大只影响单次
上游调用（hook HTTP 尝试也会取剩余预算与 `min(5 秒, 剩余)`）。`Degraded` 出现得频繁而
工具不超时，说明预算不够或供应商变慢，先确认模型与网络，再考虑提高上限
（`ToolRegistry` 的装配参数，默认 `API_CALL_DEADLINE_MS`，不暴露给模型）。

**处理**：到上限的那一路先修上游（`providers.*` 的地址、API Key、端口是否可达）；归因
写「本地」时查 SQLite 锁与文件系统（`CONFLICT`、磁盘满、NFS 上的 `link` 失败，见已知
限制 24）。`Degraded` 本身不是故障，只需要让下游知道这次结果不完整。

### 会话页 403

**症状**：`GET /api/v1/sessions` 返回 `PERMISSION_DENIED`。

**原因**：`GET /sessions` 先对作用域根求 `read` 权限，再逐个 `load` 会话目录。物化表
（`node_permission`）里没有这个节点就默认 deny。三种常见情况：

1. **数据根是空的、还没初始化**：启动时会预置 `user/{uid}/` 与 `memories` / `resources` /
   `skills` / `sessions` 四个目录的权限行（`src/bootstrap/container.ts`）。没跑到说明启动自检失败。
2. **请求身份不是这个作用域的用户**：`GET /sessions` 只列当前身份可读的根。用 API Key 或
   session token 代表 `user:bob` 时，`user:local` 的会话列表是 403（权限不足，不是 401）。
   没有凭据且不是回环来源时根本走不到这里——`src/bootstrap/container/api.ts` 的
   `createIdentityResolver` 先返回 401 `UNAUTHENTICATED`。
3. **手动改过 `.acl.json`**：把 `user:{uid}` 那条删了。owner 恒 `manage` 不受影响，但如果改的是
   `restricted` 又没加直接授权，会真的没权限。

**处理**：`curl /health` 看服务是否正常；`GET /api/v1/acl?uri=...` 看物化结果（需要 `manage`）；
`.acl.json` 改坏了就恢复备份，或者删掉整个 `_meta/comem.sqlite` 再启动（会重新物化根，但
已索引节点会消失，见「备份与恢复」的警告）。

### 用户与组页 / 任务卡 403

**症状**：控制台的「用户与组」页、概览页的待处理任务卡、会话页的任务表都报
`PERMISSION_DENIED`。接口原文是 `需要系统管理员：<主体> 不在管理名单里。`
（`src/api/http/middleware.ts`），控制台不显示这句：403 已经收敛成固定文案，那几处显示
「需要管理员权限」的空态。

**原因**：这些端点跨主体，没有目标资源可求权，只认系统管理员（架构文档 §12.4）：
`auth.adminUserIds` 里列出的用户 ID，或 `POST /api/v1/bootstrap/admin` 创建的第一个管理员
（`app_user.bootstrap_admin = 1`）。两者都没有就是 403——回环信任给出的
`server.subject` 不会自动进名单，跨主体端点不认「请求来自本机」这个事实。

**处理**：已经走 `/setup` 建过管理员的话，用那个账号登录；否则在 `config.yaml` 里写
`auth.adminUserIds: ["<你的 uid>"]` 并重启。

### 控制台每个请求 401

**症状**：控制台能打开，但每个请求都是 `UNAUTHENTICATED`；`curl` 不带凭据反而正常。

**原因**：`curl` 走的是回环信任（来源是回环地址、`Host` 指向本机），控制台走的是
`Authorization: Bearer <session token>`。控制台的 token 缺失、过期或签名不匹配时，服务端
不会回退到回环信任，而是 401。

**处理**：

1. 先看回环信任是否生效：`curl -s http://127.0.0.1:1933/health | jq .result.subject`。
   不是期望的主体，说明 `server.subject` 没生效：检查 `COMEM_SERVER_SUBJECT` 环境变量与
   `config.yaml` 的优先级（CLI > 环境变量 > 配置文件 > 默认值），改完要重启后端。
2. 重新登录。登录后仍然 401 时，检查 `auth.sessionSecret` 是否在重启后变化（空串 = 进程
   随机值），以及账号是否被改过密码 / 删除（`session_epoch` 轮换会让旧 token 立即失效）。
3. 容器部署里 `curl` 也不带凭据就 401，是因为镜像默认
   `COMEM_AUTH_TRUST_LOOPBACK=false`（容器绑 `0.0.0.0`）。在容器内访问
   `127.0.0.1:1933` 仍然走回环信任；从宿主机经 `-p` 端口转发来的请求来源是容器网段，
   必须带 Bearer。用 `POST /api/v1/auth/login` 换 token，或给该用户签一把 API Key。
4. 控制台整页显示「控制台无法确定当前身份」时，说明 `GET /bootstrap` 拉取失败或字段
   缺失。错误页会写出原因（HTTP 状态、超时、不是 JSON），按它排查；此时控制台**不会**发
   任何业务请求。
5. 整页显示「当前主体没有可访问的命名空间」时，登录用户的 `scopes` 为空：该主体在用户
   目录里不存在 / 被禁用，或根目录的权限行没物化（见上面「会话页 403」）。

### `pnpm dev` 起不来

**症状 A：`listen EADDRINUSE: address already in use 127.0.0.1:1933`**

端口被占。`ss -ltnp | grep 1933` 找出进程，或者换端口（控制台的 devProxy 写死 1933，
换端口要同时改 `web/nuxt.config.ts`）：

```bash
COMEM_SERVER_PORT=8080 pnpm dev
```

**症状 B：进程立刻退出，日志里只有一行 `$ tsx src/bootstrap/main.ts`**

入口判断没命中：`src/bootstrap/main.ts` 用 `import.meta.url === pathToFileURL(process.argv[1])`
判断「是不是入口」，不满足就不启动。用别的路径或别的加载器跑会被判成「只是被 import」。
按文档里的两条命令跑（`pnpm dev` 或 `node --import tsx ...`）即可。

**症状 C：`配置文件引用了未设置的环境变量 COMEM_LLM_KEY`（或 `COMEM_EMBEDDING_KEY`）**

你的 `config.yaml` 里有 `${VAR}`，而那个变量没设置。插值是**强制展开**的：报错只提第一个
缺失的变量，所以修完 `COMEM_LLM_KEY` 还会撞上 `COMEM_EMBEDDING_KEY`。三条路：导出这两个
变量；把它们设成空串（`COMEM_LLM_KEY= COMEM_EMBEDDING_KEY= pnpm dev`，等于「没有密钥」）；
或者从 `config.example.yaml` 重新复制一份——模板里两个 `apiKey` 都是空串，不需要任何密钥。

**症状 D：`Cannot find package 'tsx'`**

跑过 `pnpm install --prod`。tsx 是 devDependency，装上它或者按「启动」一节的说明换成
构建产物。

### 任务一直停在 `pending`

**症状**：`POST /sessions/{id}/commit` 返回了 `taskId`，`GET /tasks/{id}` 一直是 `pending`，
`history/archive_NNN/` 里没有 `.done`，也没有记忆被抽取出来。

**原因**（按可能性排序）：

1. **执行器没启动。** 阶段二执行器（`src/bootstrap/commit-runner.ts`）由
   `src/bootstrap/main.ts` 启动，每 1 秒轮询一次 `claimable`。手工用
   `createContainer()` 起的脚本不会自动跑它——要么自己 `commitRunner.start()`，要么在
   测试里 `await commitRunner.tick()`。
2. **任务载荷坏了。** `payload` 缺 `sessionUri` / `archiveUri` / `archiveId`，或 URI 解析
   失败时任务会被直接标 `failed`（不重试）。看 `task.error` 字段。
3. **租约卡住。** `running` 且 `lease_until` 在未来：上一个执行器进程崩了。等租约过期
   （默认 60 秒）或重启（启动扫描会把过期的 `running` 重置回 `pending`）。

**处理**：先 `GET /tasks/{id}` 看 `status` / `error` / `attempts`，再确认 `main.ts` 起过
执行器。见「已知限制」第一条。

### TTL 配错了，记忆全查不到

**症状**：`find` / `search` 查不到某批记忆，`GET /content/read` 按路径还能读到；
`node.status` 是 `archived`。

**原因**：`memory.ttl.defaultDays` 设小了（比如想写 365 天，写成了 1），调度器把
最后使用时刻超出窗口的记忆软过期了。**不会丢文件**——`sweep` 只改 `status`，不删内容、
不动 `node_permission`。

**处理**：

1. 把 `defaultDays` 改回 `0`（或正确的天数）并重启。第一段整体不跑之后，已归档的行
   **不会自动恢复**。
2. 用 SQL 把它们改回来（`read` / `download` 一直可用，检索只认 `status = 'active'`）。
   判据是最后使用时刻，没有「过期时间」列可清：

   ```sql
   -- 先看影响面：归档时刻就是被 TTL 收走的时间
   SELECT uri, memory_type, updated_at, last_accessed_at, archived_at
     FROM node WHERE status = 'archived' AND archived_at IS NOT NULL;
   -- 再按需收窄、恢复
   UPDATE node SET status = 'active', archived_at = NULL
    WHERE status = 'archived' AND archived_at IS NOT NULL;
   ```

   不要指望「重写一遍文件」恢复：观察者会按记忆文件的 frontmatter 重写 `status`，而
   `experiences` / `rules` 因此会回到 `pending`（复核闸门），需要再复核一次。

**注意**：如果 `defaultDays` 仍然开着，一条确实很久没用过的记忆改回 `active` 后会在
下一轮清扫里再次被归档——这是滑动窗口的正常行为。要么把窗口调大，要么把这批记忆改成
四类豁免之一的类型（不是推荐做法，豁免是给身份与规则用的）。

### 会话被自动删除了

**症状**：`sessions/` 下少了目录，日志里有 `会话已删除（空闲过期）。`

**原因**：`session.expiry.idleTimeoutSeconds > 0` 且 `session.expiry.action: delete`。
删除前已经检查过「归档产出的记忆是否仍待复核」，跳过的情况会记
`…但产出的记忆仍在待复核，跳过删除。`。

**处理**：没有回滚（`rm -rf` 不可逆）。从备份恢复整个数据根（见「备份与恢复」），
或者把 `action` 改回 `archive`——归档只改 `status`，可以改回来。

## 已知限制

按对使用的影响排序。**这些都是真的没做，不是「以后优化」。**

1. **只有 `main.ts` 起的进程会跑阶段二。** 提交的阶段一（归档目录、`messages.jsonl`、
   `.meta.json`、任务行）在请求里同步完成，阶段二（归档摘要 → 记忆抽取 → 补丁合并 →
   摘要失效）由 `CommitRunner` 认领任务执行，而它只在 `src/bootstrap/main.ts` 里启动。
   用 `createContainer()` 自己写脚本时不会自动跑，任务会停在 `pending`。
2. **TTL 没有逐条设置过期时间的能力。** 它是一个统一策略：滑动窗口
   （`memory.ttl.defaultDays`）+ 四类类型豁免。`node.expires_at` 列与
   `TtlService.setExpiry` 都已删除（`0005_sliding_ttl.sql`）。要让某条记忆永不过期，
   改它的类型或把 `defaultDays` 设回 0。
3. **回环信任不区分本机的进程。** `auth.trustLoopback` 打开时，来源是回环地址、且
   `Host` 指向本机的请求被认证成 `server.subject`（`src/bootstrap/container/api.ts` 的
   `resolveBoundSubject`）。本机任何能连上端口的人都是这个用户——与 `~/.ssh` 的权限模型
   同级，不是漏洞，但部署时必须知道。要区分身份就关掉它，让所有请求都带
   `Authorization: Bearer`（session token 或 API Key）。`Authorizer` 按每请求的
   `principals` 求权：组外用户读不到组根（`tests/integration/services/acl.test.ts` 的
   `user:bob` 用例）。控制台按同一份凭据工作：没有会话时整页跳
   `/login?redirect=...`，登录页用 `POST /auth/login` 换 session token，之后每个请求带
   `Authorization: Bearer <token>`；凭据存 `sessionStorage`（刷新保留、关标签页即清），
   顶栏提供退出。收到 401 时清掉本地会话并回登录页。可读根多于一个时顶栏出现作用域
   选择器，选择存 `sessionStorage`，刷新后恢复；组根不可读时不会列出来。
4. **`reindex` 不重建物化权限。** `pnpm reindex` 从磁盘重建检索索引（`node` /
   `node_fts`）、向量（`node_embedding`）与关联边（`memory_link` 的 `derived_from`，
   `--only=links` 或 `all`），物化权限（`node_permission`）不在它的
   职责里——它由 `.acl.json` 与所有者推导，归属 `AclService` 的写路径。索引坏了
   可以修；整库丢失时权限要另走 ACL 重建（目前没有命令）。参数见「备份与恢复」。
5. **`reject` 的原因只进日志。** `MemoryService.reject` 删掉文件、把 `reason` 写进 `info`
   日志，不落盘也不进数据库（`src/services/memory/review.ts`）。事后要复盘「为什么拒了」只能翻日志。
6. **技能目录没有 `description`。** `GET /skills` 只返回 `{uri, name}`。`SKILL.md` 的
   description 在 frontmatter 里，而 `DocumentFrontmatter` 只建模 `summary` 一个字段，
   `ContentStore.readText` 不暴露任意键。Hook 注入的 `<available-skills>` 因此只有名字，
   这是 §15.2 允许的最低一档，不是静默丢失。
7. **技能文件不设置执行位。** 技能文件按数据存放，`ContentStore` 只写字节，没有 chmod
   入口；`services/` 不能 `import node:fs`，所以脚本装进去之后不可执行。请求里传
   `executable` 会被忽略：`SkillFileInput` 只有 `path` 与 `content`，MCP 与 HTTP 两侧都只
   按这两个键取值，HTTP 路由没有严格 schema，未知键直接丢弃。要补需要给 `ContentStore`
   加一个 chmod 方法，现在没有。
8. **`reconcile.log` 里的部分失败无法自动恢复。** 重放已实现：启动时（HTTP 监听之前）与
    调度器每一轮都会重放 `op = index` / `permission`，成功后原子重写日志只保留未解决条目；
    目标 URI 已删除视为已解决，坏行记 warn 后丢弃。会写记录的写入点是 `add_resource` /
    `add_skill` 的批量索引、`IndexObserver` 的单文件索引行与移动后的目标子树（都只记文件），
    以及这三条写路径的权限物化失败（观察者同时覆盖节点自己、祖先目录与删除后的父目录）。
    仍然修不了的是：

    - `write` / `attachment` 的失败记录：日志里没有正文或原始字节，只能重新提交导入；
    - 索引**删除**失败（删除节点、移动时清理源前缀）：重放器按磁盘现状补齐，没有「删掉一条
      过期索引行」这个动作，因此只记日志，过期行要靠 `pnpm reindex` 全量重建；
    - 观察者读盘失败（连索引记录都构造不出来）与目录型节点的索引行（重放器只按文件重建）；
    - 摘要生成的 L0 / L1 索引行：失败抛给提交步骤重试或由观察者记日志，不进对账——两行都从
      磁盘的 `.abstract.md` / `.overview.md` 重建，最终失败用 `pnpm reindex` 补齐，不需要为它
      新增一种记录。

    跨进程共享同一数据根时追加与重写没有互斥，v1 不支持这种部署。每类失败记什么、不记
    什么以及原因，见架构文档 §10.6「索引双写补偿」。
9. **跨设备 `move` 的 EXDEV 分支没有自动化测试。** 两端都在同一个 `mkdtemp` 里，不 mock
    `node:fs` 构造不出来。为一条几乎走不到的分支给生产类加可注入接缝，成本大于收益。
10. **`download` 的签名密钥是进程级随机值。** 10 分钟过期，**重启即失效**。单机部署可接受；
    多实例要共享密钥，那时再加配置项。
11. **向量检索是暴力检索，没有 ANN 索引。** `sqlite-vec` 的 `vec0` 虚拟表是 C + SIMD
    的暴力检索。实测 1 万条 × 1024 维：不带候选集 8–10ms，带 1 万条 URI 候选集 78ms。
    **十万节点会先撞上「候选集全量」这个假设**（按线性外推约 800ms）。届时要么把 scope
    过滤下推到 `vec0`（给 `uri` 加分区列），要么换 ANN——这是架构决策，不是调参能解决的。

12. **记忆合并没有回滚。** `MemoryService` 没有事务（一条记忆一个文件），`filesystem`
    端口也拿不回逐字节前像（`created_at`、`status` 会在重写时被重新计算）。写盘前的
    全部校验都在任何写入之前完成，把「中途失败」压到只剩 I/O 与加锁失败；真的中途失败
    时错误 `details` 里带已经应用过的 `adds` / `updates` / `deletes`，按它收尾。

13. **记忆合并的清单有 200 条上限。** 超过时只合并前 200 条，每次合并记一条 `warn`。
    更多记忆应该先按目录拆 scope，而不是把清单撑到模型看不完。

14. **撤权扫描有 10,000 个目录的上限。** `AclService.purgePrincipal` 在反查表之外
    还会扫描数据根下所有带 `.acl.json` 的目录（手工改过文件的授权也要撤）。扫描按目录
    数计数，达到 `MAX_PURGE_SCAN_DIRECTORIES = 10000` 时停止并记一条 `truncated: true`
    的 `warn`，账号删除继续执行。上限之外如果正好有属于被删账号的手工授权，
    `node_permission` / `acl_entry` 行会被删掉，但 `.acl.json` 里的条目会留下——同 ID
    重建后 `materializeNode` 会把它算回来。没有 `acl:rebuild` 命令可以自动收口；目录数
    接近上限的部署应当在删账号后手工检查相关目录，或者按业务拆分数据根。

15. **`sqlite-vec` 的 `uri IN (...)` 有缺陷。** 候选集里只要有**一个** URI 不存在，
    整条 KNN 查询就返回空。而「权限候选集里的 URI 刚被并发删除」是正常竞态，静默返回
    空等于语义检索偶尔查不出东西。当前做法是先用全表主键扫描求交（1 万行 5.8ms）。
    **不要换成按候选集点查**：`vec0` 主键点查约 7µs/条，1 万条 70ms，比全表扫贵一个
    数量级。上游修复后可以简化。

16. **导入的会话把来源记在游标表，不是 `.meta.json`。** `SessionMeta` 没有 `source`
    字段，`metadata-file.ts` 读回的类型化视图不含未知字段（文件里仍原样保留）。
    `ingest_cursor` 的
    `(harness, native_session_id, session_uri)` 是唯一可追溯来源的地方。要在
    `.meta.json` 里直接看到来源，需要先扩 `SessionMeta`。

17. **导入的重复窗口是「一批 100 条」。** 一批消息写完之后、游标写回之前崩溃，重跑
    会把这一批再追加一次。最坏情况 100 条重复，不是整段对话。彻底消除要按源消息 ID
    逐条去重，v1 不做。

18. **`ingest_cursor` 不随账号删除。** 游标表按 `(harness, native_session_id)` 存
    `session_uri` 与 `cursor_value` 列，行类型 `IngestCursorRow`（`src/adapters/sqlite/ingest-cursor-repository.ts:25`），
    而 `IdentityService.deleteUser` 只清身份行、成员关系、API Key、组 owner 与召回账本
    （`src/services/identity.ts:210`），不碰这张表。删账号 → 重建同 ID → 再导入**同一个
    原生会话**时，游标仍在末尾：`readMessages` 从游标之后读（`src/services/ingest/session-ingest.ts:52`），
    读到 0 条消息，整段会话被记成「跳过」（`src/services/ingest/session-ingest.ts:109`），新账号的会话
    目录里没有消息。恢复：删掉对应行再重跑导入
    （`DELETE FROM ingest_cursor WHERE harness = '...' AND native_session_id = '...'`，
    见「导入本机 Agent 对话」的幂等一段）。
19. **导出前的脱敏会破坏 JSON（`密码保护`）。** 真实语料里数字串被替换成了中文字符
    串：`"total_tokens":4密码保护811`、`"create_time": 1791275310.6密码保护9`。整份
    导出因此不是合法 JSON，而 Qwen 是**单文件 35MB**、ChatGPT 是 19MB——整体
    `JSON.parse` 一个坏文件就会让整个来源失败。解析器先按「把 `密码保护` 换成 `0`」修复
    再试一次（会话结构与正文都在，被抹掉的是计数与时间戳的高位）；仍然失败才**跳过该
    文件**并写进 `report.errors`，**不中断同一来源的其它文件**。报告里 `failed` 会加一，
    `errors[].locator` 是被跳过的文件路径。

20. **Qwen 的导出文件可能整份不可解析。** 本机实测的 35MB 导出在字符串里有未转义的
    引号（`JSON.parse` 报 `Expecting ',' delimiter`）。脱敏修复救不回来时，导入会跳过
    这个文件并记进报告，不会静默返回 0 个会话；同一来源的其它文件继续导入。这份数据
    要重新导出。

21. **ChatGPT 的 HTML 导出不做适配器。** `chat.html` 是「另存为网页」，DOM 解析脆弱
    且不是官方导出格式；官方导出里的 `conversations.json` 才是稳定接口。

22. **owner 为空的组只能通过命令行恢复。** 删账号会清掉 `app_group.owner_user_id`，组根
    只剩 `group:{gid} = write`。组里没有第二个 manage 持有者时，HTTP 管理面改不了 owner
    （求权阶段就 403），只能用 `pnpm group:owner <groupId> <userId>` 恢复。控制台的组列表
    用「无所有者」标出来；没有「在界面上直接认领」的入口——那等于给任何组员一条不需要
    manage 的授权通道。

23. **`sqlite-vec` 只有预编译二进制。** `sqlite-vec@0.1.9` 通过平台包
    `sqlite-vec-<os>-<arch>` 提供 `vec0.so`（本机是 `sqlite-vec-linux-x64`，ELF x86-64，
    动态链接 `libc.so.6` 的 `GLIBC_2.14` 以上）。Debian bookworm（glibc 2.36）成立。
    换到 **Alpine / musl** 上实测（`node:24-alpine`）：`db.loadExtension` 抛
    `ERR_LOAD_SQLITE_EXTENSION: Error loading shared library /app/node_modules/sqlite-vec-linux-x64/vec0.so.so: No such file or directory`
    ——musl 的动态加载器找不到 glibc 的 `libc.so.6`，报的是 ENOENT 而不是「架构不符」。
    `src/adapters/sqlite/database.ts` 把它包成 `INTERNAL`「加载 sqlite-vec 扩展失败，
    向量检索不可用。」，HTTP 侧是 500；之后任何 `vec0` 语句报
    `ERR_SQLITE_ERROR: no such module: vec0`。平台包没装（可选依赖被跳过）时是
    `Cannot find module 'sqlite-vec-linux-x64/vec0.so'`；不支持的平台 / 架构
    （linux-ppc64、win32-arm64 等）是 `Unsupported platform for sqlite-vec, on a
    linux-ppc64 machine. Supported platforms are (darwin-x64,linux-x64,darwin-arm64,
    win32-x64,linux-arm64).`。三条都没有降级路径：向量检索是 `retrieval.engine =
    vector | hybrid` 的唯一实现，加载失败直接抛错，不会静默退回 FTS。

24. **锁文件依赖硬链接。** `src/adapters/fs/lock.ts:268` 用 `link()` 原子创建
    `.comem-lock`，只有 `EEXIST` 被当成「锁被占用」；其它 errno 原样抛出，不重试、
    不降级。**NFS / CIFS** 上 `link` 可能返回
    `EPERM: operation not permitted, link '...comem-lock.tmp' -> '...comem-lock'`
    （服务器不允许硬链接），写操作因此以 HTTP 500 `发生未预期的内部错误。` 失败。
    overlayfs 与本地 ext4 / xfs 成立（`tests/integration/fs/lock.test.ts` 在
    `mkdtemp` 上跑）。数据根放网络文件系统时，先确认 `ln 目标 链接` 能成功。

25. **镜像里跑 `pnpm test` 必须 `--target test`。** 核心镜像（`runtime`）从
    `prod-deps` 拿依赖，`pnpm prune --prod` 之后没有 `vitest` / `eslint`，而且运行
    镜像里根本没有 pnpm：`docker run --rm comem:local pnpm test` 直接
    `exec: "pnpm": executable file not found`。全量测试与 lint 用
    `docker build --target test -t comem:test-suite .` 构建出的镜像跑（它的 `test`
    阶段会自己先跑一遍 `pnpm lint && pnpm test && pnpm test:integrations`）。

26. **模型用量没有 `purpose` 维度，成本累计是下界。** `/metrics` 只有
    `comem_llm_tokens_total{kind}` 与无标签的 `comem_llm_cost_usd_total`（没配
    `providers.llm.default.pricing` 时这条序列根本不存在，另输出
    `comem_llm_pricing_configured 0` 说明原因），数据源是
    `LlmService` 的一份进程级累加器：`LlmService` 没有 `purpose` 概念，调用方不传用途，
    重启即清零。`comem_llm_calls_total`、`comem_llm_duration_seconds`、
    `comem_llm_errors_total` 也没有实现（§17.4）。另外 `generateJson` 只累加调用次数，
    不累加 token 与成本——`LlmProvider.completeJson` 的返回值不含 usage——而记忆抽取、
    记忆合并与查询改写走的都是这条路径，所以成本累计低于实际。要按用途归因，得先让
    每次调用带用途标签。

27. **`GET /api/v1/stats/sessions/{id}` 未实现。** `src/api/http/routes/` 里没有 `stats.ts`，
    也没有 `/stats/memories`；单会话的归档次数、消息数、抽取计数、召回 / 提交 P50 与
    Hook 开销既没有端点，也没有数据来源：`request_log` 没有会话列，`phases` 只由
    `phase()` 写入 `recall`（`/search/find`、`/search/search`）与 `capture`
    （`POST /sessions/{id}/messages`）两段，其余请求是空的，也串不到某个会话上。
    文档与控制台按「未实现」表述；要落地得先让请求带上会话标识、补齐阶段计时，再定
    P50 的样本窗口（架构文档 §17.5）。

28. **30 秒总上限只覆盖 MCP 的 16 个工具与 HTTP 检索的两条路由（三条调用路径）。** 常量是
    `src/api/deadline.ts` 的 `API_CALL_DEADLINE_MS = 30_000`，两侧共用；到点后 MCP
    返回 `isError` 文本 `TOOL_DEADLINE_EXCEEDED: …`，HTTP 返回 503
    `PROVIDER_UNAVAILABLE`（`details.reason = 'deadline_exceeded'`，架构文档 §13.3）。
    30 秒是推导值：28 秒上游预算（意图分析 10 + 嵌入 6 + 重排 12）+ 2 秒本地余量。
    三条路径是 `/search/find`、`/search/search` 的 `mode=list` 与 `mode=context`。

    **`POST /search/grep`、`/search/glob` 与 fs / read / list / tree 等不调模型的端点
    有意不设时间上限。** 这两条检索路由不是纯本地扫描：`glob` 是一次索引查询
    （`index.glob` 在 SQL 里按 `node_permission` 过滤，服务层再过一遍 `filterReadable`），
    `grep` 的候选集同样来自 `index.glob`（上限 `GREP_CANDIDATE_LIMIT = 200` 个候选
    文件），只有逐文件读盘与行匹配发生在本地（架构文档 §8.4）。三条理由：30 秒是上面
    的推导值，套给不调模型的操作就是「一个数字两套来源」；grep 的代价只有结构性上界
    （候选文件数 × 每个文件的行匹配），不是时间上界，同一个常数对它们没有意义；风险
    方向是「HTTP 更宽松」而不是相反——MCP 同步阻塞宿主 agent，所以先收紧，HTTP 的
    grep / glob 只被控制台与脚本调用，而 Hook 的召回走 `/search/find`，已经在闸门下。

    **用户可观察的后果**：大库加慢盘时，同一个能力会在 MCP 侧 30 秒返回错误、在 HTTP
    侧继续等待。`providers.*.timeoutSeconds` 仍然只校验正数（写 3600 就真的等 3600
    秒），而 `LlmOptions` / `EmbeddingOptions` / `RerankOptions` 的 `timeoutMs` 只是
    上限，不能把配置放宽（§19）。Hook 侧另有每个事件的墙钟总预算（1–30 秒，见
    `docs/architecture.md` §15.9），预算内每次 HTTP 尝试再取 `min(5 秒, 剩余预算)`。

29. **`SessionEnd` 用「这次提交可能放弃」换宿主的 1.5 秒共享预算。** 它的总预算是
    `SESSION_END_BUDGET_MS = 1200`（`integrations/lib/lifecycle.mjs`），而
    `captureSession` 等会话锁最多 `LOCK_WAIT_MS = 2000`（`integrations/lib/lock.mjs`）。
    锁被另一个 hook 占着时，等锁会先撞上「预算 + 250ms」的硬上限：进程在约 1.45 秒
    以退出码 0 结束（赶在宿主 1.5 秒杀掉它之前），这次提交放弃。后果可控——游标没有
    前进，下一次 `Stop` / `PreCompact` 会把同一批消息重投（§15.4「宁可重复不能丢」）。
    把等锁降到 1.2 秒以内只会把放弃点从硬上限挪到等锁超时（`HOOK_LOCK_TIMEOUT`），
    结果同样是这次提交不做；当前保留较长的一侧，是因为正常争用时更愿意等。

30. **HTTP 与 MCP 的默认检索范围不一样。** MCP 的 `find` / `search` 不带 `targetUri` 时读
    `readScopes`：个人根 + 所有可读的组根（`src/api/mcp/registry.ts`）。HTTP 的
    `/search/find` 与 `/search/search` 不带 `scopeUri` 时只查当前身份自己的根
    （`scopeOfSubject(context.subject)`）。同一句查询在两个入口能看到的范围不同；要从
    HTTP 覆盖组根，调用方必须显式传 `scopeUri`。`grep` / `glob` 不受影响——它们必须
    传一个具体 `uri`。

31. **`POST /resources/temp-upload` 与 `POST /telemetry/hook` 只校验身份，没有目标授权。**
    前者把原始字节写进 `_meta/tmp/`（请求体是 `application/octet-stream` 原始字节，不是
    multipart；`x-file-name` 头给文件名；单文件上限 50MB，超了 `RESOURCE_EXHAUSTED`），
    任何已认证身份都能写；后者记录 Hook 开销指标，同样任何已认证身份都能调。两者的落点
    都不在 `comem://` 节点上，没有可求权的目标。滥用面是「占满 24 小时暂存」与「污染
    指标」；暂存由调度器按 24 小时清理（见「后台调度器」的已知限制）。

32. **`GET /health` 不需要认证，会回绑定主体与它的可读根。** 响应里的 `subject` 与
    `scopes` 是回环信任使用的身份（架构文档 §12.7）；未认证就能读到部署者身份与命名空间
    列表。它只回 `server.subject` 那一个主体的信息，不回任何用户数据。

33. **同一个 `dataDir` 只支持一个服务端进程。** 会话的累计消息数（轮次时钟）与消息幂等
    索引都是进程内缓存，两个进程写同一个数据根会漏计已归档消息，跨轮去重窗口随之算错
    （`src/services/session.ts` 的 `totalMessageCount` 注释）；`_meta/reconcile.log` 的追加
    队列也只在进程内串行（架构文档 §10.6）。**启动时的存量向量回填落在这条限制上**：两个
    进程都会回填，`vec0` 没有 compare-and-set，最后写入者赢；不会写坏行（行里的
    `content_digest` 与向量来自同一次读盘），但两次读盘之间文件被改时，可能短暂出现「向量
    对应 A、`content_digest` 对应 B」的状态，下一次回填或 `pnpm reindex` 按磁盘重算会修正。
    多实例部署要给每个实例独立的数据根，或在前置层保证同一时刻只有一个写者。

34. **启动时的向量缺失扫描是线性的。** `retrieval.engine` 含向量且配了 embedding 时，
    `main.ts` 的 `warnIfVectorsMissing` 调 `hasDocumentsMissingVectors`
    （`src/commands/reindex.ts`）：对每个 document 行做一次 `NOT EXISTS` 子查询，命中第一
    条缺失就返回，全部都有向量时要扫完全表。它在开始监听之前跑，库越大启动越慢；扫描只
    提醒、不修复——补齐由监听之后的后台回填自动做（`startVectorBackfill`，每批一行 info
    带 embedded / skipped / failed / remaining），`pnpm reindex` 仍是手工全量重建的入口。

35. **`telemetry.metrics.includeAccountLabel` 打开后序列数按账号数放大。**
    `comem_http_request_duration_seconds` 从一条全局序列变成每账号一条（`account` 标签，
    未认证请求归 `anonymous`），条数随账号数线性增长，Prometheus 侧的存储与查询成本随之
    上升。单账号部署默认关闭是对的；多账号环境打开前先确认抓取端能承受。

36. **悬空符号链接会被写入替换掉。** `ContentStore` 用 `stat` 判断目标是否存在（跟随
    符号链接），用「同目录临时文件 + `rename`」落盘（`ContentStore` 自己的 `exists`，
    与 `src/adapters/fs/atomic-write.ts` 的 `writeFileAtomic`）。目标是一个指向不存在路径的符号链接时，`stat`
    返回 `ENOENT`，被当成「这里没有文件」，随后的 `rename` 把链接**本身**换成普通文件：
    目录里原本那个链接静默消失。丢掉的只是一个本来就指向虚无的链接，没有覆盖任何真实
    内容；但「这里有个链接」这件事无法从写入结果里看出来。`write` 与 `add_resource` 都走
    这条路径。要堵住需要不跟随符号链接的 `lstat`（先判定「这是个链接」再决定拒绝还是写
    穿），`src/` 里没有这个方法。

37. **`memory_link` 只有 `derived_from` 能重建，且会丢掉被截断的更早的边。**
    `pnpm reindex --only=links`（`--only=all` 也含）按每份记忆的 `sources` 整批重算这一类
    边，能把写失败的边、删错的行、手工改过 `sources` 之后的不一致修回来。两条边界：`references`
    / `related` 在 frontmatter 里没有真相，重建不动它们，写错的只能改 SQL；`sources` 上限
    20，一条记忆的 `sources` 被截断过时，重建会把写路径累积下来的更早的边删掉（架构文档
    §11.10）。HTTP 层仍然只有读端点（`GET /memories/{uri}/links`），没有写端点。

38. **`GET /health` 返回全库聚合计数。** `index.totalNodes`、`queue.pending`、
    `queue.processing`、`memory.pendingReview`、`memory.orphanTasks`、
    `summary.pendingDirs` / `degradedDirs` 都是跨全部用户与组的计数，不带主体过滤；端点
    在公开路径上（与 `/metrics` 一样，见上面第 32 条），任何能访问服务的人都能读到这些
    数字。它们是计数，不含 URI、正文或别的记录枚举。控制台的概览页依赖它（§16）。

39. **`supersedes` 只跟一跳，被截断的版本回不去。** `reject` 只读当前 pending 文件的
    `supersedes`，把那一份版本写回规范 URI；它不沿链回溯（`src/services/memory/versioning.ts`
    的 `restoreSuperseded`）。版本文件不参与 TTL（两段清扫 SQL 都排除 `.history`），所以让
    回退目标消失的只有「每个 identity 只留 5 份」的截断：同一个 identity 覆盖写超过 5 次
    之后，恢复失败只记一条 `warn`（「指向的文件不存在，拒绝时按删除处理」），终态是这条
    记忆被删除，不是回到更早的版本（架构文档 §11.11）。

40. **`prefetch` 只返回 `active`，未复核的经验对下一轮归纳不可见。** 经验归纳步骤
    （`experience_distill`）用 `MemoryService.prefetch` 取同一 topic 的旧正文，而
    `prefetch` 按 `status = 'active'` 过滤（`src/services/memory/query.ts` 的 `prefetchMemories`）。上一轮写入的
    经验还在 `pending`、没被复核时，下一轮归纳看不到它，模型按「没有旧经验」整段重写，
    旧结论被无合并覆盖（`pending` 旧值也不做版本快照，见架构文档 §11.11）。这是复核闸门
    的既有语义——未生效的结论不参与检索与预取——不是新缺陷；要让下一轮看到未复核的经验，
    得把 pending 纳入 `prefetch`，那会改变「pending 不进检索」的契约。
