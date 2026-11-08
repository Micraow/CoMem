# 运维手册

面向要把 CoMem 跑起来的人：装什么、怎么配、数据落在哪、出问题看哪里。
架构与设计取舍在 [`architecture.md`](architecture.md)，答辩材料在 [`defense.md`](defense.md)。

## 系统要求

| 项 | 要求 | 来源 |
|---|---|---|
| Node | ≥ 22.5 | `package.json` 的 `engines`。低版本没有 `node:sqlite`，服务起不来 |
| 包管理器 | pnpm | 仓库根与 `web/` 各有一份 `pnpm-lock.yaml`；本文在 pnpm 12.17.0 上验证 |
| 磁盘 | 内容文件 + SQLite 索引 | 没有实测上限。`request_log` 表在启动时按 `retainDays` / `retainRows` 清理一次 |
| 内存 | 未测量 | 没有常驻缓存，每次请求现读。FTS5 的索引在 SQLite 里，不占 Node 堆 |
| 网络 | 只有摘要生成与记忆抽取需要出网 | `summary.generator: rule` 与 `find` / `grep` 全程离线 |

`node:sqlite` 是实验性 API，启动时 Node 可能打印一行 `ExperimentalWarning`。它不影响功能，
也没有关掉的开关（那需要 `--no-warnings`，会把真正的警告一起吞掉）。

## 安装

```bash
pnpm install              # 后端 + Hook 插件的开发依赖（tsx、vitest、eslint）
cd web && pnpm install    # 控制台单独装：web/ 有自己的 lockfile，不在根 workspace 里
```

`integrations/` 不需要安装：它是纯 `.mjs`，只依赖 Node 内置模块，`dependencies` 为空。

## 配置

配置来源的优先级（`src/config/index.ts`）：**命令行参数 > 环境变量 > 配置文件 > 内置默认值**。

```bash
pnpm dev -- --config /etc/comem/config.yaml --data-dir /var/lib/comem
```

- 不写 `--config` 时读当前工作目录的 `config.yaml`；**文件不存在不是错误**，全部走默认值。
- 环境变量形如 `COMEM_<SECTION>_<KEY>`，嵌套段用下划线连接：
  `COMEM_SERVER_PORT=8080`、`COMEM_RETRIEVAL_ASSEMBLY_MAX_TOKENS=3200`。
- 数值、布尔、数组都会按默认值的类型转换；转换失败直接报错，不静默取 0。
- 字符串里的 `${VAR}` 在加载时展开，**变量未设置就报错**——静默保留字面量会把错误推迟到
  第一次调用模型时才出现。

`config.example.yaml` 是全量模板。把它复制成 `config.yaml` 之后必须给 `COMEM_LLM_KEY` 赋值，
否则启动直接失败（`apiKey: ${COMEM_LLM_KEY}`）。

### 配置项

