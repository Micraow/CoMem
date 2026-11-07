# CoMem 架构设计

> 状态：待评审（第 2 版）。评审通过后再写实现代码。
>
> 本文回答四个问题：系统由哪些东西组成、它们怎么分层、数据落到磁盘长什么样、每条核心链路怎么串。

## 1. 这份文档解决什么

CoMem 是面向 AI agent 的上下文记忆数据库。给 agent 一个稳定地址，让它在不同会话、不同机器、不同队友之间共享「它知道的东西」。

本文固定**架构边界**：模块怎么分、依赖朝哪走、数据长什么样、接口签名是什么、六条核心链路怎么串。不固定实现细节（具体算法、提示词措辞、UI 布局），那些在编码时定。

## 2. 范围

**做**：`comem://` 虚拟文件系统、项目作用域、三层摘要（L0/L1/L2）、会话提交与后台记忆抽取、补丁合并、摘要增量失效、目录级检索、ACL 与用户组、16 个 MCP 工具、HTTP API、Web 控制台、Hook 插件。

**不做**：多租户（单 account）、加密、计费、多后端存储、OIDC/LDAP、隐私占位符、MCP 联邦、watch、向量库（v1 只留接口）、训练循环、移动端。

## 3. 已定决策速查

| 领域 | 决策 |
|---|---|
| 语言 | TypeScript，`strict: true` |
| 后端 | Node.js + Fastify（HTTP API + MCP Streamable HTTP） |
| 前端 | Nuxt 3 + shadcn-vue + Tailwind |
| 内容存储 | 真实文件系统 |
| 索引/任务/授权反查 | SQLite + FTS5，检索做成接口 |
| URI | `comem://` |
| 命名空间 | 两个根：`comem://user/{uid}/` 与 `comem://group/{gid}/`；根下可有 `projects/{pid}/` 项目作用域 |
| 检索 v1 | FTS5 + BM25 词法召回；向量后端留接口 |
| 模型提供方 | `config.yaml` 里的 provider 抽象，按 `llm` / `embedding` 等类型区分 |
| 组空间 | 真实目录树；默认成员可写；owner 恒 rwx |
| 组记忆来源 | 显式写 + 个人记忆可分享到组；不做「会话归属组」 |
| 技能 | 包管理（目录 + `SKILL.md` + 附属文件），不做运行时 |
| 规则 | 带 schema 的记忆子类型，`rule_search` 只做条件召回，不做编译管线 |
| MCP | 只做 16 个工具 |
| 控制台 | 六个页面：文件树、检索调试、记忆复核、ACL、用户与组、会话与任务 |

## 4. 分层

### 4.1 四层

```
┌──────────────────────────────────────────────────────────┐
│ ① 接口层   api/http  api/mcp                              │
│    协议转换：HTTP 请求 ↔ 服务调用、MCP 工具 ↔ 服务调用     │
│    不含业务判断，不做权限决策                              │
├──────────────────────────────────────────────────────────┤
│ ② 应用层   services/（含 commit/ 提交管线）                │
│    用例编排：跨聚合协作、事务边界、后台任务                 │
├──────────────────────────────────────────────────────────┤
│ ③ 领域层   domain/                                        │
│    模型与规则：Uri、Node、Acl、MemoryType、Summary、       │
│    Patch、MergeOp、Ranking                                │
│    纯函数，无 IO，可穷举测试                               │
└──────────────────────────────────────────────────────────┘
                    ↑ 依赖注入（构造参数）
┌──────────────────────────────────────────────────────────┐
│ ④ 适配层   adapters/fs  adapters/sqlite  adapters/llm     │
│    具体技术：文件系统、SQLite、模型 SDK                     │
└──────────────────────────────────────────────────────────┘
```

### 4.2 依赖规则

| 层 | 允许 import | 禁止 import |
|---|---|---|
| ① 接口层 | ②③ | ④ |
| ② 应用层 | ③、④ 的**类型**（`import type`） | ①、④ 的值导入、`node:fs`、`node:sqlite`、`fetch`、`ai` |
| ③ 领域层 | 无（`zod` 仅限 `import type`） | 全部 |
| ④ 适配层 | ③ | ①② |

**为什么 `services/` 允许类型导入 `adapters/`。** §4.4 定了「只有一个实现就不留接口」，所以 `FileSystemService` 的构造参数类型就是 `ContentStore` 和 `PathLockManager` 这两个具体类型——不引用它们，服务连签名都写不出来。放开的只是**类型**依赖：`import type` 编译后擦除，运行期实例由 `bootstrap/container.ts` 构造注入，`services/` 里 `new` 不出任何适配器。ESLint 用 `allowTypeImports: true` 精确表达这条边界，值导入仍然报错。

**如果哪天出现第二个实现**（比如内存版内容存储），就把端口接口上移到 `domain/`，那时 §4.4 的判据才成立。

用 ESLint `no-restricted-imports` 挡住越界。这不是风格问题：领域层一旦 import `node:fs`，ACL 求值就没法用内存数据穷举测试，而 ACL 是最不能靠手工点两下验证的部分。

### 4.3 为什么这样分

**为什么不是 npm 多包。** workspace 包需要各自的 `package.json`、`tsconfig` references、build 顺序、`exports` 映射、类型产物路径。七周的项目里这些是纯成本，换来的是「不可能有人误 import」，而一条 lint 规则能做到同样的事。包边界留给真正需要独立发布的东西——目前一个都没有。

**为什么 `web/` 单独。** Nuxt 有自己的构建链和 `tsconfig`，塞不进后端。它是唯一需要独立的构建单元。

**为什么 `domain` 和 `services` 分开。** `domain` 是规则，`services` 是流程。ACL 求值是规则（给定树和身份，算出一个布尔值，纯函数）；提交管线是流程（有 IO、有重试、有后台恢复）。混在一起，ACL 就只能在跑通整条管线之后才能测。

**为什么检索与合并的规则收进 `domain`，不留独立目录。** 它们拆错了：`patch.ts`（SEARCH/REPLACE 块的匹配与应用）是纯字符串函数，`ranking.ts`（打分与截断）是纯数值函数，两者跟存储和协议都无关，属于领域规则。只有「调模型做意图分析」属于应用编排。按「规则进 `domain`、编排进 `services`」拆，首层就不会出现两个语义模糊的目录。

### 4.4 接口清单

接口只在**有两个以上真实实现**时建立：

| 接口 | 定义在 | 实现 1 | 实现 2 |
|---|---|---|---|
| `RetrievalIndex` | `domain/retrieval.ts` | `SqliteFtsIndex` | 向量后端（brief 明确要求预留） |
| `LlmProvider` | `domain/llm.ts` | `AiSdkLlmProvider` | `FakeLlmProvider`（测试） |
| `Logger` | `domain/log.ts` | `ConsoleLogger` / `FileLogger` | `NullLogger`（测试） |

**没有 `ContentStore` 接口。** 内存实现没必要做：测试用 `fs.mkdtemp()` 建临时目录就够，文件系统在测试里一点不慢。既然只有一个实现，按 brief §7.2 的判据「只有一个实现时就地实现，不留接口」，它就是 `adapters/fs/content-store.ts` 里的一个具体类。分层靠「`node:fs` 只允许出现在 `adapters/`」这条 lint 规则保证，不靠接口。

**没有 `Clock`、`IdGenerator`、`EmbeddingProvider`。** 时间直接 `new Date()`；任务租约过期的测试直接改数据库里的 `lease_until` 字段（本来就是这么造僵尸任务的）；ID 用 `crypto.randomUUID()`。v1 不做向量检索，就不需要 embedding 抽象——需要时再加。

**`LlmProvider` 这层必须有，理由不是「以后可能换」。** 是你说的那条：上层不该知道自己用的哪家 SDK。接口只暴露两个方法：

```ts
// domain/llm.ts
export interface LlmProvider {
  complete(prompt: LlmPrompt, options?: LlmOptions): Promise<LlmResult>;
  completeJson<T>(prompt: LlmPrompt, schema: ZodType<T>, options?: LlmOptions): Promise<T>;
}

export interface LlmResult {
  text: string;
  usage: { promptTokens: number; completionTokens: number };
  finishReason: 'stop' | 'length' | 'refusal';
}
```

`finishReason` 是接口的一部分，不是实现细节：抽取管线要靠它区分「模型说完了」和「被截断了」，截断时重试同样的上限只会再截断一次，必须报错让人调大 `maxTokens`。

实现放在 `adapters/llm/ai-sdk-provider.ts`，内部用 Vercel AI SDK：

```ts
// adapters/llm/ai-sdk-provider.ts —— 唯一 import 'ai' 的文件
import { generateText, generateObject } from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createAnthropic } from '@ai-sdk/anthropic';
```

不自己写 HTTP 客户端、流式解析、重试和 token 统计。想加 Anthropic 就是配置里 `type: anthropic`，`services/` 一行不用改。

`services/llm.ts` 是这层之上的**应用封装**：加载 prompt 模板、拼装上下文、处理重试与降级、统计用量。它只依赖 `LlmProvider` 接口，永远不 import `ai`。

## 5. 工程结构

```
CoMem/
├── package.json
├── tsconfig.json
├── eslint.config.js
├── config.example.yaml
├── src/                              # 后端
│   │
│   ├── domain/                       # ③ 领域层：模型与规则，无 IO
│   │   ├── uri.ts                    # Uri 值对象 + 规范化
│   │   ├── node.ts                   # Node 抽象 + Directory + Document
│   │   ├── summary.ts                # 摘要三层 + 新鲜度
│   │   ├── acl.ts                    # Principal / AclEntry / Acl 求值
│   │   ├── memory-type.ts            # 记忆 schema 与字段
│   │   ├── patch.ts                  # SEARCH/REPLACE 块匹配与应用
│   │   ├── merge-op.ts               # patch / replace / sum / immutable
│   │   ├── ranking.ts                # 打分与截断
│   │   ├── retrieval.ts              # RetrievalIndex 接口 + 查询类型
│   │   ├── llm.ts                    # LlmProvider 接口
│   │   ├── log.ts                    # Logger 接口
│   │   ├── session.ts                # 会话与归档
│   │   ├── task.ts                   # 任务状态机
│   │   ├── errors.ts                 # ComemError 与错误码
│   │   └── memory-types/             # 内置记忆类型（TS 常量，非 YAML）
│   │       ├── index.ts
│   │       ├── profile.ts
│   │       ├── preferences.ts
│   │       └── ...
│   │
│   ├── services/                     # ② 应用层：用例编排
│   │   ├── filesystem.ts             # ls / tree / read / write / edit / rm / mv
│   │   ├── search.ts                 # find / search / grep / glob
│   │   ├── summary.ts                # 摘要生成与失效
│   │   ├── session.ts                # 建会话 / 加消息 / 提交
│   │   ├── memory.ts                 # 记忆读写与复核
│   │   ├── acl.ts                    # 授权管理与鉴权入口
│   │   ├── resource.ts               # 资料导入
│   │   ├── skill.ts                  # 技能包安装
│   │   ├── task.ts                   # 任务调度与恢复
│   │   ├── llm.ts                    # 模型调用薄封装（意图分析 / 抽取 / 摘要）
│   │   └── commit/                   # 提交管线（Template Method）
│   │       ├── pipeline.ts
│   │       └── steps/
│   │           ├── archive-summary.ts
│   │           ├── memory-extract.ts
│   │           ├── memory-merge.ts
│   │           └── summary-invalidate.ts
│   │
│   ├── adapters/                     # ④ 适配层：具体技术实现
│   │   ├── fs/
│   │   │   ├── content-store.ts      # 内容读写（具体类，无接口）
│   │   │   ├── metadata-file.ts      # .acl.json / .abstract.md / .overview.md 读写
│   │   │   └── path.ts               # URI ↔ 磁盘路径
│   │   ├── sqlite/
│   │   │   ├── database.ts           # 连接、WAL、迁移入口
│   │   │   ├── migrations/           # 版本化建表脚本
│   │   │   ├── retrieval-index.ts    # SqliteFtsIndex
│   │   │   ├── node-repository.ts
│   │   │   ├── permission-repository.ts
│   │   │   └── task-repository.ts
│   │   ├── llm/
│   │   │   ├── ai-sdk-provider.ts    # 内部用 Vercel AI SDK，外部只见 LlmProvider
│   │   │   └── fake-provider.ts      # 测试替身
│   │   └── log/
│   │       ├── console.ts
│   │       ├── file.ts               # 写 error.log
│   │       └── null.ts               # 测试
│   │
│   ├── api/                          # ① 接口层：协议转换
│   │   ├── http/
│   │   │   ├── routes/
│   │   │   ├── envelope.ts           # 响应封套
│   │   │   └── error-mapper.ts       # 错误码 → HTTP 状态
│   │   └── mcp/
│   │       ├── registry.ts           # 工具注册表
│   │       ├── server.ts             # Streamable HTTP 挂载
│   │       └── tools/                # 16 个工具，一个文件一个
│   │           ├── find.ts
│   │           └── ...
│   │
│   ├── config/                       # 配置加载与校验（含数据根推导）
│   └── bootstrap/                    # 装配与启动
│       ├── container.ts              # 依赖装配
│       └── main.ts
│
├── web/                              # 控制台（Nuxt 3，独立构建）
│   ├── nuxt.config.ts
│   ├── app.vue
│   ├── pages/
│   │   ├── index.vue                 # 概览
│   │   ├── files/[...path].vue       # 文件树
│   │   ├── search.vue                # 检索调试
│   │   ├── review.vue                # 记忆复核
│   │   ├── acl.vue                   # 权限管理
│   │   ├── admin.vue                 # 用户与组
│   │   └── sessions.vue              # 会话与任务
│   ├── components/                   # 按 shadcn-vue 组织
│   │   ├── ui/                       # 基础组件
│   │   └── domain/                   # 业务组件（SummaryPanel、AclDerivation 等）
│   ├── composables/                  # useApi、useTree
│   └── assets/css/tokens.css         # 设计令牌，从静态 demo 落过来
├── integrations/                     # Hook 插件（独立交付物，装进宿主）
│   ├── cli.mjs                       # co-mem install / doctor
│   ├── scripts/  servers/  hosts/  lib/
│
├── tests/
│   ├── unit/                         # 领域层纯函数
│   ├── integration/                  # 适配层：临时目录 + 内存 SQLite
│   └── e2e/                          # 六条链路
├── docs/                             # 设计文档与静态 demo
│   └── design/
│       ├── mockups/                  # 第 1 版
│       └── variants/                 # 第 2 版三套对比
└── local/                            # 本地产物，不进版本控制
```

