<div align="center">

# CoMem

### 让 AI agent 真正记住「你是谁、你在做什么」

**一个开源、自托管、可检查的 AI agent 上下文记忆数据库**

[docs/architecture.md](docs/architecture.md) · [docs/operations.md](docs/operations.md) · [docs/coverage-map.md](docs/coverage-map.md) · [集成指南](integrations/README.md) · [问题反馈](https://github.com/Micraow/CoMem/issues)

<p>
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-strict-3178C6?style=flat-square&logo=typescript&logoColor=white">
  <img alt="Node" src="https://img.shields.io/badge/Node-%E2%89%A522.5-339933?style=flat-square&logo=node.js&logoColor=white">
  <img alt="Fastify" src="https://img.shields.io/badge/Fastify-5-000000?style=flat-square&logo=fastify&logoColor=white">
  <img alt="Nuxt" src="https://img.shields.io/badge/Nuxt-3-00DC82?style=flat-square&logo=nuxt.js&logoColor=white">
  <img alt="SQLite" src="https://img.shields.io/badge/SQLite-FTS5-003B57?style=flat-square&logo=sqlite&logoColor=white">
  <img alt="sqlite-vec" src="https://img.shields.io/badge/sqlite--vec-vector-4B8BBE?style=flat-square">
  <img alt="Embedding" src="https://img.shields.io/badge/Embedding-1024d-FF6F00?style=flat-square">
  <img alt="Hybrid Search" src="https://img.shields.io/badge/Recall%4010-0.904-2EA043?style=flat-square">
  <img alt="License" src="https://img.shields.io/badge/license-AGPL--3.0-blue?style=flat-square">
</p>

</div>

---

昨天你让 agent 排查一个问题，它翻了三层目录、读了五个文件、最后定位到一个 `Settings::nextHop` 是三级映射的坑。今天开个新会话问它同样的事，它从零开始再翻一遍——因为它只记得上下文窗口里的东西，而上下文窗口是**会话级**的，关掉就没了。

CoMem 给 agent 一个稳定地址（`comem://`），让它在不同会话、不同机器和不同队友之间复用上下文。记忆保存在你磁盘上的 Markdown 文件里，可以查看、编辑和比较版本。

**第一次用？** [启动并打开控制台](#-快速开始) → [接入你的 Agent](#-接入你的-agent) → 在新会话试问一条已保存的偏好。要带入旧对话，点 **会话与任务 → 导入历史会话**。如果你在搭个人助手，先看 [Hermes 快速上手](docs/hermes-quickstart.md)。

### 它记的不是「你说过什么偏好」，而是「你干活时暴露过什么」

你很少会专门告诉 agent「我的开发机是 M5 Pro、我的项目用 pnpm」。这些信息是在**干活时顺手暴露**的：

- 某次让它排查问题，它跑了一条 `uname -m`，记下了你的机器型号；
- 某次你随口抱怨「这破 CI 又要跑二十分钟」，它记下了你对 CI 环境的不满；
- 某次它改代码，摸清了你项目里 `Settings::nextHop` 是三级映射——**这个事实以后不该再被它猜一遍**；
- 某次你在评审里说「以后并发这块别用双重检查锁」，它记下了一条约束。

这些零散的、你从没打算「存下来」的东西，被 CoMem 在会话结束后**自动抽取、归类、写成有条理的记忆**。下一次你在新会话里发出第一条 prompt 的时候，**在 prompt 送到模型之前**，CoMem 已经根据这条 prompt 检索了相关记忆、把命中的上下文整理好、注入进去了——你什么都不用做。

```mermaid
flowchart LR
  U["👤 你在干活"] -->|"随口说的话 / 跑的命令 / 改的代码"| A["🤖 Agent"]
  A -->|"会话结束自动采集"| C[("🗄️ CoMem")]
  C -->|"抽取·归类·去重·写文件"| D["📁 有地址的 Markdown"]
  N["👥 你 / 队友 / 另一台机器"] -->|"发出下一条 prompt"| C2[("🗄️ CoMem")]
  C2 -->|"prompt 发出前先召回"| D
  D -->|"整理好的相关上下文一并注入"| N
```

### 一份记忆，一个团队共用

记忆是有 URI 的资源，`comem://group/eng/...` 下的内容对**组内所有人可见**。同一个项目里，A 摸索出来的部署坑、B 踩过的 API 陷阱、C 定下的代码规范，都落在同一棵记忆树里。**下一个人接手时，不用从头再踩一遍**——他发出第一条 prompt 时就已经拿到了。

权限按目录继承、按主体发牌（`user` / `group` / `user:*`），`deny` 优先级最高。共享到什么粒度，你自己决定。

---

## ✨ 为什么是 CoMem

| | 你能得到什么 |
|---|---|
| 🎣 **自动采集与召回** | 装好宿主的集成后，CoMem 可归档对话，提炼有依据的偏好、事实和经验，并在后续对话时提供相关记忆。 |
| 👥 **多人共享同一份上下文** | 记忆是有 URI 的资源，`group` 作用域下组内全员可见。新人接手直接从记忆树起步，不从零踩坑。 |
| 🪜 **复杂的分级设计** | 三层加载（L0 摘要 256 字 / L1 概览 / L2 原文）+ 目录作用域 + 记忆类型分桶 + ACL 继承链。先判断相关性、再决定读多深。 |
| 💰 **控制上下文成本** | 自动提供有界的个人背景与相关记忆正文，长材料按预算降级到概览或摘要，保留 `comem://` 来源。画像超 1000 字时要求整份重写收敛；节省多少 token 仍取决于实际任务。 |
| 🎯 **可复现的检索评估** | 仓库评测集上，混合检索 Recall@10 为 **0.904**，关键词检索为 0.315。用 `pnpm eval` 复跑；这些数字衡量检索命中。 |
| 📂 **记忆就是文件** | 每条记忆是一个有 URI 的 Markdown 文件，目录即作用域。任何编辑器打开、任何工具搜索、`git diff` 看改动。 |
| 🧩 **16 个 MCP 工具，不多不少** | 刻意克制。工具越多模型越容易选错，越难被信任。 |
| 🏠 **自托管，数据在你手里** | 一个 Docker 镜像、一个 SQLite 文件、一个数据目录。随时备份、随时迁移。 |

> 演示时「看起来能跑」不是标准。标准是**别人按文档部署后能不能用**——所以配置项真的生效，错误真的能定位，已知限制写在文档里而不是留给你踩。

---

## 🚀 快速开始

### 方式一：Docker（推荐）

需要 Docker 与 Docker Compose。整条命令都在本机 `127.0.0.1` 上，不对外监听。

```bash
git clone https://github.com/Micraow/CoMem.git
cd CoMem
cp config.example.yaml config.yaml     # compose 部署必需；不用配置文件时改用下面的 docker run
docker compose build
docker compose up -d
curl http://127.0.0.1:18080/health     # {"status":"ok",...}
```

**不需要任何密钥就能起服务。** `config.yaml` 是本地文件、不进版本控制。模板里
`providers.llm.default.apiKey` 与 `providers.embedding.apiKey` 都是空串——摘要、记忆抽取、
合并与检索改写要接真实模型才工作，接的时候在 `config.yaml` 里填 key，或用环境变量
`COMEM_PROVIDERS_LLM_DEFAULT_API_KEY` / `COMEM_PROVIDERS_EMBEDDING_API_KEY` 覆盖。

**`docker compose` 部署要先有 `config.yaml`。** compose 会把 `./config.yaml` 挂进容器；
文件不存在时 Docker 会在宿主建一个同名目录，启动报 `EISDIR: illegal operation on a directory, read`。
上面那条 `cp config.example.yaml config.yaml` 不是可选的。完全不用配置文件时，改用
`docker run` 且不挂载它（全部走默认值，会 warn 一条占位的 `baseUrl`）。

**「留空」与「不设置」不是一回事。** 空串是「没有密钥」，能启动；`${VAR}` 引用的环境变量
**没设置**时启动直接失败（`配置文件引用了未设置的环境变量 ...`），即使那个 provider 是
`disabled`。这两条混起来是「复制完启动不了」最常见的原因。

**如果你手上已经有一份 `config.yaml`**（例如从别的机器拷来的），它是**那台机器**的配置：
`dataDir`、`baseUrl`、`ingest.paths` 都可能指向本机不存在的路径，还带着别人的密钥。从零
开始请先把它移走（`mv config.yaml config.yaml.bak`），再决定要不要从模板重建。

打开浏览器访问 **http://127.0.0.1:18080**，就是控制台。

<details>
<summary><strong>需要容器内本地推理（embedding / rerank 不依赖外部 API）？</strong></summary>

```bash
docker compose --profile inference build   # 比核心镜像大 ~647 MB
docker compose --profile inference up -d
```

推理镜像把 llama.cpp 编进容器，模型在首次启动时按需下载到数据卷。不需要就跳过——默认核心镜像走远程 OpenAI 兼容 API。
</details>

<details>
<summary><strong>只用 Dockerfile、不用 Compose？</strong></summary>

```bash
docker build -t comem:local .
docker run -d --name comem \
  -p 127.0.0.1:1933:1933 \
  -v comem-data:/var/lib/comem \
  -e COMEM_DATA_DIR=/var/lib/comem \
  comem:local
```

注意：单独跑后端时控制台不在同源，得自己配一层反向代理把 `/api` 转给后端——`docker-compose.yaml` 里的 nginx 就是在做这件事，直接抄它即可。
</details>

### 方式二：本地开发

需要 **Node ≥ 22.5**（依赖内置 `node:sqlite`）与 **pnpm**。

```bash
pnpm install
cd web && pnpm install && cd ..   # 控制台独立 lockfile，会触发 nuxt prepare 生成类型
pnpm dev
```

`pnpm dev` 同时起后端（`http://127.0.0.1:1933`）与控制台（`http://127.0.0.1:3081`）。只要后端跑 `pnpm dev:server`，只要控制台跑 `pnpm dev:web`。

<details>
<summary><strong>先跑一次本地验证</strong></summary>

```bash
pnpm test:e2e
```

它用临时数据验证归档、检索、复核、摘要和权限，跑完自动停。要在这条演示中执行模型抽取与合并，需一并设置 `COMEM_LLM_KEY`、`COMEM_LLM_BASE_URL` 和 `COMEM_LLM_MODEL`。
</details>

### 第一个账号从哪来

**认证恒开，控制台只有一条首跑路径**：起服务 → 从启动日志拿初始化令牌 → `/setup` 建管理员 → `/login` 登录。本地开发、Docker、纯 SSH 都走它。

**Docker（`docker compose`）**：镜像默认关掉回环信任（容器必须绑 `0.0.0.0`），第一次启动要创建管理员：

```bash
docker compose build
docker compose up -d
docker compose logs comem | grep 初始化令牌
```

日志里有一行 `初始化令牌：<token>（用于首次创建管理员账号；创建完成后失效）`，`<token>` 待会儿要填。打开 http://127.0.0.1:18080/setup ，填用户名（默认 `local`）、密码、初始化令牌，提交后去 `/login` 登录。这个账号通过引导管理员标记直接获得系统管理员权限，不用再配 `adminUserIds`。

**本地开发（`pnpm dev`）**：打开 http://127.0.0.1:3081/setup （回环地址不需要令牌）创建管理员，再去 `/login` 登录。默认用户名是 `local`——本机的 `curl` 与 hook 插件通过回环信任拿到的也是 `user:local`，建同一个 ID 才不会分裂成两个账号。

**之后加账号**：控制台「用户与组」页的「新建用户」。新账号建出来没有密码，要在该用户的详情抽屉里打开「密码」页签设一次；不设的话，登录会得到「用户名或密码错误」。要让某个账号能管用户与组，把它的 ID 写进 `auth.adminUserIds` 并重启。

**忘记密码 / 没有浏览器**：账号已经存在时用命令改密码（数据根必须先由服务初始化过一次；用户不存在时命令只报错，不建账号）：

```bash
# 宿主机（在仓库根目录执行）
printf '%s' '新密码' | pnpm password local

# 容器（docker compose 部署）
printf '%s' '新密码' | docker compose exec -T comem node dist/commands/password.js local
```

**回环信任是一条信任策略，不是「关掉认证」。** `auth.trustLoopback` 默认打开：没有凭据、来源是回环地址、且 `Host` 指向本机的请求被认证成 `server.subject`（默认 `user:local`）——本机的 `curl`、hook 插件、MCP 客户端因此不必存凭据。**任何能连上本机端口的人都是这个用户**，与 `~/.ssh` 的权限模型同级。它只允许在 `server.host` 是回环地址时打开；容器部署（绑 `0.0.0.0`）必须设成 `false`，否则服务**拒绝启动**。TLS 只加密传输，不区分身份。

完整说明（`adminUserIds`、登录凭据、回环信任、恢复组 owner）见 [docs/operations.md 的「认证与账号」](docs/operations.md#认证与账号)。

---

## 🧠 核心概念（30 秒版）

<details>
<summary><strong>URI 命名空间——所有东西都有地址</strong></summary>

两个根 `user/{uid}` 与 `group/{gid}`，根下可以有 `projects/{pid}` 作用域：

| 用途 | 真实 URI |
|---|---|
| 个人记忆 | `comem://user/alice/memories/profile` |
| 项目作用域 | `comem://user/alice/projects/comem/memories/events/2026-11-05-decision` |
| 组空间 | `comem://group/eng/memories/conventions` |
| 会话 | `comem://user/alice/sessions/sess_7f3a91c2` |
| 资料 | `comem://user/alice/projects/comem/resources/docs/architecture` |
| 技能包 | `comem://user/alice/skills/code-review/SKILL` |

URI 先做 Unicode NFC 规范化，再合并重复斜杠、拒绝 `.`/`..`/控制字符/保留名、单段上限 255 字节。**规范化必须唯一**：权限按路径记录，同一个文件有两个路径就有两套权限，其中一套一定是错的。
</details>

<details>
<summary><strong>三层摘要（L0 / L1 / L2）——先看目录，再读文件</strong></summary>

| 层 | 落在哪 | 预算 | 用途 |
|---|---|---|---|
| **L0** | 目录的 `.abstract.md` 正文 | 256 字符 | 判断「这条和我有关吗」 |
| **L1** | 同目录的 `.overview.md` 正文 | 4000 字符 | 替代大部分原文阅读 |
| **L2** | 文件原文 | 无限制 | 确定要用了才读 |

L0 从 L1 正文提取，两层不会互相矛盾。**摘要是目录级的**，文件自己的摘要写在 frontmatter 的 `summary` 字段里，跟着文件走——移动、复制、备份都不用单独维护。
</details>

<details>
<summary><strong>目录级检索——四个面各管一件事，质量可测</strong></summary>

| 面 | 输入 | 什么时候用 |
|---|---|---|
| `find` | 一条查询 | 不知道内容在哪个目录 |
| `search` | 查询 + 会话 ID | 需要先做意图分析再检索 |
| `grep` | 正则 + 路径范围 | 知道大概在哪，要找具体那一行 |
| `glob` | 路径通配 | 只想要文件列表 |

排序分 = `bm25 × 层级权重`（L0 1.15 / L1 1.05 / L2 1.00）。权重只用来在词频接近时打破平局：L0 摘要经过一次压缩、信息密度更高，但 L2 词频明显更高时仍然应该赢。

**质量不是玄学。** `pnpm eval` 在一份带标注的数据集（105 条查询）上量化召回与排序：

| 变体 | Recall@10 | MRR | NDCG@10 | p50 |
|---|---|---|---|---|
| 纯关键词 `fts5` | 0.315 | 0.372 | 0.335 | 0.2ms |
| 纯向量 `vector` | 0.880 | 0.782 | 0.777 | 1.5ms |
| **`hybrid`** | **0.904** | **0.852** | **0.829** | 1.6ms |
| `hybrid+rerank` | 0.913 | 0.874 | 0.845 | 8.0s |

（本机 2026-11-08 实测。改一个参数就能重跑，看变好还是变坏——不是靠感觉调参。）

**默认引擎是 `hybrid`**：embedding 负责语义召回，FTS5 补充精确词。首次启动可先打开控制台，填写生成模型和嵌入模型的连接，测试、保存后重启。未配置 embedding 时检索返回 503 待配置，管理、文件和会话归档仍可用；需要离线关键词检索时显式设置 `retrieval.engine: fts5`。已有配置明确选择的引擎保持生效；旧部署省略该字段时升级会采用新默认值。

自动接入在开局交付有界的个人背景正文，每轮用当前问题与最近可读对话召回个人、团队和直接授权分享的记忆。三种宿主共用服务端组装、预算、权限过滤与去重。设置连接不需要重复填写用户 ID，身份来自当前请求凭据。
</details>

<details>
<summary><strong>权限（ACL）——deny 优先，ACL 不进 MCP</strong></summary>

主体 `user:alice` / `group:eng` / `user:*`；级别 `read = 1`、`write = 3`、`manage = 7`（高位包含低位）；每个目录可 `inherit` 或 `restricted`；同一节点 `deny` 优先。

```json
{
  "mode": "inherit",
  "entries": [
    { "principal": "user:alice", "level": "manage", "effect": "allow" },
    { "principal": "group:eng", "level": "read",   "effect": "allow" }
  ]
}
```

**ACL 不进 MCP。** 一个能给自己授权的 agent 就是提权漏洞，`get_acl` / `set_acl` 只走 Web 与 HTTP。检索侧的权限物化进 `node_permission` 表，检索时是一个 `EXISTS` 子查询。
</details>

<details>
<summary><strong>注入预算——为什么不是「塞得越多越好」</strong></summary>

记忆齐全了，但如果每次会话开头把上百条记忆全塞进上下文，token 成本会失控、还会淹没真正相关的那几条。CoMem 在注入侧做了三道闸：

1. **硬预算**：开局 `profileBudgetTokens` 默认 2000，同时受服务端 `assembly.maxTokens`（默认 1600）约束；最终渲染文本也检查字节上限。
2. **分层配额**：自动上下文最多五条记忆；画像正文与相关知识共享预算，长材料可退到概览或摘要，只剩 URI 时不注入。
3. **降级顺序固定**：服务端按完整条目裁剪；Hook 合并技能目录后再次检查宿主上限，先删除技能，再删除个人背景块。极小预算下可以不注入。

产生侧的画像也有上限：**正文超过 1000 字就整份重写收敛**（只留当前成立的事实，不摞历史），保证注入成本是一个可控的常数，而不是随会话数线性增长。
</details>

---

## 🎣 被动捕获需要什么才能生效

「我什么都没提，它应该自动记下来」——这个预期只在**装了宿主 Hook** 的部署里成立。服务端本身不监听你的对话，它不知道什么时候该归档。下面四条决定了「被动」到底有多被动。

### 1. 实时捕获靠 Hook，服务端的自动提交阈值基本不会触发

每一轮对话结束时，宿主调 `Stop` Hook，后者把这一轮的消息 `POST /sessions/{id}/messages`，再 `POST /sessions/{id}/commit` 提交归档；阶段二（抽取、合并、归纳）随后在后台跑完，记忆才落盘。**提交接口本身不做阈值判断**——调了就归档，`session.autoCommit` 管不到它。

**没装 Hook 时，只剩服务端的 `session.autoCommit` 阈值在兜底**，默认值是：

| 阈值 | 默认 | 含义 |
|---|---|---|
| `session.autoCommit.pendingTokenThreshold` | 150,000 token | 未提交内容超过它才自动提交 |
| `session.autoCommit.messageCountThreshold` | 100 条消息 | 消息数超过它才自动提交 |
| `session.autoCommit.idleTimeoutSeconds` | 0（关） | 空闲多久自动提交 |

**几句对话的新会话一条都不满足。** 装完服务端、不装 Hook，聊十轮也不会有一条记忆——不是坏了，是没有任何东西触发提交。要么装 Hook（见下一节），要么让 agent 主动调 `remember` 工具。

### 2. 复核闸门：这两类记忆写盘了，但 `find` 搜不到

> **这是「明明记了却说没记下来」最常见的原因。**

`memory.reviewRequired` 默认是 `['experiences', 'rules']`。这两类记忆写入时状态是**待复核**：

- 文件**已经**在磁盘上（`memories/experiences/`、`memories/rules/`），`GET /api/v1/memories/pending` 也能看到；
- 但 `find` / `search` **不会返回它们**——待复核的记忆不参与检索。

通过方式二选一：控制台左侧「记忆复核」页逐条通过，或调 `POST /api/v1/memories/{uri}/approve`（URI 要 URL 编码，比如 `encodeURIComponent`）。通过之后它们才会出现在检索结果里。

所以「文件在那儿、`find` 搜不到」不是索引没建，是它在等复核。

### 3. 记忆类型由对话内容决定，不是由工具决定

抽取按内容路由，不是每次写画像：

| 对话里出现 | 落到 |
|---|---|
| 稳定身份事实（名字、年龄段、所在地、职业） | `profile`（`memories/profile.md`，单文件） |
| 某天的决策、里程碑 | `events`（`memories/events/`） |
| 一次具体任务的尝试、参数与结果 | `cases`（`memories/cases/`） |
| 以后能照做的经验教训 | `experiences`（`memories/experiences/`，待复核） |
| 沟通风格、喜好、习惯、取舍 | `preferences` |

「它把这件事写进 profile 了」是这次对话的内容被判成了稳定身份，不是 `remember` 的固定行为。想确认写了什么，直接看 `memories/` 下的文件。

### 4. 批量导入是另一条通道

打开 **会话与任务 → 导入历史会话**，复制提示词交给已连接 CoMem MCP 的 Agent，指定文件，检查预览后确认。它会提交原始对话，CoMem 用同一条后台流程提炼记忆。服务端能直接读到的 Codex 等原生日志，也可用 `pnpm ingest` 批量导入。两种入口选其一即可。[详细步骤](docs/ingest-prompt.md)

---

## 🔌 接入你的 Agent

**MCP** 让 Agent 主动查找、记录和导入对话。**自动记忆**由宿主集成负责：Claude Code 和 Codex 用 Hook，DSH 用 Cordis 插件，Hermes 用 Memory Provider。控制台「接入 Agent」按宿主给出步骤。

<details>
<summary><strong>Hermes（个人助手）</strong></summary>

在官方 Hermes Webapp 里使用 CoMem 的自动记忆，并按需安装 OpenUI 交互式回答。使用同一个 CoMem 账号连接 Memory Provider 和 MCP，导入的历史对话、自动归档和手工新建的记忆就能在同一个空间里使用。见 [Hermes 快速上手](docs/hermes-quickstart.md)。
</details>

**Hook 插件用仓库内的脚本装，不是 `npx`。** `integrations/package.json` 是 `private: true`、没有发布到 npm，`npx co-mem` 会拿到 `404 Not Found`。下面的命令都要在**仓库根目录**执行。

<details>
<summary><strong>Claude Code</strong></summary>

```bash
claude mcp add --transport http comem http://127.0.0.1:1933/mcp
node integrations/cli.mjs install --host claude-code    # 写入 ~/.claude/settings.json
```

装完它就自动采集会话、注入记忆了。
</details>

<details>
<summary><strong>Codex</strong></summary>

Codex 支持完整的生命周期 Hook（`config.toml` 的 `[features].hooks`，默认开启），七个事件与 CoMem 一一对应：`SessionStart` / `UserPromptSubmit` / `PreToolUse` / `PostToolUse` / `Stop` / `PreCompact` / `SessionEnd`。

```bash
node integrations/cli.mjs install --host codex          # 写入 ~/.codex/hooks.json
```

首次使用需在 Codex 的 `/hooks` 里**信任一次** Hook（Codex 的安全机制，改动后需重审）。MCP 也可单独接 `http://127.0.0.1:1933/mcp`。
</details>

<details>
<summary><strong>DSH</strong></summary>

DSH 没有 hook 脚本面：它的生命周期点是同进程 Cordis 插件订阅的 typed 事件。所以
DSH 上不用 `install --host dsh`（它会在写任何字节之前失败，并指向插件），而是装
`integrations/dsh-plugin/`：

```bash
# 1. 装进 profile
dsh plugin --profile web add "link:$PWD/integrations/dsh-plugin"
```

```yaml
# 2. 在 $DSH_HOME/profiles/web/cordis.patch.yml 里加一条 insert
- insert:
    - id: comem
      name: comem-dsh-plugin
      config:
        baseUrl: http://127.0.0.1:1933
        token: ''            # 非回环时必须给
```

```bash
# 3. 不启动也能验证组合成功
dsh --profile web --dump-config | grep -A6 'id: comem'
```

插件使用 `agent/created` 注入个人背景与技能目录、`agent/pre-step` 逐轮召回、`tools/post-execute` 采集工具调用与结果、`session/event` 的 `turn/end` 采集并提交消息、`agent/disposed` 尽力补交；`compaction/start` 重置召回上下文并提示压缩前不会额外归档。

**已知限制**：DSH 没有可在压缩前拦截的接缝，压缩前不会额外归档；没有真正的
`SessionEnd`，进程被强杀时最后半轮会丢；子 agent 会话不注入
也不采集。细节与配置见
[插件 README](integrations/dsh-plugin/README.md) 和[集成指南](integrations/README.md#dsh)。
</details>

<details>
<summary><strong>其他 MCP 客户端</strong></summary>

任何支持 Streamable HTTP 的 MCP 客户端都可以接 `http://127.0.0.1:1933/mcp`。不带 Hook 也能用——只是要自己调 `remember` / `find`，由你来决定存什么、取什么。
</details>

详细安装、七个 hook、MCP 接入细节、bypass 与去重规则见 [集成指南](integrations/README.md)。

---

## 🗺️ 架构一览

四层，依赖方向单向：

```mermaid
flowchart TB
  API["① 接口层 api/http · api/mcp<br/>HTTP ↔ 服务调用、MCP 工具 ↔ 服务调用"]
  SVC["② 应用层 services/<br/>用例编排、事务边界、后台任务"]
  DOM["③ 领域层 domain/<br/>Uri、Acl、Patch、Ranking、节点规则；纯函数，无 IO"]
  ADP["④ 适配层 adapters/<br/>文件系统、SQLite+FTS5、模型 SDK、日志"]
  API --> SVC
  SVC --> DOM
  SVC -. "import type" .-> ADP
  ADP --> DOM
```

<details>
<summary><strong>目录结构与依赖规则</strong></summary>

| 首层目录 | 对应层 | 一句话 |
|---|---|---|
| `src/api/` | ① 接口层 | HTTP 与 MCP 两套协议 |
| `src/services/` | ② 应用层 | 用例编排 |
| `src/domain/` | ③ 领域层 | 模型与规则，可穷举测试 |
| `src/adapters/` | ④ 适配层 | 文件系统、SQLite、模型、日志 |
| `src/config/`、`src/bootstrap/` | — | 装配输入与依赖装配 |
| `web/` | — | Nuxt 3 控制台，独立构建 |
| `integrations/` | — | Hook 插件（Claude Code、Codex）与 DSH 原生插件，独立交付物 |

依赖规则用 ESLint `no-restricted-imports` **强制**：`domain/` 不出现 `node:fs`/`node:sqlite`/`fetch`，`services/` 不出现 `ai`，`services/` 只能用 `import type` 引用 `adapters/`。这不是风格问题——领域层一旦碰 IO，ACL 求值就没法用内存数据穷举测试。
</details>

<details>
<summary><strong>六条核心链路（排障从这里进）</strong></summary>

| 链路 | 做什么 | 代码 |
|---|---|---|
| 会话归档 | 阶段一把消息移进 `history/archive_NNN/` 并建任务，阶段二后台跑四步；`.done` 最后写，是唯一完成信号 | `src/services/session.ts`、`src/services/commit/pipeline.ts` |
| 记忆抽取 | 按类型预取相关文件塞进 prompt，模型输出字段级合并操作与可选实体页码引用；`page_id` 由服务端映射回 URI，实体身份与关联保存在 Markdown frontmatter | `src/services/commit/steps/memory-extract.ts` |
| 补丁合并 | 同 URI 多条 patch 按序应用；SEARCH 必须唯一命中，零处或多处整条失败记 `skippedOperations` | `src/domain/patch.ts`、`src/services/commit/steps/memory-merge.ts` |
| 摘要失效 | 子节点 L0 正文变了才向上传播；小目录（≤32 条）或 `pendingChanges/totalEntries ≥ 0.10` 立刻重算，否则只记脏 | `src/services/summary.ts` |
| 目录级检索 | 四个面统一按权限过滤；先取 `limit × 4` 候选再截断，避免过滤后不足数 | `src/services/retrieval/` |
| ACL 过滤 | 六个出口逐个求权；`restricted` 切断继承；owner 恒 `manage` 且不能被 ACL 收回 | `src/services/acl.ts` |
</details>

---

## 🛠️ 开发

```bash
pnpm verify     # typecheck + lint + check:config + check:reachability + check:shape + check:docs + 构建控制台 + 单元/集成测试 + Hook 测试
```

<details>
<summary><strong>单独跑某一关</strong></summary>

| 命令 | 内容 |
|---|---|
| `pnpm typecheck` | `tsc --noEmit`，`strict: true` + `noUncheckedIndexedAccess` |
| `pnpm lint` | ESLint：分层依赖规则在这里生效 |
| `pnpm check:config` | 每个配置项必须有消费方（L1–L3，见 `docs/operations.md`） |
| `pnpm check:reachability` | 写了但没接线的模块 / 导出 / 成员方法（见 `docs/operations.md`） |
| `pnpm check:shape` | 文件只能变短：行数、超长函数、禁用指令、`any` 计数（见 `docs/operations.md`） |
| `pnpm check:docs` | `docs/` 里的 `file:line` 引用必须仍然指向它声称的那个符号（重构搬走函数后行号漂移） |
| `pnpm test` | vitest：`tests/unit`（领域纯函数）+ `tests/integration`（临时目录 + 内存数据库） |
| `pnpm test:integrations` | Hook 插件的去重、游标、锁、超时预算 |
| `pnpm test:e2e` | 六条链路端到端（临时数据根，不碰真实数据） |

测试不 mock 文件系统和数据库：`fs.mkdtemp()` 建临时目录、SQLite 用 `:memory:`。六条核心链路每条都有对应集成测试。
</details>

**质量检查在本地跑。** CI 只用于补齐本地不具备的环境（全平台打包），不把 typecheck/lint/test 外包给 CI。

---

## 📚 文档

| 文档 | 内容 |
|---|---|
| [`docs/architecture.md`](docs/architecture.md) | **唯一真相**：分层、数据布局、六条链路、错误模型、里程碑（21 节） |
| [`docs/operations.md`](docs/operations.md) | 部署、配置、备份、监控、排障、已知限制 |
| [`docs/coverage-map.md`](docs/coverage-map.md) | 按代码核对的能力全景图：每项能力给入口、实现 `file:line`、数据流、测试证据；另列已砍掉的东西与已知缺口 |
| [`docs/ingest-prompt.md`](docs/ingest-prompt.md) | 历史会话导入：从控制台复制提示词，给已接入 CoMem 的 Agent 指定导出文件或文本，确认预览后由 `remember` 提交；与 `pnpm ingest` 共用归档、抽取、合并与复核流程 |
| [`integrations/README.md`](integrations/README.md) | Hook 插件：安装、七个 hook、MCP 接入、bypass、去重 |

---

## 📄 许可证

[AGPL-3.0](LICENSE)。自托管自用不受限制；**把它作为服务提供给他人使用时，需要公开修改后的源码**。如果你的场景不能接受这一条，可以在 fork 后更换许可证——代码本身不依赖 AGPL 的任何特性。

---

<div align="center">
<sub>用 TypeScript、Fastify、SQLite 和一点点固执写成。</sub>
</div>