| 键 | 默认值 | 是什么 / 什么时候改 |
|---|---|---|
| `dataDir` | `""` | 数据根。空串表示按运行形态推导（§6.5）：容器里 `/var/lib/comem`、root 运行 `/var/lib/comem`、其余 `$XDG_DATA_HOME/comem`。挂卷或备份到别处时显式写 |
| `providers.llm.default.type` | `openai-compatible` | 走哪个 AI SDK provider。`anthropic` 走 `@ai-sdk/anthropic` |
| `providers.llm.default.baseUrl` | `https://api.example.com/v1` | 兼容 OpenAI 协议的服务地址。换成自建网关时改 |
| `providers.llm.default.model` | `gpt-4o-mini` | 模型名。摘要质量与成本由它决定 |
| `providers.llm.default.apiKey` | `""` | 密钥。模板里是 `${COMEM_LLM_KEY}`；空串时调用会失败，但没有密钥也能启动 |
| `providers.llm.default.maxTokens` | `32768` | 单次生成的 token 上限。**截断（`finishReason = length`）不重试**，抽取被截断时调大它（§11.4） |
| `providers.llm.default.timeoutSeconds` | `120` | 单次调用超时。长摘要或慢网关时调大 |
| `providers.llm.default.pricing.inputPerMillion` | `0.15` | 每 100 万输入 token 的单价（美元）。`comem_llm_cost_usd_total` 用它换算（§17.4） |
| `providers.llm.default.pricing.outputPerMillion` | `0.6` | 每 100 万输出 token 的单价 |
| `summary.generator` | `llm` | `llm` 走模型；`rule` 断网降级（子节点名字 + 摘要首句拼接）。**`rule` 的结果恒带 `degraded: true`**，`/health` 会把它报成 `degraded` |
| `summary.abstractMaxChars` | `256` | L0 摘要的字符预算（§9.1）。超了截断，不重试 |
| `summary.overviewMaxChars` | `4000` | L1 概览的字符预算 |
| `retrieval.engine` | `fts5` | 检索后端：`fts5` / `vector` / `hybrid`。后两者需要 `providers.embedding`，没配时 `loadConfig` 直接报错 |
| `retrieval.candidateMultiplier` | `4` | 先取 `limit × N` 候选再按权限过滤，避免过滤后不足数（§8.2）。候选被拦得多时调大 |
| `retrieval.levelWeights.l0` / `.l1` / `.l2` | `1.15` / `1.05` / `1.00` | 层级加权（§8.5）。只用来在 BM25 接近时打破平局 |
| `retrieval.queryFilters` | `[]` | sed 风格正则数组，作用在 prompt 上，产物才是查询（§8.8）。Hook 侧也有默认五条 |
| `retrieval.assembly.maxTokens` | `1600` | 注入模型的 token 预算（§8.6）。模型上下文窄时调小 |
| `retrieval.assembly.dedupTurns` | `3` | 这么多轮内投过的 URI 不再投（召回账本，§8.7） |
| `retrieval.assembly.quotaPreset` | `coding` | `chat`（记忆 5 / 资料 3 / 技能 2）或 `coding`（3 / 5 / 2） |
| `session.autoCommit.enabled` | `true` | 自动提交开关。关掉就只能手动 `commit` |
| `session.autoCommit.pendingTokenThreshold` | `150000` | 未提交 token **严格大于**该值才提交（§10.2.1） |
| `session.autoCommit.messageCountThreshold` | `100` | 未提交消息数严格大于该值才提交 |
| `session.autoCommit.minCommitIntervalSeconds` | `0` | 两次自动提交的最小间隔（全局闸门）。调小会让归档碎片变多 |
| `session.autoCommit.idleTimeoutSeconds` | `0` | 空闲多久后**提交**。0 = 关。由后台调度器执行（§10.7） |
| `session.autoCommit.keepRecentCount` | `0` | 归档时保留最近 N 条在 live 会话里 |
| `session.expiry.idleTimeoutSeconds` | `0` | 空闲多久后**归档**（或删除）。0 = 关。与上面那个是两个独立开关 |
| `session.expiry.action` | `archive` | `archive`（只改 `status`，可逆）或 `delete`（物理删除会话目录，不可逆） |
| `memory.ttl.defaultDays` | `0` | 记忆默认存活天数。0 = 永不过期。只影响之后写入的记忆 |
| `memory.ttl.sweepBatchSize` | `100` | 每轮最多清扫多少条，防止一次清太多把库锁住 |
| `memory.reviewRequired` | `["experiences","rules"]` | 走复核闸门的记忆类型（§11.6）。从列表里去掉某个类型，它的写入直接是 `active` |
| `memory.workingMemory.enabled` | `false` | 开它会多一次模型调用（7 段工作记忆，§10.5）。只在长会话场景值得 |
| `acl.groupDefaultLevel` | `write` | 组空间根的预置级别（`write` / `read`） |
| `server.host` | `127.0.0.1` | 监听地址。容器里改 `0.0.0.0` |
| `server.port` | `1933` | 监听端口。控制台的 devProxy 写死转 `1933`，改端口要同时改 `web/nuxt.config.ts` |
| `logging.level` | `info` | `trace` / `debug` / `info` / `warn` / `error` / `fatal` |
| `logging.file` | `""` | 填路径则在 stdout 之外**额外**写一份 `error` 及以上级别的日志。10MB 轮转到 `<path>.1`（§17.8） |
| `telemetry.metrics.enabled` | `true` | 关掉时 `GET /metrics` 返回 404 并说明「指标已关闭」（空文本会被抓成「指标全为 0」） |
| `telemetry.metrics.includeAccountLabel` | `false` | 单账号部署没必要，开了会放大标签基数 |
| `telemetry.requestLog.enabled` | `true` | 是否写 `request_log` 表（控制台的请求记录） |
| `telemetry.requestLog.retainDays` | `7` | 请求记录保留天数。启动时执行一次清理（不做定时任务） |
| `telemetry.requestLog.retainRows` | `100000` | 请求记录保留行数。同上 |
| `telemetry.requestLog.sampleRate` | `1.0` | 采样率。**错误请求永远全量记录** |
| `telemetry.hookOverhead.enabled` | `true` | 关掉时 Hook 阻塞开销直接丢弃，不累加指标 |
| `telemetry.hotness.weight` | `0` | 热度对最终排序的影响：`finalScore = score × (1 + weight × hotness)`（§17.5）。`0` = 只做冷热标记，不参与排序；非 0 时 `find` 会多查一次访问统计，并把本次命中累加进 `node.access_count`（fire-and-forget，不等它完成） |
| `telemetry.hotness.halfLifeHours` | `168` | 热度半衰期（一周，§17.5）。调小让热度掉得更快 |
| `task.leaseSeconds` | `60` | 任务租约。到期未续租会被启动扫描回收（§10.4） |
| `task.maxAttempts` | `3` | 单个任务最多执行 3 次，超限置 `failed` |
| `task.concurrency` | `4` | 阶段二执行器同时跑几个任务。每个任务会调模型，调太高会把供应商的速率限制打满 |
| `ingest.enabled` | `false` | 本机对话导入的总开关。关着时 `pnpm ingest` 拒绝真正写入，只允许 `--dry-run` |
| `ingest.batchSize` | `100` | 每个会话一次读多少条。100 与 MCP 单次批量写入的量级一致（§10.6 的验收场景） |
| `ingest.paths.<harness>` | `[]` | 源路径覆盖。留空用默认路径：Claude Code `~/.claude/projects`、Codex `~/.codex/sessions`、DeepSeek `~/Downloads/**/conversations.json`、Qwen `~/Downloads/**/Qwen-chat-export-*.json` |