六个首层目录，和四层一一对应：

| 首层目录 | 对应层 | 一句话 |
|---|---|---|
| `api/` | ① 接口层 | HTTP 和 MCP 两套协议 |
| `services/` | ② 应用层 | 用例编排 |
| `domain/` | ③ 领域层 | 模型与规则 |
| `adapters/` | ④ 适配层 | 文件系统、SQLite、模型、日志 |
| `config/` | — | 装配输入 |
| `bootstrap/` | — | 装配与启动 |

**为什么叫 `api/` 不叫 `interfaces/`。** `interface` 是 TypeScript 关键字，一个叫 `interfaces/` 的目录会让人以为里面装的是类型定义，实际装的是 HTTP 和 MCP 两套协议的路由。改名消除歧义。

## 6. URI 与磁盘布局

### 6.1 URI 格式

```
comem://{scope}/{path}
```

- `scope`：`user` | `group`
- `path`：段用 `/` 分隔，末斜杠表示目录
- 别名 `~`：服务端展开成 `comem://user/{当前 uid}`，只认第一段

### 6.2 规范化

`parseUri` 之后必须走 `canonicalize`：

1. 段做 Unicode NFC 规范化
2. 合并重复斜杠，去掉末尾斜杠（目录判断由结尾是否带 `/` 决定，不靠路径猜）
3. 拒绝 `.` 与 `..` 段
4. 拒绝控制字符（`\u0000`–`\u001f`）与 `\`
5. 单段 UTF-8 字节数 ≤ 255
6. 拒绝保留名：`.abstract.md`、`.overview.md`、`.acl.json`、`.meta.json`、`.done`、`memory_diff.json` 不能作为普通文件名写入

**为什么规范化必须唯一。** 权限按路径记录。同一文件有两个路径，就有两套权限，其中一套一定是错的。大小写、软链接、`..` 全部在规范化层解决，鉴权层只看规范化后的结果。

### 6.3 两个根 + 项目维度

**根**决定归属，**项目**决定作用域。两者正交。

| 根 | 预置 ACL | 子树 |
|---|---|---|
| `comem://user/{uid}/` | `user:{uid} = manage` | `memories/` `resources/` `skills/` `sessions/` `projects/` |
| `comem://group/{gid}/` | `group:{gid} = write` | `memories/` `resources/` `skills/` `projects/` |

项目是根下面的二级命名空间，结构跟根同构（少 `sessions/` 和 `projects/`）：

```
comem://user/alice/projects/comem/
├── memories/
├── resources/
└── skills/

comem://group/eng/projects/comem/
├── memories/
├── resources/
└── skills/
```

`sessions/` 只出现在根下：会话属于个人，一段对话是谁说的不能共享到组，更不能挂到项目上。

### 6.4 为什么需要项目这一层

没有项目层的话，alice 同时做 CoMem 和另一个项目，两边记忆全混在 `user/alice/memories/` 下。检索无法按项目收窄，只会把不相干的记忆一起捞出来——这是最伤使用体验的地方。

**项目的语义**：一个稳定的上下文作用域。同一个仓库的不同 clone、worktree、子目录都归到同一个项目。

**项目 ID 从 git origin 派生**：`git@github.com:micraow/CoMem.git` → `github.com-micraow-comem`（非字母数字换成 `-`）。不在仓库里时用目录名。可以用 `.comem/config.json` 显式指定：

```json
{ "version": 1, "project": { "id": "comem" } }
```

**个人项目 vs 组项目**：

| | 路径 | 谁能看 |
|---|---|---|
| 个人项目 | `comem://user/{uid}/projects/{pid}/` | 只有 owner，除非显式授权给别人/组 |
| 组项目 | `comem://group/{gid}/projects/{pid}/` | 组内全员按组 ACL |

想只分享给组里某几个人？在项目节点上设 `restricted` 切断继承，再挂直接授权。这是 §12.5 的三层共享模型，不需要额外机制。

### 6.5 磁盘布局示例

下面是一次真实使用后的目录。

**数据根的位置。** 这里没有「一个默认值走天下」的答案，因为三种部署形态的惯例不同。规则是**按运行形态推导默认值**，并且永远可以被显式覆盖：

```
1. COMEM_DATA_DIR 或 --data-dir 设了        → 用它
2. 容器里（存在 /.dockerenv 或 pid 1 是容器初始化进程）→ /var/lib/comem
3. 进程以 root 运行                         → /var/lib/comem
4. 其余（桌面单用户）                        → $XDG_DATA_HOME/comem
                                              （默认 ~/.local/share/comem）
```

| 用途 | 桌面单用户 | 系统服务 | 容器 |
|---|---|---|---|
| 数据 | `~/.local/share/comem` | `/var/lib/comem` | `/var/lib/comem`（挂卷） |
| 配置 | `~/.config/comem/config.yaml` | `/etc/comem/config.yaml` | `/etc/comem/config.yaml`（挂只读） |
| 缓存 | `~/.cache/comem` | `/var/cache/comem` | 不需要（走 tmpfs） |

**为什么容器里不能走 XDG。** 你说的没错：XDG 是**桌面会话**规范，它假设有 `$HOME`、有图形会话、每个用户一套数据。容器里 `$HOME` 可能是 `/root` 也可能不存在，数据落在那儿既不可预测也没法挂卷。官方镜像的通行做法是 `/var/lib/<app>`——PostgreSQL 用 `/var/lib/postgresql/data`，MySQL 用 `/var/lib/mysql`，Jenkins 用 `/var/jenkins_home`。`/var/lib` 在 FHS 里的定义就是「应用的可变状态数据」，正是这个用途。`/opt` 是**安装**前缀，写数据是错的。

镜像里显式钉死，不依赖推导：

```dockerfile
ENV COMEM_DATA_DIR=/var/lib/comem \
    COMEM_CONFIG_FILE=/etc/comem/config.yaml
VOLUME ["/var/lib/comem"]
```

```bash
docker run -d \
  -v comem-data:/var/lib/comem \
  -v ./config.yaml:/etc/comem/config.yaml:ro \
  -p 1933:1933 \
  comem
```

日志默认写 stdout（12-factor 惯例），落盘是可选的：配置 `logging.file` 时额外写一份到 `$COMEM_DATA_DIR/logs/error.log`。容器里不给 `logging.file` 就只走 stdout，运维从 `docker logs` 看。

下面按桌面单用户的默认值展开。

```
~/.local/share/comem/
├── _meta/
│   └── comem.sqlite                     # 索引 + 任务 + 授权反查
├── user/
│   └── alice/
│       ├── .acl.json                    # alice 空间根的权限
│       ├── memories/                    # 跨项目的个人记忆（偏好、身份、原则）
│       │   ├── .acl.json
│       │   ├── .abstract.md             # L0
│       │   ├── .overview.md             # L1
│       │   ├── profile.md               # L2
│       │   ├── identity.md
│       │   ├── soul.md
│       │   └── preferences/
│       │       ├── .abstract.md
│       │       ├── .overview.md
│       │       └── code-style.md
│       ├── resources/                   # 跨项目资料
│       ├── skills/
│       │   └── code-review/
│       │       ├── SKILL.md
│       │       └── scripts/
│       │           └── check.sh
│       ├── projects/                    # 项目作用域
│       │   └── comem/
│       │       ├── .acl.json
│       │       ├── memories/
│       │       │   ├── .abstract.md
│       │       │   ├── .overview.md
│       │       │   ├── entities/
│       │       │   │   └── retrieval-pipeline.md
│       │       │   ├── events/
│       │       │   │   └── 2026-11-05-architecture-decision.md
│       │       │   ├── experiences/
│       │       │   │   └── monorepo-migration.md   # 待复核
│       │       │   └── rules/
│       │       │       └── license-review/
│       │       │           ├── .abstract.md
│       │       │           └── must-locate-license.md
│       │       ├── resources/
│       │       │   └── docs/
│       │       │       ├── .abstract.md
│       │       │       ├── .overview.md
│       │       │       ├── .attachments/     # 原始附件，download 用
│       │       │       │   └── spec.pdf
│       │       │       ├── architecture.md   # 规范化文本，带 frontmatter 摘要
│       │       │       └── spec.md           # 从 spec.pdf 规范化而来
│       │       └── skills/
│       └── sessions/
│           └── sess_7f3a91c2/
│               ├── messages.jsonl        # 当前消息
│               ├── .meta.json
│               ├── .abstract.md
│               ├── .overview.md
│               └── history/
│                   ├── archive_001/
│                   │   ├── messages.jsonl
│                   │   ├── .meta.json
│                   │   ├── .abstract.md
│                   │   ├── .overview.md
│                   │   ├── memory_diff.json
│                   │   └── .done
│                   └── archive_002/
│                       └── ...
└── group/
    └── eng/
        ├── .acl.json
        ├── memories/
        │   ├── .abstract.md
        │   └── conventions.md
        ├── resources/
        └── skills/
```

### 6.6 文件内容示例

**`user/alice/memories/preferences/code-style.md`** —— 一条记忆

```markdown
---
memory_type: preferences
topic: code-style
uri: comem://user/alice/memories/preferences/code-style
status: active
created_at: 2026-10-28T09:12:00Z
updated_at: 2026-11-05T16:40:00Z
---

## content

用户偏好 TypeScript 严格模式、2 空格缩进、函数式写法优先于类继承。不喜欢为单一实现预留接口。
```

**`user/alice/memories/.abstract.md`** —— 这个目录的 L0

```markdown
---
uri: comem://user/alice/memories
generated_by: summary.service
generated_at: 2026-11-05T16:41:02Z
freshness:
  total_entries: 6
  pending_changes: 0
---

alice 的长期记忆：代码风格偏好、CoMem 项目背景、2026-11-05 的架构决策，以及一条待复核的 monorepo 迁移经验。
```

**`user/alice/memories/.overview.md`** —— 这个目录的 L1

```markdown
---
uri: comem://user/alice/memories
generated_by: summary.service
generated_at: 2026-11-05T16:41:02Z
freshness:
  total_entries: 6
  pending_changes: 0
---

# alice 的长期记忆

alice 的代码风格偏好、正在做的 CoMem 项目，以及最近一次架构决策的记录。

## 快速导航

- `profile.md` —— 基本信息与角色
- `preferences/` —— 按话题组织的偏好
- `entities/` —— 项目、组织等实体
- `events/` —— 决策与里程碑
- `experiences/` —— 从执行结果蒸馏的经验
- `rules/` —— 必须遵守的约束

## 详细说明

### profile.md

alice，后端工程师，主要写 TypeScript。

### preferences/

偏好按话题拆分，目前只有 `code-style`：严格模式、2 空格缩进、函数式优先。

### entities/comem-project.md

CoMem 是一个面向 AI agent 的上下文记忆数据库，2026 年 9 月启动。

### events/2026-11-05-architecture-decision.md

决定采用单包 + 内部四层分层，不做 npm workspace 多包。

### experiences/monorepo-migration.md

待复核。从 monorepo 迁移到单包的教训。

### rules/license-review/

开源许可证审查场景下的约束，要求仓库声明开源时必须提供可定位的许可证文本。
```

**`user/alice/memories/.acl.json`** —— 目录权限

