<div align="center">

# CoMem

### 让 AI agent 真正记住「你是谁、你在做什么」

**一个开源、自托管、可检查的 AI agent 上下文记忆数据库**

[docs/architecture.md](docs/architecture.md) · [docs/operations.md](docs/operations.md) · [集成指南](integrations/README.md) · [问题反馈](https://github.com/Micraow/CoMem/issues)

<p>
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-strict-3178C6?style=flat-square&logo=typescript&logoColor=white">
  <img alt="Node" src="https://img.shields.io/badge/Node-%E2%89%A522.5-339933?style=flat-square&logo=node.js&logoColor=white">
  <img alt="Fastify" src="https://img.shields.io/badge/Fastify-5-000000?style=flat-square&logo=fastify&logoColor=white">
  <img alt="Nuxt" src="https://img.shields.io/badge/Nuxt-3-00DC82?style=flat-square&logo=nuxt.js&logoColor=white">
  <img alt="SQLite" src="https://img.shields.io/badge/SQLite-FTS5-003B57?style=flat-square&logo=sqlite&logoColor=white">
  <img alt="License" src="https://img.shields.io/badge/license-AGPL--3.0-blue?style=flat-square">
</p>

</div>

---

你在 Claude Code 里跟它说「这个项目不用 `any`，收窄时用 `unknown`」，它照做了一次。第二天换台机器、换个会话，它又给你写出 `any`——因为它只记得上下文窗口里的东西，而上下文窗口是**会话级**的。

CoMem 给 agent 一个稳定地址（`comem://`），让它跨会话、跨机器、跨队友共享「它知道的东西」。记忆是**你磁盘上的 Markdown 文件**——看得见、改得动、可以 `git diff`。没有黑箱，没有「存进去就查不出来」的失望。

```mermaid
flowchart LR
  U["👤 你"] -->|"说一句偏好"| A["🤖 Agent"]
  A -->|"Stop: 采集消息"| C[("🗄️ CoMem")]
  C -->|"Markdown 文件 + SQLite 索引"| D["📁 磁盘"]
  A2["🤖 新会话"] -->|"find 检索"| C
  C -->|"注入命中的摘要"| A2
```

---

## ✨ 为什么是 CoMem

| | 你能得到什么 |
|---|---|
| 📂 **记忆就是文件** | 每条记忆是一个有 URI 的 Markdown 文件，目录即作用域。用任何编辑器打开、任何工具搜索。 |
| 🔍 **先读摘要，再读原文** | 三层粒度（L0 一句话 / L1 概览 / L2 原文），agent 先用摘要判断相关性，省 token。 |
| 🎯 **按目录检索，不是扫全库** | `find` 把语义搜索限定在某个项目或记忆子树里，而不是在一大堆平铺向量里碰运气。 |
| 🔐 **权限是一等公民** | `user` / `group` / `user:*` 三级主体，`read`/`write`/`manage` 递进，`deny` 优先。ACL 不进 MCP——能给自己授权的 agent 就是提权漏洞。 |
| 🧩 **16 个 MCP 工具，不多不少** | 刻意克制。工具越多模型越容易选错。 |
| 🏠 **自托管，数据在你手里** | 一个 Docker 镜像、一个 SQLite 文件、一个数据目录。随时备份、随时迁移。 |

> 演示时「看起来能跑」不是标准。标准是**别人按文档部署后能不能用**——所以配置项真的生效，错误真的能定位，已知限制写在文档里而不是留给你踩。

---

## 🚀 快速开始

### 方式一：Docker（推荐）

需要 Docker 与 Docker Compose。整条命令都在本机 `127.0.0.1` 上，不对外监听。

```bash
git clone https://github.com/Micraow/CoMem.git
cd CoMem
cp config.example.yaml config.yaml     # 填 provider 的 key；留空也能离线跑
docker compose build
docker compose up -d
curl http://127.0.0.1:18080/health     # {"status":"ok",...}
```

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
<summary><strong>一条命令跑完整链路（不需要模型凭据）</strong></summary>

```bash
pnpm test:e2e
```

它起服务、写记忆、检索、归档会话、跑完阶段二、过复核、生成摘要、演示 ACL，跑完自动停。用临时数据根，不碰你的真实数据。
</details>

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
<summary><strong>目录级检索——四个面各管一件事</strong></summary>

| 面 | 输入 | 什么时候用 |
|---|---|---|
| `find` | 一条查询 | 不知道内容在哪个目录 |
| `search` | 查询 + 会话 ID | 需要先做意图分析再检索 |
| `grep` | 正则 + 路径范围 | 知道大概在哪，要找具体那一行 |
| `glob` | 路径通配 | 只想要文件列表 |

排序分 = `bm25 × 层级权重`（L0 1.15 / L1 1.05 / L2 1.00）。权重只用来在词频接近时打破平局：L0 摘要经过一次压缩、信息密度更高，但 L2 词频明显更高时仍然应该赢。
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

---

## 🔌 接入你的 Agent

CoMem 通过 **MCP**（Streamable HTTP）和 **Hook 插件**接入 agent。Hook 在会话开始时检索并注入相关记忆，在会话结束时采集消息。

<details>
<summary><strong>Claude Code</strong></summary>

```bash
# 在项目根目录
claude mcp add --transport http comem http://127.0.0.1:1933/mcp
```

再把 `integrations/` 下的 Hook 配置按 [`integrations/README.md`](integrations/README.md) 装进 Claude Code 的 settings，它就自动采集会话、注入记忆了。
</details>

<details>
<summary><strong>DSH / 其他 MCP 客户端</strong></summary>

任何支持 Streamable HTTP 的 MCP 客户端都可以接 `http://127.0.0.1:1933/mcp`。不带 Hook 也能用——只是要自己调 `remember` / `find`，由你来决定存什么、取什么。
</details>

详细安装、六个 hook、MCP 接入细节、bypass 与去重规则见 [集成指南](integrations/README.md)。

---

## 🗺️ 架构一览

四层，依赖方向单向：

```mermaid
flowchart TB
  API["① 接口层 api/http · api/mcp<br/>HTTP ↔ 服务调用、MCP 工具 ↔ 服务调用"]
  SVC["② 应用层 services/<br/>用例编排、事务边界、后台任务"]
  DOM["③ 领域层 domain/<br/>Uri、Node、Acl、Patch、Ranking；纯函数，无 IO"]
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
| `integrations/` | — | Hook 插件（Claude Code、DSH），独立交付物 |

依赖规则用 ESLint `no-restricted-imports` **强制**：`domain/` 不出现 `node:fs`/`node:sqlite`/`fetch`，`services/` 不出现 `ai`，`services/` 只能用 `import type` 引用 `adapters/`。这不是风格问题——领域层一旦碰 IO，ACL 求值就没法用内存数据穷举测试。
</details>

<details>
<summary><strong>六条核心链路（排障从这里进）</strong></summary>

| 链路 | 做什么 | 代码 |
|---|---|---|
| 会话归档 | 阶段一把消息移进 `history/archive_NNN/` 并建任务，阶段二后台跑四步；`.done` 最后写，是唯一完成信号 | `src/services/session.ts`、`src/services/commit/pipeline.ts` |
| 记忆抽取 | 按类型预取相关文件塞进 prompt，模型输出「URI + 字段级合并操作」，`page_id` 由服务端映射回 URI | `src/services/commit/steps/memory-extract.ts` |
| 补丁合并 | 同 URI 多条 patch 按序应用；SEARCH 必须唯一命中，零处或多处整条失败记 `skippedOperations` | `src/domain/patch.ts`、`src/services/commit/steps/memory-merge.ts` |
| 摘要失效 | 子节点 L0 正文变了才向上传播；小目录（≤32 条）或 `pendingChanges/totalEntries ≥ 0.10` 立刻重算，否则只记脏 | `src/services/summary.ts` |
| 目录级检索 | 四个面统一按权限过滤；先取 `limit × 4` 候选再截断，避免过滤后不足数 | `src/services/search.ts` |
| ACL 过滤 | 六个出口逐个求权；`restricted` 切断继承；owner 恒 `manage` 且不能被 ACL 收回 | `src/services/acl.ts` |
</details>

---

## 🛠️ 开发

```bash
pnpm verify     # typecheck + lint + check:config + 单元/集成测试 + Hook 测试
```

<details>
<summary><strong>单独跑某一关</strong></summary>

| 命令 | 内容 |
|---|---|
| `pnpm typecheck` | `tsc --noEmit`，`strict: true` + `noUncheckedIndexedAccess` |
| `pnpm lint` | ESLint：分层依赖规则在这里生效 |
| `pnpm check:config` | 每个配置项必须有消费方（L1–L3，见 `docs/operations.md`） |
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
| [`integrations/README.md`](integrations/README.md) | Hook 插件：安装、六个 hook、MCP 接入、bypass、去重 |

---

## 📄 许可证

[AGPL-3.0](LICENSE)。自托管自用不受限制；**把它作为服务提供给他人使用时，需要公开修改后的源码**。如果你的场景不能接受这一条，可以在 fork 后更换许可证——代码本身不依赖 AGPL 的任何特性。

---

<div align="center">
<sub>用 TypeScript、Fastify、SQLite 和一点点固执写成。</sub>
</div>