## 启动

### 开发

```bash
pnpm dev                 # 等价于 pnpm dev:server，tsx 直接跑 TypeScript
pnpm dev:web             # 控制台 127.0.0.1:3081，devProxy 把 /api 转到 1933
pnpm dev                 # 后端 + 控制台一起起（端口跟着 COMEM_SERVER_PORT 走）
bash scripts/demo.sh     # 一条命令跑完六条链路，用 /tmp/comem-demo 这个临时数据根
```

### 生产

```bash
node --import tsx src/bootstrap/main.ts --config /etc/comem/config.yaml
```

**v1 为什么用 tsx。** 仓库没有构建步骤：`tsconfig.json` 是 `noEmit: true`，跑的就是源码。
Node 22.5 起自带类型剥离，但它要求模块说明符指向真实文件，而源码按 ESM 惯例写的是
`import ... from '../domain/errors.js'`（编译后才是 `.js`）。直接跑会失败：

```
$ node --experimental-strip-types src/bootstrap/main.ts
Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/home/.../src/api/http/server.js'
    imported from /home/.../src/bootstrap/main.ts
```

tsx 把这层解析接管掉，也解释了 `import type` 与 `verbatimModuleSyntax` 的语义。
代价是**没有类型检查**：类型门禁是 `pnpm typecheck`，CI 与本地都要跑，不能指望启动时报错。