```json
{
  "mode": "inherit",
  "entries": [
    { "principal": "user:alice", "level": "manage", "effect": "allow" },
    { "principal": "group:eng", "level": "read", "effect": "allow" }
  ]
}
```

**`group/eng/.acl.json`** —— 组空间根

```json
{
  "mode": "inherit",
  "entries": [
    { "principal": "group:eng", "level": "write", "effect": "allow" }
  ]
}
```

**`user/alice/sessions/sess_7f3a91c2/.meta.json`**

```json
{
  "sessionId": "sess_7f3a91c2",
  "userId": "alice",
  "createdAt": "2026-11-05T14:02:11Z",
  "commitCount": 2,
  "lastCommitAt": "2026-11-05T16:40:12Z",
  "pendingTokens": 0
}
```

**`user/alice/sessions/sess_7f3a91c2/history/archive_001/.meta.json`**

```json
{
  "archiveId": "archive_001",
  "phase1": {
    "status": "ready",
    "messagesSha256": "9f2c...",
    "archivedMessageIds": ["msg_01", "msg_02", "msg_03"],
    "retainedMessageIds": []
  },
  "stepsDone": ["archive_summary", "memory_extract", "memory_merge", "summary_invalidate"],
  "taskId": "task_b41e"
}
```

**`user/alice/sessions/sess_7f3a91c2/history/archive_001/memory_diff.json`**

```json
{
  "archiveUri": "comem://user/alice/sessions/sess_7f3a91c2/history/archive_001",
  "extractedAt": "2026-11-05T16:40:58Z",
  "operations": {
    "adds": [
      {
        "uri": "comem://user/alice/memories/preferences/code-style",
        "memoryType": "preferences",
        "after": "## content\n\n用户偏好 TypeScript 严格模式…"
      }
    ],
    "updates": [],
    "deletes": []
  },
  "skippedOperations": [
    {
      "memoryType": "events",
      "reasonCode": "invalid_ranges",
      "reason": "消息区间无法解析，跳过"
    }
  ],
  "summary": { "totalAdds": 1, "totalUpdates": 0, "totalDeletes": 0, "totalSkipped": 1 }
}
```

### 6.7 元数据文件

目录里除了内容文件，还有三类**元数据文件**——它们描述这个目录本身，不是目录的内容：

| 文件 | 描述什么 | 谁写 |
|---|---|---|
| `.acl.json` | 这个目录的权限 | `AclService` |
| `.abstract.md` | 这个目录的一句话摘要（L0） | `SummaryService` |
| `.overview.md` | 这个目录的完整概览（L1） | `SummaryService` |

**文件级摘要不另存档，写在文件自己的 frontmatter 里。**

```markdown
---
summary: URI 规范与路径规范化规则
summary_digest: 9f2c8a1e
summary_state: fresh            # fresh | stale
---

# URI 规范
...
```

这样摘要跟着文件走：移动、复制、备份都不用额外维护。重建索引时扫一遍文件头就够，一次 LLM 都不调。文件被 `write` / `edit` 改动后，`summary_digest` 对不上，`summary_state` 置 `stale`，由后台任务重算——这是唯一会触发重算的路径。

**边界：只有 Markdown 支持。** 代码、JSON、纯文本没有统一的 frontmatter 语法（`#` 在 Python 是注释，在 C 里是预处理指令），强行加会破坏原文。这类文件的摘要存在索引的 `node.abstract` 字段里，重建时重算。资源目录里文档占绝大多数，代码文件重算是可接受的成本，不为了统一而污染原文。

统一格式：YAML frontmatter + Markdown 正文。frontmatter 字段固定，未知字段丢弃。普通 `ls` 不显示这三个文件；只有显式 `read` 才返回原始内容，`abstract` / `overview` 接口只返回正文。

## 7. 为什么元数据放文件、索引放 SQLite

判据是**这东西属于哪一类**：

| 类别 | 例子 | 放哪 | 理由 |
|---|---|---|---|
| 内容 | 正文、摘要、权限 | 文件 | 用户能看见、能编辑、能备份走 |
| 索引 | 倒排表、授权反查 | SQLite | 从内容算出来的，可重建 |
| 运行时状态 | 任务、租约、队列 | SQLite | 高并发写，需要原子性 |

三条具体理由：

1. **删库不丢数据。** `rm _meta/comem.sqlite` 之后跑一次重建命令，Markdown 的摘要从 frontmatter 读回来，重建过程零 LLM 调用。反过来，如果摘要在库里，删库就丢了摘要，而摘要重算要花模型的钱；如果权限在库里，删库等于所有人失去访问权。

   **例外要说清楚**：非 Markdown 文件的摘要（代码、JSON、纯文本）存在索引的 `node.abstract` 里，重建时重算，会花钱。资源目录里这类文件是少数，成本可接受。
2. **目录删了不留孤儿。** `rm -r comem://user/alice/resources/foo` 之后，磁盘上那个目录连同它的 `.abstract.md` 一起没了。如果摘要在库里，就得再维护一套「删目录时级联删索引」的逻辑，而这套逻辑漏一处就产生孤儿记录。
3. **人可以直接改。** 断网、模型挂了、摘要写错了，用编辑器改 `.overview.md` 就能修，改完重建索引即可。

代价与对策：

| 代价 | 对策 |
|---|---|
| 每次鉴权要 open `.acl.json` | 每请求一份 `Map<uri, Acl>` 缓存，请求结束丢弃 |
| 没有跨文件事务 | 先写内容再更新索引；索引失败时标记为待重建，启动对账 |
| 写入需要先 mkdir | `write` 内部自动建父目录，调用方不用关心 |

## 8. 索引与检索

### 8.1 SQLite 表

```sql
-- 节点索引：检索与 stat 的读模型
CREATE TABLE node (
  uri            TEXT PRIMARY KEY,
  parent_uri     TEXT NOT NULL,
  scope          TEXT NOT NULL,      -- user | group
  kind           TEXT NOT NULL,      -- directory | document
  context_type   TEXT NOT NULL,      -- memory | resource | skill | session
  memory_type    TEXT,               -- profile | preferences | entities | ...
  level          TEXT NOT NULL,      -- 'L0' | 'L1' | 'L2'，存字面量不存 0/1/2
  abstract       TEXT,
  body_digest    TEXT NOT NULL,
  size           INTEGER NOT NULL,
  updated_at     TEXT NOT NULL,
  status         TEXT NOT NULL       -- active | pending | archived
);
CREATE INDEX node_parent ON node(parent_uri);
CREATE INDEX node_scope  ON node(scope, context_type);

-- 全文检索
-- 注意 content / abstract 存的是「切分后」的文本，不是原文（见下面的中文切分）
CREATE VIRTUAL TABLE node_fts USING fts5(
  uri UNINDEXED,
  abstract,
  content,
  tokenize = 'unicode61 remove_diacritics 2'
);

-- 物化的有效权限：写入 ACL 时算好，检索时直接查
CREATE TABLE node_permission (
  node_uri   TEXT NOT NULL,
  principal  TEXT NOT NULL,          -- user:alice | group:eng | user:*
  level      INTEGER NOT NULL,       -- 1 read | 3 write | 7 manage
  PRIMARY KEY (node_uri, principal)
);
CREATE INDEX node_permission_principal ON node_permission(principal, level);

-- 授权反查：谁被授权过什么
CREATE TABLE acl_entry (
  uri        TEXT NOT NULL,
  principal  TEXT NOT NULL,
  level      INTEGER NOT NULL,
  effect     TEXT NOT NULL,          -- allow | deny
  PRIMARY KEY (uri, principal)
);
CREATE INDEX acl_principal ON acl_entry(principal);

-- 运行时任务
CREATE TABLE task (
  id           TEXT PRIMARY KEY,
  type         TEXT NOT NULL,
  status       TEXT NOT NULL,        -- pending | running | done | failed
  payload      TEXT NOT NULL,
  steps_done   TEXT NOT NULL,        -- JSON 数组
  attempts     INTEGER NOT NULL DEFAULT 0,
  lease_until  TEXT,
  error        TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX task_claim ON task(status, lease_until);
```

**中文必须单字切分，否则检索整段失效。** 实测（SQLite 3.54.1，Node 26 的 `node:sqlite`）：

| 方案 | 查「记忆」（文档含「上下文记忆数据库的设计」） | 查「偏好」（文档含「代码风格上的偏好」） |
|---|---|---|
| 只用 `unicode61` | ❌ 无结果 | ❌ 无结果 |
| 只用 `trigram` | ❌ 无结果（不足 3 字） | ❌ 无结果 |
| CJK 单字切分 + 短语查询 | ✅ 命中 | ✅ 命中 |

`unicode61` 按 Unicode 类别切词，CJK 连续字是「字母类」，整段变成一个巨型 token——只有把整段原样当查询才命中，用户不可能这么搜。`trigram` 天然支持子串，但要求查询至少 3 个字符，而**中文双字词是最常见的形式**（「用户」「偏好」「记忆」「严格」全部落空）。

做法：**CJK 单字切分（unigram），查询侧同样切分后按短语匹配**。

```ts
// 索引侧：每个 CJK 字符两侧补空格，再合并空白
function segmentForIndex(text: string): string {
  return text
    .replace(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g, (char) => ` ${char} `)
    .replace(/\s+/g, ' ')
    .trim();
}

// 查询侧：切分后包成 FTS5 短语，双引号要转义
function toMatchExpression(query: string): string {
  return `"${segmentForIndex(query).replace(/"/g, '""')}"`;
}
```

单字会拉低 BM25 的区分度（虚词「的」「在」到处都是），但**短语匹配要求字符相邻**，精度是够的。真正的排序靠 §8.5 的层级加权和后续的 rerank。

**索引里存的是切分后的文本，不是原文。** `node_fts.content` 只服务于匹配，`snippet()` / `highlight()` 不用（返回的是 `abstract` 与 URI，摘要来自 `node` 表）。原文在磁盘上，`read` / `grep` 走文件系统，不走这张表。

**查询里的 FTS5 元字符必须转义。** `"` `*` `(` `)` `-` `:` `^` 和 `AND` / `OR` / `NOT` 都会改变查询语义，用户输入里完全可能出现。整串包成短语 + 内部双引号双写，是唯一安全的做法。

### 8.2 权限为什么要物化进索引

**上一版这里我写错了**，原方案是「先取候选，再逐条 open 祖先 `.acl.json` 求权」。这有两个硬伤：

- 一条候选要 open 5 层目录的 `.acl.json`。`tree` 一个 1000 节点的目录就是 5000 次文件读。
- 如果取回的前 40 条候选全都没权限，最终返回不足 10 条，用户看到「没有结果」，而实际上有。

正确做法是**把「这个节点对谁能做什么」在写 ACL 时算好，存进 `node_permission` 表**。检索时它就是一个普通的 `EXISTS` 子查询：

```sql
SELECT n.uri, n.level, n.abstract, n.context_type
FROM node_fts f
JOIN node n ON n.uri = f.uri
WHERE f MATCH ?
  AND (n.uri = ? OR n.uri GLOB ? || '/*')       -- 路径 scope，按段边界
  AND EXISTS (
    SELECT 1 FROM node_permission p
    WHERE p.node_uri = n.uri
      AND p.principal IN ('user:alice', 'user:*', 'group:eng')
      AND p.level >= 1                          -- read
  )
ORDER BY rank
LIMIT ?;
```

**路径范围必须用 `GLOB`，不能用 `LIKE`。** 两个原因，第二个是安全问题：

1. `LIKE` 对 ASCII 大小写不敏感。URI 只做 Unicode NFC 规范化，不折叠大小写，所以 `comem://user/Alice` 和 `comem://user/alice` 是**两个不同的用户**。用 `LIKE` 的话，`alice` 的范围查询会把 `Alice` 的子树一起捞出来——这是跨用户越权。
2. `LIKE` 的 `_` 和 `%` 是通配符，而 URI 段允许这两个字符（§6.2 只拒斜杠、控制字符、`.`、`..`、保留名）。一个叫 `a_b` 的目录会让范围查询匹配到 `axb`。`GLOB` 的 `*` `?` `[` `]` 同样要转义，但转义规则集中在 `node-repository.ts` 一处。

**`level` 存 `'L0'|'L1'|'L2'` 而不是整数。** 领域类型、检索返回值、索引记录三处都是字面量联合，存整数要在每个读写点做一次有损映射。SQLite 的 TEXT 存储开销相对索引体积可以忽略，换来的是「磁盘上看一眼就知道是什么」。

**代价转移动了。** 改一个节点的 ACL，要重算它所有后代的 `node_permission`。ACL 改动是低频操作（一个项目整个周期可能就改几次），读是高频操作。物化方向必须是「写时算，读时查」。

**重算用事务包住**：`BEGIN; DELETE FROM node_permission WHERE node_uri LIKE ? || '%'; INSERT ...; UPDATE acl_entry ...; COMMIT;`。中途失败整批回滚，`node_permission` 和 `.acl.json` 不会不一致。

### 8.3 检索接口

接口定义在 `domain/retrieval.ts`（它是领域概念：「给一个查询，返回命中」），实现放在 `adapters/sqlite/retrieval-index.ts`：

```ts
// domain/retrieval.ts
export interface RetrievalIndex {
  upsert(records: IndexRecord[]): Promise<void>;
  deleteByUri(uri: string, options?: { recursive?: boolean }): Promise<void>;
  search(query: SearchQuery): Promise<SearchHit[]>;
  grep(query: GrepQuery): Promise<GrepHit[]>;
  glob(query: GlobQuery): Promise<string[]>;
  stat(uri: string): Promise<NodeStat | null>;
}
```

`SearchQuery` 带 `scopes`（路径前缀）、`principals`（调用方的权限主体）、`contextTypes`、`levels`、`limit`、`scoreThreshold`。`principals` 由 `Authorizer` 统一算好传进来，FTS5 实现和未来的向量实现共用同一套过滤条件。

**为什么这个接口要留。** 这是 brief 里唯一一条明确要求预留的扩展点（「查找要做成接口，后续可能要做成向量库」）。其余抽象都按「只有一个实现就地写」处理。

### 8.4 四个检索面

| 面 | 输入 | 返回 | 用 session |
|---|---|---|---|
| `find` | 单条 query | 命中列表，带 `uri` / `level` / `abstract` / `score` | 否 |
| `search` | query + `sessionId` | 同上，先做意图分析得到 0–5 条 TypedQuery | 是 |
| `grep` | 正则 + 路径范围 | 行级命中，带行号与前后文 | 否 |
| `glob` | 路径通配 | 文件 URI 列表 | 否 |

### 8.5 层级加权

纯 BM25 的分数只反映词频，不反映「这段文字是否真的回答了问题」。但在同一套词法索引上，**层级本身带信息**：L0 摘要是别人总结过的一句话，信噪比天生比 L2 原文高。

排序分 = `bm25 × levelWeight[level]`：

| 层级 | 权重 | 理由 |
|---|---|---|
| L0 | 1.15 | 摘要，一句话说清了才被写下来 |
| L1 | 1.05 | 概览，介于两者之间 |
| L2 | 1.00 | 原文，未加工 |

**为什么权重这么小**：加权是为了在 BM25 分数接近时打破平局，不是为了压过词频。1.15 意味着 L0 只要词频不差太多就能赢 L2；如果 L2 的词频明显更高，它仍然应该赢。

权重集中配置（`retrieval.levelWeights`），来源是「摘要经过一次人工或模型的压缩，信息密度更高」这个经验假设。**没有实测数据支撑具体数值**，调参时应该用一批真实查询做对比。

### 8.6 上下文组装（Context Assembly）

`search` 有一个 `mode="context"` 变体：返回的不是命中列表，而是一段**可直接塞进模型上下文**的文本。这是「检索结果 → 模型输入」的独立一层。

四步：

**1. token 预算。** 默认 1600 tokens（`assembly.maxTokens`），单条也有上限（`maxTokens / 条目数 × 2`，给单条留 2 倍余量）。

**2. 分层投放。** 每条候选先按类别放到起始层：

| 类别 | 起始层 | 可升到 |
|---|---|---|
| `events` | L1 概览 | L2 原文 |
| 其余 | L0 摘要 | L1 概览 |

放不下就**降级**：`L2 → L1 → L0 → 只有 URI`。降到底还放不下就丢弃，计入 `dropped`。然后按分数做三轮**升级**：先升到 L1、再升到 L2、最后是无单条上限的 L2（只受总预算约束）。

**3. 去重。** 渲染后正文完全相同的条目只留分数最高的（同一个文件可能同时命中 L0 和 L2 两条记录）。

**4. 配额。** 预设两套（`chat` / `coding`），按类别分配条目数：

| 预设 | memories | resources | skills |
|---|---|---|---|
| `chat` | 5 | 3 | 2 |
| `coding` | 3 | 5 | 2 |

**渲染格式**：

```
<memory uri="comem://user/alice/projects/comem/memories/preferences/code-style" type="memory" score="0.87" detail="abstract">
用户在代码风格上的偏好：TypeScript 严格模式、2 空格缩进、偏好函数式写法。
</memory>
```

正文里如果出现 `</memory>` 这类会伪造标签的串，做转义——否则记忆内容能劫持提示词结构。

**为什么这一层是分水岭**：没有它，「检索」只解决「找到什么」，没解决「给多少、给多细、重复几次」。三个问题里任何一个没解决，模型看到的上下文都是次优的。而且它**不依赖向量库**——纯 FTS5 也能做预算、分层、去重、配额。

### 8.7 召回账本（Recall Ledger）

每个会话维护一份 `.recall_log.json`，记录「第 N 轮给模型投喂了哪些 URI、投喂到什么粒度」。下一轮召回时，`dedup_turns` 轮内投过的**不重复投**。

三条规则：

1. **只记账真的给了正文的条目。** 只给了 URI 的不记——模型没看到内容，下一轮还得给。
2. **轮次时钟取消息总数。** `turn = max(totalMessageCount, liveMessages.length)`，任何一方前进都推进时钟。
3. **按 `turn - 4 × dedup_turns` 裁剪，上限 500 条。** 不裁剪会无限增长。

**为什么需要**：用户连续问三个相关问题，同一段记忆会被完整注入三次。上下文浪费 2/3，模型还可能因为重复而分心。

**与去重的区别**：8.6 的去重是**同一次请求内**的重复（同一 URI 命中多条记录）；账本是**跨请求**的重复（上一轮给过，这一轮不再给）。两者都要做。

### 8.8 输入过滤

用户的 prompt 里混着大量不该当查询用的噪音：

| 噪音 | 例子 | 不处理的后果 |
|---|---|---|
| 斜杠命令 | `/help`、`/clear`、`/model opus` | 拿 `/help` 去检索，召回一堆讲「帮助」的记忆 |
| 文件提及 | `@src/foo.ts` | 拿路径去匹配，命中所有含 `src` 的文档 |
| 代码块 | 粘进来的 200 行报错 | 查询变成 200 行，BM25 分数被稀释，召回全是噪音 |
| 无实质内容 | `继续`、`ok`、`yes` | 每轮都触发一次无意义检索，还往账本里写脏数据 |
| URL | `https://example.com/x` | 命中所有含 `example` 的文档 |

**做法**：一组 sed 风格的正则规则，按顺序作用在 prompt 上，产物才是查询。

```yaml
retrieval:
  queryFilters:
    - 's|^/\w+.*$||'                 # 去掉斜杠命令
    - 's|@[\w/\.\-]+||g'            # 去掉文件提及
    - 's|```[\s\S]*?```||g'         # 去掉代码块
    - 's|https?://\S+||g'             # 去掉 URL
    - 's|^(ok\|yes\|继续\|好\|嗯)$||i'  # 无实质内容
```

**分隔符和正则里的元字符会打架，必须转义。** `s|pattern|replacement|flags` 的分隔符可以是任意非字母数字字符，选 `|` 是为了可读，代价是 pattern 里的 `|`（选择分支）必须写成 `\|`。上面最后一条就是例子：不转义的话解析器在第二个 `|` 处就断开，把 `^(ok` 当成正则，直接报 `INVALID_ARGUMENT`。写一个真正包含竖线的字符集也要转义（`[|]` 与 `\|` 等价）。

**过滤后为空就不检索。** 不要拿空串调 `find`——那会返回随机结果，比不返回更糟。

**为什么用 sed 语法而不是配置对象**：用户（和 agent）脑子里想的就是「把这段替换成那段」。正则替换的表达式最直接，写成 YAML 也最省事。

### 8.9 Bypass 开关

三类场景需要临时关掉记忆：

- **演示**：想对比「有记忆 / 没记忆」的差异
- **调试**：某轮召回不对，想隔离变量
- **隐私**：这段对话不该入库

```bash
# 整个会话关掉
COMEM_BYPASS_SESSION=1

# 按路径 glob 关掉
COMEM_BYPASS_SESSION_PATTERNS="*/scratch/*,*/tmp/*"
```

**生效位置在 Hook 层**：注入和采集都跳过。服务端不知道有这回事——它只是没收到请求，不需要额外逻辑。

## 9. 摘要与失效

### 9.1 三层

| 层 | 位置 | 预算 | 用途 |
|---|---|---|---|
| L0 | `.abstract.md` 正文 | 256 字符 | 相关性判断、检索召回 |
| L1 | `.overview.md` 正文 | 4000 字符 | 替代大部分 L2 阅读 |
| L2 | 原文件 | 无限制 | 按需加载 |

L0 从 L1 正文提取（H1 标题之后、第一个 `##` 之前的段落），两层不会互相矛盾。

**L0/L1 是目录级的**，不是文件级。文件摘要存在索引记录的 `abstract` 字段里，作为生成父目录 L1 的输入。

### 9.2 生成

自底向上。一个目录的 L1 输入是「直接子文件的摘要」+「直接子目录的 L0 正文」：

```
叶子目录 → 父目录 → ... → scope 根
```

`SummaryGenerator` 是 Strategy，两个实现：

- `LlmSummarizer`：调 `LlmProvider`，按固定结构产出（标题、简述、快速导航、逐条详述）
- `RuleSummarizer`：断网降级。取子节点名字 + 各自摘要首句拼接，不调模型

两者实现同一个 `SummaryGenerator` 接口（`domain/summary.ts`），`services/summary.ts` 按配置选择。降级不是静默的：结果带 `degraded: true`，控制台显示，`health` 工具报告。

### 9.3 失效

**只增量失效，不全量重算。**

```
写节点 N（或删除、移动）
  → 算 N 的 L0 正文 digest
  → 与索引里记录的一致？一致就到此为止（正文没变不传播）
  → 变化了：
      P = parent(N)
      P.freshness.pendingChanges += 1
      没有 freshness 基线            → 立刻重算
      P.totalEntries <= 32           → 立刻重算
      pendingChanges / totalEntries >= 0.10 → 立刻重算
      否则                           → 只记脏，等下次
  → 重算 P 完成后，若 P 的 L0 正文也变了，对 parent(P) 重复
  → 到达 scope 根停止
```

**为什么是「事件计数」而不是「脏标记」。** 同一个文件反复改，脏标记只算一次，永远到不了阈值。计数才反映「这个目录的摘要落后了多少次改动」。

**为什么消费时要减而不是清零。** 重算过程中可能又有新改动进来。写回时 `pending = max(pending - 消费时的快照, 0)`，生成期间到达的改动保留。

## 10. 会话提交管线

### 10.1 两阶段

```
commit(sessionId, options)
├─ 阶段一（请求内，同步）
│   1. 分配归档序号 archive_NNN
│   2. 写 archive_NNN/messages.jsonl
│   3. 写 archive_NNN/.meta.json（phase1.status = preparing）
│   4. 重写 session/messages.jsonl（保留部分）
│   5. 更新 .meta.json（phase1.status = ready + sha256）
│   6. 创建 task，返回 { taskId, archiveUri }
│
└─ 阶段二（后台）
    1. 生成归档摘要（L0/L1）
    2. 从归档消息抽取记忆操作
    3. 应用补丁合并
    4. 标记祖先摘要失效并重算
    5. 写 memory_diff.json
    6. 写 .done（最后写）
```

**消息的 part 类型。** 一条消息由若干 part 组成，抽取时都参与：

| Part | 内容 |
|---|---|
| `TextPart` | 纯文本 |
| `ImagePart` | 图片 URL（需要视觉模型描述） |
| `ContextPart` | 上下文引用（URI + 摘要），表示「这条消息引用了哪段记忆」 |
| `ToolPart` | 工具调用的 `{toolCallId, name, input, output}` |

`ToolPart` 不能省：很多经验藏在工具输出里（「这个命令报错了，因为 X」）。但**用户记忆抽取时默认隐藏工具输出**——它会泄漏环境变量、数据库内容、文件系统结构。只有 agent 作用域才带上，且截断到 500 字符。

**为什么 `.done` 最后写。** `.done` 是唯一的完成信号。先写它就等于宣称成功。崩溃后重放时，看到 `.done` 就跳过整个归档。

**每步完成都写 `.meta.json` 的 `stepsDone`。** 这样重放能跳过已完成的步骤，不会重复应用记忆操作。记忆操作不幂等——重复应用会造出重复记忆。

### 10.2 归档边界

默认归档全部消息。可选 `keepRecentCount` 保留最近 N 条。归档序号单调递增，`archive_001`、`archive_002`……，从不复用。

### 10.2.1 自动提交策略

**记忆延迟最大的来源不是抽取慢，是根本没人触发提交。** agent 不会主动调 `commit`，用户聊两小时，记忆一条没进库。