`tsx` 是 devDependency。生产环境如果装依赖时带了 `--prod`，要显式把它算进去，或者换成
先 `tsc` 出 `dist/` 再 `node dist/...`（仓库目前没有这个构建脚本）。

### 退出

`SIGINT` / `SIGTERM` 走优雅退出：先 `app.close()` 停收新请求，再停后台调度器
（会等在途的一轮跑完），再等后台摘要失效跑完（`indexObserver.drain()`），最后关数据库。
10 秒没退完就强退（`process.exit(1)`）——「优雅但可能挂住」不如「确定会结束」
（`src/bootstrap/main.ts` 的 `SHUTDOWN_TIMEOUT_MS`）。

## 后台调度器

`src/bootstrap/scheduler.ts` 每 30 秒跑一轮，做三件事（架构文档 §10.7、§11.7）：

| 职责 | 打开它的配置 | 动作 |
|---|---|---|
| 自动提交 | `session.autoCommit.enabled`（默认开） | 走阶段一，产出 `sessions/<id>/history/archive_NNN/` |
| 会话过期 | `session.expiry.idleTimeoutSeconds > 0` | `archive`（默认，只改 `status`）或 `delete`（物理删除） |
| 记忆 TTL 清扫 | `memory.ttl.defaultDays > 0` | 过期记忆的 `status` 置 `archived` |

**三个开关全关时不起定时器**，启动日志是 `调度器未启动：自动提交、会话过期、记忆 TTL 全部关闭。`；
否则有一行 `调度器已启动。` 带间隔与三个开关的状态。**改了配置要重启**：开关在
`createContainer` 里读一次。

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
    defaultDays: 30       # 新写入的记忆 30 天后归档
    sweepBatchSize: 100   # 每轮最多清 100 条
```

**只影响之后写入的记忆**：过期时间在写入时算成绝对时刻（`updated_at + defaultDays`），
已有的记忆保持原值。要追平存量，只有显式设过期时间（v1 没有对应的 HTTP 接口，见
「已知限制」）。

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
│       └── <scope>.recall_log.json   # 召回账本：第 N 轮投喂过哪些 URI（§8.7）
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
│                       ├── memory_diff.json # 这次归档抽出了哪些记忆操作
│                       └── .done            # 完成信号，最后写（§10.1）
└── group/
    └── <gid>/                    # 组空间：memories / resources / skills / projects
```

**规则**：普通 `ls` 看不到 `.acl.json` / `.abstract.md` / `.overview.md` / `.meta.json` /
`.done` / `memory_diff.json`——它们是元数据，不是目录内容。想看内容用 `GET /content/*`，
想看元数据用 `GET /fs/ls` 之外的接口（§6.7）。

## 备份与恢复

**内容文件是真相，SQLite 是派生。** 判据是「这东西属于哪一类」（§7）。注意派生数据的
「可重建」在 v1 只是设计承诺：`reindex` 与 `reconcile.log` 的重放都没有实现。

| 能丢 | 不能丢 |
|---|---|
| `_meta/tmp/`（还没被引用的上传暂存） | `user/`、`group/` 下的内容文件 |
| `_meta/reconcile.log`（重放了就该删，但 v1 没有重放） | 目录里的 `.acl.json`（丢了等于所有人失去访问权） |
| `_meta/recall/*.recall_log.json`（丢了只多投一次） | `.abstract.md` / `.overview.md`（重算要调模型，花钱） |
| `request_log` 表（只是观测数据） | `_meta/comem.sqlite`（**见下面的警告**） |

> **警告：v1 没有 `reindex` 命令。** 设计上「删库可重建」（§7、§21 的 backlog），但重建命令
> 还没实现。所以**不要只备份内容文件**——现阶段删掉 `comem.sqlite` 等于让所有已索引的节点从
> 检索结果里消失，`find` / `search` 会返回空，只能靠 `grep` / `read` 按路径硬找。备份时把
> 数据根整个打包。

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

## 监控