五个阈值，前三个是客户端判断，后两个是服务端扫描：

| 参数 | 默认 | 触发条件 | 谁判断 |
|---|---|---|---|
| `pendingTokenThreshold` | 150000 | 未提交 token **严格大于**该值 | 客户端（`add_message` 后） |
| `messageCountThreshold` | 100 | 未提交消息数 **严格大于**该值 | 客户端（`add_message` 后） |
| `minCommitIntervalSeconds` | 0 | 两次自动提交的最小间隔 | 客户端 |
| `idleTimeoutSeconds` | 0（关） | 空闲这么久且有未提交内容 | 服务端扫描器 |
| `keepRecentCount` | 0 | 自动提交时保留最近 N 条 | 客户端 |

**为什么阈值是「严格大于」**：默认 100 条，用户发第 100 条时不该提交，第 101 条才提交。这样「阈值 100」和「每 100 条提交一次」是同一个意思。

**为什么 `idleTimeout` 默认关**：它需要一个服务端定时扫描器，是额外的常驻开销。长会话场景才开，开了要同时开 `memory.sessionAutoCommit.enabled`——单独设 `idleTimeoutSeconds` 不启动扫描器。

**空闲提交忽略 `keepRecentCount`**：空闲意味着对话结束了，没有「最近几条要留着」的概念，全部归档。

**提交是幂等的**：自动提交和手动提交走同一条管线，重复触发不会产生重复归档（Phase 1 的路径锁 + 归档序号单调保证）。

### 10.3 管线骨架

```ts
abstract class CommitStep {
  abstract readonly name: string;
  abstract run(ctx: StepContext): Promise<void>;
}

class CommitPipeline {
  constructor(private readonly steps: CommitStep[]) {}

  async run(ctx: StepContext): Promise<void> {
    for (const step of this.steps) {
      if (ctx.meta.stepsDone.includes(step.name)) continue;
      await this.withRetry(step, ctx);
      await ctx.markStepDone(step.name);
    }
  }
}
```

Template Method 固定「跳过已完成 → 执行 → 记录」的骨架，变化点是四个步骤的实现。新增步骤不改骨架。

### 10.4 任务恢复

- 认领：`UPDATE task SET status='running', lease_until=now+60s WHERE id=? AND (status='pending' OR (status='running' AND lease_until < now))`
- 心跳：每 20 秒续租
- 启动扫描：`status='running' AND lease_until < now` → 重置为 `pending`，`attempts += 1`
- 重试上限 3 次。超限置 `failed`，错误写进 `error` 字段和 `error.log`

### 10.5 工作记忆（Working Memory）

每次提交除了抽取长期记忆，还维护一份**工作记忆**——7 段结构化文档，写在归档目录的 `.overview.md`：

```markdown
# 会话工作记忆

**一行概述**：[主题]：[意图] | [结果] | [状态]

## 分析
关键步骤

## 主要请求与意图
用户的核心目标

## 关键概念
技术概念与决策

## 待办
未完成的事

## 背景约束
时间、环境、依赖

## 相关上下文
涉及的其他会话或资源
```

**作用**：让下一次提交的抽取知道「上次聊到哪了」。没有它，每次提交都是孤立的一次抽取，无法判断「这个偏好是延续还是改变」。

**怎么用**：下一次提交时，上一个归档的 `.overview.md` 作为 `latestArchiveOverview` 喂进抽取 prompt。第一次提交没有前序，这一段为空。

**默认关闭**（`memory.workingMemory.enabled = false`）。开它会多一次 LLM 调用，只在长会话场景有价值。

### 10.6 并发与一致性

四类写操作会互相踩：`rm`、`mv`、`write`、`session.commit`。没有互斥会出四种错误，且都不会报错。

**路径锁**

`domain/lock.ts` 定义两种模式：

| 模式 | 锁什么 | 用在哪 |
|---|---|---|
| `EXACT` | 单路径 | `write` / `edit` 单文件 |
| `TREE` | 路径及其子树 | `rm -r` / `mv` / 目录级 `write` |

`adapters/fs/lock.ts` 用锁文件实现：`{path}.comem-lock`，内容是 `{owner, expiresAt}`，默认 30 秒租约、10 秒续租。获取时先检查现有锁——过期就抢，没过期就等待。释放校验 owner，不是自己拿的锁不能释放。

四个入口统一 `withPathLock(mode, uri, fn)` 包装。

**为什么要 TREE 而不是只锁文件**：`rm -r resources/foo` 要保证「删索引 → 删文件」期间没有人往 `foo/` 里写。只锁 `foo` 自身挡不住写 `foo/bar.md` 的人。

**元数据写保护**

`.acl.json` / `.abstract.md` / `.overview.md` 的 frontmatter 是**受保护的**：

- `write` 到元数据文件时，先读出现有 frontmatter，只替换正文，再写回
- `append` 只追加正文，绝不碰 frontmatter
- 想改 frontmatter（比如手工修 `freshness`）必须用专门的 API，正常路径不该有

**不保护的后果**：一次 `write` 就把 `freshness`、`uri`、`generated_by` 全清掉，摘要失效机制从此失灵，而且没有任何报错——系统安静地退化成「每次全量重算」。

**索引双写补偿**

写文件成功、更新索引失败时，文件在磁盘上但检索不到。处理：

1. 写索引失败 → 往 `_meta/reconcile.log` 追加一条 `{op, uri, error, at}`
2. 启动时扫这个日志重放；定期任务也扫
3. 重放成功才删除日志条目

**为什么不是回滚文件**：文件已经是对的，回滚反而丢数据。补偿的方向是「把索引追上来」，不是「把文件退回去」。

**归档期间并发写**

`session.commit` 的 Phase 1 要「读 live messages → 写归档 → 重写 live messages」。这中间如果用户又发了一条消息，会被 Phase 1 的重写覆盖。

**做法**：Phase 1 全程持 session 的 `TREE` 锁，`add_message` 也要拿同一把锁。Phase 1 只做落盘，很快（毫秒级），不会卡住用户。

**批量写入**

`add_resource` 导入 100 个文件，如果每个都单独 `write`，就是 100 次「打开文件 + 写 + 更新索引 + 触发摘要失效」。开销在三处：

| 开销 | 单独写 | 批量 |
|---|---|---|
| 索引事务 | 100 次 `BEGIN/COMMIT` | 1 次 |
| 摘要失效标记 | 200 次（10 个目录 × 20 文件各标一次） | 10 次（去重后每个祖先一次） |
| 目录摘要重算 | 可能触发多次 | 结束后统一触发一次 |

批量路径：

1. 先算出所有目标 URI 的**唯一祖先集合**
2. 一个大事务里：写全部文件 → 批量 `INSERT` 索引 → 每个祖先标一次脏
3. 提交后统一投递摘要重算任务

**为什么不能只做「循环调 write」再优化**：摘要失效是 Observer 驱动的，每个文件写入都会走到祖先标记。100 个文件就是 200 次标记，其中 190 次是重复的。批量路径必须在**入口处**就去重，不能事后合并。

## 11. 记忆模型与合并

### 11.1 记忆类型

用 **TypeScript 常量** 描述，放在 `src/domain/memory-types/`。不用 YAML：`domain/` 不许有 IO 和第三方运行时依赖，YAML 会让领域层需要一个解析器（§4.2）。每个类型导出 `satisfies MemoryTypeSchema` 的常量，`index.ts` 汇总成 `BUILTIN_MEMORY_TYPES`。

```ts
export const preferencesMemoryType = {
  type: 'preferences',
  description: '用户在某个话题上的偏好',
  directory: 'memories/preferences',
  filename: '{topic}.md',        // 可以带多段，如 '{scenario}/{rule}.md'
  operationMode: 'upsert',       // upsert | addOnly
  fields: [
    { name: 'topic', type: 'string', identity: true, description: '偏好所属话题，小写短横线' },
    { name: 'content', type: 'string', merge: 'patch', description: '偏好内容，一句话' },
    { name: 'updatedAt', type: 'string', merge: 'replace' },
  ],
} satisfies MemoryTypeSchema;
```

**`filename` 可以带多段，一个类型可以有多个 `identity` 字段。** `rules` 就是两级：`{scenario}/{rule}.md` → `memories/rules/license-review/must-locate-license.md`（§6.5 的示例）。规则两条：

1. `filename` 里的每个占位符必须是 `identity` 字段。普通字段的占位符永远填不上，放行等于把「拼出带 `{x}` 的路径」留到运行时。
2. `identity` 字段不必都出现在 `filename` 里。`profile` 的 `name` 只作为记录标识，文件名固定为 `profile.md`。

`renderPath(schema, values)` 的 `values` 是 `Record<string, string>`：缺值报错（否则拼出带花括号的路径），多值报错（说明调用方搞错了类型），每段值做单段安全校验（拒绝 `/`、`..`、控制字符）。

内置类型：`profile`、`preferences`、`entities`、`events`（`addOnly`）、`identity`、`soul`、`experiences`、`rules`。

### 11.2 合并操作

| 操作 | 适用 | 语义 |
|---|---|---|
| `patch` | string 字段 | SEARCH/REPLACE 块；SEARCH 必须唯一命中 |
| `replace` | 任意 | 整体替换 |
| `sum` | 数值 | 累加 |
| `immutable` | 任意 | 首次写入后不可改 |

**patch 的 SEARCH 必须唯一命中。** 命中多处就失败，不做「猜一个」的模糊匹配——猜错的代价是静默改坏一条记忆，比报错严重得多。

**新建记忆时多块 patch 要全部拼接。** 只取第一块会静默丢掉抽取出来的事实。

### 11.3 抽取预取

抽取时要判断「这条新信息是新增还是更新已有记忆」。不读已有记忆就判断不了，只能盲目新增，结果是大量重复。

两条做法：

- **循环**：让模型先调 `search` 再调 `read`，然后输出操作（reAct，最多 3 轮）。质量最好，token 最贵。
- **预取**：先按 schema 的目录做一次检索，把 top-N 命中直接塞进 prompt，然后单次输出。省 token，质量略低。

v1 用预取。每个多文件类型的 schema 做一次检索，`limit = max(5, prefetchTopN)`；单文件类型（`profile` / `identity` / `soul`）直接读该文件。检索结果的 `page_id` 标注随正文一起给模型，不另建映射表。

### 11.4 抽取与 page_id

LLM 看不到原始 URI，只看到「第 N 个读过的记忆文件」（page_id）。输出里的操作引用 page_id，服务端再映射回 URI。

让模型直接输出 URI 会引入拼写错误和幻觉路径；page_id 是它刚刚亲眼读到的编号。新建项用 ≥ 100 的编号，避免和已读项冲突。

**解析失败只重试一次。** 第二次还失败就抛错，`.done` 不写。截断（`finishReason === 'length'`）**不重试**——同样的上限只会再截断一次，必须报错让人调大 `maxTokens`。

### 11.5 规则合并

一次提交可能产出 20 条操作，其中 5 条指向同一个记忆文件。不合并就是 5 次覆盖写，最后只剩最后一次。

**同 URI 的多条 patch 按顺序应用，不调模型。** 这是 SEARCH/REPLACE 的天然语义：第 2 条的 SEARCH 在第 1 条应用后的正文上匹配。只要每条 SEARCH 唯一命中，结果就是确定的。

三种情况要特殊处理：

| 情况 | 处理 |
|---|---|
| 同一批次里既 upsert 又 delete 同一 URI | 保留 upsert（delete 视为误判） |
| 同 URI 同时有 replace 和 patch | 按操作在输出里的出现顺序应用 |
| SEARCH 命中多处 | 整条操作失败，记入 `skippedOperations`，**不做模糊匹配** |

**为什么不做 LLM 二次合并**：那需要模型看到「这 5 条其实是同一件事的不同侧面」。v1 的抽取输出是结构化的（每次操作针对一个 schema 字段），同一字段的多条 patch 本来就该按顺序应用。语义重复（不同 URI 讲同一件事）留到 v2 再合并。

### 11.6 复核闸门

`experiences` 与 `rules` 两类记忆走 `pending → active`：

- 抽取产生的是 `pending` 记录，不进检索结果
- 控制台「记忆复核」页展示 diff（before/after）
- 人工通过 → `active`；拒绝 → 删除并记录原因
- 其余类型直接 `active`

## 12. 权限模型

### 12.1 基本元素

- **主体**：`user:{uid}`、`group:{gid}`、`user:*`。不支持 `group:*`。
- **级别**：`read = 1`、`write = 3`、`manage = 7`。高位包含低位。
- **效果**：`allow` / `deny`。
- **模式**：`inherit`（默认，继承祖先） / `restricted`（切断继承，只看直接授权）。

### 12.2 求值

```
effective(N) =
  owner(N) == ctx.uid ? {manage}           // owner 恒 rwx
  : denied(N) ? ∅                           // 同节点 deny 优先
  : mode(N) == restricted ? direct(N)
  : direct(N) ∪ effective(parent(N))

check(N, action) = effective(N).some(e => e.allow && e.level & action == action)
```

三个不变量：

1. **owner 恒 rwx**：owner 判断独立于 ACL，不能被 ACL 收回。否则存在「把 owner 自己的权限收掉」再借别人的路径提权的可能。
2. **同节点 deny 优先**：同一主体在同一节点既有 allow 又有 deny 时，deny 赢。
3. **只有 manage 能改 ACL**：`setAcl` 前置检查 `check(N, manage)`。ACL 工具不进 MCP——一个能给自己授权的 agent 就是提权漏洞。

### 12.3 继承不存快照

`effective(N)` 递归到 `parent(N)`，**不预存继承快照**。存了必然在祖先变更后过期，而这类 bug 只在演示时暴露。

每请求维护 `Map<uri, Acl>` 缓存，请求结束丢弃。

检索侧的 `node_permission` 是物化结果，不是快照：改 ACL 时整棵子树重算，保证它等于「此刻的 `effective()`」。

### 12.4 出口清单

每一个出口都必须过 `Authorizer`，漏一个就是泄露：

| 出口 | 所需级别 |
|---|---|
| `read` / `stat` / `abstract` / `overview` | read |
| `list` / `tree` | 逐条 read |
| `find` / `search` / `grep` / `glob` | 逐条 read |
| `write` / `edit` / `mkdir` | write |
| `rm` / `mv` | manage |
| `getAcl` / `setAcl` | manage |

**列表语义**：无权限节点完全不出现，不返回「存在但无权」的占位。文件名和摘要本身就是信息。

### 12.5 组空间的三层共享

| 场景 | 做法 |
|---|---|
| 组内全员可读写 | 组根预置 `group:{gid} = write` |
| 个人文件给全组看 | 在 `comem://user/{uid}/...` 该节点挂 `group:{gid} = read` |
| 组内只给部分人看 | 在更深节点设 `restricted` 切断继承，再挂 `user:{uid2}` 直接授权 |

退组立即生效：ACL 存的是 `group:{gid}` 这个 principal，不展开成成员列表，不需要回写。

### 12.6 根预置

| 根 | 预置 |
|---|---|
| `comem://user/{uid}/` | `user:{uid} = manage` |
| `comem://group/{gid}/` | `group:{gid} = write` |

两个预置都是普通 ACL 条目，可以改（owner 那一条除外）。写死会让组空间无法降级成只读。

## 13. MCP 工具契约

16 个，只读 10 个、写 4 个、摄取 2 个。**不含 `get_acl` / `set_acl`**。

### 13.1 工具描述怎么写

MCP 工具的描述是给模型看的**使用说明**，不是 API 文档。每个描述必须回答三件事：

1. **什么时候用这个工具**（而不是别的）
2. **参数里最容易用错的是什么**
3. **返回结果怎么读**

例如 `find` 的描述不是「执行语义检索」，而是「不确定内容在哪个目录时用这个；如果你已经知道路径，用 `read` 更快」。

### 13.2 16 个工具

| 工具 | 参数 | 返回格式 |
|---|---|---|
| `find` | `query`、`targetUri?`、`limit=10`、`level?`、`contextType?` | 文本：`Found N item(s):` + 每条 `- [类型 分数] uri` + 缩进摘要 |
| `search` | 同上 + `sessionId?` | 同上，末尾附 `Query plan` |
| `rule_search` | `taskContext`、`threshold=0.65` | 文本：适用规则的完整正文块 |
| `read` | `uri` 或 `uris[]`、`offset=0`、`limit=-1` | 文本；图片/音频返回二进制块 |
| `list` | `uri`、`recursive=false`、`offset`、`limit`、`sortBy` | 文本：`[dir] name` / `[file] name` |
| `tree` | `uri`、`levelLimit=3`、`includeAbstract=false` | 文本树形，缩进表示层级 |
| `grep` | `uri`、`pattern`、`caseInsensitive=false`、`nodeLimit=10` | 文本：`Found N match(es):` + `uri` + `  L42 [pattern]: 内容` |
| `glob` | `pattern`、`uri`、`nodeLimit=100` | 文本：`Found N file(s):` + `  uri` |
| `download` | `uri` | 短期签名 URL（10 分钟） |
| `health` | — | 文本：服务状态、索引条数、摘要降级标记 |
| `write` | `uri`、`content`、`mode=replace\|append\|create`、`wait=false` | 文本：写入结果 + 索引状态 |
| `edit` | `uri`、`oldString`、`newString`、`replaceAll=false` | 文本：替换结果 |
| `remember` | `messages[]` | 文本：`taskId` + 抽取在后台进行的提示 |
| `forget` | `uri`、`recursive=false` | 文本：`Deleted: uri` |
| `add_resource` | `name`、`files[]`、`to`、`description`、`source`、`tags[]` | 文本：`taskId` |
| `add_skill` | `data` / `path`、`targetUri`、`listOnly=false` | 文本：安装结果 |

**为什么返回文本而不是 JSON。** MCP 的返回值直接进模型上下文。文本格式的信息密度更高，模型也更容易读。JSON 适合程序消费，不适合模型消费。

**`remember` 复用提交管线**：造一个合成会话再提交，不另写一条记忆写入路径。

**`add_resource` 分两步：先上传附件，再建资源。** 原始文件必须落盘保留，否则 `download` 没东西可下。

```ts
// 第一步：上传
POST /api/v1/resources/temp-upload   // multipart，返回 { uploadId }

// 第二步：建资源
interface AddResourceInput {
  name: string;              // 资源名，作为目录名
  to?: string;               // 默认 comem://~/resources/{name}/
  description?: string;
  source?: string;           // 原始出处
  tags?: string[];
  files: Array<{
    path: string;            // 逻辑路径，如 "docs/api.md"
    uploadId: string;        // 上一步拿到的附件 id
    content?: string;        // 可选：规范化后的文本，用于检索
    summary?: string;        // 可选：agent 给的文件摘要
    language?: string;
  }>;
}
```

**后端不做格式解析。** 文本提取的规则：

| 上传的 MIME | 后端行为 |
|---|---|
| `text/*`、`application/json`、代码文件 | 直接读文本，建索引 |
| 二进制（PDF / 图片 / Office） | 有 `content` 就用它建索引；没有就只存附件 + 文件名 + `description`，`indexed: false` |

原始附件存 `resources/{name}/.attachments/{path}`，`download` 直接给这个文件。规范化文本存在 `resources/{name}/{path}`，带 frontmatter 摘要。

**为什么让 agent 提供 `content`。** PDF、HTML、DOCX 的解析需要各自的库，版面、表格、公式的还原质量参差不齐。上传方是 agent——它本来就有读 PDF、抓网页、看图片的工具，比后端再实现一遍更强。后端只做「存附件 + 存文本 + 切分 + 摘要 + 建索引」，职责单一。

代价要说清楚：大文件要 agent 整个读进上下文，token 成本转移到调用方；不能「给个 URL 让后端去抓」。后者由 agent 自己 fetch 后再上传。

**原文不被污染。** 附件是原始字节，不做任何改写；规范化文本是独立文件。两者都能单独 `read` / `download`。

## 14. HTTP API

统一前缀 `/api/v1`。响应封套：

```json
{ "status": "ok", "result": { } }
{ "status": "error", "error": { "code": "PERMISSION_DENIED", "message": "..." } }
```

| 分组 | 端点 |
|---|---|
| 文件系统 | `GET /fs/ls`、`/fs/tree`、`/fs/stat`；`POST /fs/mkdir`、`/fs/mv`、`/fs/cp`；`DELETE /fs` |
| 内容 | `GET /content/read`、`/content/abstract`、`/content/overview`、`/content/download`；`POST /content/write`、`/content/edit` |
| 检索 | `POST /search/find`、`/search/search`、`/search/grep`、`/search/glob` |
| 会话 | `POST /sessions`、`/sessions/{id}/messages`、`/sessions/{id}/commit`；`GET /sessions`、`/sessions/{id}` |
| 任务 | `GET /tasks/{id}`、`GET /tasks`、`POST /tasks/{id}/retry` |
| ACL | `GET /acl`、`PUT /acl`、`POST /acl/grant`、`POST /acl/revoke` |
| 记忆 | `GET /memories/pending`、`POST /memories/{uri}/approve`、`POST /memories/{uri}/reject` |
| 资源/技能 | `POST /resources`、`POST /skills`、`GET /skills` |
| 用户与组 | `GET|POST /admin/users`、`GET|POST /admin/groups`、`POST /admin/groups/{id}/members` |
| 运维 | `GET /health`、`GET /metrics` |

MCP 挂在 `/mcp`，Streamable HTTP 传输。

## 15. Agent 集成

16 个 MCP 工具里没有会话相关操作，真实会话靠 **Hook 插件**在宿主侧自动采集。这是独立于服务端的交付物，放在 `integrations/`，装进宿主。

### 15.1 为什么不在 MCP 工具里做

MCP 工具是模型主动调用的。会话提交不能靠模型「记得调」——它一忘，这次对话就丢了。而且提交要在**每轮结束后**发生，模型没有这个时机。

所以走宿主 Hook：宿主在固定生命周期点回调我们的脚本，脚本负责召回和采集。

### 15.2 生命周期点

| Hook | 做什么 |
|---|---|
| `SessionStart` | 注入用户 profile + 偏好 + `<available-skills>` 技能目录 |
| `UserPromptSubmit` | 拿这条 prompt 去 `find`，把相关记忆注入上下文 |
| `PreToolUse` | 拦住把 `comem://` 当本地路径的文件工具调用，指回 MCP 工具 |
| `PostToolUse` | 采集工具调用与结果（作为 `tool` 部分） |
| `Stop` | 采集本轮的 user / assistant 消息，提交会话 |
| `PreCompact` / `SessionEnd` | 提交待处理消息 |

技能目录有独立 token 预算：放不下就只列名字，连一个名字都放不下就缩成一行计数。

### 15.3 采集不阻塞对话

采集跑在**分离的 worker 进程**里，`Stop` 立刻返回。只有 `PreCompact` / `SessionEnd` 会等提交完成（在 hook 超时预算内）。

**为什么必须分离**：`Stop` 卡住等于把用户的输入延迟绑在 LLM 抽取上。抽取一次几秒到几十秒，用户会以为宿主卡死了。

### 15.4 去重与幂等

三层：

1. **事件去重**：宿主可能重复投递同一个 hook 事件，按 `eventId` 去重，同一个事件 500ms 窗口内只处理一次。
2. **消息去重**：按轮次序号推进游标，只提交游标之后的消息。游标只在**服务端确认接收**后前进——没确认就重投，宁可重复不能丢。
3. **跨进程锁**：同一个 session 的多个 hook 进程可能并发（比如两次 Stop 挨得很近），用文件锁串行化。

### 15.5 会话 ID

宿主没有统一的会话 ID 格式，插件按宿主加前缀：`cc-`（Claude Code）、`dsh-`（DSH）。

### 15.6 MCP 代理

宿主的 MCP 客户端只认 stdio。`integrations/servers/mcp-proxy.mjs` 做一层薄代理：读配置里的 URL 和 key，转发到服务端的 Streamable HTTP 端点。这样 key 存在一个文件里，不散落在宿主的配置中；换 key 只改一处，不用重装插件。

### 15.7 支持哪些宿主

v1 做两个：**Claude Code**（hooks + MCP，最常用）和 **DSH**（plugin + MCP）。

不做 Cursor、Codex、TRAE。它们的 hook 事件名和 payload 各不相同，每个都要单独适配并对着真实宿主验证。适配器接口留好即可。

### 15.8 目录

```
integrations/
├── package.json
├── cli.mjs                    # co-mem install / doctor
├── scripts/
│   ├── hook.mjs               # 唯一入口，按 host 分发
│   └── uri-guard.mjs          # comem:// 路径守卫
├── servers/
│   └── mcp-proxy.mjs          # stdio → Streamable HTTP
├── hosts/
│   ├── index.mjs              # 适配器注册
│   ├── claude-code.mjs
│   └── dsh.mjs
└── lib/
    ├── runtime.mjs            # 去重、游标、文件锁
    ├── capture.mjs            # 采集本轮消息
    ├── recall.mjs             # 检索并注入
    └── config.mjs             # 凭据解析
```

宿主适配器只回答四个问题：**事件名怎么叫**、**返回信封长什么样**、**prompt 从 payload 哪里读**、**一轮结束怎么判定**。其余状态机（去重、游标、锁、重试）由 `lib/runtime.mjs` 统一承担。

### 15.9 召回阻塞与预算

**这是整个设计最需要算清楚的一笔账。**

`UserPromptSubmit` 是**同步阻塞**的：用户按下回车 → 宿主启动 hook 进程 → hook 调 CoMem 检索 → 拿到注入内容 → 宿主把 prompt 和注入内容一起发给模型。