两个端点都不认证：探活系统没有 CoMem 身份，要求 `x-comem-subject` 只会让 `curl /health`
全部 401。它们也不读用户内容（`src/api/http/routes/ops.ts`）。

### `/health`

`GET /health` 与 MCP 的 `health` 工具返回同样内容（§17.9）。实测输出：

```console
$ curl -s http://127.0.0.1:1933/health | jq
{
  "status": "ok",
  "result": {
    "status": "degraded",
    "index": { "nodes": 4 },
    "queue": { "pending": 0, "processing": 0 },
    "summary": { "degraded": false, "pendingDirs": 0, "degradedDirs": 3 },
    "memory": {
      "pendingReview": 0,
      "orphanTasks": 0,
      "oldestPendingAgeSeconds": null
    },
    "version": "0.1.0"
  }
}
```

| 字段 | 含义 | 什么时候要管 |
|---|---|---|
| `result.status` | `ok` / `degraded` | `degraded` = 摘要走的是规则降级，或存在降级摘要的目录。降级必须可见（§17.9） |
| `index.nodes` | 索引里的节点数 | 掉到 0 而磁盘上有文件 = 索引没写进去，看 `reconcile.log` |
| `queue.pending` / `processing` | 待执行 / 执行中的任务 | `processing` 长期不降 = 卡住的任务，看租约 |
| `summary.pendingDirs` | 待刷新摘要的目录数 | 长期不降 = 摘要失效在堆积 |
| `summary.degradedDirs` | 用规则摘要生成的目录数 | 模型不可用时会涨；恢复后需要重算 |
| `memory.pendingReview` | 待复核的记忆条数（`node.status = 'pending'`） | 控制台「记忆复核」页该清了 |
| `memory.orphanTasks` | 租约过期的 `running` 任务 | 有人认领却没续租 = 进程崩了。启动扫描会把它重置回 `pending` |
| `memory.oldestPendingAgeSeconds` | 最老的待复核记忆距今多少秒 | 没有待复核时是 `null`（「没有」不是 0 秒） |
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
# HELP comem_llm_cost_usd_total 模型成本累计，美元（§18 的 pricing 换算）
# TYPE comem_llm_cost_usd_total counter
comem_llm_cost_usd_total 0
```

v1 实际输出的全部指标（`src/services/observability.ts` 的 `renderMetrics`）：

| 组 | 指标 | 用途 |
|---|---|---|
| HTTP | `comem_http_request_duration_seconds_sum` / `_count` | 请求完整耗时的累加与次数。v1 是 summary 形态，没有分位数 |
| Hook 开销 | `comem_hook_overhead_seconds{event,phase}`、`comem_hook_overhead_total_seconds{event}`、`comem_hook_async_seconds{event}` | 回答「用 CoMem 让每一轮多花了多少毫秒」。`phase` 是 `process_start` / `recall` / `serialize` / `capture`；`total` 是单轮阻塞合计；`async` 是后台部分，与阻塞分开 |
| 模型 | `comem_llm_tokens_total{kind="prompt"\|"completion"}`、`comem_llm_cost_usd_total` | 钱花在哪。成本按 `providers.llm.default.pricing` 换算 |
| 业务 | `comem_index_nodes`、`comem_pending_review` | 索引规模与待复核积压 |

**§17.3 / §17.4 里的其余指标还没实现**：`comem_http_requests_total`、`comem_http_requests_per_second`、
`comem_http_inflight_requests`、`comem_http_ttfb_seconds`、`comem_llm_calls_total`、
`comem_llm_duration_seconds`、`comem_llm_errors_total`。设计文档写了标签与含义，代码里没有对应的
累加器——接 Grafana 之前先按这张表核对一遍，不要照文档写查询。

**阻塞与异步分开统计**（§17.2）：归档 / 抽取 / 合并 / 摘要在后台跑，用户没等它，
不能算进「CoMem 让请求慢了多少」。混在一起会把 12 秒的后台处理算成延迟。

`/health` 与 `/metrics` 同时挂在根路径与 `/api/v1` 下，两处都能抓（§17.1）。

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

`pnpm ingest` 把机器上的历史对话导进会话目录，并逐条会话走阶段一提交。阶段二（记忆
抽取）由 `CommitRunner` 在后台执行，与 `remember` 工具同一条路径。

```bash
pnpm ingest --source claude-code          # 只导一个
pnpm ingest --source all                  # 全部
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
`find` 能搜到的是阶段二从归档里抽取出来的记忆。如果任务一直 `pending`，见「已知
限制」第 1 条（只有 `main.ts` 起的进程会跑阶段二）。