也就是说，**用户每打一轮，都要先等 CoMem 把记忆找完**。这笔延迟直接加在「回车到模型开始生成」之间。

**耗时拆解**：

| 阶段 | 阻塞 | 典型 | 上限 |
|---|---|---|---|
| hook 进程启动 | 是 | 30–50ms | — |
| 意图分析（可选 LLM） | 是 | 300–500ms | `expansionTimeoutMs` = 5000 |
| 检索（FTS5 + 过滤） | 是 | 20–100ms | — |
| 上下文组装 + 序列化 | 是 | < 5ms | — |
| 摘要重写（可选 LLM） | 是 | 1–3s | `rewriteTimeoutMs` = 30000 |
| 采集写入（`Stop`） | 是 | 5–20ms | — |
| 归档 + 抽取 + 合并 + 摘要 | **否**（后台） | 几秒到几十秒 | — |

**先纠正一个容易搞反的语义：查询扩展是追加，不是替换。**

```
queries = [原始 query]
queries += [LLM 改写出来的 1–3 条 TypedQuery]
```

原始 query **一定**会被检索，扩展只是补上「原文查不到的」。所以「不扩展 = 没有召回」不成立——不扩展少的是**补充召回**，不是全部召回。

**三档模式**：

| 模式 | 调几个 LLM | 典型总耗时 | 用在哪 |
|---|---|---|---|
| `fast` | 0 | 50–100ms | 延迟敏感、关键词密集的 prompt |
| `balanced` | 1（查询扩展） | 350–600ms | **默认** |
| `deep` | 2（扩展 + 摘要重写） | 1–4s | 演示、研究 |

```yaml
recall:
  mode: balanced             # fast | balanced | deep
  expandOnlyWithContext: true   # 没有会话上下文时不扩展（首轮自动 fast）
  expansionTimeoutMs: 5000
  rewriteTimeoutMs: 30000
  escalateBelowScore: 0.5    # 快速检索 top1 低于此分就升级到扩展
```

**为什么默认不是 `fast`**：用户大部分时候说的是**口语**，不是检索式。

| Prompt | fast 召回 | balanced 召回 |
|---|---|---|
| `TypeScript strict 怎么配` | 好——关键词已经足够具体 | 略好 |
| `这个怎么又报错了` | **差**——「这个」「报错」匹配不到具体记忆 | 好——LLM 结合上几轮改写成「TypeScript 类型错误」 |
| `继续` | **空** | 好——改写成上一轮话题 |

口语化 prompt 里没有关键词，BM25 无从下手。这时候扩展不是锦上添花，是**唯一能召回的手段**。

**但参考实现的 `auto` 本来就是自适应的**：没有会话上下文时不扩展（首轮自动 fast），有上下文才扩展。固定成 `fast` 等于把这个机制拍平了。

**v1 再加一层自适应升级**：先跑 `find`（无 LLM），top1 分数低于 `escalateBelowScore` 才升级到 `balanced` 重检索一次。

| Prompt 类型 | 走哪条 | 占比（估计） |
|---|---|---|
| 关键词密集（含代码、路径、报错） | 快速命中，不升级 | ~60% |
| 口语化 / 指代 | 升级到扩展 | ~30% |
| 首轮 | 无上下文，直接 fast | ~10% |

平均开销 ≈ `0.7 × 75ms + 0.3 × 475ms` ≈ **195ms**，比固定 `balanced` 的 475ms 省 60%，质量损失只在「本来就能命中」的场景。

**降级而不是等待**：扩展超过 `budgetMs` 就用已拿到的原始 query 结果。宁可用粗糙的查询，也不让用户干等。

**`deep` 的摘要重写为什么不做默认**：它把 10 条召回改写成几条带引用的要点，省 token 但要多 1–3 秒，而且 30 秒超时一旦触发就是灾难。演示时开，日常关。

**为什么这笔开销是值得的**：

按「自适应升级」的平均 195ms 算，完整链路是：

```
Hook 阻塞           +195ms
模型少探索 1–2 轮    -1200ms
──────────────────────────
净变化               -1005ms
```

参考实现在 LoCoMo 上实测：准确率 24–57% → 80–83%，**输入 token 降 34–91%，端到端查询延迟降 58–66%**。

延迟降的原因很直接：模型不用为了搞清楚「上次那个配置是怎么写的」而翻三轮工具调用。**200ms 换 1.2 秒**。

**注意这个数字的前提**：它假设召回质量足够好。如果召回是噪音，模型多花 200ms 什么都没得到，还会被错上下文带偏——这比没有记忆更糟。所以下面三条不是优化项，是前提。

**但前提是记忆质量够好。** 召回是噪音的话，用户付出 80ms 什么都没得到，纯亏。所以三件事必须同时成立：

1. **召回为空就不注入**——不要给模型一段「没有相关记忆」的废话
2. **低于阈值不注入**——低分命中是噪音
3. **账本去重**——同一记忆不重复投喂

这三条任何一条不成立，预热延迟的收益就归零。这也是为什么 §17.2 的延迟归因必须做：**它要能证明「这一轮 CoMem 花了 80ms，帮模型省了 1.2 秒」**。

**能不能做到不阻塞**：

| 手段 | 可行性 | 省多少 |
|---|---|---|
| 长驻守护进程 + Unix socket | 可以，加复杂度 | 省掉 30–50ms 进程启动 |
| 预取 | 不行 | 按下回车前不知道 prompt |
| 异步注入 | 不行 | hook 协议是同步的，宿主不会等 |
| 缓存同 prompt 结果 | 有限 | 重复 prompt 很少 |

v1 每次起进程。如果实测发现进程启动占比过高（> 50%），再上 Unix socket 守护进程。

## 16. Web 控制台

Nuxt 3 + shadcn-vue + Tailwind。七个页面：

| 页面 | 内容 |
|---|---|
| 文件树 | 左树右详情；详情分 L0/L1/L2 三档切换；显示摘要来源与新鲜度 |
| 检索调试 | 输入 query，选 `find` / `search`，显示每条命中的分数、层级、命中原因 |
| 记忆复核 | `pending` 列表 + diff 视图（before/after）；通过 / 拒绝 |
| ACL 管理 | 节点树 + 授权列表；切换 inherit / restricted；显示有效权限的推导链 |
| 用户与组 | 用户列表、组列表、组成员维护 |
| 会话与任务 | 会话列表、归档列表、任务状态、重试、僵尸回收记录 |
| 监控 | 开销归因、吞吐（TPS / TTFB）、模型用量与成本、记忆健康度（见 §17.10） |

### 16.1 视觉方向：Apple

已定。参考 `docs/design/variants/apple/`（5 页 + `app.css`），实现时按它落 Nuxt 组件。

| 维度 | 取值 |
|---|---|
| 字体 | SF Pro 系统栈（`-apple-system`），标识符用 SF Mono；标题负字距 −0.011em ~ −0.028em |
| 字号 | 基准 15px / 行高 1.47；阶梯 34 / 28 / 22 / 17 / 15 / 14 / 13，**全站下限 13px** |
| 色板 | 深色主区 `#0B0B0D`、表面 `#1C1C1E`–`#3A3A3C`；浅色 `#F5F5F7`/`#FFFFFF`；强调色系统蓝 `#0A84FF`(深) / `#007AFF`(浅) |
| 材质 | `blur(30px) saturate(180%)` + 半透明，只用于固定外壳（侧边栏 62% / 工具栏 78% / 操作条 92%） |
| 圆角 | 6 标记 / 10 控件 / 18 卡片 / 22 面板 / 24 sheet；连续圆角 = radius + 0.5px 内描边 + 顶部高光 |
| 阴影 | 只给浮层，不用阴影表达层级 |
| 动效 | `cubic-bezier(0.32, 0.72, 0, 1)`，160 / 280 / 420ms，尊重 `prefers-reduced-motion` |
| 间距 | 4px 基准 |
| 对比度 | 正文 ≥ 4.5:1（实测深色 16.3:1、浅色 18.5:1） |

**不做红黄绿三点。** macOS 的窗口控制点表达的是「关闭 / 最小化 / 最大化」，而控制台是浏览器标签页里的应用，没有这三个动作。放上去是纯粹的装饰性拟物，还占掉标题栏的可读空间。

**界面文案原则**：不把提示词抄到 UI 上。开发期内部术语（page_id、digest、pendingChanges）不进用户可见区域，用「基线」「待刷新」这类词。

## 17. 可观测性与运维

四个问题要能回答：**系统现在在干什么、刚才那次为什么慢、那次失败错在哪、用 CoMem 让每个请求多花了多少时间。**

最后一个是关键——记忆系统的价值必须能证明大于它的成本。做不到这一点，所有「效果提升」都是空话。

### 17.1 分层

```
业务代码 / HTTP 中间件 / 后台任务 / Hook
                  ↓ 事件 + 状态读取
         MetricsRegistry（进程内）
         计数器 / 仪表 / 直方图
                  ↓
    ┌─────────────┴─────────────┐
    ▼                           ▼
/metrics                  /api/v1/stats/*
Prometheus 文本              分析型 JSON
机器可读、低基数               控制台用、可高基数
```

**为什么分两套**：Prometheus 的抓取模型要求低基数（标签组合不能爆炸），而控制台要显示「每条记忆的热度」这种高基数数据。混在一起要么撑爆指标库，要么控制台拿不到细节。

### 17.2 延迟归因（核心）

这是回答「用 CoMem 让每个请求慢了多少」的唯一方式。

**先分清阻塞与异步**：

| 阶段 | 阻塞用户？ | 典型值 |
|---|---|---|
| Hook 进程启动（`node hook.mjs`） | **是** | 30–50ms |
| 检索（`find` / `search`） | **是** | 20–100ms |
| 注入序列化 | **是** | < 5ms |
| 采集写入（`Stop` 时的消息落盘） | **是** | 5–20ms |
| 归档 + 抽取 + 合并 + 摘要 | 否（后台） | 几秒到几十秒 |

**单轮阻塞开销 = 进程启动 + 检索 + 序列化 + 采集写入**，典型 60–180ms。异步部分不算进去——用户没等它。

**为什么必须单独测进程启动**：hook 起一个新 Node 进程就是 30–50ms 纯开销。把它藏在「检索 20ms」后面会误导人，让人以为 CoMem 只花 20ms。

**指标**：

```
comem_hook_overhead_seconds{event, phase}      # phase = process_start | recall | serialize | capture
comem_hook_overhead_total_seconds{event}        # 单轮合计
comem_hook_async_seconds{event}                 # 后台部分耗时，与阻塞部分分开
```

**报告路径**：hook 在退出前 `POST /api/v1/telemetry/hook`，带 `{event, sessionId, phases: {processStartMs, recallMs, serializeMs, captureMs}}`。服务端累加进直方图。

**控制台怎么展示**：

```
本轮 CoMem 开销  142ms
├── 进程启动      38ms  ██████
├── 检索         104ms  █████████████████
├── 序列化         0ms
└── 采集           0ms
后台处理        12.4s（不阻塞用户）
```

### 17.3 TTFB 与 TPS

| 指标 | 类型 | 标签 | 含义 |
|---|---|---|---|
| `comem_http_ttfb_seconds` | Histogram | `route, method, status` | 从收到请求到写出第一个字节 |
| `comem_http_request_duration_seconds` | Histogram | `route, method, status` | 完整耗时 |
| `comem_http_requests_total` | Counter | `route, method, status` | 请求总数，TPS 用 `rate()[10s]` |
| `comem_http_requests_per_second` | Gauge | `route` | 10 秒滑窗，给不跑 Prometheus 的场景直接看 |
| `comem_http_inflight_requests` | Gauge | `route` | 当前在途请求数 |

**TTFB 和总耗时什么时候不同**：JSON 响应两者相等；MCP 的 SSE 流式响应才真正体现「首事件时间」。分开测是因为流式接口的 TTFB 才是用户感知的延迟。

### 17.4 模型用量与成本

```
comem_llm_calls_total{purpose, provider, model}
comem_llm_tokens_total{purpose, provider, model, kind}   # kind = prompt | completion
comem_llm_duration_seconds{purpose, provider, model, quantile}
comem_llm_cost_usd_total{purpose, provider, model}       # 按配置单价换算
comem_llm_errors_total{purpose, code}
```

**为什么要有 cost**：答辩被问「跑一次演示多少钱」，能直接答出来。单价配置在 `providers.llm.default.pricing`，不写死。

**`purpose` 的取值**：`summary`（目录摘要）、`extract`（记忆抽取）、`intent`（意图分析）、`working_memory`。分开才能看出「钱花在哪」。

### 17.5 记忆健康度（分析型）

`GET /api/v1/stats/memories`：