### 输出怎么读

```text
来源 claude-code：发现 42 个会话
  ✅ 新建 38 个会话，共 1,204 条消息
  ➕ 追加 12 条消息到已有会话
  ⏭️  跳过 3 个（游标已到末尾）
  ❌ 失败 1 个
    - /path/to/session.jsonl：<原因>
```

失败会带 `locator`（源文件路径），单条会话的失败不影响其它会话。命令在有失败时以
退出码 1 结束，`--json` 的报告里 `harnesses[].errors` 是完整清单。

### 源路径

默认路径见配置表。真实语料常常是导出的副本（例如 `~/Downloads/AI对话/`），这时用
`ingest.paths` 显式指定，不要改默认值——默认值服务的是「本机正在用的 Claude Code /
Codex」，导出目录是一次性的。

## 故障排查

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
3. 目录条目数 ≤ 32 或 `pendingChanges / totalEntries ≥ 0.10` 才立刻重算，否则只记脏
   （§9.3 第 4 步）。条目多的目录要攒够比例。

**处理**：先看 `server.log` 里有没有 `PROVIDER_UNAVAILABLE`；把 `summary.generator` 临时改成
`rule` 能让摘要立刻生成（结果带 `degraded: true`，`/health` 会显示出来）。v1 没有「强制重算
某个目录」的接口，只能靠再写一次该目录下的文件来触发。

### 检索不到刚写的内容

**症状**：`POST /content/write` 返回 200，`GET /content/read` 读得到，`POST /search/find` 查不到。

**原因**：

1. **`status` 不是 `active`**。`experiences` / `rules` 写入时是 `pending`，检索 SQL 固定
   `status = 'active'`（`src/adapters/sqlite/retrieval-index.ts`）。先 `POST /memories/{uri}/approve`。
2. **中文查询没命中**。FTS5 索引的是 CJK 单字切分后的文本，查询侧同样切分再包成短语
   （§8.1）。短语匹配要求字符**相邻**：搜「门禁」不会命中「跑完全部门禁」，除非这两个字在
   原文里连续出现。
3. **索引写入失败**。看 `_meta/reconcile.log`——批量导入时写文件成功、写索引失败，那条记录
   会在这里。**没有自动重放**，处理办法是再写一次同一路径（走 `FileSystemService`，观察者会
   重新索引），或者接受它暂时检索不到。
4. **权限过滤**。`find` 只返回调用方有 `read` 的节点（§12.4），无权限节点完全不出现。

**处理**：先用 `grep` 按行确认内容在文件里，再确认 `status`，最后看 `reconcile.log`。

### 会话页 403

**症状**：`GET /api/v1/sessions` 返回 `PERMISSION_DENIED`。

**原因**：`GET /sessions` 先对作用域根求 `read` 权限，再逐个 `load` 会话目录。物化表
（`node_permission`）里没有这个节点就默认 deny。三种常见情况：

1. **数据根是空的、还没初始化**：启动时会预置 `user/{uid}/` 与 `memories` / `resources` /
   `skills` / `sessions` 四个目录的权限行（`src/bootstrap/container.ts`）。没跑到说明启动自检失败。
2. **`x-comem-subject` 与绑定身份不一致**：v1 单用户，服务图只有一份。请求头写了
   `user:bob` 而装配时绑定的是 `user:local`，直接 `UNAUTHENTICATED`（401），不是 403。
3. **手动改过 `.acl.json`**：把 `user:{uid}` 那条删了。owner 恒 `manage` 不受影响，但如果改的是
   `restricted` 又没加直接授权，会真的没权限。