```json
{
  "total": 128,
  "byType":   { "preferences": 42, "entities": 31, "events": 24, "experiences": 18, "rules": 13 },
  "byStatus": { "active": 120, "pending": 8 },
  "hotness":  { "hot": 12, "warm": 45, "cold": 71 },
  "stale":    { "directories": 5, "oldestHours": 18 },
  "avgSizeBytes": 1840
}
```

`GET /api/v1/stats/sessions/{id}`：

```json
{
  "sessionId": "sess_7f3a",
  "archives": 2,
  "messages": 42,
  "extracted": { "adds": 3, "updates": 1, "deletes": 0, "skipped": 1 },
  "latency":   { "recallP50": 0.08, "commitP50": 12.4 },
  "overhead":  { "blockingMs": 142, "asyncMs": 12400 }
}
```

**热度的算法**：`sigmoid(log1p(activeCount)) × exp(-ln2 × ageHours / halfLifeHours)`。`activeCount` 是记忆被检索命中并注入的次数，`halfLifeHours` 默认 168（一周）。分桶：≥0.7 热、≥0.3 温、其余冷。

**为什么热度不影响排序**：热度是治理指标（「哪些记忆该清理」），不是检索指标。混进排序会让老记忆永远赢，新记忆永远出不来。

### 17.6 请求记录

每个 HTTP 请求一行，写 SQLite 的 `request_log` 表：

```json
{
  "at": "2026-11-07T22:00:00Z",
  "requestId": "req_abc",
  "userId": "alice",
  "method": "POST",
  "route": "/api/v1/search/find",
  "status": 200,
  "durationMs": 104,
  "ttfbMs": 104,
  "responseBytes": 2048
}
```

**保留策略**：默认 7 天或 10 万条，先到先删。可配置。

**采样**：默认全量。高频写入场景可开采样（`telemetry.requestLog.sampleRate`），但**错误请求永远全量记录**。

**为什么用 SQLite 不用日志文件**：控制台要按时间、路由、状态码、用户筛选，`grep` 做不到。SQLite 有索引，一条 SQL 就够。

### 17.7 请求 ID 贯穿

每个 HTTP 请求和每个后台任务都有 `requestId`（从 `X-Request-Id` 读，没有就生成）。它进 `AsyncLocalStorage`，然后：

- 每条日志带上
- 每个错误响应的 `details.requestId` 带上
- 子任务继承父任务的 ID
- 请求记录表里存一份

**为什么必须做**：后台任务失败时你只有一行错误日志。没有 requestId 就串不起「哪个请求触发的、中间调了几次模型、哪一步炸的」。

### 17.8 结构化日志

`error.log` 每行一个 JSON：

```json
{"at":"2026-11-07T22:00:00Z","requestId":"req_abc","code":"PROVIDER_UNAVAILABLE","op":"summary.generate","uri":"comem://user/alice/projects/comem/resources/docs","durationMs":1200,"attempt":2,"message":"模型返回 503"}
```

`grep req_abc error.log` 就能看到一次请求的全貌。

**不写堆栈到日志文件**——堆栈进 stderr（开发时看），日志文件只留可读的字段。堆栈在日志里除了占地方没别的用。

### 17.9 health

`health` MCP 工具与 `GET /health` 返回同样内容：

| 字段 | 含义 |
|---|---|
| `status` | `ok` / `degraded` / `error` |
| `index.nodes` | 索引节点数 |
| `queue` | `{pending, processing}` |
| `summary.degraded` | 是否降级到规则摘要 |
| `summary.pendingDirs` | 待刷新目录数 |
| `overhead.p50Ms` | 最近 5 分钟阻塞开销中位数 |
| `version` | 服务版本 |

**`degraded` 的判定**：模型不可用且开了规则降级，或索引与文件系统对账不一致。降级必须可见——静默降级等于骗人。

### 17.10 控制台「监控」页

第 7 个页面，四块：

| 区块 | 内容 |
|---|---|
| 开销归因 | 单轮阻塞开销的 P50/P95 + 四阶段饼图；异步耗时单列 |
| 吞吐 | TPS 曲线、TTFB P95、错误率 |
| 模型 | 调用次数、token 曲线、成本累计（按 purpose 分） |
| 记忆健康 | 类型分布、pending 数、热度分布、陈旧目录 |

### 17.11 不做

- **不部署 Prometheus + Grafana**：`/metrics` 输出标准格式，接不接是运维的事。
- **不做 OpenTelemetry 分布式追踪**：单进程服务，`requestId` 串起来就够。
- **不做日志聚合**（ELK/Loki）：`error.log` + `grep` 够用。
- **不做告警**：课程项目没人值夜班。

## 18. 配置

```yaml
# 数据根。留空表示按运行形态推导（见 6.5），容器里由镜像钉死为 /var/lib/comem
dataDir: ""

providers:
  llm:
    default:
      type: openai-compatible      # openai-compatible | anthropic
      baseUrl: https://api.example.com/v1
      model: gpt-4o-mini
      apiKey: ${COMEM_LLM_KEY}
      maxTokens: 32768
      timeoutSeconds: 120
      pricing:                  # 用于成本换算，按 1M token 计
        inputPerMillion: 0.15
        outputPerMillion: 0.60

summary:
  generator: llm          # llm | rule
  abstractMaxChars: 256
  overviewMaxChars: 4000

retrieval:
  engine: fts5            # fts5 | vector（v1 只有 fts5）
  candidateMultiplier: 4  # 先取 limit×N 候选，再按权限过滤
  levelWeights:           # 层级加权，用于 BM25 平局时打破
    l0: 1.15
    l1: 1.05
    l2: 1.00
  queryFilters: []        # sed 风格正则，作用在 prompt 上，产物才是查询
  assembly:
    maxTokens: 1600       # 注入模型的 token 预算
    dedupTurns: 3         # 这么多轮内投过的 URI 不再投
    quotaPreset: coding   # chat | coding
  recall:
    mode: balanced        # fast(0 次 LLM) | balanced(1) | deep(2)
    expandOnlyWithContext: true   # 首轮自动 fast
    escalateBelowScore: 0.5       # 快速检索 top1 低于此分则升级
    expansionTimeoutMs: 5000
    rewriteTimeoutMs: 30000
    budgetMs: 500         # 超了就用已拿到的结果

session:
  autoCommit:
    enabled: true
    pendingTokenThreshold: 150000
    messageCountThreshold: 100
    minCommitIntervalSeconds: 0
    idleTimeoutSeconds: 0     # 0 = 关；开了需要服务端扫描器
    keepRecentCount: 0

memory:
  reviewRequired:
    - experiences
    - rules
  workingMemory:
    enabled: false        # 开它会多一次 LLM 调用

acl:
  enabled: true
  groupDefaultLevel: write   # write | read

server:
  host: 127.0.0.1
  port: 1933

logging:
  level: info
  file: ""                   # 留空只写 stdout；填路径则额外写 error.log

telemetry:
  metrics:
    enabled: true
    includeAccountLabel: false   # 单账号部署没必要，开了会放大基数
  requestLog:
    enabled: true
    retainDays: 7
    retainRows: 100000
    sampleRate: 1.0          # 1.0 = 全量；错误请求永远全量记录
  hookOverhead:
    enabled: true            # Hook 上报阻塞开销，控制台「监控」页用
  hotness:
    halfLifeHours: 168       # 一周

task:
  leaseSeconds: 60
  maxAttempts: 3
  concurrency: 4
```

环境变量覆盖：`COMEM_<SECTION>_<KEY>`。所有魔法数字集中在这里，判断标准是「改一个值要翻几个文件」。

**`type` 决定用哪个 AI SDK provider。** 写 `openai-compatible` 走 `@ai-sdk/openai-compatible`，写 `anthropic` 走 `@ai-sdk/anthropic`。换供应商只改配置，不改代码。v1 没有 `embedding` 段——不做向量检索就不需要 embedding 抽象，需要时再加。

**并发控制。** SQLite 开 `PRAGMA journal_mode=WAL` + `PRAGMA busy_timeout=5000`，允许并发读、单写者。写事务统一走一个 `withWriteTransaction()` 包装，超过 `busy_timeout` 抛 `CONFLICT` 由任务层重试。这是 SQLite 的标准用法，不需要额外的写队列。

## 19. 错误模型

`ComemError { code, message, details? }`。`code` 是稳定枚举，`message` 是给用户看的中文句子。

| code | HTTP | 场景 |
|---|---|---|
| `INVALID_URI` | 400 | URI 不合法 |
| `INVALID_ARGUMENT` | 400 | 参数不合法 |
| `NOT_FOUND` | 404 | 节点不存在 |
| `UNAUTHENTICATED` | 401 | 没有身份 |
| `PERMISSION_DENIED` | 403 | 权限不足 |
| `ALREADY_EXISTS` | 409 | 目标已存在 |
| `CONFLICT` | 409 | 并发冲突 |
| `RESOURCE_EXHAUSTED` | 429 | 超出配额 |
| `PROVIDER_UNAVAILABLE` | 503 | 模型不可用 |
| `INTERNAL` | 500 | 未预期错误 |

**错误必须可解释**：写进 `error.log`，带请求 ID、URI、操作。不抛只有开发者能读的堆栈，也不静默吞掉。

## 20. 质量闸门

六条链路不受「探索期豁免」约束：

| 链路 | 验收点 |
|---|---|
| 会话归档 | 两阶段落盘顺序、`.done` 最后写、重放跳过已完成步骤 |
| 记忆抽取 | 输出解析、page_id 映射、失败重试一次、截断不重试 |
| 补丁合并 | SEARCH 唯一命中、多块拼接、同批 upsert/delete 冲突抑制 |
| 摘要失效 | 正文不变不传播、阈值触发、消费减而非清零、到根停止 |
| 目录级检索 | 四个面统一过滤、无权限节点不出现、候选不足时继续取 |
| ACL 过滤 | 六个出口逐个测、restricted 切断、owner 恒 rwx、退组立即生效、`node_permission` 与 `.acl.json` 一致 |

另外两组不受豁免：

| 链路 | 验收点 |
|---|---|
| 并发 | 路径锁 EXACT / TREE 互斥；`rm -r` 与后台写摘要不产生孤儿；`commit` 与 `add_message` 不丢消息；元数据 frontmatter 写不坏 |
| 可观测性 | 开销归因的四阶段相加等于总耗时；`requestId` 从 HTTP 贯穿到后台任务与日志；`/metrics` 输出能被 Prometheus 解析 |

测试在本地跑。`MemoryContentStore` 和 `MemoryIndex` 让核心测试不碰磁盘。

## 21. 里程碑

| 阶段 | 内容 | 验收 |
|---|---|---|
| P1 | 骨架：工程结构、URI、错误、配置、SQLite 迁移 | `pnpm typecheck` 通过 |
| P2 | 存储与文件系统：`ContentStore`、`FileSystemService`、元数据文件、**路径锁**、**元数据写保护** | `write`/`read`/`ls`/`tree` 可用；并发写不串 |
| P3 | 索引与检索：FTS5、`find`/`grep`/`glob`、**层级加权**、**Context Assembly**、**Recall Ledger** | 检索链路测试通过；token 预算与分层投放可验 |
| P4 | 摘要：生成、失效、降级 | 失效链路测试通过 |
| P5 | 会话与管线：归档、抽取、**预取**、合并、**规则合并**、复核、**并发锁**、**ToolPart** | 提交链路端到端通过 |
| P6 | ACL 与用户组 | 权限链路测试通过 |
| P7 | 摄取：`add_resource`（**批量写入**）、`add_skill`、**索引双写补偿** | 导入 100 文件不退化 |
| P8 | MCP 16 工具 | MCP 客户端可连 |
| P9 | 可观测性：`/metrics`、任务查询 API、请求 ID、请求记录、`error.log`、开销归因、`health` 扩展、监控页 | 答辩能看到「CoMem 让每个请求多花多少毫秒」 |
| P10 | 控制台六页 | 完整演示路径 |
| P11 | Hook 插件（Claude Code + DSH） | 真实会话自动入库 |
| P12 | 文档与答辩材料 | 文档定稿 |

**顺序调整的说明**：路径锁和元数据写保护从「以后再说」提到 P2——它们是**正确性**问题，晚补等于在错误的地基上盖楼。Context Assembly 和 Recall Ledger 放在 P3，因为它们跟检索是同一层，拆开做要改两遍。

**v1 之后（backlog）**：

| 项 | 为什么先不做 |
|---|---|
| `reindex` 重建命令 | 索引损坏是运维场景，演示用不到。但「删库可重建」的承诺要留着，不能删 |
| 快照与回滚 | 归档级回滚（按 `memory_diff.json` 反向应用）比 git 风格快照便宜，仍是 P2 之后 |
| 空闲提交扫描器 | 需要常驻定时器，长会话场景才需要 |
| Rerank | 需要模型，v1 用层级加权顶着 |
| 检查点摘要 | 只在部分归档时需要，v1 全量归档 |
| Prometheus + Grafana 部署 | `/metrics` 输出标准格式，接不接是运维的事 |