**处理**：`curl /health` 看服务是否正常；`GET /api/v1/acl?uri=...` 看物化结果（需要 `manage`）；
`.acl.json` 改坏了就恢复备份，或者删掉整个 `_meta/comem.sqlite` 再启动（会重新物化根，但
已索引节点会消失，见「备份与恢复」的警告）。

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

**症状 C：`配置文件引用了未设置的环境变量 COMEM_LLM_KEY`**

`config.example.yaml` 里的 `apiKey: ${COMEM_LLM_KEY}` 是**强制展开**的。要么导出这个变量，
要么把这一行删掉（空串也能启动）。

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

**原因**：`memory.ttl.defaultDays` 设小了（比如想写 365 天，写成了 1），调度器把过期
的记忆软过期了。**不会丢文件**——`sweep` 只改 `status`，不删内容、不动
`node_permission`。

**处理**：

1. 把 `defaultDays` 改回 `0`（或正确的天数）并重启：已经归档的行不会自动恢复。
2. 用 SQL 把它们改回来（`read` / `download` 一直可用，检索只认 `status = 'active'`）：

   ```sql
   -- 先看影响面
   SELECT uri, expires_at FROM node WHERE status = 'archived' AND expires_at IS NOT NULL;
   -- 再按需收窄、恢复
   UPDATE node SET status = 'active' WHERE status = 'archived' AND expires_at IS NOT NULL;
   ```

   不要指望「重写一遍文件」恢复：观察者会按记忆文件的 frontmatter 重写 `status`，而
   `experiences` / `rules` 因此会回到 `pending`（复核闸门），需要再复核一次。

**想彻底清掉过期时间**（让这些记忆永不过期）再加一句
`UPDATE node SET expires_at = NULL WHERE expires_at IS NOT NULL;`。

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
2. **TTL 没有「给已有记忆批量设过期时间」的接口。** `memory.ttl.defaultDays` 只影响之后
   写入的记忆；存量要追平得直接改库（见「TTL 配错了」一节的 SQL）。`TtlService.setExpiry`
   是服务层方法，没有对应的 HTTP 路由。
3. **单用户部署。** 服务图在启动时绑定一个身份（默认 `user:local`），
   `Authorizer` 的三个方法没有 subject 参数（§12.4）。请求头 `x-comem-subject` 与它不一致
   时直接 401，不静默降级——但也没有「多用户」这一档。多租户要的是每请求一份服务图。
4. **ACL 的过滤效果无法用第二个身份验证。** 因为上一条：个人空间里 owner 恒 `manage`，
   `deny` 收不回去；组空间在 v1 没有成员关系（`groups` 只能由装配方传入，`main.ts` 传的是
   空数组），所以 HTTP 层建不出组空间。ACL 求值本身由 `tests/unit/domain/acl.test.ts`
   （41 个用例）与 `tests/integration/services/acl.test.ts` 覆盖，演示脚本只能演到「管理面 +
   被拒绝的组空间写入」。
5. **`reindex` 没有。** 「删库可重建」是设计承诺（§7、§21 的 backlog），命令不存在。
   索引坏了只能靠文件系统继续读写，检索能力等于没有。
6. **`reject` 的原因只进日志。** `MemoryService.reject` 删掉文件、把 `reason` 写进 `info`
   日志，不落盘也不进数据库（`src/services/memory.ts`）。事后要复盘「为什么拒了」只能翻日志。
7. **技能目录没有 `description`。** `GET /skills` 只返回 `{uri, name}`。`SKILL.md` 的
   description 在 frontmatter 里，而 `DocumentFrontmatter` 只建模摘要三字段，
   `ContentStore.readText` 不暴露任意键。Hook 注入的 `<available-skills>` 因此只有名字，
   这是 §15.2 允许的最低一档，不是静默丢失。
8. **`add_resource` 不设置 `executable` 位。** `SkillFileInput.executable` 字段在，
   `services/` 不能 `import node:fs`、`ContentStore` 也没有 chmod 入口，所以脚本装进去之后
   不可执行。要补需要给 `ContentStore` 加一个 chmod 方法，现在没有。
9. **`stop.mjs` 的 50ms 断言余量很薄。** 它测的是进程总耗时（含 ~20ms Node 启动），
   当前机器 40–48ms。更慢的门禁机上这条会先红——那是环境问题，不是实现问题。
10. **`reconcile.log` 没有重放。** 日志在写（批量导入的索引失败会追加一行），但没有启动扫描
    去重放它。所以「索引双写补偿」只做了「记下来」这一半。处理办法见排障一节。
11. **跨设备 `move` 的 EXDEV 分支没有自动化测试。** 两端都在同一个 `mkdtemp` 里，不 mock
    `node:fs` 构造不出来。为一条几乎走不到的分支给生产类加可注入接缝，成本大于收益。
12. **`download` 的签名密钥是进程级随机值。** 10 分钟过期，**重启即失效**。单机部署可接受；
    多实例要共享密钥，那时再加配置项。
13. **向量检索是暴力检索，没有 ANN 索引。** `sqlite-vec` 的 `vec0` 虚拟表是 C + SIMD
    的暴力检索。实测 1 万条 × 1024 维：不带候选集 8–10ms，带 1 万条 URI 候选集 78ms。
    **十万节点会先撞上「候选集全量」这个假设**（按线性外推约 800ms）。届时要么把 scope
    过滤下推到 `vec0`（给 `uri` 加分区列），要么换 ANN——这是架构决策，不是调参能解决的。

14. **记忆合并没有回滚。** `MemoryService` 没有事务（一条记忆一个文件），`filesystem`
    端口也拿不回逐字节前像（`created_at`、`status` 会在重写时被重新计算）。写盘前的
    全部校验都在任何写入之前完成，把「中途失败」压到只剩 I/O 与加锁失败；真的中途失败
    时错误 `details` 里带已经应用过的 `adds` / `updates` / `deletes`，按它收尾。

15. **记忆合并的清单有 200 条上限。** 超过时只合并前 200 条，每次合并记一条 `warn`。
    更多记忆应该先按目录拆 scope，而不是把清单撑到模型看不完。

16. **`sqlite-vec` 的 `uri IN (...)` 有缺陷。** 候选集里只要有**一个** URI 不存在，
    整条 KNN 查询就返回空。而「权限候选集里的 URI 刚被并发删除」是正常竞态，静默返回
    空等于语义检索偶尔查不出东西。当前做法是先用全表主键扫描求交（1 万行 5.8ms）。
    **不要换成按候选集点查**：`vec0` 主键点查约 7µs/条，1 万条 70ms，比全表扫贵一个
    数量级。上游修复后可以简化。

17. **导入的会话把来源记在游标表，不是 `.meta.json`。** `SessionMeta` 没有 `source`
    字段，`metadata-file.ts` 读回时也会丢弃未知字段。`ingest_cursor` 的
    `(harness, native_session_id, session_uri)` 是唯一可追溯来源的地方。要在
    `.meta.json` 里直接看到来源，需要先扩 `SessionMeta`。

18. **导入的重复窗口是「一批 100 条」。** 一批消息写完之后、游标写回之前崩溃，重跑
    会把这一批再追加一次。最坏情况 100 条重复，不是整段对话。彻底消除要按源消息 ID
    逐条去重，v1 不做。

19. **Qwen 的导出文件可能整份不可解析。** 本机实测的 35MB 导出在字符串里有未转义的
    引号（`JSON.parse` 报 `Expecting ',' delimiter`）。导入命令会明确报
    `INVALID_ARGUMENT` 并带 `locator`，不会静默返回 0 个会话。这份数据要重新导出。

20. **ChatGPT 的 HTML 导出不做适配器。** `chat.html` 是「另存为网页」，DOM 解析脆弱
    且不是官方导出格式；官方导出里的 `conversations.json` 才是稳定接口。
