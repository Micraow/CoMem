# CoMem 架构设计

> 这份文档描述系统**当前**的架构与设计。代码与文档不一致时，先确认哪个对，再改另一个。
>
> 本文回答四个问题：系统由哪些东西组成、它们怎么分层、数据落到磁盘长什么样、每条核心链路怎么串。

## 1. 这份文档解决什么

CoMem 是面向 AI agent 的上下文记忆数据库。给 agent 一个稳定地址，让它在不同会话、不同机器、不同队友之间共享「它知道的东西」。

本文固定**架构边界**：模块怎么分、依赖朝哪走、数据长什么样、接口签名是什么、六条核心链路怎么串。不固定实现细节（具体算法、提示词措辞、UI 布局），那些在编码时定。

## 2. 范围

**做**：`comem://` 虚拟文件系统、项目作用域、三层摘要（L0/L1/L2）、会话提交与后台记忆抽取、补丁合并、摘要增量失效、目录级检索、ACL 与用户组、15 个 MCP 工具、HTTP API、Web 控制台、Hook 插件。

**不做**：多租户（单 account）、加密、计费、多后端存储、OIDC/LDAP、隐私占位符、MCP 联邦、watch、独立向量数据库服务、训练循环、移动端。

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
| 检索 | 默认 hybrid：embedding 语义召回 + FTS5 精确词；支持显式 vector / fts5 |
| 模型提供方 | `config.yaml` 里的 provider 抽象，按 `llm` / `embedding` 等类型区分 |
| 组空间 | 真实目录树；默认成员可写；owner 恒 rwx |
| 组记忆来源 | 显式写 + 个人记忆可分享到组；不做「会话归属组」 |
| 规则 | 带 schema 的记忆子类型，`rule_search` 只做条件召回，不做编译管线 |
| MCP | 只做 15 个工具 |
| 控制台 | 十个业务页面（概览、文件树、检索、记忆复核、ACL、用户与组、会话与任务、监控、提示词、工具），多用户部署下多一个登录页（§16） |

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

**为什么 `web/` 单独。** Nuxt 有自己的构建链和 `tsconfig`，塞不进后端。可选的 [Hermes OpenUI](https://github.com/Micraow/hermes-openui) 展示插件已拆到独立仓库，使用自己的构建链，不属于 CoMem 的服务端、控制台或 Hook 构建。

**为什么 `domain` 和 `services` 分开。** `domain` 是规则，`services` 是流程。ACL 求值是规则（给定树和身份，算出一个布尔值，纯函数）；提交管线是流程（有 IO、有重试、有后台恢复）。混在一起，ACL 就只能在跑通整条管线之后才能测。

**为什么检索与合并的规则收进 `domain`，不留独立目录。** `patch.ts`（补丁块的应用）是纯字符串函数，`ranking.ts`（打分、去重与单条预算）是纯数值函数，两者跟存储和协议都无关，属于领域规则。只有「调模型做意图分析」属于应用编排。按「规则进 `domain`、编排进 `services`」拆，首层就不会出现两个语义模糊的目录。

### 4.4 接口清单

接口只在**有两个以上真实实现**时建立：

| 接口 | 定义在 | 实现 1 | 实现 2 |
|---|---|---|---|
| `RetrievalIndex` | `domain/retrieval.ts` | `SqliteFtsIndex` | 向量后端（brief 明确要求预留） |
| `LlmProvider` | `domain/llm.ts` | `AiSdkLlmProvider` | `FakeLlmProvider`（测试，`tests/helpers/`） |
| `Logger` | `domain/log.ts` | `ConsoleLogger` / `FileLogger` | `NullLogger`（测试，`tests/helpers/`） |

**没有 `ContentStore` 接口。** 内存实现没必要做：测试用 `fs.mkdtemp()` 建临时目录就够，文件系统在测试里一点不慢。既然只有一个实现，按 brief §7.2 的判据「只有一个实现时就地实现，不留接口」，它就是 `adapters/fs/content-store.ts` 里的一个具体类。分层靠「`node:fs` 只允许出现在 `adapters/`」这条 lint 规则保证，不靠接口。

**没有 `Clock`、`IdGenerator`。** 时间直接 `new Date()`；任务租约过期的测试直接改数据库里的 `lease_until` 字段（本来就是这么造僵尸任务的）；ID 用 `crypto.randomUUID()`。

**有 `EmbeddingProvider` 与 `RerankProvider`。** 这两个不是投机抽象：嵌入有 `AiSdkEmbeddingProvider`（OpenAI 兼容的 `/v1/embeddings`）一个真实实现，重排有 `HttpRerankProvider`（Cohere / Jina 兼容的 `/v1/rerank`）一个真实实现，而测试需要假实现。按「有两个以上真实实现才建抽象」的标准它们是边界情况，但**没有它们就没法在测试里替换掉网络**——而嵌入与重排都是要打外网的。

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

`LlmOptions.retry` 默认允许应用层重试。已有单一硬 deadline、到点后必须立即降级的调用显式设为 `false`；该设置同时覆盖供应商错误重试和结构化输出解析重试。

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
│   │   ├── node.ts                   # 节点规则：类别/状态守卫 + 摘要纯函数
│   │   ├── summary.ts                # 摘要三层 + 新鲜度
│   │   ├── acl.ts                    # Principal / AclEntry / Acl 求值
│   │   ├── memory-type.ts            # 记忆 schema 与字段
│   │   ├── patch.ts                  # 补丁块的应用（不解析文本格式）
│   │   ├── merge-op.ts               # patch / replace / sum / immutable
│   │   ├── ranking.ts                # 打分、去重与单条预算
│   │   ├── retrieval.ts              # RetrievalIndex 接口 + 查询类型
│   │   ├── llm.ts                    # LlmProvider 接口
│   │   ├── log.ts                    # Logger 接口
│   │   ├── session.ts                # 会话与归档
│   │   ├── task.ts                   # 任务形状与重试判定（状态转移在仓储 SQL）
│   │   ├── errors.ts                 # ComemError 与错误码
│   │   └── memory-types/             # 内置记忆类型（TS 常量，非 YAML）
│   │       ├── index.ts
│   │       ├── profile.ts
│   │       ├── preferences.ts
│   │       └── ...
│   │
│   ├── services/                     # ② 应用层：用例编排
│   │   ├── filesystem.ts             # ls / tree / read / write / edit / rm / mv
│   │   ├── search.ts                 # 门面：re-export，实现在 retrieval/
│   │   ├── retrieval/                # 检索：三臂 / 合并 / 重排 / 路径面 / 预算 / 意图 / 交付
│   │   │   ├── service.ts            # SearchService 装配与 find / search / context 编排
│   │   │   ├── arms.ts               # fts / vector / hybrid 三臂与向量候选集
│   │   │   ├── merge.ts              # 多查询合并、去重、层级加权与热度加权
│   │   │   ├── rerank.ts             # 重排取文、条数上限、失败分类与健康度
│   │   │   ├── paths.ts              # grep / glob 两个路径型检索面
│   │   │   ├── intent.ts             # 意图分析（查询重写、降级成单条原查询）
│   │   │   ├── delivery.ts           # 跨轮去重、召回账本、访问计数
│   │   │   ├── budget.ts             # 条数上限与上游时间预算收窄
│   │   │   ├── enrich.ts             # 向量命中补全成 SearchHit
│   │   │   └── types.ts              # 对外类型与目录内中间结构
│   │   ├── summary.ts                # 摘要生成与失效
│   │   ├── session.ts                # 建会话 / 加消息 / 提交
│   │   ├── memory.ts                 # 门面：re-export，实现在 memory/
│   │   ├── memory/                   # 记忆读写：文档格式 / 版本 / 复核 / 预取
│   │   │   ├── service.ts            # MemoryService 编排（锁、字段合并、闸门、快照触发）
│   │   │   ├── document.ts           # frontmatter ↔ 结构、保留键、identity → URI
│   │   │   ├── versioning.ts         # 版本快照、MAX_VERSIONS 截断、supersedes 回退
│   │   │   ├── review.ts             # approve / reject 的判定与写回
│   │   │   ├── query.ts              # read 投影、待复核列表、抽取预取
│   │   │   ├── ports.ts              # 端口定义与文件级原语
│   │   │   ├── yaml.ts               # 记忆文件用到的 YAML 子集
│   │   │   └── errors.ts             # INVALID_ARGUMENT 的唯一构造
│   │   ├── acl.ts                    # 授权管理与鉴权入口
│   │   ├── resource.ts               # 资料导入
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
│   │   │   ├── metadata-file.ts      # .meta.json 与兼容导出
│   │   │   ├── summary-file-store.ts # .abstract.md / .overview.md 双写
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
│   │   │   └── provider-error-mapping.ts # 供应商错误 → ComemError，三个适配器共用
│   │   └── log/
│   │       ├── console.ts
│   │       └── file.ts               # 写 error.log
│   │
│   ├── api/                          # ① 接口层：协议转换
│   │   ├── deadline.ts               # 30 秒调用上限（MCP 注册表与 HTTP 检索路由共用）
│   │   ├── health-status.ts          # ok / degraded 判定（/health 与 MCP health 共用）
│   │   ├── text-slice.ts             # 按码点分页（MCP read 与 HTTP content/read 共用）
│   │   ├── http/
│   │   │   ├── routes/
│   │   │   ├── envelope.ts           # 响应封套
│   │   │   └── error-mapper.ts       # 错误码 → HTTP 状态
│   │   └── mcp/
│   │       ├── registry.ts           # 工具注册表
│   │       ├── server.ts             # Streamable HTTP 挂载
│   │       └── tools/                # 15 个工具，一个文件一个
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
│   │   ├── search.vue                # 检索
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
│   ├── servers/  hosts/  lib/        # Hook 入口 / 宿主适配 / 共享骨架
│   ├── dsh-plugin/                   # DSH 原生插件包（取代脚本 hook 那条路）
│   ├── skills/                       # 独立装进宿主的提示词包，不由 CoMem 服务管理
│   └── tests/                        # node --test
│
├── scripts/                          # 质量闸门与运维脚本
│   ├── check-config.ts               # 配置项必须有消费方（L1–L3）
│   ├── check-docs.ts                 # 文档里的 file:line 引用必须指到真实声明
│   ├── check-reachability.ts         # 写了但没接线
│   ├── check-shape.ts                # 行数 ratchet：文件只能变短
│   ├── copy-build-assets.mjs         # 构建后拷非 TS 资源（`pnpm build`）
│   ├── reachability-baseline.json    # 可达性检查基线
│   ├── shape-baseline.json           # 形状检查基线（只允许收紧）
│   ├── e2e.mjs                       # 六条链路端到端演示（`pnpm test:e2e`）
│   ├── demo.mjs                      # 演示辅助进程（等 /health、断言产物）
│   └── dev.mjs                       # 后端 + 控制台一起起（`pnpm dev`）
│
├── tests/
│   ├── unit/                         # 领域层纯函数
│   ├── integration/                  # 适配层：临时目录 + 内存 SQLite
│   ├── helpers/                      # 测试替身（FakeLlmProvider、NullLogger、AllowAllAuthorizer）
│   ├── contract/                     # 端口契约套件（一份套件跑所有实现）
│   └── helpers/                      # 测试替身（不在 src/ 里占导出面）
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

**节点模型不在内存里。** 节点的状态分两处：`node` 表的行（`kind`、`context_type`、`status`、摘要新鲜度四列，§8.1）与文件本身（正文 + frontmatter，§6.7）。`domain/node.ts` 只放不依赖 IO 的规则——`ContextType` / `NodeStatus` 的枚举与守卫、URI → `context_type` 的推导、正文摘要 `stableDigest`。曾经有一对 `Node` 抽象类与 `Document` / `Directory` 子类表达同一棵对象树，生产代码从不实例化（只有测试 `new`），已删除。

## 6. URI 与磁盘布局

### 6.1 URI 格式

```
comem://{scope}/{path}
```

- `scope`：`user` | `group`
- `path`：段用 `/` 分隔，末斜杠表示目录
- 别名 `~`：**MCP 工具层**展开成当前绑定主体的根（`comem://user/{uid}` 或
  `comem://group/{gid}`），只认第一段。展开目标来自 `health` 返回的 `subject`，
  工具调用之间没有状态，Agent 靠它拼绝对 URI（§13.2）。`Uri.parse` 本身在没有主体
  时拒绝 `~`（`INVALID_URI`），**不兜底到 `user:local`**——空库上猜错的根会让写入
  落进别人的空间。

### 6.2 规范化

`parseUri` 之后必须走 `canonicalize`：

1. 段做 Unicode NFC 规范化
2. 合并重复斜杠，去掉末尾斜杠（目录判断由结尾是否带 `/` 决定，不靠路径猜）
3. 拒绝 `.` 与 `..` 段
4. 拒绝控制字符（`\u0000`–`\u001f`）与 `\`
5. 单段 UTF-8 字节数 ≤ 255
6. 拒绝保留名：`.abstract.md`、`.overview.md`、`.acl.json`、`.meta.json`、`.done`、`memory_diff.json`、`memory_operations.json` 不能作为普通文件名写入

**为什么规范化必须唯一。** 权限按路径记录。同一文件有两个路径，就有两套权限，其中一套一定是错的。大小写、软链接、`..` 全部在规范化层解决，鉴权层只看规范化后的结果。

### 6.3 两个根 + 项目维度

**根**决定归属，**项目**决定作用域。两者正交。

| 根 | 预置 ACL | 子树 |
|---|---|---|
| `comem://user/{uid}/` | `user:{uid} = manage` | `memories/` `resources/` `sessions/` `projects/` |
| `comem://group/{gid}/` | `group:{gid} = write` | `memories/` `resources/` `projects/` |

组的根和三个基础目录在创建组时立即物化为索引与权限行。容器启动时会扫描已有组，认证请求命中组主体时也会再次检查；旧版本留下的缺目录、缺索引或缺权限行会就地补齐。

项目是根下面的二级命名空间，结构跟根同构（少 `sessions/` 和 `projects/`）：

```
comem://user/alice/projects/comem/
├── memories/
└── resources/

comem://group/eng/projects/comem/
├── memories/
└── resources/
```

`sessions/` 只出现在根下：会话属于个人，一段对话是谁说的不能共享到组，更不能挂到项目上。

### 6.4 为什么需要项目这一层

没有项目层的话，alice 同时做 CoMem 和另一个项目，两边记忆全混在 `user/alice/memories/` 下。检索无法按项目收窄，只会把不相干的记忆一起捞出来——这是最伤使用体验的地方。

**项目的语义**：一个稳定的上下文作用域。同一个仓库的不同 clone、worktree、子目录都归到同一个项目。

**当前实现边界。** 项目 URI 可以显式传给写入与检索接口，但宿主接入尚未实现从 git origin 或 `.comem/config.json` 自动绑定当前项目。自动采集默认使用个人根，默认召回范围包含可读根的子树；因此当前不能把目录位置当成“只召回当前项目”的保证。项目自动识别与兄弟项目排除仍待接线。

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
│       │       │   ├── cases/
│       │       │   │   └── mips-sll-datapath.md
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
│                   │   ├── memory_operations.json
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
        └── resources/
```

**旧版 `skills/` 的兼容口径。** 已有数据根里可能仍有 `skills/`。CoMem 不再预建、
安装、识别或提供该类目录，也不会删除其中的文件；重建索引时它按普通 `resources`
路径处理。宿主要分发提示词包时，直接使用仓库 `integrations/skills/` 的独立包，
由宿主自己的 skills 目录加载。

**归档目录里哪些文件可见。** `archive_NNN/` 下的 `.meta.json`、`.abstract.md`、
`.overview.md`、`.done`、`memory_diff.json`、`memory_operations.json` 是保留名
（§6.2 规则 6）：它们是归档的元数据，`Uri` 构造不出普通路径段，`list` / `tree`
也不返回。**`messages.jsonl` 是唯一的非保留名文件**，也是用户唯一能读的归档内容
——它和普通文档一样有 `node` / `node_fts` / `node_permission` 行，`list` /
`tree` / `glob` / `read` 都能到达；live 会话目录里的 `messages.jsonl` 同理。阶段
一写完之后由 `SessionService` 通知 `IndexObserver`（见 §8.2），不依赖阶段二的摘要
生成。

### 6.6 文件内容示例

**`user/alice/memories/preferences/code-style.md`** —— 一条记忆

```markdown
---
memory_type: preferences
topic: code-style
uri: comem://user/alice/memories/preferences/code-style
valid_from: 2026-11-05T16:40:00Z
sources:
  - comem://user/alice/sessions/s1/history/archive_001
status: active
created_at: 2026-10-28T09:12:00Z
updated_at: 2026-11-05T16:40:00Z
---

## content

用户偏好 TypeScript 严格模式、2 空格缩进、函数式写法优先于类继承。不喜欢为单一实现预留接口。
```

**`sources` 为空时不写这个键。** 没有溯源信息的记忆（W97 之前的存量、不由归档产生的写入）与改动前逐字节相同。

实体文件可增加服务端分配的 `entity_id` 与用户可纠正的 `aliases`；任意记忆可有 `entity_refs`，指向相关实体 ID。非 `derived_from` 的显式关联写作 JSON 字符串数组 `memory_links`，每项带 `toUri`、`linkType`、`weight`、`matchText` 与 `description`。它们随正文以外的 frontmatter 一起写入 Markdown、可手工检查；不把实体编号放进 URI，也不把设备现状拆成三元组。普通编辑、复核、版本、合并、移动和索引重建均保留这些键。`memory_links` 的确切编码由 `src/domain/stored-memory-link.ts` 校验。

**`valid_from` / `valid_until` / `supersedes` 是三个保留键，只能由服务端写。** 它们不在
`schema.fields` 里，值来自 `MemoryDocument` 的元数据：

- `valid_from`：这一版从何时开始有效。`upsertMemory` 每次写入都写，值是本次写入时刻；
  `approve` / `reject` 也是整份重写，但沿用读到的值（复核与回退不改变「从何时开始
  有效」）。
- `valid_until`：只有旧值快照（`.history` 版本文件）写；非空表示「已失效」，检索默认
  过滤掉。当前值不写这个键。
- `supersedes`：被这条记忆顶替掉的版本文件 URI；`reject` 时回吐的目标。没有顶替任何
  版本时不写这个键。

模型改不了它们：`parseMemoryDocument` 把保留键从 `fields` 里剔掉
（`src/services/memory/document.ts`），`serializeMemoryDocument` 只写 `schema.fields` 与保留键
（同文件），三个键的值取自 `MemoryDocument` 的元数据字段，不从 `fields` 读。`fields` 里出现
同名键也不会落盘——整份重写时被丢弃。保留键集合是同文件的 `RESERVED_KEYS`。版本文件的完整
语义见 §11.11。

**`user/alice/memories/.abstract.md`** —— 这个目录的 L0

```markdown
---
uri: comem://user/alice/memories
generated_by: llm
generated_at: 2026-11-05T16:41:02Z
degraded: false
---

alice 的长期记忆：代码风格偏好、CoMem 项目背景、2026-11-05 的架构决策，以及一条待复核的 monorepo 迁移经验。
```

**`user/alice/memories/.overview.md`** —— 这个目录的 L1

```markdown
---
uri: comem://user/alice/memories
generated_by: llm
generated_at: 2026-11-05T16:41:02Z
degraded: false
---

# alice 的长期记忆

alice 的代码风格偏好、正在做的 CoMem 项目，以及最近一次架构决策的记录。

## 快速导航

- `profile.md` —— 基本信息与角色
- `preferences/` —— 按话题组织的偏好
- `entities/` —— 项目、组织等实体
- `events/` —— 决策与里程碑
- `cases/` —— 具体任务的尝试、参数与结果
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

### cases/mips-sll-datapath.md

一次具体任务的输入、实际尝试和仿真结果。它不自动升级为通用经验。

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

会话的 `messages.jsonl` 中每条消息可带 `source: {host, machineId, cwd}`，HTTP 写入与磁盘重读均保留。新插件以机器名与 home 路径的哈希标识安装环境；这不是硬件身份，也不能判断当前执行位置是主力电脑、服务器还是容器。旧消息没有来源时不猜机器归属。归档仍受会话 ACL 保护，分享记忆结论不会自动分享其原始消息。

抽取保留 user/assistant 角色、来源和时间，忽略 system 文本。任意工具结果不进入个人事实抽取；只允许 shell 执行的 `cat /etc/os-release`、`uname -s`、`uname -m`、`cat /sys/class/dmi/id/product_name` 的有界结构值形成「当前执行环境观察」。复合命令、错误结果和其它输出不进入观察，观察不证明设备属于用户。经验归纳仍隐藏全部工具部分。没有可抽取材料时不调用模型或预取，写出可重放的空操作产物。原始工具输出仍可能存在归档中，这不是归档脱敏功能。

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
  "stepsDone": ["archive_summary", "memory_extract", "memory_merge", "summary_invalidate", "dreamer"],
  "skippedSteps": [],
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
| `.meta.json` | 会话与归档的元数据（进度、步骤、任务 ID） | `SessionService` |
| `.done` | 归档完成的唯一信号（§10.1） | `CommitPipeline` |
| `memory_diff.json` | 这次归档抽取出了哪些记忆操作 | `MemoryMergeStep` |
| `memory_operations.json` | 抽取步骤的产物，重放时恢复 `state`（§10.4） | `MemoryExtractStep` |

**七种元数据文件的读写全部在 `adapters/fs/metadata-file.ts` 与 `adapters/fs/acl-file.ts`。** `services/` 只声明它需要的方法，具体落盘由适配层做——这条不是为了好看：`services/` 一旦碰 `node:fs`，它下面对 `domain/` 的所有判断就没法用内存数据穷举测试了（§4.2）。

**`.meta.json` 有两种形状**：会话级（`sessionId` / `commitCount` / `pendingTokens`）与归档级（`archiveId` / `phase1` / `stepsDone` / `skippedSteps` / `taskId`），见 §6.6。同一个文件名承载两种结构，靠路径区分——归档在 `history/archive_NNN/` 下。

**文件级摘要不另存档，写在文件自己的 frontmatter 里。**

```markdown
---
summary: URI 规范与路径规范化规则
---

# URI 规范
...
```

这样摘要跟着文件走：移动、复制、备份都不用额外维护。重建索引时扫一遍文件头就够，一次 LLM 都不调。文档层只建模 `summary` 一个字段，其余键写回时原样保留。

画像的 L0 从全部事实条目按原顺序拼接，去掉条目标记与归档日期，在 256 字符内保留完整事实并标出省略。写入、索引重建和 `/content/abstract` 都使用同一规则，详情直接读当前正文，因此存量画像不必重写就能显示更新后的提要。完整带日期的事实仍以 L2 为准。这些操作不调用模型。

**文件摘要的失效不写在文件头上。** `write` / `edit` 改动正文后，写入路径调 `SummaryService.markStale(父目录)`（`src/services/write-through.ts`）；基线摘要、生成输入 digest、待刷新计数与生成时的直接子项数存在索引的 `node.summary_baseline` / `node.summary_input_digest` / `node.summary_pending` / `node.summary_entries` 四列（§8.1）。是否立刻重算由 §9.3 的阈值判定，只记脏的目录等下一次改动再判定。

**边界：只有 Markdown 支持。** 代码、JSON、纯文本没有统一的 frontmatter 语法（`#` 在 Python 是注释，在 C 里是预处理指令），强行加会破坏原文。这类文件的摘要存在索引的 `node.abstract` 字段里，重建时重算。资源目录里文档占绝大多数，代码文件重算是可接受的成本，不为了统一而污染原文。

统一格式：YAML frontmatter + Markdown 正文。**类型层只建模已知字段**（普通文件只有 `summary`），未知键在写回时原样保留——`content-store` 与 `metadata-file` 都先读磁盘上的现有键再合并，`parseDocument` 的往返稳定性也依赖这一点。普通 `ls` 不显示这三个文件；只有显式 `read` 才返回原始内容，`abstract` / `overview` 接口只返回正文。

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
| 没有跨文件事务 | 先写内容再更新索引；索引失败时追加 `_meta/reconcile.log`，启动时与调度器每一轮重放（§10.6） |
| 写入需要先 mkdir | `write` 内部自动建父目录，调用方不用关心 |

**反查表也是派生数据，以文件为准。** `acl_entry` 从 `.acl.json` 推出，只服务授权反查（控制台 ACL 页、删账号撤权）。它可能不全：手工改过文件、`mv` 之后丢过行、从备份恢复过文件。`AclService.purgePrincipal` 因此不能只按表找目录——它取「反查表行 ∪ 数据根下所有带 `.acl.json` 的目录」的并集，文件里没有该主体就只删行、不写盘。扫描有目录数上限（`MAX_PURGE_SCAN_DIRECTORIES = 10000`，经验假设：撤权是低频管理操作，10,000 个目录在本地 SSD 上约亚秒级；超出时记 `truncated: true` 并继续，残余风险见 `docs/operations.md` 的已知限制）。

**派生数据的三个通知入口。** 内容写完之后由 `IndexObserver` 把索引与物化权限追上来。它对外只有三个方法，对应三种磁盘状态变化：

| 入口 | 什么时候 | 做什么 |
|---|---|---|
| `onNodeWritten(uri, kind)` | 单个节点被创建或覆盖 | 写该节点的索引 → 物化它自己与祖先目录的权限 → 父目录摘要标脏 |
| `onNodeRemoved(uri)` | 节点被删除 | 删整棵子树的索引 / 物化权限 / 向量 → 父目录摘要标脏 |
| `onNodeMoved(from, to)` | 节点被移动 / 改名 | 遍历 `to` 的整棵子树重建索引、物化权限与授权反查（`acl_entry`），删掉 `from` 前缀的行 → 源与目标的父目录各标脏一次 |

**`move` 必须是一次通知，不能拆成「按 `from` 删除 + 按 `to` 写入」。** 拆开时目标路径只重建根节点自己，子项一条都不出现：文件在磁盘上还在，`tree` 却只剩一个空目录，`find` 搜不到，而且不报错。一次通知还让整棵子树只走一遍磁盘、只做一次索引事务、只投递两次摘要失效（源与目标各一次），而不是每个子项各一次。

**反查表也要跟过去。** `deleteSubtree(from)` 会删掉源子树的 `acl_entry`，而 `materializeNode` 只写 `node_permission`。少了「按目标 URI 从 `.acl.json` 重建 `acl_entry`」这一步，`purgePrincipal` 反查不到那个目录，删账号撤不掉文件里的授权，同 ID 重建的账号继承旧权限。只对目录做：文件没有自己的 `.acl.json`，目标侧没有文件时直接跳过——按文件为准。

**每个派生存储各一步 `try/catch`。** 四件事写在同一个 `try` 里时，任何一步抛错都会让后面的步骤全部跳过。默认配置（`providers.embedding.type === 'disabled'`，`node_embedding` 表不存在）正好会踩中：删节点时向量清理抛 `no such table`，父目录的物化权限与摘要失效静默丢失。

## 8. 索引与检索

### 8.1 SQLite 表

```sql
-- 节点索引：检索与 stat 的读模型。一行 = 一条检索行，一个 URI 最多两行（见下表）
CREATE TABLE node (
  uri            TEXT NOT NULL,
  parent_uri     TEXT NOT NULL,
  scope          TEXT NOT NULL,      -- user | group
  kind           TEXT NOT NULL,      -- directory | document
  context_type   TEXT NOT NULL,      -- memory | resource | session
  memory_type    TEXT,               -- profile | preferences | entities | ...
  -- 这一行**自己**的层级：'L0' | 'L1' | 'L2'，存字面量不存 0/1/2
  level          TEXT NOT NULL,
  abstract       TEXT,
  body_digest    TEXT NOT NULL,
  size           INTEGER NOT NULL,
  updated_at     TEXT NOT NULL,
  status         TEXT NOT NULL,      -- active | pending | archived
  -- 记忆的有效区间（§11.11）。ISO 8601 UTC（Date#toISOString() 形态），TEXT
  -- 比较即时间比较。NULL = 这一侧没有边界：valid_from 无下界、valid_until 仍有效
  valid_from     TEXT,
  valid_until    TEXT,
  -- 目录摘要的新鲜度（§9.3）。只在 kind = 'directory' 的行上有意义
  summary_baseline TEXT,             -- 当前摘要基于哪份 L0 正文（digest）
  summary_input_digest TEXT,         -- 上次生成实际使用的目录输入（digest）
  summary_pending  INTEGER NOT NULL DEFAULT 0,   -- 未消费的变更次数
  summary_entries  INTEGER NOT NULL DEFAULT 0,   -- 生成摘要时的直接子项数
  -- 访问热度（§17.5 的热度衰减输入）与 TTL 的判据（§11.7）：记忆的最后使用
  -- 时刻是 max(updated_at, last_accessed_at)，不另存绝对过期时刻
  access_count     INTEGER NOT NULL DEFAULT 0,
  last_accessed_at TEXT,
  PRIMARY KEY (uri, level)            -- 目录有 L0 与 L1 两行，主键必须是两者的组合
);
CREATE INDEX node_parent ON node(parent_uri);
CREATE INDEX node_scope  ON node(scope, context_type);
CREATE INDEX idx_node_last_accessed ON node(last_accessed_at);

-- 全文检索
-- 注意 content / abstract 存的是「切分后」的文本，不是原文（见下面的中文切分）
CREATE VIRTUAL TABLE node_fts USING fts5(
  uri UNINDEXED,
  -- 与 `node` 行的层级对齐。一个 URI 两行时，只按 uri 关联会把两条匹配交叉成四条
  level UNINDEXED,
  abstract,
  content,
  tokenize = 'unicode61 remove_diacritics 2'
);

-- 物化的有效权限：写入 ACL 时算好，检索时直接查
CREATE TABLE node_permission (
  node_uri   TEXT NOT NULL,
  principal  TEXT NOT NULL,          -- user:alice | group:eng | user:*
  level      INTEGER NOT NULL,       -- 1 read | 3 write | 7 manage
  effect     TEXT NOT NULL DEFAULT 'allow',  -- allow | deny
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
CREATE INDEX task_type_status ON task(type, status);
CREATE INDEX task_created ON task(created_at);

-- 嵌入模型的元数据（`0001_init.sql`）。虚拟表 `node_embedding` 的维度建表时固化，
-- 而维度来自配置，所以单独一行记「库里存的是哪个模型、多少维」。
-- 启动时比对：不一致就报错提示跑 reindex——静默跳过会让语义检索永久返回空。
CREATE TABLE embedding_model (
  id         INTEGER PRIMARY KEY CHECK (id = 1),   -- 单行表
  model      TEXT NOT NULL,
  dimension  INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

-- 嵌入缓存（`0001_init.sql`）。**不是索引**，是「这份正文嵌过没有」的跨进程记忆。
-- 两张表的分工见下面「node_embedding 与 embedding_cache 的职责边界」。
-- 派生数据：可以随时清空，清空只让下一次重新打供应商，结果逐位相同。
CREATE TABLE embedding_cache (
  model          TEXT NOT NULL,   -- 进主键：不同模型的向量不可比，换模型必须全量重算
  content_digest TEXT NOT NULL,   -- 进主键：同一段正文只嵌一次
  vector         BLOB NOT NULL,   -- Float32Array 原始字节
  dimension      INTEGER NOT NULL,  -- 与配置不一致的行当未命中
  created_at     TEXT NOT NULL,   -- 淘汰按它升序（FIFO）
  PRIMARY KEY (model, content_digest)
);
CREATE INDEX idx_embedding_cache_created ON embedding_cache(created_at);

-- 用户与组目录（§12）。`acl_entry` / `node_permission` 存的是
-- `user:{uid}` / `group:{gid}` 字符串；这三张表是组员关系与
-- `GET /admin/*` 的数据来源。
--
-- 表名加 `app_` 前缀：`user` 是 SQLite 关键字，`group` 是 `GROUP BY` 的关键字。
-- 加引号能用，但漏一次就是语法错误。
CREATE TABLE app_user (
  id            TEXT PRIMARY KEY,
  display_name  TEXT NOT NULL,
  email         TEXT,
  status        TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  password_hash TEXT,               -- 用户名密码登录（§12.7）
  session_epoch TEXT NOT NULL DEFAULT ''  -- session token 的身份版本（§12.7）
);

CREATE TABLE app_group (
  id            TEXT PRIMARY KEY,
  display_name  TEXT NOT NULL,
  description   TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  -- 组的 owner（§12.6）。删用户是删主体不是删组，置 NULL 保留组。
  owner_user_id TEXT REFERENCES app_user(id) ON DELETE SET NULL
);

-- 组成员关系。**不参与授权求值**——ACL 只认 `group:{gid}` 字符串。
-- 这张表用于控制台展示，以及「删用户时清掉它的成员关系」。
-- 外键 ON DELETE CASCADE 保证绕过用例的直接删行也收口。
CREATE TABLE group_member (
  group_id TEXT NOT NULL REFERENCES app_group(id) ON DELETE CASCADE,
  user_id  TEXT NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  role     TEXT NOT NULL CHECK (role IN ('owner', 'member')),
  added_at TEXT NOT NULL,
  PRIMARY KEY (group_id, user_id)
);
CREATE INDEX idx_group_member_user ON group_member(user_id);

-- API Key（§12.7）。user_id 外键 ON DELETE CASCADE。
CREATE TABLE api_key (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  key_hash   TEXT NOT NULL,
  prefix     TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  revoked_at TEXT
);
CREATE INDEX idx_api_key_user ON api_key(user_id);
```

**一个 URI 在索引里最多有几行。** `node` 的主键是 `(uri, level)`，因为「索引行」与
「节点」不是一对一：目录可检索的文本有两段（L0 摘要、L1 概览），两段的信噪比不同，
必须各自成为一条 FTS 行，§8.5 的层级权重才有作用对象。

| 节点 | 行 | `level` | `abstract` | `content`（进 `node_fts`） | `levelWeight` |
|---|---|---|---|---|---|
| 文件 | 1 | `L2` | frontmatter 摘要 | 正文 | 1.00 |
| 目录 | 1 | `L0` | L0 摘要 | 空 | 1.15 |
| 目录 | 2 | `L1` | L0 摘要（展示用，与上一行相同） | L1 概览正文 | 1.05 |

- **最多两行**，且只有目录有第二行。`SummaryService.#persistSummary` 在同一个事务里
  写这两行（`src/services/summary.ts`），所以概览改了就同时改，不存在「摘要新、概览旧」。
- **L1 行的 `node_fts.abstract` 列是空的**：L0 是从 L1 正文提取的（§9.1），概览正文
  已经包含它；同一段文字进两列会让 `bm25()` 把同一处匹配算两遍（它按列累加词频）。
  `node.abstract` 仍然存 L0 原文，检索结果展示的是那一列。
- **「节点自身那一行」= `NOT (kind = 'directory' AND level = 'L1')`**。这一个谓词在
  源码里存在两份：`adapters/sqlite/node-repository.ts` 的 `nodeSelfRowSql()`（适配层
  内所有仓储都调它）与 `services/observability.ts` 的 `NODE_SELF_ROW` 常量。分两份是
  分层的代价——`services/` 不能 import `adapters/` 的值（§4.2），而 `domain/` 不该知道
  SQL 片段；`identity.ts` 与 `fs/path.ts` 的 `RESERVED_NAMES` 是同一处境的先例。
  两份由 `tests/integration/sqlite/node-self-row-consistency.test.ts` 做行为级对拍
  （逐 `kind × level` 比对筛出的 URI 集合），改了其中一份而没改另一份会红。
  按 URI 读节点的路径（`get` /
  `descendants` / `stat` / 热度 / `glob` / TTL 候选）都带这条谓词，否则一个目录会变成两条节点：`tree` 出现重复、`metrics` 的
  `comem_index_nodes` 虚高、`sweepExpired` 把同一个目录返回两次。
- **归档、过期、删除是按 URI 的**：`sweepExpired` 的状态转移、`deleteByUri` 的删除
  都会覆盖同一个 URI 的两行——只改 L0 行会让已归档的目录继续从概览正文里被检索到。
- **概览行只在 FTS 臂上**：向量臂按 URI 一条（`node_embedding` 的主键是 `uri`），
  目录本来就不产生向量，L1 也不会。代价是纯语义查询（`retrieval.engine: vector`）
  命不中概览正文，只有 `fts5` / `hybrid` 的 BM25 臂能命中。要让概览参与语义检索，
  需要把 `node_embedding` / `vec0` 的主键改成 `(uri, level)` 并给摘要服务接嵌入——那是
  另一个迁移，不在本次范围内。

**`valid_from` / `valid_until` 是记忆的有效区间（`0007_node_validity.sql`）。** 一条记忆
被覆盖后旧值仍留在磁盘上（`.history` 版本文件，§11.11），`node` 里也多出一行；检索默认
看不到它，靠的就是这两列。判据是半开区间 `valid_from <= now < valid_until`。NULL 表示
**这一侧没有边界**：`valid_from` 为 NULL 即不设下界（迁移前的存量行都读成这样），
`valid_until` 为 NULL 即仍然有效；过滤时按「该侧不设条件」放行，不是「值缺失所以这一列
不可信」。对存量行，没有下界也等于「不知道从何时开始有效」——两种说法在过滤行为上是
同一件事。旧行不重写：`ADD COLUMN` 只补 NULL，所以本迁移之前写入的每个节点自动是无界，
检索行为与迁移前逐字相同。两列都存 `Date#toISOString()` 形态，带偏移的手写值由
`parseValidityInstant` 归一化后再写。**不建索引**：查询入口永远是 `node_fts MATCH` 或
`n.uri` 的 GLOB 范围，这两列只作为逐候选行的谓词；迁移注释里记了 5000 行的
`EXPLAIN QUERY PLAN` 实测，建索引后两条 plan 不变，只多出每次 `upsert` 的两棵 B 树维护。

这两列（连同 `supersedes`）在 HTTP 上的出口是待复核列表与单条记忆元数据：
`GET /memories/pending` 总是输出 `validFrom` / `validUntil` / `supersedes` 三个键；
`GET /memories/{uri}` 按 URI 输出 `validFrom` / `validUntil`（不带 `supersedes`，那个只服务
于拒绝时的回退提示）。两处都是无值时显式 `null` 而不是省略键（§12.4）。已生效的记忆因此
也能在控制台看到有效期。

**迁移清单**（`src/adapters/sqlite/migrations/`）：

| 序号 | 文件 | 内容 |
|---|---|---|
| 0001 | `0001_init.sql` | 完整初始 schema（唯一建表脚本，版本号 1） |
| 0002 | `0002_archived_at.sql` | `node.archived_at`（TTL 两段式，§11.7） |
| 0003 | `0003_memory_link.sql` | `memory_link`（记忆之间的关联，§11.10） |
| 0004 | `0004_node_level_rows.sql` | `node` 主键改 `(uri, level)`、`node_fts` 加 `level` 列：目录的 L1 概览行 |
| 0005 | `0005_sliding_ttl.sql` | 删 `node.expires_at` 与 `idx_node_expires`：TTL 判据改为清扫时现算（§11.7） |
| 0006 | `0006_drop_request_log_indexes.sql` | 删 `request_log` 的 `status_code` / `request_id` / `subject` 索引：这张表没有读出口（§17.6） |
| 0007 | `0007_node_validity.sql` | `node.valid_from` / `node.valid_until`：记忆的有效区间，NULL = 无界（§11.11） |
| 0008 | `0008_bootstrap_admin.sql` | 首个管理员引导令牌 |
| 0009 | `0009_memory_structure.sql` | `memory_entity` / `memory_alias` / `memory_entity_ref` 与旧链接逐起点迁移标记 |
| 0010 | `0010_llm_call_log.sql` | `llm_call_log`：按认证主体查询的逐次 LLM 用途、模型、token、耗时与结果（§17.4） |
| 0011 | `0011_summary_input_digest.sql` | `node.summary_input_digest`：非 force 刷新在调用模型前比较目录输入（§9.3） |

**为什么只有一个文件。** 早期是 18 个增量迁移，其中 0016–0018 是「修前面迁移 bug」的
补丁（`session_epoch`、身份表外键、组 owner 外键）。项目没有存量用户、不需要从 0001
一路 migrate 上来，补丁历史只增加阅读负担——新读者要读 18 个文件才能拼出最终结构。
这些迁移已经合并成 `0001_init.sql`：一次 `runMigrations` 从空库建出最终 schema，版本号 1。

**此后每次 schema 变更新增一个迁移文件**（`NNNN_描述.sql`，`NNNN` 从 0002 起递增），
不再改 `0001_init.sql`。`runMigrations` 按文件名前缀的数字解析版本号，逐版应用未执行过的
迁移；`schema_version` 表由 `runMigrations` 自己创建，不写进迁移文件。

`0001_init.sql` 里包含的表（最终结构，被补丁合并进来的部分已就地写进建表语句）：

- `app_user`（含 `password_hash`、`session_epoch`）/ `app_group`（含 `owner_user_id` 外键
  `ON DELETE SET NULL`）/ `group_member`（`ON DELETE CASCADE`）/ `api_key`（`ON DELETE CASCADE`）
- `node`（含摘要新鲜度四列、`access_count` / `last_accessed_at`）及其索引、
  `node_fts`（FTS5）。`expires_at` 已由 0005 删除（§11.7 的滑动窗口改为清扫时现算）
- `node_permission`（含 `effect`）/ `acl_entry`
- `task` / `request_log`；`llm_call_log` 由 0010 新建
- `embedding_model` / `embedding_cache`
- `ingest_cursor` / `prompt_override`

**`node_embedding` 与 `embedding_cache` 的职责边界。** 两张表都不是真相（文件是真相，§7），但它们回答的问题不同：

| 表 | 主键 | 回答的问题 | 谁读 | 删掉会怎样 |
|---|---|---|---|---|
| `node_embedding` | `uri` | 这个**节点**的向量是不是最新的 | 检索（`find` / `search` 的向量召回） | 语义检索返回空，直到回填 |
| `embedding_cache` | `(model, content_digest)` | 这份**正文**嵌过没有 | 嵌入服务（写路径、检索查询、回填） | 下一次嵌入重新打供应商，结果逐位相同 |

`node_embedding` 的按 URI 去重只能回答「这个地址写过没有」。同一段正文出现在两个 URI 下（复制一份记忆、把同一份规则挂到两个项目）、同一条查询被重复执行、`pnpm eval` 重跑同一批语料——这三种场景在 URI 维度上都未命中，却是同一份正文。`embedding_cache` 补的就是这一段。

**缓存不跨模型，也不跨维度。** `model` 进主键：不同模型的向量空间不可比，换模型时旧行自然全部未命中，不需要任何清理动作（与 `node_embedding` 的 `model = ?` 过滤同一个语义）。`dimension` 单独一列：模型名没变而维度改了（配置写错、换了量化版本）时主键仍然命中，读路径比对维度后当未命中并记 `warn`——直接把长度不对的向量返回，`assertValidVector` 会在写 `node_embedding` 时抛错，而写入路径不该因为缓存坏掉而失败。

**容量与淘汰。** 默认上限 20,000 条（`providers.embedding.cache.maxEntries`），超了按 **FIFO**（`created_at` 升序）淘汰。选 FIFO 而不是 LRU 的理由是**不在命中路径上写库**：LRU 要在每次命中时更新「最近使用时间」，而命中是写路径上最热的操作，为了一次淘汰把它变成写事务不划算。失效场景要说清楚：一份很早插入、之后被反复命中的正文，会先于一份只嵌过一次的近期正文被淘汰——错判只影响命中率，下一次重新打一次供应商即可，不影响数据。20,000 的来源：1024 维每行约 4 KiB（共约 80 MiB），1536 维约 120 MiB，是「磁盘不是无限的」这一条下的保守取值；它覆盖 100 倍于 `pnpm eval` 的语料量（52 篇 + 105 条查询），再大的库靠供应商调用补。

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

// 查询侧：按空白切词，每个词切分后包成 FTS5 短语，词之间 AND
function toMatchExpression(query: string): string | null {
  const terms = query
    .split(/\s+/)
    .map((word) => segmentForIndex(word))
    .filter((word) => /[\p{L}\p{N}]/u.test(word))
    .map((word) => `"${word.replace(/"/g, '""')}"`);
  return terms.length === 0 ? null : terms.join(' AND ');
}
```

**为什么不是整串一个短语**：整串包短语要求字符**连续**出现，`重试 网关层 支付` 会被当成「文档里必须原样出现 `重试网关层支付` 这一段」，于是任何多词查询都召回 0。按空白切词后，每个词内部仍是「字符相邻」的短语（保住精度），词之间是合取（每词都必须出现）——`AND` 而不是 `OR`，因为 `OR` 会让「的」这类虚词把几乎所有文档拉进候选集，把精度全压给 BM25，抹平 §8.5 里词法臂与向量臂的分工。

单字会拉低 BM25 的区分度（虚词「的」「在」到处都是），但**短语匹配要求字符相邻**，精度是够的。真正的排序靠 §8.5 的层级加权和后续的 rerank。

**词法检索的边界**：无空格中文短语要求连续；自然语言问句含文档没有的词时，`AND` 合取也可能返回 0。默认 `hybrid` 用 embedding 补充语义召回，FTS5 保留精确词匹配。

**索引里存的是切分后的文本，不是原文。** `node_fts.content` 只服务于匹配，`snippet()` / `highlight()` 不用（返回的是 `abstract` 与 URI，摘要来自 `node` 表）。原文在磁盘上，`read` / `grep` 走文件系统，不走这张表。

**查询里的 FTS5 元字符必须转义。** `"` `*` `(` `)` `-` `:` `^` 和 `AND` / `OR` / `NOT` 都会改变查询语义，用户输入里完全可能出现。**每个词**包成短语 + 词内双引号双写，是唯一安全的做法：短语里的元字符退化为字面量，用户输入无法改变表达式结构。切词后没有可检索字符的词（纯标点）直接丢弃——空短语在 `AND` 里恒假，会把整个查询变成 0 命中。

### 8.2 权限为什么要物化进索引

**「先取候选，再逐条 open 祖先 `.acl.json` 求权」有两个硬伤：**

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
      AND (p.level & 1) = 1                     -- read（读位测试，与 levelSatisfies 同义）
      AND p.effect = 'allow'
  )
  AND NOT EXISTS (
    SELECT 1 FROM node_permission d
    WHERE d.node_uri = n.uri
      AND d.principal IN ('user:alice', 'user:*', 'group:eng')
      AND d.effect = 'deny'
  )
ORDER BY rank
LIMIT ?;
```

**`level` 用读位测试，不用 `>=`。** 两份 SQL（`retrieval-index.ts` 的 `permissionPredicate`、
`permission-repository.ts` 的 `readableUris`）与单节点读路径必须是同一个判定，所以谓词写成
`(p.level & 1) = 1`。规范级别 1 / 3 / 7 下它与 `p.level >= 1` 等价；库里出现 `level = 2` / `6`
这类读位为 0 的非规范行时两者分叉——`>=` 说可读、位测试说不可读，症状是「列表里有、点进去
读不了」。这种行 API 写不出来（`isAclLevel` 只认 1 / 3 / 7），只可能来自手改库；两侧一致由
`tests/integration/sqlite/permission-visibility-consistency.test.ts` 对拍（含 `level = 2` /
`5` / `6`）。

**单节点读路径求的是级别位并集，不是 `MAX(level)`。** `PermissionRepository.maxLevel` 把命中
的 allow 行逐行 `granted |= level`，再把结果交给 `domain/acl.ts` 的 `levelSatisfies` 做位测试。
`MAX` 只在规范级别 1 / 3 / 7 上等于并集：同一个节点上有 `{user:bob = 1, group:eng = 4}` 时
`MAX` 取 4、读位是 0，而 `readableUris` 会因为 bob 那一行读位为真而放行——`check` 与检索的
可见集合必然分叉。位并集保留每个位，在规范数据上与 `MAX` 同值，在非规范组合下与列表路径同
结论。这类非规范行同样写不出来（`isAclLevel` 只认 1 / 3 / 7），只可能来自手改库；并集是让读
路径与列表路径给出同一答案的那个定义，不是为「让非规范数据变得可读」而放宽判据。

**`effect` 列不能省，否则 deny 在检索路径上完全失效。** 链式求值（§12.2）是正确的，但检索走的是物化表。只有 `level` 的话，`restricted` 节点上「`user:* = allow read` + `user:alice = deny`」会物化成一行 `(N, 'user:*', 1)`，alice 命中通配行就读到了本该被拒绝的节点——跨用户越权，而且不报错。

加 `effect` 之后：`user:*` 物化成通配 allow 行，被拒绝的具体主体物化成 deny 行。alice 同时命中 allow 与 deny，deny 赢；bob 只命中 `user:*`，允许。通配与精确拒绝因此能共存。

**代价是 `principals` 要绑两次**（外层 allow 一次、内层 deny 一次），不是三次——`p.effect = 'allow'` 是字面量。

**路径范围必须用 `GLOB`，不能用 `LIKE`。** 两个原因，第二个是安全问题：

1. `LIKE` 对 ASCII 大小写不敏感。URI 只做 Unicode NFC 规范化，不折叠大小写，所以 `comem://user/Alice` 和 `comem://user/alice` 是**两个不同的用户**。用 `LIKE` 的话，`alice` 的范围查询会把 `Alice` 的子树一起捞出来——这是跨用户越权。
2. `LIKE` 的 `_` 和 `%` 是通配符，而 URI 段允许这两个字符（§6.2 只拒斜杠、控制字符、`.`、`..`、保留名）。一个叫 `a_b` 的目录会让范围查询匹配到 `axb`。`GLOB` 的 `*` `?` `[` `]` 同样要转义，但转义规则集中在 `node-repository.ts` 一处。

**`level` 存 `'L0'|'L1'|'L2'` 而不是整数。** 领域类型、检索返回值、索引记录三处都是字面量联合，存整数要在每个读写点做一次有损映射。SQLite 的 TEXT 存储开销相对索引体积可以忽略，换来的是「磁盘上看一眼就知道是什么」。

**代价在写入侧。** 改一个节点的 ACL，要重算它所有后代的 `node_permission`。ACL 改动是低频操作（一个项目整个周期可能就改几次），读是高频操作。物化方向必须是「写时算，读时查」。

**重算用事务包住**：`BEGIN; DELETE FROM node_permission WHERE node_uri LIKE ? || '%'; INSERT ...; UPDATE acl_entry ...; COMMIT;`。中途失败整批回滚，`node_permission` 和 `.acl.json` 不会不一致。

**`acl_entry` 是反查索引，不是求权来源。** 求权只读 `node_permission`；`acl_entry` 回答「哪些目录直接写了这个主体」。两者由同一个 `#writeAcl` 一起替换。节点被移动时 `acl_entry` 必须按新 URI 从 `.acl.json` 重建（否则删账号的反查会漏），这条重建在 `IndexObserver.onNodeMoved` 里逐目录执行；没有 `.acl.json` 的节点直接跳过。

**写后物化收在服务层，不在每个路由补一次。** `ResourceService` / `SessionService` / `SummaryService` 都直接写 `ContentStore`（批量路径要一次 `index.upsert`，走不了 `FileSystemService` 的观察者），物化因此由它们自己在写完之后补，但调用入口分两种：`ResourceService` / `SessionService` 对写出的 URI（含逐级建出的父目录）调 `authorizer.assert(uri, WRITE)`——`InheritingAuthorizer` 的写路径缺行时先 `materializeNode` 再求权，这一次调用就是「算一遍」；`SummaryService` 不持有 `Authorizer`，它的依赖是 `acl: Pick<AclService, 'materializeNode'>`，写完摘要后从目标目录逐级向上调 `materializeNode` 直到根（`#materialize`），不做求权。`SessionService` 在每次写 `messages.jsonl`（`create` / `addMessage` / 阶段一步骤 2、4 / 补完中断归档）之后调 `IndexObserver.onNodeWritten`：索引行与逐级物化权限一起补上，归档目录里的「原始对话」本身才可寻址。归档目录（`history/`、`archive_NNN/`）的摘要仍由 `SummaryService` 写索引行与物化权限——阶段一的落盘由 `SessionService` 直接写 `ContentStore`，只写索引行不物化权限的话目录对 `list` / `tree` / `glob` 完全不可见（它们是纯 SQL 查询），而 `stat` 一次又全部恢复——「数据没丢，是权限物化漏了」。HTTP 路由与 MCP 工具只保留对**请求目标**（父目录 / 作用域根）的授权检查，不再各自补一个补偿循环：两套实现迟早在一条路径上漂移，而漏掉的那条路径的症状是「写成功了，树里什么都没有」。

### 8.3 检索接口

接口定义在 `domain/retrieval.ts`（它是领域概念：「给一个查询，返回命中」），实现放在 `adapters/sqlite/retrieval-index.ts`：

```ts
// domain/retrieval.ts
export interface RetrievalIndex {
  upsert(records: IndexRecord[]): Promise<void>;
  deleteByUri(uri: string, options?: { recursive?: boolean }): Promise<void>;
  search(query: SearchQuery): Promise<SearchHit[]>;
  glob(query: GlobQuery): Promise<string[]>;
  stat(uri: string): Promise<NodeStat | null>;
}
```

`SearchQuery` 的字段分两类：**范围与权限**（`text` / `scopes` / `principals`）与**过滤维度**：

| 字段 | 语义 | 下推位置（`retrieval-index.ts`） |
|---|---|---|
| `contextTypes` | 上下文类型（memory / resource / session） | `n.context_type IN (...)` |
| `levels` | 层级 | `n.level IN (...)` |
| `memoryTypes` | 记忆类型；`memory_type IS NULL` 的非记忆节点永远不命中 | `n.memory_type IN (...)` |
| `updatedAfter` / `updatedBefore` | 更新时间**闭区间**（`updated_at >=` / `<=`） | `n.updated_at >= ? / <= ?` |

**没有分数下限。** `SearchQuery` 里没有 `scoreThreshold`：不存在一个能同时适用于 FTS5（`-bm25`，正数无界）、向量（余弦 `[-1, 1]`）、混合（RRF，约 `0.0164–0.0328`）与重排（供应商未归一化分数）四种量纲的阈值——同一个值在三种引擎里分别是「清空」「放行」「随机」。相关性筛选用「排序 + `limit`」；质量门若需要，应放在重排之后按模型分的分布定，而不是在检索接口上开一个跨引擎的绝对阈。

**所有过滤维度都进 SQL 的 `WHERE`、走 `LIMIT` 之前。** 先取候选再在 JS 里筛，会把「类型或时间匹配、但 bm25 / 向量距离排在 `limit × candidateMultiplier` 之后」的节点整批丢掉。`rule_search` 就踩过这个坑：先取 5 条通用命中再按 `memory_type = 'rules'` 过滤，前几条命中是偏好 / 实体时规则全部被挤掉，工具返回 `Found 0`，而库里明明有匹配的规则。

**时间边界是闭区间，且先归一化再比较。** `updatedAfter` / `updatedBefore` 收 ISO 8601 绝对时刻；`node.updated_at` 一律由 `Date#toISOString()` 写入（定长、带 `Z`），所以过滤边界也要归一化成同一形态（`canonicalInstant`），带时区偏移的输入（`2026-11-08T08:00:00+08:00`）才不会被按字符串比较。区间为空（`updatedAfter` 晚于 `updatedBefore`）在进 SQL 之前报 `INVALID_ARGUMENT`。自然语言日期解析不在这一层，也不在当前接口里。

**向量检索的候选集同样在 SQL 里过滤。** `vec0` 的输入是候选 URI 列表：`services/retrieval/arms.ts` 的 `#readableUris` 用 `GlobQuery` 枚举「路径 + 权限 + 上面三个过滤维度」之后的 URI，再交给 `SqliteVectorIndex.search`。因此 `hybrid` 的 RRF 融合发生在两路都已过滤之后——不是先融合、再截断、最后筛。`GlobQuery` 因此也带可选的 `memoryTypes` / `updatedAfter` / `updatedBefore`，它们只为向量候选集枚举存在，MCP / HTTP 的 `glob` 面不暴露。

`principals` 由 `Authorizer` 统一算好传进来，FTS5 实现和向量实现共用同一套权限谓词。

**为什么这个接口要留。** 这是 brief 里唯一一条明确要求预留的扩展点（「查找要做成接口，后续可能要做成向量库」）。其余抽象都按「只有一个实现就地写」处理。

### 8.4 四个检索面

| 面 | 输入 | 返回 | 用 session |
|---|---|---|---|
| `find` | 单条 query | 命中列表，带 `uri` / `level` / `abstract` / `score` | 否 |
| `search` | query + `sessionId` | 同上，先做意图分析得到 0–5 条 TypedQuery | 是 |
| `grep` | 正则 + 路径范围 | 行级命中，带行号与前后文 | 否 |
| `glob` | 路径通配 | 文件 URI 列表 | 否 |

**默认条数。** `find` / `search` / `grep` 默认返回 10 条，常量是 `src/services/retrieval/budget.ts` 的 `DEFAULT_SEARCH_LIMIT`，HTTP 的 `/search/*` 与 MCP 三个工具直接 import 这一处——各写一份（曾经是 MCP 10 / HTTP 20）会让同一个能力按调用方式返回不同规模。值定义在服务层而不是 `api/`：`services/` 不能 import `api/`（§4.2），而服务层的 `resolveLimit` 与两个入口的默认值必须是同一个数。`glob` 默认 100 条，两个入口也一致，但用的是各自的常数（MCP 仍叫 `nodeLimit`）。

**`search` 与 `find` 的差别只有一条：`search` 在检索之前先问模型「这句话该拆成哪几个查询」。** 没有这一条，两个面就是同一份实现套两个名字。

`TypedQuery` 四个字段，少一个都不够用：

| 字段 | 作用 |
|---|---|
| `text` | 重写后的查询。**可以与原 query 完全不同**——指代（「那它呢」）就在这里解析 |
| `intent` | `preference` / `fact` / `decision` / `event` / `procedure` / `other`。多命中时判断该合并还是该分开 |
| `confidence` | 0–1，模型对「这条查询值得跑」的判断 |
| `derivedFrom` | 原 query 里对应的片段。没有它，控制台解释不了「为什么搜出这个」 |

**上限 5 条**：候选是 `limit × 5`，去重后仍截到 `limit`。再多就不是「拆解意图」而是「猜词表」。

**三条降级语义**（`plan.analyzed = false`，`reason` 必非空，**不静默**）：

| 情况 | 行为 |
|---|---|
| 没注入 `LlmService` | 用原 query 跑一次 |
| 供应商错误 / 超时（10 秒）/ 输出被截断 | 同上，**截断不重试**——重试一次必然再截断 |
| 结构化输出重试一次后仍不合法 | 同上 |

**模型返回空数组不是降级**，是合法结论：`analyzed = true` + `queries: []` + 空命中。检索不到比检索错更节省上下文。

**合并规则**：多条 TypedQuery 各跑一次 `find`，按 URI 去重取最高分，`matchedQuery` 记是哪条命中。这样「同一条记忆被两个改写查询命中」不会在结果里出现两次。

**MCP 的 15 个工具全部在 30 秒总上限下。** `ToolRegistry` 的 `bindDeadline` 统一包装全部工具（§13.3）；HTTP 的 `/context`、`/search/find` 与 `/search/search`（含 list/context 两种 mode）也受同一上限约束，到点返回 503 `PROVIDER_UNAVAILABLE`。HTTP 的 grep/glob 不调模型，没有这一层；glob 在 SQL 按权限过滤，服务层再检查可读性，grep 从 glob 取得最多 200 个候选再逐文件匹配。向量和重排失败时按各引擎契约降级并返回原因。

**检索默认只看「现在有效」的记忆。** `find` 与 `search` 的命中都在索引侧按
`valid_from <= now < valid_until` 过滤（NULL 表示该侧无界，§8.1）。`search` 先取一次
`asOf`，FTS 臂与向量臂的候选集用同一个时刻；向量候选集来自 `SearchService` 内部那次
`index.glob`，它也带着同一个 `asOf`，否则 kNN 的名额会被同一段正文的旧版本占掉。多条
TypedQuery 各自跑一次 `find` 后再按 URI 合并，所以**合并后的命中清单**不会重新引入已
失效的版本。`asOf` 不对外暴露：MCP 的 15 个工具与 HTTP 查询参数都没有这一项，所有入口
都用「请求到达的时刻」。

**`list` / `tree` / `read` / `download` 是路径面，契约是磁盘；`glob` / `grep` 属于检索面。**
路径面能看到 `memories/{type}/.history/` 下的版本文件，按 URI 直接 `read` / `download` 是
查看历史值的唯一入口——没有为版本文件单独开的工具或接口。检索面排除整个 `.history` 子树：
`find` / `search` 按 `valid_until` 过滤（系统写的快照恒非空），而 `glob` / `grep` 不带
`asOf`，改由 `notVersionFileSql` 在索引 SQL 里按路径段排除（与 TTL 共用
`adapters/sqlite/node-repository.ts` 的同一份 GLOB 模式，`grep` 的候选集因此也不被版本文件
占名额）。判定按路径段、不看子串：`memories/preferences/.history.md` 是普通记忆，照常
出现在检索结果里。同一份数据在检索面与路径面得到不同结果，这是两个出口的契约差异，不是
索引缺数据。

### 8.5 层级加权

纯 BM25 的分数只反映词频，不反映「这段文字是否真的回答了问题」。但在同一套词法索引上，**层级本身带信息**：L0 摘要是别人总结过的一句话，信噪比天生比 L2 原文高。

排序分 = `bm25 × levelWeight[level]`：

| 层级 | 权重 | 理由 |
|---|---|---|
| L0 | 1.15 | 摘要，一句话说清了才被写下来 |
| L1 | 1.05 | 概览，介于两者之间 |
| L2 | 1.00 | 原文，未加工 |

**三层都有真实的作用对象。** 目录写入摘要后，索引里有两行：L0 行（一句话摘要）与
L1 行（概览正文，`overviewMaxChars` 默认 4000 字）。L1 行的 `content` 是概览正文、
`abstract` 是该目录的 L0 摘要——所以「同一目录同时命中 L0 与 L1」是常态，而不是
理论上的可能性（§8.6 第 3 步与 §8.1 的「一个 URI 最多几行」）。

**L1 行只在 FTS 臂上。** 向量臂按 URI 一条、目录不产生向量，`retrieval.engine:
vector` 命不中概览正文；`hybrid` 下这一臂的贡献是 0（§8.1 的最后一条说明）。

**为什么权重这么小**：加权是为了在 BM25 分数接近时打破平局，不是为了压过词频。1.15 意味着 L0 只要词频不差太多就能赢 L2；如果 L2 的词频明显更高，它仍然应该赢。

**混合检索下，权重乘在每个后端对融合分的贡献上**，不是先改后端名次：

```
score(d) = Σ_retriever levelWeight(level_d) / (k + rank_retriever(d))
```

RRF 仍然只比较名次（§8.3）；层级权重是**文档先验**（摘要经过压缩，信息密度更高），不是检索后端的分数量纲，所以两者不冲突。名次为 1 的 L0 贡献 `1.15 / 61`、L2 贡献 `1.00 / 61`：同分时 L0 赢，L2 词频明显更高时仍然赢。权重全为 `1` 时退化成标准 RRF（`1.0 * x === x`）。

单引擎（`fts5` / `vector`）走 `rankCandidates` 的 `score × levelWeight[level]`，默认 `hybrid` 走融合贡献；两条路径读同一份 `retrieval.levelWeights`。

**重排之后先验仍然保留**（§18 的「重排的实际语义」）：模型分替换的是相关性判断，不是层级先验。不保留时 `hybrid + rerank` 下层级权重只在「模型没给分」的尾部候选上生效。

权重集中配置（`retrieval.levelWeights`），来源是「摘要经过一次人工或模型的压缩，信息密度更高」这个经验假设。**没有实测数据支撑具体数值**，调参时应该用一批真实查询做对比。

### 8.6 上下文组装（Context Assembly）

**自动上下文。** `SearchService.automaticContext(query, options)` 供 `POST /api/v1/context` 使用。身份取认证请求；默认范围统一为本人根、实际可读的组根与直接授权子树。范围查询来自物化权限，候选与正文再次求权；无权节点的 URI、索引摘要也不出现在输出。共享结论不展开私有源会话。撤权与退组在下一次请求生效，已经进入宿主历史的文字无法远程撤回。

空 query 用于开局：读取本人 `memories/profile.md` 与最多 4 条偏好的正文，按既有 chat 配额最多 5 条；偏好超出的内容留待语义召回。普通 query 只固定读取 profile，优先使用当前问题与最近 10 条可读 user/assistant 对话，历史尾部最多 4000 字符。近期读取跨 live 和归档、按消息 ID 去重，并持会话 TREE 锁避免与归档交错。检索前不做每轮 LLM 查询改写，主动 `search` 的改写路径保留。自动候选只查 memory，不把整段原始会话送作长期事实。

默认请求预算 1600 token、9000 字节，且不超过服务端 `assembly.maxTokens`；指令、标签与转义后的正文都计入。普通请求背景最多使用剩余 token 的一半，给相关个人及团队知识留空间；开局可使用全部预算。这是初版工程分配假设，尚无模型效果标定。历史 4000 字符和抽取预取 8000 字符同为有界输入的工程上限。背景从全文起投，放不下沿既有层级降级；最终按完整条目缩减，不切断事实或标签。空正文/只有 URI 不自动注入。结果包括 `items/rendered/tokensUsed/dropped/degradation/deliveryToken`，降级只发给诊断层。

RRF 用于排序，没有通用的「无答案」判定；自动路径移除相对分数门槛。注入指令要求只使用相关且归属明确的事实，新指示优先；这能约束使用方式，不能保证下游模型总能忽略无关候选。真实自然语言效果和冷查询延迟仍需在实际使用中确认。

**自动召回压缩。** `retrieval.assembly.compressRecall` 默认开启；没有配置 `providers.llm.default` 时跳过压缩，继续交付原条目。普通自动请求在检索、再次求权、去重和预算组装之后，将当前问题、用于消解指代的近期对话尾部与可交付的召回条目发给该模型；开局和固定画像不参与压缩。模型返回来源编号与精简正文，每个来源最多一条；服务端用原条目还原 URI、归属和来源层级，转义正文，输出 `items[].compressed: true` 和 `compressed="true"` 标签属性。只有估算 token 数减少且字节数不增加才采用。有效的空数组表示不投放召回，固定背景照常交付。超时、模型错误或编号无效则交付原条目，并在 `degradation` 说明。压缩调用显式禁用应用层自动重试，单次压缩预算到点后不会再启动第二次供应商调用；到点的取消原因保留为 `PROVIDER_UNAVAILABLE` 超时，调用日志的 `attempts` 记录实际尝试数。`retrieval.assembly.compressRecallTimeoutMs` 设置压缩阶段最多等待多久，默认 5000 毫秒，允许 1–30000 毫秒（HTTP 请求总上限 30 秒）。实际等待还受请求剩余时间与模型供应商自身超时限制。普通 Hook 默认有 8 秒总时限，可在客户端配置 `recallTimeoutMs`（§15.9）；只调服务端压缩上限不会延长宿主等待。回执只覆盖最终实际交付的来源，按压缩前的来源内容指纹去重。来源校验不验证生成正文的事实含义。此步骤不写入画像或记忆，也不用于主动 `search`。

`search` 有一个 `mode="context"` 变体：返回的不是命中列表，而是一段**可直接塞进模型上下文**的文本。这是「检索结果 → 模型输入」的独立一层。

`mode` 只有两个取值，**默认 `list`**：

| 形态 | 返回 | 说明 |
|---|---|---|
| `list` | `{ hits, plan }` | 命中列表 + 查询计划。默认形态，向后兼容 |
| `context` | `{ items, rendered, dropped, usedTokens }` | 分层投放后的条目（带 `detail` / `tokens`）与渲染文本 |

`POST /search/search` 与 MCP `search` 工具接受同一个字段。`context` 是 `search` 的出参形态，不是新能力。

四步：

**1. token 预算。** 默认 1600 tokens（`assembly.maxTokens`），单条也有上限（`maxTokens / 条目数 × 2`，给单条留 2 倍余量）。

**2. 分层投放。** 每条候选先按类别放到起始层：

| 类别 | 起始层 | 可升到 |
|---|---|---|
| `events` | L1 概览 | L2 原文 |
| 其余 | L0 摘要 | L1 概览 |

放不下就**降级**：`L2 → L1 → L0 → 只有 URI`。降到底还放不下就丢弃，计入 `dropped`。然后按分数做三轮**升级**：先升到 L1、再升到 L2、最后是无单条上限的 L2（只受总预算约束）。

**3. 去重。** 渲染后正文完全相同的条目只留分数最高的。真实场景是同一个目录的两行：
L0 摘要行与 L1 概览行同时命中时，两条命中携带的 `abstract` 逐字相同（§8.1 的表格），
渲染出来就是两段一样的正文。

去重分两层，各自解决一层的问题：

| 层 | 位置 | 键 | 作用 |
|---|---|---|---|
| 命中列表 | `find` 的 `rankHits`（`services/retrieval/merge.ts`）、`search` 的 `mergeHits` | `(uri, abstract)` / `uri` | 不把同一句摘要返回两遍，也不让重复行占掉 `limit` 名额 |
| 上下文组装 | `ranking.dedupeByRenderedText`（`domain/assembly.ts`） | 渲染后的正文 | 纯逻辑兜底：即使上游给出两条，也只投一条 |

`(uri, abstract)` 而不是 `uri`：同一个 URI 的两行**如果**携带不同摘要（将来的其他层级
组合），那是两条信息，不该合并；只有摘要逐字相同才算重复。

**4. 配额。** 预设两套（`chat` / `coding`），按类别分配条目数：

| 预设 | memory | resource | session |
|---|---|---|---|
| `chat` | 5 | 3 | 2 |
| `coding` | 3 | 5 | 2 |

`session` 一列给 2：会话摘要只用于接上「上一轮聊到哪」，当前轮 + 上一轮就够。

**渲染格式**：

```
<memory uri="comem://user/alice/projects/comem/memories/preferences/code-style" type="memory" score="0.87" detail="abstract">
用户在代码风格上的偏好：TypeScript 严格模式、2 空格缩进、偏好函数式写法。
</memory>
```

正文里如果出现 `</memory>` 这类会伪造标签的串，做转义——否则记忆内容能劫持提示词结构。

**为什么这一层是分水岭**：没有它，「检索」只解决「找到什么」，没解决「给多少、给多细、重复几次」。三个问题里任何一个没解决，模型看到的上下文都是次优的。而且它**不依赖向量库**——纯 FTS5 也能做预算、分层、去重、配额。

**`items` 就是注入集合。** 调用方的上下文由它渲染，所以访问记账（§11.7 的
「什么算一次使用」）只认落在 `items` 里的 URI；命中候选集不是交付物，不记。

### 8.7 召回账本（Recall Ledger）

自动接入与主动工具共用服务端账本。自动上下文在组装后按 `sha256(detail + NUL + text)` 比较内容，更新正文或改变交付粒度后允许重新注入。自动上下文的会话键由宿主会话 ID 与 `contextEpoch` 组成；SessionStart 与压缩重置边界更新 epoch。旧条目没有内容指纹时不能抑制新的自动投放。写入按作用域串行，裁剪只用当前会话的轮次淘汰当前会话条目，再按最近写入的会话保留总量上限；跨会话的轮次不可比较。

**自动交付使用回执。** `/context` 只组装并签发 `deliveryToken`，不立即记账或刷新访问时间。HMAC 回执绑定认证身份、原始轮次、epoch、URI、层级与正文指纹，不含记忆正文；服务重启后签名失效。有效期一天是工程上限，容纳跨日恢复且避免旧凭据无限生效，不代表记忆有效期。客户端成功写完宿主 stdout 或完成 DSH 注入后才原子保存回执，下一次请求携带 `previousDeliveryToken`，服务端确认后去重；也可显式调 `POST /context/ack`。确认再次过滤当前权限，无效或过期的旧回执在自动请求中忽略、显式 ack 返回 400。旧客户端不确认时会重复召回，服务端与插件应同步升级。客户端只保存一个待确认回执，不维护第二份 URI 去重账本。stdout 写入成功不等于下游模型确实使用内容；宿主没有更强的确认能力时，以这个边界为准。并发召回仍可能重复，优先保留再次获得上下文的机会。

**文件按作用域分片，条目按会话过滤。** 账本文件是 `{dataDir}/_meta/recall/{scopeKey}.recall_log.json`（如 `user_alice.recall_log.json`），每条记录带 `sessionId`，写的是「哪个会话在第 N 轮给模型投喂了哪些 URI、投喂到什么粒度」。下一轮召回时，**同一个会话**在 `dedup_turns` 轮内投过的**不重复投**。

**为什么这样切。** 去重窗口是「本会话最近几轮投过什么」，按会话隔离是正确性要求：同一用户的两个会话共用一个 `turn` 时钟会互相污染——会话 A 跑到第 50 轮后，会话 B 从第 1 轮开始会把 A 投过的全部 URI 当成「刚投过」，新会话前几轮召回被静默压制。但文件不能按会话切：每个会话一个文件会产生大量小文件，而按作用域分片让并发写落在不同文件上。

**窗口过滤是三个条件的合取**：

```
entry.sessionId === sessionId && entry.turn > turn - dedup_turns && entry.turn <= turn
```

第三个条件排除「未来轮次」：账本可能已经写入了比当前 `turn` 更大的记录（另一个更靠后的调用先写回），不过滤会把它们当成「刚投过」。

**向后兼容。** 旧账本里的条目没有 `sessionId`。读取时把它当作「不匹配任何会话」忽略，不抛错——账本是缓存，丢一条只影响去重强度，不影响正确性。

三条规则：

1. **只记账真的给了正文的条目。** 只给了 URI 的不记——模型没看到内容，下一轮还得给。
2. **轮次时钟取会话的累计消息数。** `turn = SessionService.totalMessageCount(sessionUri)` = 已归档消息 ID 集合大小 + live 条数。它是**派生量**，不额外存储：存成计数器就要在归档、补完归档、删除消息几条路径上同步维护，漏一处时钟就与消息总数漂移，而去重窗口只依赖这个单调量。
3. **当前会话按 `turn - 4 × dedup_turns` 裁剪，全文件上限 500 条。** 不裁剪会无限增长。

**为什么需要**：用户连续问三个相关问题，同一段记忆会被完整注入三次。上下文浪费 2/3，模型还可能因为重复而分心。

**与去重的区别**：8.6 的去重是**同一次请求内**的重复（同一 URI 命中多条记录）；账本是**跨请求**的重复（上一轮给过，这一轮不再给）。两者都要做。

**写侧调用点。** `SearchService.context` 在组装完成后调用 `RecallLedger.record(scopeKey, sessionId, turn, items)`，只记 `detail !== null` 的条目（规则 1）。同一个 `items` 也是访问记账的输入（§11.7）：账本只记给了正文的，访问记账记全部注入条目——两件事的窗口不同（账本管下一轮还发不发，TTL 管这条记忆还留不留）。`turn` 取 `SessionService.totalMessageCount(sessionUri)`，**不是 `SessionService.load` 的 `messageCount`**——后者提交后归零，账本读侧的 `entry.turn <= turn` 会把提交前的条目当成「未来轮次」排除。`sessionId` 取会话 ID，`scopeKey` 取会话 URI 的作用域部分（`user_{uid}`）。

**消息记录里的 `turn` 不是这个时钟。** `SessionMessage.turn` 是这条消息在当前 live 窗口内的序号（`nextTurn` = `messages.length + 1`），归档之后新消息从 1 重新编号，所以它不是累计值，也不能拿去当账本时钟。账本只认 `totalMessageCount`。

**两个容易拿错的数都会倒退。** `Session.messageCount` 是 live 未提交条数（`commitPhase1` 默认 `keepRecentCount = 0`，提交后归零），`SessionMessage.turn` 是 live 窗口内序号（提交后新消息从 1 重新编号）；两者都不能当账本时钟。`domain/session.ts` 里 `SessionMessage.turn` 的注释写着「轮次」，指的就是这个局部序号，不是账本口径。

**已知限制：多进程写同一个 `dataDir` 会漏计。** 已归档消息 ID 索引是进程内缓存，与 `addMessage` 的幂等索引共用同一个假设：v1 不支持多个服务端进程共享数据根（`docs/operations.md` 已知限制 33）。

**没有 `sessionId` 时不做跨轮去重，也不写账本。** 没有会话就没有东西能推进 `turn`；用一个常量会让账本在 500 条之后永久排除所有候选——静默失效比不去重更糟。`ContextOptions` 里只有 `sessionId` 一个入口，没有「显式传时钟」的旁路：离线脚本要么给一个真实会话 ID，要么接受本轮不去重。

**账本写失败只记 `warn`，不影响检索。** 账本是去重辅助，不是真相来源；一次磁盘写失败不该让已经组装好的上下文丢掉。

**`mode` 必须从 HTTP 路由与 MCP 工具一路贯穿到 `context`。** 只实现 `context` 与 `RecallLedger.record`、不给入口加 `mode` 参数时，生产路径一次都不会执行，测试全绿只说明它自洽。回归测试走 `POST /search/search` 与 MCP `search` 工具，连续两次 `mode="context"` 必须证明第二次不重复投放第一次给过的条目。

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

### 8.10 检索质量评估

§8.1–§8.9 的每个参数都有来源注释，但**来源是「文献」或「经验假设」不等于「在本项目的
数据上验证过」**：RRF 的 `k = 60` 是原论文值，层级权重 `1.15 / 1.05 / 1.00` 是拍的，
`candidateMultiplier = 4` 与层级权重没有测量依据。没有评估集时，改一个参数
只能得到「感觉应该更好」，而不是「变好了多少」。

`pnpm eval`（`src/eval/`、`src/commands/eval.ts`）用一份带标注的数据集测量三个指标：

| 指标 | 公式 | 来源 |
|---|---|---|
| Recall@k | `\|top-k ∩ relevant\| / \|relevant\|` | 标准 IR 定义 |
| MRR | `1 / rank_of_first_relevant`（rank 从 1 起） | 标准 IR 定义 |
| nDCG@k | `DCG@k / IDCG@k`，`DCG = Σ (2^rel_i - 1) / log2(i + 1)` | Järvelin & Kekäläinen (2002) |

三个指标一起看才有意义：Recall 高、MRR 低是「找到了但埋得很深」；只有 Recall 是
「该找的有没有被找出来」，对顺序不敏感。

**两个明确的取舍**：`relevant` 为空时 Recall 返回 1（没有该找的东西，检索没有做错
任何事）；`graded` 为空时 nDCG 返回 0（分子分母同时为 0，没有可归一化的基准）。

**数据集即被测语料。** `eval/datasets/*.yaml` 同时给出 `corpus`（URI → 正文）与
`cases`（query + 二值 `relevant` + 分级 `graded`）。语料必须全部属于同一个 `user`
根，执行器把它绑成服务图身份；标注里引用的 URI 必须在语料里，`graded` 值域是
`0–3` 整数——任何一条不成立都在解析时抛 `INVALID_ARGUMENT`，不静默跳过。数据集格式
与标注规则见 `eval/README.md`。

**执行方式**（`src/eval/runner.ts`）：

- **每个变体一个临时数据根**。变体之间的索引、向量、权限表完全隔离；否则「hybrid 比
  fts5 好」可能只是「hybrid 跑在 fts5 建好的索引上」。
- **延迟只测 `find()` 调用本身**。建容器（迁移、建表、根预置）与播种语料（写文件 +
  嵌入）在计时窗口之外。
- **每个查询跑 3 次取中位数**。第一次带冷缓存成本（SQLite 页缓存、`sqlite-vec`、
  FTS5 段缓存）；3 是「能算中位数」的最小奇数。命中取最后一次（热缓存稳定态）。
- **变体切换重建容器**。重排 / 热度 / 层级权重 / 引擎都是容器级配置，没有热改入口；
  重建成本已经被「延迟窗口之外」隔离掉。
- **评估固定覆盖三项配置**：`summary.generator=rule`（摘要生成会调模型，与检索
  无关）、`session.autoCommit.enabled=false` 与 `session.expiry.idleTimeoutSeconds=0`
  （不启动后台调度器）、`logging.level=fatal`（容器日志走 stdout，会割裂表格 / JSON；
  变体零命中时执行器自己补一条告警）。

**基线**（2026-11-08，本机，34 条查询，k=10，远程 bge-m3 嵌入）：

| 变体 | Recall@10 | MRR | NDCG@10 | p50 | p95 |
|---|---:|---:|---:|---:|---:|
| fts5 | 0.387 | 0.355 | 0.355 | 0.1ms | 0.3ms |
| vector | 0.963 | 0.907 | 0.907 | 386.2ms | 465.3ms |
| hybrid | 0.963 | 0.909 | 0.911 | 381.2ms | 587.7ms |
| hybrid+rerank | 0.990 | 0.956 | 0.958 | 1880.2ms | 3282.1ms |
| hybrid+levels | 0.963 | 0.909 | 0.911 | 416.2ms | 639.9ms |

混合检索不是「永远更好」：FTS5 在自然语言改写上召回接近 0，在专有名词 / 标识符上
召回 1.0；向量反过来。

**`hybrid+rerank` 与 `hybrid` 的差距来自候选文本。** 候选文本摘要优先、正文兜底
（512 字符）：普通文档的 `abstract` 是 `null`，不兜底时空文本候选被 `applyRerank`
跳过，重排退化成「按融合分原样返回」，只多了一次模型调用的延迟。正文兜底后
`hybrid+rerank` 的三项指标都高于 `hybrid`，代价是 p50 从 381.2ms 涨到 1880.2ms
（正文读取 + 模型调用）。

**`hybrid+levels` 与 `hybrid` 逐位相同不是缺陷。** 当前数据集的标注全是文件（L2
记录）；目录的 L0 摘要虽然进了索引、也出现在 top-10 里，但没有被标成相关文档。
层级先验只改变这些 L0 记录的名次，不改变相关文档的名次。接入验证由
`tests/integration/services/search-hybrid.test.ts` 的「层级权重」用例完成（同分
候选，L0 的融合贡献是 L2 的 1.15 倍）。要让指标层可测，得把目录摘要标成相关
文档，而数据集格式目前要求 `relevant` 的 URI 在 `corpus` 里。

**评估能证明什么、不能证明什么。** 34 条查询上的点估计没有置信区间，0.02 的差距
可能是噪声；向量变体的延迟包含查询嵌入的网络往返，不能当作索引本身的延迟；热度
变体需要访问历史，临时数据根里 `access_count` 全是 0。这些限制写在 `eval/README.md`
的「已知限制」里。

## 9. 摘要与失效

### 9.1 三层

| 层 | 位置 | 预算 | 用途 |
|---|---|---|---|
| L0 | `.abstract.md` 正文 | 256 字符 | 相关性判断、检索召回 |
| L1 | `.overview.md` 正文 | 4000 字符 | 替代大部分 L2 阅读 |
| L2 | 原文件 | 无限制 | 按需加载 |

L0 从 L1 正文提取（H1 标题之后、第一个 `##` 之前的段落），两层不会互相矛盾。

**L0/L1 是目录级的**，不是文件级。文件摘要存在索引记录的 `abstract` 字段里，作为生成父目录 L1 的输入。

两层都进检索索引，而且是同一个 URI 的两行（§8.1）：L0 行只索引摘要，L1 行索引概览
正文。这不是冗余——摘要是一句话，概览是 4000 字，两者能回答的问题不同，`bm25 ×
levelWeight` 让它们在同一个排序里按层级竞争（§8.5）。

### 9.2 生成

自底向上。一个目录的 L1 输入是「直接子文件的状态与摘要」+「没有独立 ACL 边界的
直接子目录 L0 正文」：

```
叶子目录 → 父目录 → ... → scope 根
```

`contextType = memory` 且状态为 `pending` / `archived` 的文件仍以「名称 + 状态」占位
进入生成请求和输入 digest，但其索引摘要与正文都不传入生成器。这样父目录能明确写出
「有一条待复核内容」或「有一条已归档内容」，不会把实际存在的子项误报成空目录。
审批把文件索引状态改为 `active` 后，下一次显式重建或正常失效重算才把它的摘要带入。
archived session / resource 目录不能因为状态名相同而从摘要树中消失。`.history`
版本文件仍由目录存储层提前隐藏，不依赖这条状态过滤。

**直接子目录有自己的 `.acl.json` 时，父目录摘要不读它的 L0。** 文件没有独立 ACL，
继承所在目录；目录的 `.acl.json` 就是摘要聚合不得跨过的权限边界。子目录仍可在同一
可见面内生成自己的摘要，但其正文不会进入 `history/`、session 或其他更上层摘要。
判断复用 `AclService.hasIndependentAcl()`，没有新增配置项。

**归档根的真实对话 L0 永远不进入父摘要。** 无独立 ACL 时，父摘要仍把
`archive_NNN/` 作为导航子目录列出，但传入的 L0 是空串；有独立 ACL 时整个子项跳过。
因此事后给一个原先无 ACL 的归档加限制，下一次生成不会继续把该归档正文卷进
`history/`、session 或更高层。这个规则不会批量重写存量摘要：已经由旧版本写入更高层
的文本仍留在旧 `.overview.md` 中，直到运维显式重建对应目录；加 `.acl.json` 本身不会
自动失效祖先摘要。部署升级不能把这条存量泄漏边界说成已修复。

**归档根目录（`archive_NNN/`）额外使用本批对话事实。** 摘要生成经 `readSummaryInput`
读取归档根自己的受控 `messages.jsonl`，只取 user / assistant 的 `text` parts，不包含
image / context URI、tool_use / tool_result、`source`（host / machineId / cwd）或文件
元数据。正常 4000 字预算按头尾各留一半，连续装入完整的消息块，保留开头意图和最终
纠正 / 答复，中间明确省略；预算小于省略标记时严格截到配置长度。材料进入摘要输入
digest 与 single-flight 尾批，所以初始归档、之后 `markStale(archiveRoot)` 和无参数
`regenerate(archiveRoot)` 都从同一个 JSONL 得到同一份输入，不会用“仅知道
messages.jsonl”的空材料覆盖已生成的概览。

该材料仍走原本的目录摘要模型调用，没有为 `messages.jsonl` 单独生成 L0，也没有改写
原始 JSONL。规则生成器从材料中保留首条用户意图、末条助手答复和直接子节点，继续明确
标记 `degraded: true`。

**存量目录不会自动获得新排序。** 已生成且仍新鲜的 `experiences/.overview.md` 等父目录
摘要要等正常失效重算，或运维显式重建对应目录；部署本身不批量扫描、不触碰原始文件。

`SummaryGenerator` 是 Strategy，两个实现：

- `LlmSummarizer`：调 `LlmProvider`，按固定结构产出（标题、简述、快速导航、逐条详述）
- `RuleSummarizer`：断网降级。有归档对话时保留首条用户意图与末条助手答复，再取
  子节点名字 + 各自摘要首句；不调模型

两者实现同一个 `SummaryGenerator` 接口（`domain/summary.ts`），`services/summary.ts` 按配置选择。降级不是静默的：结果带 `degraded: true`，控制台显示，`health` 工具报告。

**一次生成写两行索引。** L0 行与 L1 行在同一个事务里写
（`src/services/summary/persist.ts` 的 `persistSummary`，那是摘要写索引的唯一入口），
所以概览与摘要不会各自漂移；`node` 与 `node_fts` 两张表也在这个事务里，中途失败
整批回滚（`SqliteFtsIndex.upsert` 检测到外层已有事务会直接复用）。

`.abstract.md` 与 `.overview.md` 的每个文件分别原子替换，两个文件由
`MetadataFileStore` 按目录串行写入；读取时还会比较两份 frontmatter 的生成信息，
把“两个文件都在但来自不同一代”标为不一致。文件先写、索引事务后提交，因此进程在
两者之间退出时仍可能暂时落后；下一次刷新会比对文件正文与 L0/L1 的 `node` /
`node_fts` 行并重建，而不是因为 `summary_input_digest` 没变就跳过。

**提示词不在代码里拼。** 静态骨架在仓库的 `prompts/summarize-system.md` 与 `prompts/summarize-user.md`，动态部分（目录地址、直接子节点、两个字数预算）由 `services/prompts/summarize.ts` 渲染成字符串后用 `{{name}}` 注入。模板可以在控制台修改（§18「提示词」），改完下一次摘要生成就生效，不需要重启。

### 9.3 失效

**只增量失效，不全量重算。**

```
写节点 N（或删除、移动）
  → 算 N 的 L0 正文 digest
  → 与索引里记录的一致？一致就到此为止（正文没变不传播）
  → 变化了：
      P = parent(N)
      node.summary_pending += 1
      node.summary_baseline 为 NULL   → 立刻重算
      node.summary_entries <= 32      → 立刻重算
      summary_pending / summary_entries >= 0.10 → 立刻重算
      否则                            → 只记脏，等下次
  → 重算 P 完成后，若 P 的 L0 正文也变了，对 parent(P) 重复
  → 到达 scope 根停止
```

**为什么是「事件计数」而不是「脏标记」。** 同一个文件反复改，脏标记只算一次，永远到不了阈值。计数才反映「这个目录的摘要落后了多少次改动」。

**为什么消费时要减而不是清零。** 开始生成前先把本轮计数持久化并记下快照，不提前清零；写回成功后执行 `pending = max(pending - 消费时的快照, 0)`。生成失败时计数仍在，下一次失效或健康检查能看到待刷新工作；生成期间到达的改动也继续保留。

**同一目录的刷新在进程内 single-flight。** 一个目录已有生成在跑时，后来的失效通知并入同一条尾批，仍按事件次数计数；不同目录各自并行。每次非 force 生成前，协调器先计算当前目录输入的稳定 digest（目录 URI、直接子项按名称规范排序后的 URI / 名称 / 类别 / 状态 / 摘要，以及归档根目录可选的本批对话材料），并与 `node.summary_input_digest` 比较。相同就消费本轮 pending 并返回 `unchanged` / `stale`，不调用模型；不同才把同一份已读取输入交给生成器，成功落盘时把它的 digest 与摘要一起写回。摘要输入编码在 `version = 2` 中加入状态；升级后旧记录会因版本失配自动重建，避免继续使用把待复核子项误写成空目录的摘要。模型调用完成后，协调器重新读取目录摘要输入并计算稳定 digest；尾批输入与这次生成的输入相同，说明生成结果已经覆盖这些通知，不再调用模型，输入确实变化则只为最新输入再生成一轮。尾批处理期间又到达通知时本轮不会吞掉它，而是继续到计数稳定。这里没有时间窗口或延迟，判定只看事件计数与输入内容。`force` 跳过 digest 比较，始终保持显式全量重建语义。共享一轮生成的并发调用中只有一个负责继续向父目录传播；否则同一份 L0 变化会被父目录计成多次，并可能产生重复模型调用。

**产物不完整时立即自愈。** 当 `summary_input_digest` 已存在时，刷新入口会检查
`.abstract.md` / `.overview.md` 是否完整且同代，以及 L0、L1 的 `node` 行和
`node_fts` 行是否仍与两份正文一致。任一缺失或陈旧都会跳过“相同输入不重算”的
快速路径，重新生成并原子替换两行索引。这里只修被刷新到或显式重建的目录，不在启动时
全库扫描。

**摘要写入不反向触发失效。** `.abstract.md` / `.overview.md` 由 `MetadataFileStore` 直接原子写入；`IndexObserver` 只接收正文写入、删除与移动通知，不监听这两个元数据文件。摘要生成因此不会通过 observer 递归触发自己。

**两个入口，语义不同。** `SummaryService.invalidate(nodeUri)` 先比较正文 digest 是否变化再传播（上面第 2 步）；`SummaryService.markStale(directoryUri)` 跳过比较，从这个目录本身开始传播。**已经知道内容确实变了的调用方必须用 `markStale`**：批量写入的顺序是「写文件 → 批量 `index.upsert` → 标脏」，等标脏被调用时索引里已经是新 digest，`invalidate` 的比较必然相等，整条传播链被静默跳过——文件写了、目录摘要停在旧内容，不报错也不失败。用错的另一种形态更彻底：`invalidate` 从 `node.parent()` 开始传播，把目录 URI 传给它时目标目录连一次判定都拿不到，第一次写入后该目录的摘要直接是 `null`（不是「停在旧内容」）。规则收在 `src/services/write-through.ts`：它的依赖类型是 `Pick<SummaryService, 'markStale'>`，实现里连 `invalidate` 都拿不到；`tests/integration/services/write-through.test.ts` 的替身也只实现 `markStale`，`markStale` 被换成 `invalidate` 时该用例的类型对不上。

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
    1. 生成归档摘要（L0/L1；正常 LLM 模式同时使用本批 user/assistant 文本事实）
    2. 从归档消息抽取记忆操作，写 memory_operations.json
    3. 应用补丁合并，写 memory_diff.json
    4. 标记祖先摘要失效并重算
    5. Dreamer 整理归档经验、提出待复核偏好
    6. 写 .done（最后写）
```

**阶段二的第 3 步在锁内应用补丁。** `memory_merge` 不读正文快照，补丁作为转换函数交给 `upsertMemory`，在 `exact(uri)` 锁内基于磁盘上的最新正文执行（§18「并发控制」）。`task.concurrency: 4` 下四个归档同时合并同一条记忆时，读在锁外会让后写者用陈旧正文覆盖先写者——`profile` 只有一个 `content` 字段，字段级合并保护不到它。

**第 5 步 `dreamer`** 用一次模型调用整理本次归档：从一次有结果的事件提炼可复用的经验，或从不同会话归纳带适用条件的偏好。写入追加到 `memory_diff.json` 并标记父目录摘要失效。缺少可用模型时随抽取和补丁应用一起跳过。具体证据和复核规则见 §11.8。

**消息的 part 类型。** 一条消息由若干 part 组成，抽取时都参与：

| Part | 内容 |
|---|---|
| `TextPart` | 纯文本 |
| `ImagePart` | 图片 URL（需要视觉模型描述） |
| `ContextPart` | 上下文引用（URI + 摘要），表示「这条消息引用了哪段记忆」 |
| `ToolPart` | 工具调用的 `{toolCallId, name, input, output}` |

`ToolPart` 保存调用与结果。个人事实抽取隐藏任意工具原文，仅允许 §6.6 列出的受控环境观察；经验归纳隐藏全部工具部分。当前 URI 只有 user/group 两个根，没有独立 agent 作用域。

**为什么 `.done` 最后写。** `.done` 是唯一的完成信号。先写它就等于宣称成功。崩溃后重放时，看到 `.done` 就跳过整个归档。

**每步完成都写 `.meta.json` 的 `stepsDone`。** 这样重放能跳过已完成的步骤，不会重复应用记忆操作。记忆操作不幂等——重复应用会造出重复记忆。

**「跑过」必须同时意味着「产物还在」。** `stepsDone` 只记进度不记产物的话，重放会跳过产物只存在内存里的步骤，下游拿到空输入。每个步骤的产物都必须落在归档目录里，跳过时由 `CommitStep.rehydrate` 读回 `state`——见 §10.4 的表格。

**部署缺少能力时跳过步骤，不让任务失败。** `providers.llm.default.type: disabled` 时 `memory_extract` 每次都会撞上 `DisabledLlmProvider` 的 `INVALID_ARGUMENT`，而它是终态错误——第一次就把任务置 `failed`，归档永远停在 `archive_summary`。阶段一（归档落盘、建任务、`session` 关联）不依赖模型，所以 `CommitPipeline` 的 `skippedSteps` 把 `memory_extract` / `memory_merge` / `dreamer` 这三步登记成「不执行」：跳过也写 `stepsDone`（重放判据），原因另记在 `skippedSteps`（`{ "step": "memory_extract", "reason": "llm_disabled" }`），并记一条 `warn` 日志。判据由装配层从 `providers.llm.default.type` 推出，`services/` 不 import `config/`——与 `ingest` 的 `{ skipped: true, reason: "llm_disabled" }` 同一个模式。

### 10.2 归档边界

默认归档全部消息。可选 `keepRecentCount` 保留最近 N 条。归档序号单调递增，`archive_001`、`archive_002`……，从不复用。

### 10.2.1 自动提交策略

**记忆延迟最大的来源不是抽取慢，是根本没人触发提交。** agent 不会主动调 `commit`，用户聊两小时，记忆一条没进库。

四个判定参数（token / 消息数 / 空闲 / 最小间隔），判定在 `domain/session.ts` 的 `shouldAutoCommit`，触发者是服务端的后台调度器（§10.7）。`keepRecentCount` 也在这个策略里，但不参与判定：它决定阶段一提交时保留多少条 live 消息，消费方是 `services/session.ts` 的 `commitPhase1`。

| 参数 | 默认 | 作用 |
|---|---|---|
| `pendingTokenThreshold` | 150000 | 未提交 token **严格大于**该值 |
| `messageCountThreshold` | 100 | 未提交消息数 **严格大于**该值 |
| `minCommitIntervalSeconds` | 0 | 两次自动提交的最小间隔（全局闸门） |
| `idleTimeoutSeconds` | 0（关） | 空闲这么久且有未提交内容 |
| `keepRecentCount` | 0 | 不是判定阈值：提交时保留最近 N 条 live 消息 |

**为什么阈值是「严格大于」**：默认 100 条，用户发第 100 条时不该提交，第 101 条才提交。这样「阈值 100」和「每 100 条提交一次」是同一个意思。

**`minCommitIntervalSeconds` 是全局闸门**：任何触发条件都要先过它。没有它，调度器每 30 秒提交一次，`history/archive_NNN` 会被刷成一堆碎片，而每个碎片都要跑一遍阶段二（模型调用）。

**为什么 `idleTimeout` 默认关**：它是「长会话」场景的旋钮，不是默认路径的一部分。打开它需要服务端常驻扫描器（§10.7 的调度器），单机部署多一个每 30 秒空转的定时器。

**空闲提交与其它触发走同一条阶段一，`keepRecentCount` 一视同仁。** 让空闲提交忽略 `keepRecentCount` 需要在阶段一加一个「这一次不看保留条数」的参数，而「保留最近几条」在用户回来接着聊时恰好是有用的上下文。`keepRecentCount = 0`（默认）时两种语义是同一个结果。

**提交是幂等的**：自动提交和手动提交走同一条管线，重复触发不会产生重复归档（Phase 1 的路径锁 + 归档序号单调保证）。

### 10.3 管线骨架

```ts
abstract class CommitStep {
  abstract readonly name: string;
  abstract run(ctx: StepContext): Promise<void>;
  /** 跳过已完成的步骤时，把只存在内存里的产物从归档目录读回 `state`（§10.4） */
  async rehydrate(ctx: StepContext): Promise<void> {}
}

class CommitPipeline {
  constructor(private readonly steps: CommitStep[]) {}

  async run(ctx: StepContext): Promise<void> {
    for (const step of this.steps) {
      if (ctx.meta.stepsDone.includes(step.name)) {
        // 被跳过的步骤从未执行过，没有产物可恢复。
        if (!ctx.meta.skippedSteps.some((skipped) => skipped.step === step.name)) {
          await step.rehydrate(ctx);
        }
        continue;
      }
      const skipReason = this.skippedSteps.get(step.name);
      if (skipReason !== undefined) {
        await ctx.markStepSkipped(step.name, skipReason);
        continue;
      }
      await this.withRetry(step, ctx);
      await ctx.markStepDone(step.name);
    }
  }
}
```

Template Method 固定「跳过已完成 → 跳过不可执行 → 执行 → 记录」的骨架，变化点是五个步骤的实现。新增步骤不改骨架。`skippedSteps` 是装配期传入的 `Map<CommitStepName, CommitStepSkipReason>`（目前只有 `llm_disabled`）：它表示「这个部署里这一步不可能成功」，重试没有意义。

### 10.4 任务恢复

- 认领：`UPDATE task SET status='running', lease_until=now+60s WHERE id=? AND (status='pending' OR (status='running' AND lease_until < now))`
- 心跳：每 20 秒续租
- 启动扫描：`status='running'` 且租约过期 → 重置为 `pending`、`lease_until = NULL`，**不动 `attempts`**（下次认领时才 `attempts += 1`；与「失败回 `pending`」同一条口径，认领才是执行次数的计数点）
- 重试上限 3 次。超限置 `failed`，错误写进 `error` 字段和 `error.log`

**每个步骤的产物必须持久化。** 这是设计约束，不是实现细节。`stepsDone` 是重放判据：重放会跳过它记下的步骤。如果某一步的产物只存在 `StepContext.state`（进程内存）里，那么这一步之后的**任何**一次瞬态失败（供应商 503、SQLite 写冲突、租约过期、进程重启）都会让重放跳过它、下游拿到空输入。记忆操作不幂等，所以步骤不能被重跑；能做的只有让「跳过」不丢产物。

| 步骤 | 产物 | 位置 | 可恢复性 |
|---|---|---|---|
| `archive_summary` | 归档目录的 `.abstract.md` / `.overview.md`（开启工作记忆时） | 盘 | 跳过即恢复：产物本来就在盘上 |
| `memory_extract` | 抽取出的操作列表 | `archive_NNN/memory_operations.json` | `rehydrate` 读回 `state` |
| `memory_merge` | 真正写过 / 删过的文件集合 | `archive_NNN/memory_diff.json` | `rehydrate` 从 diff 推出 `written` / `deleted` |
| `summary_invalidate` | 无（副作用是摘要的待刷新计数 `node.summary_pending`） | — | 跳过即正确；重跑会重复累加脏计数 |
| `dreamer` | 经验与推断偏好记忆文件、归档差异清单 | 盘 | 跳过即恢复：产物本来就在盘上，没有下游步骤读 `state`；重跑会再调一次模型，经验同一 topic 仍整段覆盖；已写入的推断不重复创建 |

`CommitStep.rehydrate(context)` 是这条契约的落点：管线跳过已完成的步骤时先调用它，把产物从归档目录读回 `state`，再继续。此前 `memory_extract` 与 `memory_merge` 的产物都只存在 `state` 里，`memory_merge` 之后的一次 503 会让归档**永久**停在「`stepsDone` 声称抽取完成、产物却不存在」，而错误信息写着「步骤顺序被改过」——完全指错方向。

**被跳过的步骤（`skippedSteps`）不 `rehydrate`。** 它们从未执行过，没有产物；对它们调用会把「`providers.llm.default.type: disabled` 的正常跳过」在任务重放时误报成「产物不存在」。

**盘上没有产物 = 真正的装配或数据错误。** `rehydrate` 抛 `INVALID_ARGUMENT`（终态，不重试），错误信息写明「归档元数据声称某一步已完成，但对应文件不存在」。重试同一个缺失没有意义。

### 10.5 工作记忆（Working Memory）

每次提交除了抽取长期记忆，还维护一份**工作记忆**——6 段结构化文档，写在归档目录的 `.overview.md`：

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

**怎么用**：下一次提交时，上一个归档的 `.overview.md` 作为 `latestArchiveOverview` 喂进抽取 prompt。第一次提交没有前序，这一段为空。工作记忆生成后经
`SummaryService.replace()` 替换归档目录的 L0/L1：同一目录锁内先重写两份摘要文件，
再在事务里同步更新 L0、L1 的 `node` 与 `node_fts` 行。它不能绕过摘要服务只改文件，
否则控制台看到工作记忆，检索仍会命中替换前的普通摘要。

**默认关闭**（`memory.workingMemory.enabled = false`）。开它会多一次 LLM 调用，只在长会话场景有价值。**开启就必须有可用的 LLM**：工作记忆没有规则生成器，`providers.llm.default.type: disabled` 时 `loadConfig` 抛 `INVALID_ARGUMENT`（与 `ingest` 的降级不同——导入的阶段一有独立产物，工作记忆没有）。

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

**锁不可重入。** 持有者再拿同一路径（含祖先 `TREE` 与后代 `EXACT` 的冲突）的锁会等自己，超时抛 `CONFLICT`。多锁必须按路径字典序升序获取、反序释放——`FileSystemService.move` 就是这条规则。ACL 写入的锁粒度、锁序与「读-改-写必须在同一把锁内」的完整契约见 §12.8。

**锁内不得跨越慢操作。** 一把锁只应保护「读状态 → 决定 → 写状态」这条**几毫秒**的短路径。LLM 调用（一次 7–9 秒）、网络请求、全库 / 全子树扫描、大批量文件 IO，都必须在锁外完成，做完再进锁写结果。原因有三，都会把「极少数慢请求」放大成「大面积 `CONFLICT`」：

- `PathLockManager` **不可重入**：持锁期间再拿同路径或冲突路径的锁会等自己直到超时。
- `TREE` 与祖先 / 后代的 `EXACT` 互斥：一次慢 `EXACT` 会挡住整棵子树的写入与 `rm -r`。
- 默认获取超时 5000 ms：慢操作一进锁，持有时间放大上百到上千倍，并发的写者 5 秒后直接 `CONFLICT`。

**这条规则的来源是一次实测。** W83 用 `summary.generator: llm` 跑 ingest 时，`SummaryService.#invalidateDirectory` 把 `generator.generate`（模型调用）放在目录的 `EXACT` 锁里，摘要一算 7–9 秒；期间的提取写操作要拿祖先 `TREE` 锁，正好撞上这把手慢锁，5 秒后 `CONFLICT`。当时的绕法是「必须把 `summary.generator` 设成 `rule` 才能跑通 ingest」。修复把流程拆成锁内判定 → **锁外生成** → 锁内写回，锁持有时间从 ≈9 秒降到几毫秒。生成开始前持久化本轮 `pending` 快照，只有写回成功才消费；失败时计数保留。生成期间到达的改动由目录协调器组成尾批，在写回后比较输入 digest，必要时只为最新输入追加重算，最终收敛。

**为什么 TREE 而不是只锁文件**：`rm -r resources/foo` 要保证「删索引 → 删文件」期间没有人往 `foo/` 里写。只锁 `foo` 自身挡不住写 `foo/bar.md` 的人。

**元数据写保护**

`.acl.json` / `.abstract.md` / `.overview.md` 的 frontmatter 是**受保护的**：

- `write` 到元数据文件时，先读出现有 frontmatter，只替换正文，再写回
- `append` 只追加正文，绝不碰 frontmatter
- 想改 frontmatter（比如手工修 `generated_by`）必须走元数据入口，正常路径不该有

**不保护的后果**：一次 `write` 就把 `.abstract.md` / `.overview.md` 的 `uri` 与 `generated_by` 清掉，摘要变成「来源未知」（`readGeneration` 返回 `null`，控制台按手工内容处理）。摘要正文还在，失效状态也不在文件头上（§6.7），但丢失的来源标记没有别处可恢复。

**索引双写补偿**

写文件成功、更新索引失败时，文件在磁盘上但检索不到。处理：

1. 写索引失败 → 往 `_meta/reconcile.log` 追加一条 `{op, uri, error, at}`
2. 启动时扫这个日志重放一次，HTTP 开始监听之前完成；调度器每一轮（默认 30 秒）也重放。
   `op = index` 从磁盘重建索引记录，`op = permission` 调 `AclService.materializeNode`；
   两者都是 upsert，重复执行安全。
3. 重放成功后原子重写日志，只保留未解决的条目（临时文件 + `rename`）。重写前会在
   串行队列里重新读一次文件，重放期间新追加的记录因此不会被覆盖。坏行记 warn 后丢弃；
   `write` / `attachment` 的失败记录没有可重放的输入（正文或原始字节不在日志里），保留
   待人工处理。目标 URI 已经不存在时按已解决移出。

**启动顺序**：重放在 `main.ts` 的 `task.recover()` 之后、`commitRunner.start()` 与 HTTP
监听之前。监听之后跑会与用户请求争同一批 SQLite 写事务与文件锁，而且第一批请求可能
读到「文件在、检索不到」的旧状态；重放本身只读一个小文件，记录为 0 时成本是一次
`ENOENT`。**定期重放**不能省：启动扫描只覆盖上次退出前的记录，一个跑几个月的进程
如果只在启动时对账，运行期间新产生的失败会沉默到下次重启。调度器本身因四个维护开关全关而不启动时（`session.autoCommit.enabled === false`、`session.expiry.idleTimeoutSeconds === 0`、`memory.ttl.defaultDays === 0`、`memory.ttl.retentionDays === 0`），只有启动那一次重放。

**哪些失败会写日志。** 下面四类失败共用同一条记录实现（`services/reconcile-record.ts`）：
`add_resource` 的批量索引写、`IndexObserver` 的单节点索引行、`IndexObserver`
移动后的目标子树批量写，都写 `op: 'index'`；写路径的权限物化失败（资源、观察者）
都写 `op: 'permission'`。记录只记**能重放的目标**：移动失败记目标 URI（源 URI 在
磁盘上已经不存在，记它只会被当成「目标已删除」移出）；删除路径的权限失败记父目录（被删
节点自己同理会被移出）。读盘失败、索引**删除**失败与目录型节点的索引行不写记录。

**仍然无法重放的形态**：
- `write` / `attachment`：日志里没有可重放的输入（正文或原始字节不在记录里），只能重新提交；
- 索引**删除**失败（删除节点、移动时清理源前缀）：重放器只会补齐仍然存在的节点，没有
  「删掉一条过期索引行」这个动作，硬写一条记录也只会被按已解决移出，所以只记日志——
  过期行要靠 `pnpm reindex` 全量重建；
- 观察者读盘失败（连 `IndexRecord` 都构造不出来）：重放同样没有素材；
- 目录型节点的索引行：重放器只按文件重建（目录目标判 `not-a-file` 后移出日志），
  目录行缺失同样只能 `reindex`；
- 摘要生成的 L0 / L1 索引行（`SummaryService.#persistSummary`）：失败抛给调用方重试，
  不进对账——重试最终失败时没有重放线索；
- 跨进程同时追加（串行队列只覆盖本进程，v1 不支持多进程共享同一数据根）。

见 `docs/operations.md` 已知限制 8。

**三类派生数据各自怎么修。** 文件是真相（§7），索引行、权限行与向量都是它的派生，修法分「重放」与「重建」两级：`_meta/reconcile.log` 里已有的记录由重放器逐条补齐；重放器覆盖不到的形态（见上）只能 `pnpm reindex` 全量重建。

| 派生数据 | 失败表现 | 恢复方式 |
|---|---|---|
| 索引行（`node` / `node_fts`） | `find` / `search` / `glob` 少命中；`read` 按路径仍能读到 | 对账重放（`op: 'index'`，从磁盘重建该行）；重放覆盖不到的形态用 `pnpm reindex` |
| 权限行（`node_permission`） | 该看到的看不到（默认 deny：`list` / `tree` / `glob` 里整个节点消失）；该拦的没拦（`deny` 行缺失时越权节点出现在结果里） | 对账重放（`op: 'permission'` → `AclService.materializeNode`）。`.acl.json` 是真相，重放只重算派生表；文件本身被改坏要手工修文件，重放不生成授权 |
| 向量（`node_embedding`） | `vector` / `hybrid` 少命中（FTS5 仍能按关键词命中），不报错 | 写路径失败只记日志、不写对账记录；补齐有两条——服务监听之后的后台回填（`startVectorBackfill`，按 `model` / `content_digest` 判缺、正文从磁盘读、分批嵌入）与手工 `pnpm reindex`。启动时 `warnIfVectorsMissing` 仍对存量缺失记一条 `warn` |

**为什么不是回滚文件**：文件已经是对的，回滚反而丢数据。补偿的方向是「把索引追上来」，不是「把文件退回去」。

**归档期间并发写**

`session.commit` 的 Phase 1 要「读 live messages → 写归档 → 重写 live messages」。这中间如果用户又发了一条消息，会被 Phase 1 的重写覆盖。

**做法**：Phase 1 全程持 session 的 `TREE` 锁，`add_message` 也要拿同一把锁。Phase 1 只做落盘，很快（毫秒级），不会卡住用户。

**批量写入**

`add_resource` 导入 100 个文件，如果每个都单独 `write`，就是 100 次「打开文件 + 写 + 更新索引 + 触发摘要失效」。开销在三处：

| 开销 | 单独写 | 批量 |
|---|---|---|
| 索引事务 | 100 次 `BEGIN/COMMIT` | 1 次 |
| 摘要失效标记 | 100 次（每个文件各标一次父目录） | 10 次（按直接父目录去重） |
| 目录摘要重算 | 可能触发多次 | 结束后统一触发一次 |

批量路径（`ResourceService` 使用 `src/services/write-through.ts`）：

1. `invalidateParentSummaries` 先按**直接父目录**去重
2. 持父目录 `TREE` 锁写全部文件 → 一次 `index.upsert`（内部一个事务）→ `materializeAncestorPermissions` 逐级物化权限
3. 锁释放后，`invalidateParentSummaries` 对每个直接父目录调一次 `markStale`；再往上的祖先链由 `markStale` 自己传播（§9.3），批量路径不展开

**批量资源的写后钩子只有一份实现。** `add_resource` 绕开 `FileSystemService` 直接写 `ContentStore`，走三步：批量写 → 一次 `index.upsert` → 标记直接父目录摘要失效 + 物化写出来的节点与全部祖先的权限。物化失败时往 `_meta/reconcile.log` 追加一条 `permission` 记录（§10.6 的「索引双写补偿」），重放器据此重算该节点的物化权限。索引批量写失败则追加 `op: 'index'`：文件在盘上但 `find` 搜不到时，重放器必须看得见这次失败。`markStale` 必须在目录的 `TREE` 锁释放之后调：`SummaryService` 会拿目标目录的 `EXACT` 锁，与祖先 `TREE` 锁互斥，锁内调用会等到 `CONFLICT`。

**标记摘要失效只能用 `markStale`，不能用 `invalidate`。** 规则与后果见 §9.3。

**只去重到直接父目录，不预先算全部祖先。** 祖先链的传播条件（正文是否变化、到哪里停）由 `SummaryService` 的失效逻辑判断，批量路径重算一遍会造出第二套规则。同一目录下 10 个文件本来要标 10 次，现在只标 1 次——这正是去重到父目录的目的。

**为什么不能只做「循环调 write」再优化**：摘要失效是 Observer 驱动的，每个文件写入都会走到父目录标记。100 个文件就是 100 次标记，其中 90 次是重复的（10 个目录）。批量路径必须在**入口处**就去重，不能事后合并。

### 10.7 后台调度器

`src/bootstrap/scheduler.ts`。六个职责共用一条 30 秒的轮询；TTL 清扫在一次 `sweep()` 里同时做软归档与物理删除，下表拆成两行：

| 职责 | 判定 | 动作 | 幂等依据 |
|---|---|---|---|
| 自动提交 | `SessionService.shouldAutoCommit`（§10.2.1） | 走现有的阶段一 `commitPhase1` | 路径锁 + 归档序号单调 |
| 会话过期 | `now - 最后活动 >= session.expiry.idleTimeoutSeconds` | `archive`（默认）或 `delete` | 已归档的会话跳过 |
| TTL 清扫 | `max(node.updated_at, node.last_accessed_at) < now - memory.ttl.defaultDays`（§11.7） | `status = 'archived'` | `status <> 'archived'` |
| 临时上传清理 | `stagedAtMs < now - 24 小时` | 删 `_meta/tmp/` 下的文件与元数据 | 删掉的行下一轮自然不再出现 |
| 对账重放 | `_meta/reconcile.log` 有未解决记录（§10.6） | 重做 `index` / `permission`，成功后原子清理日志 | 两者都是 upsert |
| 请求记录裁剪 | `created_at < now - telemetry.requestLog.retainDays` 或超出 `retainRows`（§17.6） | 删 `request_log` 的行 | 删过的行不会再被匹配 |

**间隔 30 秒。** 来源未知（经验假设）：自动提交的判定是量级判断（15 万 token / 100 条消息），30 秒延迟相对对话时长可以忽略；更短的间隔只会让每条会话每 30 秒被 `load` 一次，而没有新消息时那次读不会有任何变化。

**会话从磁盘扫出来。** 会话不是 SQLite 行：`sessions/sess_xxx/` 是目录，`.meta.json` 是真相（§7），`GET /sessions` 也是列目录再逐个 `load`。所以遍历的是数据根下的 `{user,group}/<rootId>/sessions/<sessionId>/`。**不建 `session` 表**：那会造出第二个真相来源。

**半成品会话跳过。** 有目录、没有 `.meta.json` 的会话（`create` 崩在两步之间）按 `NOT_FOUND` 跳过，不记错误——它不是故障，是「建了一半」。

**失败隔离。** 每个会话的异常各自 `try/catch` 并记日志，TTL 清扫也单独兜底。`tick()` 本身**不抛错**：轮询失败只记日志，下一轮再试。抛出去会让定时器停在一个没人接的 rejection 上。

**重叠保护。** 上一轮没跑完时这一轮直接返回（`skipped: true`），不排队、不重叠。`stop()` 等在途的一轮跑完再返回，且**不打断**它：一次自动提交可能停在「归档消息已写、live 还没重写」的 `preparing` 状态，中断只会把「等一下」换成「下次补」。

**定时器 `unref`。** 与 §10.4 的执行器相反：调度器是周期性维护，不是「服务在跑」的证据；真正让进程活着的是 HTTP 服务。测试与一次性脚本不该为了一个每 30 秒空转一圈的定时器卡住不退出。

**配置全关时不起定时器。** `session.autoCommit.enabled === false`、`session.expiry.idleTimeoutSeconds === 0`、`memory.ttl.defaultDays === 0`、`memory.ttl.retentionDays === 0` 四者同时成立时，`createContainer` 不调 `start()`，只记一行「调度器未启动」。空转的定时器是纯浪费。`memory.ttl.retentionDays > 0` 也算一个开关：两段式里第一段（软归档）与第二段（物理删除）独立，`defaultDays: 0` + `retentionDays: 30` 是「不再新增归档、只回收已有的」这一种合法配法，漏判它等于让物理删除永不发生。

**删除会话前必须确认没有待复核记忆。** 关联只有一条：`archive_NNN/memory_diff.json` 记下了每次归档写入了哪些记忆（§6.6）。它就在会话目录里，所以删掉会话等于删掉「这条待复核记忆是哪个会话产出的」这唯一线索。只要归档产出里有一条记忆仍是 `pending`，就跳过删除并记 `warn`；清单读不出来时同样跳过（无法证明安全）。

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

**`sources` 是保留键，不是记忆字段。** frontmatter 里的 `sources` 记「这条记忆由哪几次归档产生」，由服务端在写入点追加（`MemoryUpdateInput.provenance`），不由模型输出，也不出现在 `fields` 里。它必须是保留键：`serializeMemoryDocument` 只写 `schema.fields` 与 `RESERVED_KEYS`，任何不在这两处里的键都会在整份重写时静默消失——复核通过、补丁合并、记忆合并都走 `serializeMemoryDocument`，读出来是对的、写回去就没了。`edit`、MCP 的 `write` 与 `POST /content/write` 三条路径都只替换正文、frontmatter 保留（语义保留，字节不保证），不在这条风险里；它们丢掉的是提交语义（§13.2），不是元数据。

**`MAX_SOURCES = 20` 的来源是经验假设。** 一条记忆通常由少数几次归档产生（新建一次、之后几次覆盖各一次）；20 是防病态增长的界（每次覆盖写都会追加），一条 URI 约 90 B、20 条约 1.8 KB，与一条记忆正文同量级。超过时保留最近 20 条，最旧的先丢。

**`sources` 在归档写入点产生，合并时继承。** 补丁合并步骤（`services/commit/steps/memory-merge.ts`）的每次 upsert 都带 `provenance: { sources: [archiveUri] }`，包括抽取产出的 add / update。记忆合并（§11.8）把本批被删除记忆的 `sources` 并进写出的保留者：保留者自己的在前，被删的按操作顺序追加，去重与 20 条上限沿用同一套策略，所以删除不会带走溯源。同一批里有多条写回时，每条都继承整批被删记忆的来源——聚合结果里没有可靠的分组信号，宁可多记。

**`memories/` 下不是记忆的文件会记一条 warn。** `read` / `listPending` 读 `.abstract.md` 这类文件时解析不出记忆 frontmatter（没有 `memory_type`），按「不存在」处理并记 `warn`——这是既有行为，不是新问题；看到日志里出现它，先确认读的 URI 是不是记忆文件。

内置类型：`profile`、`preferences`、`entities`、`events`（`addOnly`）、`cases`、`identity`、`soul`、`experiences`、`rules`。

**目录按信息职责划分，按需创建。** 长期内容统一放在 `memories/`，原始对话放在 `sessions/`，导入资料放在 `resources/`；不把全部记忆摊在根目录，也不把学习所得放进宿主技能目录。

| 路径 | 内容 |
|---|---|
| `memories/profile.md`、`identity.md`、`soul.md` | 画像、身份与长期原则 |
| `memories/preferences/{topic}.md` | 跨会话稳定的表达、工作与选择偏好 |
| `memories/entities/{entity}.md` | 项目、设备、人物等实体事实 |
| `memories/events/{date}-{event}.md` | 决定、里程碑与状态变化 |
| `memories/cases/{case}.md` | 一次具体任务的尝试、参数、结果与证据 |
| `memories/experiences/{topic}.md` | 可复用的方法、适用情境、反思与边界 |
| `memories/rules/{scenario}/{rule}.md` | 明确需要遵守的约束 |

`cases` 经过同一条抽取、合并和检索链路；Dreamer 预取相关案例作为经验提炼的上下文。手动整理更新或删除已有案例前，必须先读取正文，否则整批操作被拒绝。没有独立保留价值的一次计算可以只留在会话中，不强行生成案例或经验。

**浏览器新建记忆的路径也由服务端算。** 控制台的「新建记忆」只收类型、标题/主题与正文，提交到 `POST /memories`；`domain/memory-types/creation.ts` 的 `deriveCreationIdentity` 把标题映射成该类型的 identity 值（单段类型整份标题作值；`rules` 的 `{scenario}/{rule}.md` 按 `/` 分成两段；`events` 缺日期前缀时补今天的本地日期），再交给 `renderMemoryUri` / `renderPath` 用 schema 的 `filename` 模板渲染。响应带最终 URI，控制台只做跳转——路径规则仍然只有 `memories/` 下这一份，前端没有模板解析器。同类型同标题再次提交走 `upsertMemory` 的字段级合并，响应里的 `created` 区分「新建」与「更新」；`events` 是 `addOnly`，撞名返回 `ALREADY_EXISTS`。

#### 用户画像（`profile`）

画像**整份注入每次会话的开头**（`integrations/servers/session-start.mjs`），长度是每次请求的固定成本。它的 `description` 原样渲染进抽取提示词（`services/prompts/extract.ts` 的 `renderMemoryTypes`），所以那里写的是**判定规则**而不是摘要：收录范围、路由表、格式契约、反例。改它等于改模型行为。

| 判定 | 内容 | 归位 |
|---|---|---|
| 收录 | 姓名或称谓、年龄段、籍贯与当前所在地、当前学历职业与雇主、关系状态、长期健康 | `profile` |
| 日期型转变、已完成事件、做过的决定 | 「2026-10 离职」 | `events` |
| 沟通风格、喜好、习惯、对做法的取舍 | 「偏好 2 空格缩进」 | `preferences` |
| 具体项目、库、工具、组织、第三方人物 | 「`Settings::nextHop` 是三级映射」 | `entities` |
| 一次具体任务的尝试、参数与结果 | 「给 MIPS 添加 sll，仿真通过」 | `cases` |
| 必须遵守的约束、跨案例可复用流程 | | `rules` / `experiences` |
| 一次性技术细节、临时状态、推断、性格评价、无保留价值的一次计算 | 类型签名、代码片段、「他很严谨」 | 丢弃或留在原会话 |

**格式契约**：正文是一组 bullet（不带小标题），每条以 `(as of YYYY-MM-DD)` 结尾、单条不超过 30 字（日期后缀不算），同一可变状态只留最新值。

**哪些契约由服务端执行，哪些只靠提示词。** `domain/profile-format.ts` 的 `validateProfileBody` 是纯函数，只做字面判定；`MemoryService.upsertMemory` 在写盘成功后调用它。

| 契约条目 | 服务端校验 | 判据 |
|---|---|---|
| 不带小标题 | 是 | 非空行以 `#` 开头 → `heading` |
| 不用代码块 | 是 | 行首 ``` → `code-fence` |
| 一行一条 bullet | 是 | 不以 `- ` / `* ` 开头 → `not-bullet` |
| 以 `(as of YYYY-MM-DD)` 结尾 | 是 | 缺后缀 → `missing-date-suffix`。**全角括号同样接受**（`（as of …）`）：中文输入法与中文写作的模型会给出这种形态，它在中文语境下是同一个后缀，判成违规只会让这条 warn 被忽略 |
| 日期是真实归档日 | 是 | `Date.parse` 成功、年份在 2000–2100、回写后与原文逐字相同 → 否则 `invalid-date-suffix`。回写比对是为了拒绝 `2026-02-30` 这类被 `Date.parse` 归一化成 3 月 2 日的日期 |
| 单条不超过 30 字 | 是 | 按 Unicode 码点数（不是显示宽度、不是 UTF-16 码元），日期后缀不计入 → `entry-too-long` |
| 同一可变状态只留最新值 | 否 | 需要判断两条 bullet 是否在说同一个状态，正则做不到 |
| 陈述事实，不写评价与推断 | 否 | 需要语义判断；硬做会把「用户是后端工程师」这类事实误报 |
| 收录范围与路由表 | 否 | 需要理解内容属于哪个记忆类型，只能由提示词约束 |

**校验结果是警告，不是拒绝。** 不合规的写入**照常落盘**，只记一条 `warn`：日志带 `scope`（哪个 scope 的画像，如 `comem://user/alice`）、`uri`、`memoryType`、`violationCount` 与去重后的 `rules`，**不带正文**——画像可能含个人信息。丢弃不合规写入比接受更糟：那是把模型抽到的事实直接扔掉，而用户永远不知道。

**为什么按字符数而不是显示宽度。** 契约与成本都以字符/token 计，列宽不参与；东亚宽字符按 2 算会让 15 个汉字就撞线，等于把中文画像的上限砍半，而契约对中英文是同一个 30。`String.length` 数的是 UTF-16 码元（emoji 算 2），所以用 `Array.from` 数码点。组合字符（如国旗 emoji）仍可能算多个码点，这是已知边界。

**健康度自查。** `GET /health` 的 `memory.profileFormat` 返回 `{checked, invalid, violations, truncated}`：按索引里 `memory_type = 'profile'` 的节点逐个读正文跑一次校验。`invalid` 是**至少有 1 条违规的画像份数**，`violations` 是违规条数合计。一次最多检查 200 份（`PROFILE_CHECK_LIMIT`，经验值），达到上限时 `truncated: true` 并记一条 `warn`，三个计数都只应读作下界。`ObservabilityService.profileFormatHealth()` 是 `private`，只由 `health()` 调用，`memory.profileFormat` 是它唯一的出口；没有单独的分析端点。

**超阈值重写。** `memory.profile.maxChars`（默认 1000）是画像正文的字符上限。抽取时把**当前字数与上限一起**渲染进提示词（`renderProfileDirective`）：超过时要求这次输出一条 `replace content` 的整份重写，只保留稳定身份；未超过时用 `patch` 增量维护，但正文不符合格式契约（缺日期后缀、单条超长、留着历史值）同样整份重写。压缩**不额外调用模型**——它骑在本来就要跑的 `memory_extract` 上。

1000 字是工程余量：它在旧默认 800 字上增加 25%，最多可容纳约 21 条「30 字正文 + 17 字日期后缀」的满长 bullet（21 × 47 = 987）。这个数值没有对应的实测质量提升结论。

**产生侧与注入侧采用不同预算。** 产生侧 `memory.profile.maxChars`（默认 1000 字符）要求抽取时收敛；开局请求 `profileBudgetTokens`（默认 2000 token）还受服务端 `assembly.maxTokens` 与宿主字节上限约束。调整 `maxChars` 不改变检索组装或开局画像注入预算；显式写进配置文件或环境变量的 `maxChars` 仍按原优先级覆盖默认值。服务端优先注入正文，装不下沿既有层级降级；客户端整块缩减，先丢技能再丢背景。不能仅根据画像字符数保证总注入一定装得下，具体规则见 §8.6。

重写动作本身不会撞 `providers.llm.default.maxTokens`（默认 32,768）：一次重写最多写 1000 字正文，约 0.6–0.9K token，加上同一次输出里的其它记忆操作也远低于上限。真正会撞上限的是「一次归档抽出来的操作特别多」，那是 `maxTokens` 的既有风险，与画像重写无关。

### 11.2 合并操作

**材料时间保护。** 记忆 frontmatter 的保留键 `evidence_at` 表示最近一次写入所用材料的时间，与写盘时刻 `updated_at` 分开。自动抽取、经验归纳使用本归档非 system 消息的最大 `createdAt`；同 URI 的较早材料不能覆盖或删除较新节点，记录 `stale_evidence` 后继续整批。直接新建/修改正文使用当前时间；复核、版本快照和回退保留材料时间。旧文件缺键时允许首次更新。此保护是节点粒度：旧材料中仍有价值的独立字段也会被保守跳过；不识别自然语言中的事实有效日期，不替代事实级冲突判断。消息时间依赖宿主提供，跨机器时钟偏差仍可能影响先后顺序。

**删除后的重放保护。** HTTP 文件删除与 MCP `forget` 在路径锁内先原子写 `{dataDir}/_meta/forgotten/{sha256(uri)}.json`，再删除节点；写删除记录失败则不删除。记录原始 URI 与删除时间，父路径记录覆盖子树，自动抽取和归纳在写锁内检查它：删除之前的材料不能在同 URI 重新建出记忆，记 `forgotten_evidence`。删除记录独立于 SQLite，重建索引不会丢失；备份必须包含 `_meta/forgotten/`。删除记录不自动过期，新的材料或显式手工创建可以重建节点。它不是任意事实的语义遗忘，也不删除源会话、其它 URI 的同义结论、版本文件或已注入的宿主历史；后台合并/TTL的删除不创建用户遗忘记录。目录改名/跨路径重建不会迁移这些记录。只有带归档来源的自动写入受约束，内部维护调用不能用来绕过公开授权。

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

v1 用预取。每个多文件类型的 schema 做一次检索，`limit = max(5, prefetchTopN)`；单文件类型（`profile` / `identity` / `soul`）直接读该文件。检索结果的 `page_id` 标注随正文一起给模型，不另建映射表。实体页额外提供稳定 ID 的别名与已有实体关联的页码投影；模型只能输出页码，同批新增实体由服务端先分配 ID 再解析引用。归档产物同时持久化这些结构，任务重放不重分实体号。实体候选预取由名称/别名与作用域检索提供，不调用额外模型；embedding 不作身份合并依据。

提示词的静态骨架在 `prompts/extract-system.md` 与 `prompts/extract-user.md`；记忆类型清单、页面列表与会话记录由 `services/prompts/extract.ts` 渲染后注入。**空列表必须渲染成一句明确的话**（「（这次没有预取到已读记忆。）」），否则模型会自己编造编号——这条判断留在代码里，模板没有条件语法（§18「提示词」）。

### 11.4 抽取与 page_id

LLM 看不到原始 URI，只看到「第 N 个读过的记忆文件」（page_id）。输出里的操作引用 page_id，服务端再映射回 URI。`entityPages` 是可选的实体 page_id 数组：完整数组替换关联，空数组清除；省略保留当前引用。目标须为本次读取或同批成功写入的实体页。

让模型直接输出 URI 会引入拼写错误和幻觉路径；page_id 是它刚刚亲眼读到的编号。新建项用 ≥ 100 的编号，避免和已读项冲突。起始编号是代码里的常量（`NEW_PAGE_ID_START`），模板通过 `{{newPageIdStart}}` / `{{newPageIdExamples}}` 引用——写死在 `.md` 里会让「改常量」与「改提示词」漂移。

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
| `addOnly` 类型（`events`）的目标已存在 | 该条操作记入 `skippedOperations`，整批照常完成 |

**`skippedOperations` 是「这条操作为什么没生效」的稳定出口。** 每条跳过带三个字段：`memoryType`、机器可读的 `reasonCode`、给用户看的 `reason`（完整句子，带 URI）。抽取阶段的弱校验（编号越界、类型不存在、identity 拼不出路径）、字段级合并失败（`patch_not_found` / `patch_ambiguous` / `immutable_violation`）、写盘冲突都在这里汇合，`memory_diff.json` 原样落盘，控制台与运维按它查证。

**归档合并后的正文为空时整条不动。** 目标 schema 有 `content` 字段、但字段级操作的全部结果仍让正文缺失或只有空白时，`memory_merge` 记 `empty_content` 并跳过这个 URI：新目标不创建 frontmatter 空壳，已有目标保留原正文，同一归档里其它 URI 照常处理。这个闸门只约束归档合并；没有 `content` 字段的合法 schema，以及手工写入、MCP 写入不受影响。`patch_not_found` 等真实字段失败仍逐条保留，不能拿 `empty_content` 冒充补丁诊断。

**`addOnly` 的目标已存在是跳过，不是失败。** `events` 是「某时发生了什么」，写入模式是 `addOnly`：文件已存在时 `MemoryService.upsertMemory` 抛 `ALREADY_EXISTS`（§11.1「覆盖写等于篡改历史」）。`memory_merge` 捕获它，把这条操作记进 `skippedOperations` 后继续处理其余 URI——一条已存在的记录不该让整批归档失败。`reasonCode` 分两种：正文与已有记录**相同**是重放（`already_exists`，幂等，重跑多少次结果一样）；**不同**则是同 URI 的另一条事件（`uri_conflict`，本次内容没有落盘）。

**为什么这两种必须分开。** `events` 的 URI 由 `{event}.md` 的 identity 值拼出，是调用方（模型）指定的标识，不是正文派生的哈希——「同 URI」不等于「同内容」。都写成「已存在」会把「换个 `event` 标识」这个动作藏起来；分开记，`memory_diff.json` 才能回答「是重放，还是两条不同的事件撞了名字」。无论哪种，事件都不可覆盖写，能做的只有跳过并记录。

**为什么不做 LLM 二次合并**：那需要模型看到「这 5 条其实是同一件事的不同侧面」。v1 的抽取输出是结构化的（每次操作针对一个 schema 字段），同一字段的多条 patch 本来就该按顺序应用。语义重复（不同 URI 讲同一件事）留到 v2 再合并。

### 11.6 复核闸门

复核闸门按记忆类型打开，默认 `experiences` 与 `rules`（`memory.reviewRequired`）：

- 这两类写入时是 `pending`，不进检索结果。`rules` 来自抽取与补丁合并，`experiences`
  来自阶段二第 5 步的经验归纳（§10.1）
- 控制台「记忆复核」直接展示新增正文；更新按 `supersedes` 读取上一版本，再展示行级差异。
- 人工通过 → `active`；通过时可以把正文改成复核后的版本，若编辑则同时提交用户看到的
  `updatedAt` 作为版本标记；拒绝 → 回退到被顶替的版本，没有版本可回时删除并记录原因
  （§11.11）
- 其余类型直接 `active`

**编辑后通过与普通通过共用 `POST /memories/{uri}/approve`。** 空 body 保持旧行为：
`pending` / `archived → active`，已经 `active` 时 200 幂等空操作。编辑请求体是
`{content, expectedUpdatedAt}`；`content` 必须 trim 后非空，目标 schema 必须有 string
型 `content` 字段，`expectedUpdatedAt` 必须是待复核响应里原样带出的 `updatedAt`。服务端
在同一个 `exact(uri)` 锁内重新读取文档，只有它仍是 `pending` 且 `updatedAt` 等于版本
标记时才把 `content` 映射进 `fields.content`、更新 `updatedAt` 并置 `active`。写回保留
`createdAt`、`sources`、`validFrom` / `validUntil`、`supersedes`、记忆类型、实体 / 链接
及其它 schema 字段，URI 与 ACL 不变。

**过期编辑不能覆盖新版本或已生效正文。** 记录已经 `active` / 非 `pending` 时，编辑审批
返回 409 `CONFLICT`（`details.reason = "not_pending"`）；`expectedUpdatedAt` 不匹配时
返回 409（`stale_pending`）。两个并发编辑只有一个在锁内通过，后到者按 active 冲突返回，
不会把另一个正文覆盖后又声称通过。缺少版本标记或空白正文返回 400 `INVALID_ARGUMENT`。

**`status` 键存在但值非法 = 不可解析的记忆。** `domain/node.ts` 的 `parseStatusField(raw)`
分三档：键**缺失** → `active`（兼容没有这个键的历史文件）；合法值 → 照抄；**存在但非法**
（`status:` 空值、`status: Archived`、布尔或数字）→ 文档损坏。第三档不是「没有状态」：
猜一个值等于让一次手误绕过复核闸门（写成 `Archived` 的 `pending` 记忆会被读成
`active`）。各层的结论：

- 内容层：`parseMemoryDocument` 返回 `null`，`memory.read` 得 `null`，`listPending`
  不含它（`services/memory/document.ts`、`services/memory/query.ts`）。
- 索引层：`IndexObserver` 与 `pnpm reindex` 把它落成 `memory_type = NULL` +
  `status = 'active'` 并记一条 `warn`，**不保留索引里的旧值**——旧 `memory_type` 与旧
  `status` 一起作废。保留旧值会让索引与文件永久分叉：文件读不出来，`find` 却仍按上次
  的 `pending` / `active` 返回它。

**两侧的结论刻意不同。** 检索路径按「磁盘上有什么」工作，所以 `find` 仍能命中它（文件
存在、索引行是 `active`）；内容层按「是不是一条可解析的记忆」工作，所以读不到。`find`
的契约是「这里有东西」，`read` 的契约是「这是一条记忆」。

### 11.7 记忆 TTL 与过期清扫

记忆有存活时间，判据是**最后一次被使用**，不是写入时间：一条记忆在
`max(node.updated_at, node.last_accessed_at) + memory.ttl.defaultDays` 之前都算活着。
交付给调用方的检索结果与按 URI 读到的正文会写 `last_accessed_at`（与
`access_count` 同一句 `UPDATE`，§17.5 的热度衰减也读这两列），所以天天被读到的偏好
和从没被打开过的事件不会同时到期。

**什么算一次使用。** 「使用」= **进入了调用方的上下文**。不是「被检索到」，也不是
「被模型引用」——后者不可观测（模型有没有在回答里用上一条注入的记忆，服务端拿不到
证据），不追求。

| 路径 | 进入调用方上下文的部分 | 记不记 | 实现点（`src/services/retrieval/delivery.ts` / `filesystem.ts`） |
|---|---|---|---|
| `find` | 返回的命中列表 | 记 | `findWithDiagnostics` 里的 `DeliveryService.recordHits(outcome.hits)` |
| `search` `mode=list` | 合并去重后的命中列表 | 记 | `search()` 在 `mergeHits` 之后 `recordHits(hits)` |
| `search` `mode=context` | 组装后注入块里的条目（`AssemblyResult.items`） | **只记这些** | `contextWithDiagnostics` 在 `assemble` 之后 `recordHits(result.items)` |
| `rule_search` | 返回的规则列表 | 记 | 走 `findWithDiagnostics`，同一处 |
| `read` | 读到的正文 | 记 | `FileSystemService.read` → `#touchAccess` |
| `grep` / `glob` / `list` / `tree` / `stat` | 文件名 / 行匹配 / 目录结构 | 不记 | 无记账点 |

命中列表本身就是交付物，所以 `find` 与 `mode=list` 记全部返回的命中。`mode=context`
交付的是**组装之后**的注入块：§8.6 的预算、分层、去重、配额会把候选砍掉一大半
（实测见下）。记候选集等于把从未进入调用方上下文的记忆窗口推后——一条宽泛查询就
能刷新一大批记忆的 TTL，「曾经被搜到过」退化成「永不过期」，滑动窗口失去治理作用。
所以记账点在组装之后，用的集合是组装层返回的 `items`，**不拿候选集再推一遍预算**：
预算只有 `assembleContext` 一份实现，重复推导会立刻漂移（§8.6 第 1、2、4 步任何一
处调参都会漏）。

**组装内部读过、但没进注入块的不算。** `readOverview` / `readBody` 可能读了文件又被
预算丢掉，也读过之后降到「只有 URI」。读的是磁盘，交付的是 `items`：记账点只认后者。
这和 §8.7 的账本口径一致（只记账真的给了正文的条目）。

**只剩 URI 的条目算注入。** `detail === null` 的条目渲染成单行
`<memory uri="..." />`，地址本身进了调用方的上下文，所以访问记账仍然记它；§8.7 的
账本不记它，因为下一轮还得把正文补上。两个集合的差别就这一条（账本 ⊂ 注入），
是刻意的：TTL 问「这条记忆还有没有被用到」，账本问「下一轮还用不用再发」。

**`rule_search` 有一处同类的残余。** 它的相对阈值（默认 0.65）在工具层生效
（`src/api/mcp/tools/rule-search.ts`），而记账发生在服务层的 `findWithDiagnostics`
（`services/retrieval/service.ts`）：被阈值裁掉、没进返回文本的规则也会记一次。上界是 `RULE_LIMIT`（5）条，且被裁掉的规则不会
再随后的 `read` 续一次，量级可以接受；要消掉它得给 `find` 加一个「不记账」的入口，
那是一个只为工具层服务的开关，不值。

**`grep` / `glob` / `list` / `tree` / `stat` 不记。** 它们交付的是文件名、行匹配、
目录结构——「这里可能有我要的东西」，不是「我用了这条记忆」。把这些算进来，刷新一次
列表就能把整棵子树的 TTL 一起续命，滑动窗口立刻失去意义；控制台浏览同理（否则一个
开着目录页的窗口会不停给整个目录续期）。反过来也不吃亏：真要这条记忆，下一步一定是
`read`（记）或 `search mode=context`（记）。

**`readBytes`（`download` 的字节传输、二进制 `read`）不记。** TTL 只作用于
`context_type = 'memory'` 的文本记忆，二进制资源不在清扫范围；文本记忆在 MCP `read`
里走的是文本路径（记）。**已知偏差**：把一条文本记忆当附件下载（`GET /content/download`）
经过 `readBytes`，因此不刷新窗口。这一处按「资源下载」处理，没有按内容类型分流：
`readBytes` 同时服务二进制读取与资源下载，在这一层统一记会把资源也写进访问列；
分流需要在读取路径上加一次 `node` 查询。

**实测（`mode=context` 的截断比例）。** 60 条记忆（正文逐条不同、每条约 600 字），
宽泛查询 `记忆` 命中全部 60 条，`assembly.maxTokens = 1600`、`quotaPreset = coding`：
`find` 返回 60 条、`mode=list` 合并后 60 条、`mode=context` 的候选也是 60 条，组装后
**注入 3 条、被截断 57 条**（`items = 3`、`dropped = 57`）。这里砍掉的主因是配额而不是
预算：`coding` 给 `memory` 3 条（§8.6 第 4 步）。原始记录里的 `tokensUsed = 343` 是
**旧估算口径**（中文按 0.25 token/字）；现行口径是 `domain/session.ts` 的
`estimateTokens`（CJK 1 码点 = 1 token、其它 1/4），同一份数据约 4 倍、仍在 1600 以内。
这不是收紧预算，是修掉旧口径对中文的系统性低估——按旧口径 1600 的预算对中文实际能塞
约 6400 字。同一份数据下三条路径写入 `last_accessed_at` 的行数分别是 60、60、3——旧实现
（在组装之前记候选集）第三条也是 60。

**记访问与热度排序是两件事。** `telemetry.hotness.weight` 只决定热度要不要进检索排序
（§17.5），**不决定条目算不算一次使用**。`last_accessed_at` 有两个读者：热度排序
（`weight` 控制）与 TTL 清扫的滑动窗口（没有开关）。默认部署 `weight = 0`，如果因此
跳过写 `last_accessed_at`，agent 最典型的用法（通过 `find` / `search` / `rule_search`
拿到记忆）对 TTL 就完全不可见，被反复检索到的记忆仍会按写入时间过期。所以
`#recordHits` 只要交付了条目就记，与 `weight` 无关，同一请求内按 URI 去重。

**写代价。** `NodeRepository.recordAccess` 对整批 URI 只 `BEGIN IMMEDIATE` 一次、只预编译一条 `UPDATE`，N 条命中是 N 次 `run`，不是 N 个写事务。实测（Node 26.13、`node:sqlite`、WAL 文件库，各 20 轮中位数，两次测量）：1 条 0.5–0.6 ms、10 条 0.6 ms、50 条 0.8–0.9 ms、200 条 1.2–1.3 ms；UPDATE 语句数 = 命中条数，事务数恒为 1。`#recordHits` 仍然 fire-and-forget，写失败只 warn——访问统计不是检索正确性的一部分。注意 `node:sqlite` 是同步 API：不 await 只是不让调用方等 Promise，写事务本身仍在这条同步段里执行（上面的耗时就是它），所以这不是「零成本」，只是「不改变返回时机」。

清扫由后台调度器（§10.7）周期性执行，**两段式：先归档、再物理删**。

| 概念 | 语义 |
|---|---|
| `memory.ttl.defaultDays` | 滑动窗口长度（天），从最后一次被使用（写入、检索结果被交付、正文被读取）起算。`0`（默认）= 永不过期 |
| `memory.ttl.sweepBatchSize` | 每轮最多清扫多少条（默认 100），给一次 UPDATE 一个上界 |
| `memory.ttl.retentionDays` | 归档后保留多少天才物理删除。`0`（默认）= 永不物理删，只软归档 |
| `TtlService.sweep()` | 第一段：最后使用时刻早于 `now - defaultDays` 的节点 `status` 置 `archived` 并写 `archived_at`；第二段：归档满 `retentionDays` 天的节点删文件 + 索引行。两段 SQL 都带 `NOT_VERSION_FILE_SQL`：`.history` 下的版本文件不参与 TTL 的两段，数量由每 identity 5 份的截断兜住（§11.11） |

**TTL 是一个统一策略，不是逐条属性。** 早期有一个 `TtlService.setExpiry(uris, at)`，
给指定 URI 设一个绝对过期时刻。它没有任何生产调用方（HTTP 没有路由、MCP 没有工具、
控制台没有入口），而且与「滑动窗口 + 类型豁免」是两套互相矛盾的语义：一条被豁免的
记忆可以被 `setExpiry` 强行设成明天过期。`setExpiry` 与它的仓储方法已经删除，
`node.expires_at` 列一并删除（`0005_sliding_ttl.sql`）。没有「这一条不过期」的逐条
开关：要让某条记忆不过期，改它的类型（四类豁免），或把 `defaultDays` 设为 0。

**判据在清扫时现算，不存绝对时刻。** 三个后果：

- 改 `defaultDays` 立即对存量生效，不需要追平脚本，也不会有「按旧配置算出的陈旧
  过期时刻」；
- 检索命中路径（`recordAccess`）不用多写一列——它本来就在写 `last_accessed_at`；
- 第一段每轮做一次顺序扫描（`context_type = 'memory'` 且未归档的行），按表达式排序，
  用不上普通索引。**实测**（Node 26 的 `node:sqlite`，SQLite 3.54.0，`:memory:`，
  5 万行 `node`，取前 100 条）这条 `SELECT` 是 5.0–5.4 ms。没有为这个表达式建索引：
  索引会在 `recordAccess`（每次检索命中的写路径）上多维护一条索引项，而默认配置
  （`defaultDays = 0`）下第一段整体不跑。

**取最大值，不是「有访问就看访问」。** `max(updated_at, last_accessed_at)`：一条记忆
可能先被访问、之后正文又被改写。只用 `COALESCE(last_accessed_at, updated_at)` 会挑
那条更早的访问时刻，让刚写过的记忆立刻成为过期候选。

**类型豁免：四类永不过期。** `profile`（用户画像）、`identity`（agent 身份）、
`soul`（原则）、`rules`（规则）是**稳定的身份与约束**。它们会被反复读到，但「最近
没被读到」不等于「不再重要」——一条规则可能整月没有触发场景。让它们到期等于让
agent 忘掉自己是谁、忘掉用户是谁、忘掉约定；TTL 要清理的是 `events` /
`experiences` 这类时效性内容。

豁免集合是**硬编码**的，在 `domain/memory-types/index.ts` 的
`TTL_EXEMPT_MEMORY_TYPES`（与记忆类型定义同一处，类型名从各类型的 `type` 字段取，
SQL 里不出现字面量列表）。不做配置项：哪些类型承载身份是记忆模型的语义，不是部署
偏好，做成配置只会多一个「配错之后 agent 忘了自己是谁」的入口（§6）。

类型从 `node.memory_type` 取。**没有 `memory_type` 的文档不进 TTL。** 第一段（软归档）的
候选集带 `AND (kind = 'directory' OR memory_type IS NOT NULL)`，第二段（物理删除）带
`AND memory_type IS NOT NULL`（`src/adapters/sqlite/node-repository.ts` 的 `sweepExpired`
与 `selectPurgeable`）。**TTL 是记忆的回收站，不是文件系统的回收站**：`memories/**` 下手工
放的、没有 frontmatter / `memory_type` 的 Markdown 不再被归档或删除，仍然是 `active`，仍然能
被 `find` 命中。存量部署里若原来靠 TTL 回收这类文件，现在需要人工清理——已经归档的这类行
也不会被第二段清掉（`memory_type = NULL` 不入选），同样只能人工处理。这是刻意的口径，
不是遗漏。目录节点仍按原行为参与第一段（软归档），`.history` 子树例外（§11.11）。

`memory_type` 非空的四类豁免见上；没有类型的行同样不在候选集里，谈不上「豁免」。

**只对 `context_type = 'memory'` 生效。** `memory.ttl` 描述记忆的存活时间，
`resources` 不参与。

**两段式。** 第一段是软过期（`status = 'archived'`，写 `archived_at`）；第二段在归档
后超过 `retentionDays` 时才物理删除。中间隔一个保留期，既让「配错 TTL」（把 30 天
写成 1 天）在保留期里可观测、可撤销，又让 `memory.ttl.*` 真的能省磁盘——只有第一段
时 archived 行越积越多、磁盘一分没省。

**「归档多久」怎么算。** `node.archived_at`（`0002_archived_at.sql`）在第一段归档的
同一句 `UPDATE` 里写，值是**清扫时刻**，不是过期边界 `now - defaultDays`——用后者会
让保留期提前 `defaultDays` 天走完（配了「30 天过期、再保留 30 天」时，归档当天就满足
物理删除条件）。`archived_at IS NULL` 表示「不知道归档时刻」——迁移前就已是 archived
的历史行、或非 TTL 途径产生的 archived 行——第二段**永不删它们**：物理删除不可逆，
不把未知当成「很久以前」。

**第二段的安全性。** 只删 `status = 'archived' AND archived_at < cutoff AND
kind = 'document'`（叶子文档，目录节点不入选——目录里可能有没归档的兄弟记忆），并且带
`NOT_VERSION_FILE_SQL`：`.history` 下的版本文件不参与 TTL 的两段——第一段不归档、第二段
不物理删除（§11.11）。删除
复用 `forget` 的路径 `FileSystemService.remove`（求 MANAGE → 拿 TREE 锁 → 删文件 →
通知 `IndexObserver` 删 `node` / `node_fts` / `node_permission`），不另写一套删除逻辑。
单条删除失败只记 warn 跳过，不打断整轮。`retentionDays` 配得小时（< 7 天）记 warn，
危险操作不静默。

**为什么第一段仍是软过期。** 第一段只改 `status`，不删文件、不动 `node_permission`。
TTL 配错（把 30 天写成 1 天）时归档状态还能改回来，物理删除没有回滚；保留期就是这个
「还能改回来」的窗口。**归档只影响检索面**：§8.4 的四个面（`find` / `search` /
`grep` / `glob`）都只返回 `status = 'active'` 的节点，`grep` 与向量检索的候选集由
`glob` 枚举，共用同一条 SQL 谓词（`src/adapters/sqlite/retrieval-index.ts` 的
`ACTIVE_STATUS_PREDICATE`）。`read` / `download` 按路径仍然拿得到内容；`list` /
`tree` 是目录浏览、`stat` 是状态读取，它们**不按归档状态过滤**——文件还在磁盘上，
控制台要能看见归档内容并把它改回 `active`。

**两个默认值都是 0。** `defaultDays = 0` 关闭第一段：一条都不过期（第一段整段跳过，
不是「截止时刻 = 现在」——那会一次归档光）。`retentionDays = 0` 关闭第二段：归档
就是终点，与「只做软归档」的历史行为一致。物理删除不可逆，默认不能删任何东西；要省
磁盘必须显式配一个正数保留期，先观察一轮归档量再决定。两段互不依赖：只配
`retentionDays` 而不配 `defaultDays` 能清掉「上一轮配置留下的 archived 行」，`sweep`
不会因为第一段关闭就提前返回。

**幂等。** `sweep` 的 `WHERE status <> 'archived'` 让同一条过期记忆只被计数一次；
重复调用返回 0，不会把「已经归档」重复写一遍。第二段删掉行以后自然不再命中。

**归档不是内容修改。** 第一段不改 `updated_at`：它是热度衰减（§17.5）与滑动窗口
判据的输入，把治理动作当成内容写入会让一条从没改过的记忆看起来刚被更新过。

**恢复一条被误归档的记忆**：把 `defaultDays` 改回 0（或正确值）并重启，再把
`node.status` 改回 `active`（见 `docs/operations.md`「TTL 配错了」）。归档行保留
`last_accessed_at`，所以只要第一段还开着，「改回 active 但确实很久没用过」的记忆会在
下一轮再次被归档——这是滑动窗口的语义，不是缺陷。

### 11.8 Dreamer：经验、偏好与记忆整理

Dreamer 统一归档整理和手动整理，两种入口使用同一个服务、模型结果协议与记忆写入层。`memory_merge` 仍负责按归档检查点应用抽取补丁；它不负责判断已有记忆是否重复或已被取代。

- **归档整理**：读取本次归档片段（剔除工具调用及结果）、全部当前经验的最小目录（含 active 与 pending）、本次归档已写入的案例，以及按查询预取的相关案例。提示词为每条 user / assistant 消息附加原始消息 ID，并为每个案例附加 URI、正文和来源；模型按 `category`、`topic`、`claim`、`situation`、`approach`、`reflection`、`evidence` 输出结构化契约。`claim` 是独立结论并成为 L0 摘要，`situation / approach / reflection` 分别承担适用边界、做法、结果与未决限制。`evidence` 是 `{kind:"message", messageId, role, quote}` 或 `{kind:"case", caseUri, quote}`；服务端写盘前整批核验消息或案例在本次可见输入中，且 quote 逐字出现在对应正文里，任一失败都不写该批经验。消息和案例都可以独立支持经验；schema 要求 `evidence` 至少一项。写盘时把本次归档、实际引用的案例及案例自己的归档来源并入 `sources`，并写对应的 `derived_from` 边；新消息证据行会带上当前归档 URI，旧正文里的证据行由服务端原样保留且不截断。这里只做精确引用核验，不用关键词或语义评分冒充事实验证。字段长度与列表条数上限是控制提示词体积、模型输出成本和复核负担的产品预算，不构成质量保证。同一 topic 更新整条契约；若候选 topic 已在目录中但正文未预取，服务端先定向读取该记录再让模型重试，读取失败时拒绝覆盖并记录告警。文件仍为 `memories/experiences/{topic}.md`，复核策略沿用 `memory.reviewRequired`。自动整理不执行删除；输出对象及 operations 项都拒绝未知字段，手动整理的顶层 experiences 会被拒绝并提示改用 operations。原来写入归档元数据的 `experience_distill` 在读取时映射成 `dreamer`，旧检查点不会作废。
- **偏好推断**：只在个人作用域使用本次用户原话和最近会话的归档证据。历史取最近 8 个会话的末次归档（每个会话最多 1,500 个文本字符，跳过大于 256 KiB 的历史归档）；这些是控制输入成本的预算，不代表覆盖了全部历史。服务端校验至少两个不同会话、不同的可逐字匹配的原话，并要求自动运行引用本次归档；模型根据反例、纠正与适用条件决定是否提议。推断写入 `memories/preferences/inferred-{topic}.md`，保留引用归档与原话，始终待复核。已存在同 topic 的明确偏好或推断项时不写，不改 `profile.md`；拒绝会阻止同路径被拒绝前的材料重建。词义相近但 topic 不同的冲突目前仍由模型提示与人工复核判断。引用校验验证材料存在，不证明结论正确。
- **手动整理**：默认不开放，需要 `memory.dreamer.manualConsolidation: true` 和可用 LLM。`POST /api/v1/memories/dreamer` 接收 `{scope, dryRun?}`；默认预览，显式 `dryRun: false` 才写。调用者需要作用域管理权，对目标另查写入或删除权限。模型在有界的 `read` / `finish` 循环内读取可见的生效记忆，然后给出带理由的 add/update/delete 与可选的待复核偏好。默认最多 10 轮，是控制成本的设计上限；没有完成就不写。共享材料不会跨带独立 ACL 的子目录，清单之外的正文不能读；不自动展开组或项目。

手动端点返回 `adds` / `updates` / `deletes` 和逐轮 `trace`。旧地址 `POST /api/v1/memories/consolidate` 保留为同一处理器的兼容别名，权限、默认预览与写入语义相同。合并计划应用前验证目标合法、已有记忆状态与路径、ACL 及字段；先写保留项，再删被取代项。I/O 或锁冲突造成部分成功时，错误详情会列出已执行的操作。MCP 工具集合不变。旧配置文件里的 `memory.consolidation.enabled` / `maxIterations` 及对应环境变量兼容读取，新键优先。

相似度只能回答「这两条像不像」，回答不了「这两条里是不是有一条已经被取代」。两条
互相矛盾的约定同样相似，按阈值合并的两种结果都不对：都留下（矛盾仍在），或者不分
青红地删一条（可能删掉仍然有效的那条）。判断需要读正文、需要说明理由，所以决策交给
模型。

#### 循环

`LlmProvider` 只有 `complete` / `completeJson`，没有 tool calling（§4.4）。合并用
**多轮 `completeJson`**，每一轮输出一个 JSON 对象：

```json
{ "action": "read", "uris": ["comem://user/alice/memories/preferences/code-style.md"] }
{ "action": "finish", "operations": [
  { "kind": "update", "uri": "comem://.../code-style.md", "content": "...", "reason": "..." },
  { "kind": "delete", "uri": "comem://.../code-style-legacy.md", "content": null, "reason": "..." }
] }
```

| 轮次动作 | 服务端行为 |
|---|---|
| `read` | 读取已通过 ACL 过滤、列入本次候选清单的生效记忆正文，塞进下一轮上下文 |
| `finish` | 用 `operations` 结束循环；缺省是空列表（模型认为不需要改） |

每轮提示词包含 scope 下**全部**生效中记忆的清单（URI、类型、摘要与更新时间，
**不带正文**）、已经读过的正文、当前轮次。

默认提示词在 `prompts/consolidation-system.md` 与
`prompts/consolidation-user.md`。它们和抽取、经验归纳、摘要、查询重写使用同一套
仓库默认值 + 控制台覆盖机制（§18.1）；修改 `memory.dreamer.maxIterations`
后，系统提示词中的轮次上限会在下一轮渲染时同步更新。提示词是数据，但仍必须通过
占位符与变量校验，不能绕过 §11.8 的服务端操作验证、ACL 和整批失败规则。

| 配置 | 默认 | 语义 |
|---|---|---|
| `memory.dreamer.manualConsolidation` | `false` | 关着时 `POST /memories/dreamer` 与兼容别名 `/memories/consolidate` 明确拒绝（403），不返回空结果 |
| `memory.dreamer.maxIterations` | `10` | 轮次上限。**来源是设计约定**：每轮至少一次模型调用，10 轮足够读完一个 scope 的主要记忆；收敛通常发生在前几轮 |

到上限还没 `finish` 抛 `RESOURCE_EXHAUSTED`，**不做部分应用**：只合并了一半的记忆库
比没合并更难解释。

#### 校验：整批失败

`validateOperations`（`domain/consolidation.ts`）逐条检查，**任意一条不满足就整批
失败**，不逐条丢弃：

| 拒绝条件 | 为什么 |
|---|---|
| `delete` / `update` 的 URI 不在清单里 | 模型幻觉出不存在的路径 |
| `add` 的 URI 已存在 | 应该用 `update` |
| URI 不在允许的 scope 内 | 隔离：只能操作显式给出的 scope |
| `content` 为空而 `kind !== 'delete'` | 空正文等于删除，但走了 update 的路径 |
| `reason` 为空 | 没有理由的删除不可接受 |
| 同一个 URI 出现两次 | 同一批里 update 又 delete 是自相矛盾的；写盘阶段也会对同一条记忆重复加锁 |

**为什么整批失败而不是逐条丢弃**：模型产出的一半操作被执行、一半被丢弃，得到的是一份
自相矛盾的记忆库——比如「这条被那条取代了」的删除被丢掉，两条就都留下了。要么全做，
要么全不做。

#### 写回

- 操作只带 URI，`MemoryService.upsertMemory` 要的是「记忆类型 + identity 值」。
  中间这一步由 `resolveMemoryTarget`（`domain/consolidation.ts`）还原：**不切字符串**，
  目录与文件名模板都来自记忆类型定义（`renderPath` 的逆运算）。`profile` 这类固定
  文件名的类型 identity 不能由路径推出，所以只能 `update`，`add` 会被拒绝。
- 写盘前完成全部校验，然后**按 URI 升序逐条写入**。加锁不在这一层：`MemoryService`
  的 `upsertMemory` / `remove` 各自在自己的单文件 `exact` 锁内完成；这一层再持锁会
  等自己（`PathLockManager` 不可重入）。因此这**不是原子批次**——中途 `CONFLICT` 或
  I/O 失败时，前面已应用的操作不会回滚，错误 `details` 带上已应用的清单（下一节）。
  URI 升序只让报告与日志的顺序确定。
- `delete` 必进日志，带模型给的 `reason`。

#### 溯源

被合并掉的记忆删除之后只剩磁盘历史，所以**本批被删除记忆的 `sources` 会并进本批写出的
每一条**：保留者自己的在前（顺序不变），被删的按操作顺序追加，去重与 20 条上限沿用
§11.1 的同一套规则。`entity_refs` 与 `memory_links` 属于各自文件，自动 consolidation 不转移它们；如需保留已删除记忆的关联，应在删除前显式纠正目标文件。

**已知限制：`add` 一条「参考了现有多条、但把原条目留着」的新记忆，不会继承它们的
来源。** 模型输出里没有「我参考了哪几条」这个信号，按正文猜就是编。这类记忆的溯源从
它自己被归档的那一次开始。

**被删记录的 `sources` 里出现不合法的 URI 时整批失败**（`INVALID_ARGUMENT`），一条
记忆都不删：打错的 frontmatter 必须在写盘之前拦住，否则删除已经应用、没有回滚
（下一节「回滚语义」）。

**这条校验是不对称的。** 只有**被删除**的记录会被逐个 `Uri.tryParse`——它们的来源要
并进保留者，坏值会在写盘中途炸掉整批。**保留者自己**从磁盘读出的坏 `sources` 不参与
校验，会原样留在文件里、不报错；写入侧只做字符串去重与 20 条截断，不校验已有条目的
URI。这是当前行为：保留者路径没有崩溃风险，来源字符串原样展示即可，所以没有把它升级
成整批失败。

#### 回滚语义

`MemoryService` 没有事务（一条记忆一个文件），`filesystem` 端口也拿不回逐字节前像
（`created_at`、`status` 会在重写时被重新计算）。所以**不做假回滚**：全部校验前置，
把「中途失败」压到只剩 I/O 与加锁失败；真的中途失败时错误 `details` 里带上已经应用
过的 `adds` / `updates` / `deletes`，由运维按这份清单收尾。

#### 隔离

- 只允许操作 `scope` 下的记忆（`validateOperations` 的 `allowedScopes`）。
- **不展开组**：`comem://group/eng/` 的记忆不会因为调用者有 `group:eng` 就被合并。
  合并是**写**操作，scope 必须显式指定。
- 清单与正文用**调用方自己的 principals** 读取：`restricted` 切断的节点不能因为
  「scope 根是调用方」就被读出来，然后删掉一条调用方本来无权看到的记忆。
- **`pending` / `archived` 不是候选**：`pending` 还在复核（§11.6），删掉它等于绕过
  复核闸门；`archived` 已被 TTL 归档（§11.7），清理要按 TTL 的策略走。清单过滤之外，
  写回前还会再读一次状态：`add` 的 `existing` 用的是**全部**记忆文件，`update` /
  `delete` 的目标必须是 `active`——模型可以凭空写出一条真实存在的路径（不算幻觉），
  只靠清单过滤会让它通过「存在」校验然后被删掉。
- 清单来自检索索引（文件是真相，索引是派生，§7）。文件写了但索引还没同步时不会出现
  在清单里，也就不会被合并——漏合并比「合并了一份陈旧的正文」安全。

#### 入口

`POST /api/v1/memories/dreamer`，body `{ "scope": "...", "dryRun": true }`，
需要 `manage`。**`dryRun` 默认 `true`**：合并会 `delete`，不传就等于预览，误点的代价
不可逆。`POST /api/v1/memories/consolidate` 是同一处理器的兼容别名。**不进 MCP**
（§3：15 个工具，不多不少）。

模型结果协议同时服务归档整理、偏好推断与手动整理：`action`、`experiences`、
`inferences` 和 `operations` 都是可选字段。手动整理把缺少 `action` / `operations`
解释为没有需要改的内容；归档阶段接受 `experiences` 与 `inferences`，拒绝普通
add/update/delete 操作。推断偏好仍然只通过 `inferences` 写入待复核文件。

### 11.9 本机 Agent 对话导入

用户的机器上散落着历史对话（Claude Code / Codex / DeepSeek / Qwen）。这些对话里的
偏好、约定与踩过的坑是 CoMem 要存的东西，但用户不会一条条搬。`pnpm ingest` 把它们
导进会话目录，再走 §10.1 的提交管线。

**导入命令只落归档、建任务；记忆由阶段二抽取**（§10.1），与 `remember` 工具同一条
路径。所以 `pnpm ingest` 在导完一批会话之后必须把阶段二驱动到结束——否则任务停在
`pending`，用户得到的是「导了 908 个会话，`find` 0 命中」。见「导入后的处理」。

**没有可用模型时阶段二跳过，不报错。** `providers.llm.default.type: disabled` 时
每个任务都会停在 `DisabledLlmProvider`。阶段一（归档）不依赖模型，「先把数据导进来、
模型以后配」是合法的部署顺序，所以这里降级而不是拒绝：会话照常归档、任务照常建
（停在 `pending`），报告的 `extraction` 是 `{ "skipped": true, "reason":
"llm_disabled" }`，并记一条 `warn` 日志。**跳过必须可见**——两个字段、一条日志、
一行终端输出——否则用户以为跑完 1,076 个会话就抽好了记忆，实际 `find` 一条都搜不到。
与 `rerank.enabled` 的差别在这里：开了重排却不重排没有任何用处，开了导入却不抽取
还有一半用处（原始对话落盘、可检索）。

**注意「停在 `pending`」只对导入进程成立。** 同机若有服务端在跑，它的
`CommitRunner`（默认启动、每秒轮询）会认领这些任务。修复前它会停在
`memory_extract` 并置 `failed`（`INVALID_ARGUMENT` 是终态错误，不会重试）；现在
归档提交与导入走同一条判据：跳过 `memory_extract` 与 `memory_merge`，任务以
`done` 结束，`.meta.json` 的 `skippedSteps` 写明原因。两种形态都没有记忆抽取，
区别是任务状态——`done` 的归档不会在配好模型后补抽取，要让「先归档、以后再抽取」
成立，得在没有服务端共用同一个数据目录时导入（任务停在 `pending`）。

#### 两条路，同一段管线

本机历史对话有两条入口，**不是二选一**：它们负责的阶段不同。

| | 服务端适配器（`pnpm ingest`） | Agent 侧提示词（`docs/ingest-prompt.md`） |
|---|---|---|
| 谁跑 | CoMem 进程内的 `LogSource` | 用户本机的 Agent |
| 能读到什么 | 服务进程有权限的路径 | 用户明确指定、Agent 能访问的文件或粘贴的文本 |
| 输入 | 四个内置宿主格式 | Agent 将能解析的内容转成 `{role, content, createdAt}`，先给预览，确认后才写入 |
| 产出 | 会话归档和提交任务 | 同样的归档和任务，经 `remember`；响应包含实际 `archiveUri`、消息数、`taskId` |
| 之后 | 阶段一 → 阶段二 → 记忆 | 完全一致 |

**为什么不是二选一。** 服务端适配器只能覆盖「服务进程能读到、且格式已内置」的宿主；
导出目录在用户自己的机器上，CoMem 进程看不到。反过来，Agent 侧提示词要自己解析
每个宿主的日志格式，格式一变就漂——所以常见宿主仍然有服务端适配器。

**Agent 只负责「原样上传」。** 提示词不写 `memories/*.md`，也不需要知道
`memory_type`、目录布局与 frontmatter 格式。它把对话解析成消息数组，调 `remember`
（带稳定的 `sessionId`）上传原始会话；归档、抽取、合并、复核闸门全在服务端。

**这条边界是硬约束，不是实现细节。** 让 Agent 直接写 `memories/*.md` 会绕过：

- **LLM 合并**（§11.2 / §11.8）：同一条事实会以多份副本落盘，且互相矛盾；
- **复核闸门**（§11.6）：`experiences` / `rules` 不再需要人工通过；
- **摘要失效**（§9.3）：索引里的摘要与正文对不上；
- **补丁合并**（§11.5）：同一 URI 的多次写入没有收敛。

结果就是「导进来的记忆」和「正常流程产出的记忆」不是同一种东西——两条写入路径迟早
会漂，而漂移只在检索质量下降时暴露。

#### `remember` 的 `sessionId` 与幂等

不传 `sessionId` 时 `remember` 每次新建一个随机会话，这是「把当前这段对话存一下」的
语义。批量上传必须传 `sessionId`（`<harness>-<native-id>`），否则 908 个会话重跑一次
就变成 1,816 个。

- **传了**：会话已存在就追加、不存在就创建（`SessionService.ensure` 不覆写消息）。
- **幂等**：消息的稳定 ID 由 `services/session.ts` 的 `stableMessageId(role, text, createdAt)` 算（与 ingest 同一个实现）。追加前收集会话已有的
  消息 ID（live + `history/archive_NNN/` 的 `archivedMessageIds`），命中就跳过。所以
  **调用方必须给同一消息传入同一个 `createdAt`**；不传时用当前时刻，重跑无法去重。
  导入提示词要求保留源时间（统一为 ISO 8601 UTC）；缺失时用 Unix 纪元加消息序号毫秒作为占位。
- **没有新消息**：不提交，返回 `taskId: none`。live 里还有上一次崩溃留下的未提交消息时
  仍然提交——否则它们永远停在 live 里。
- **并发**：去重是「读现有 → 追加」两步，没有跨请求的锁。批量导入是单协程顺序调用，
  不受影响；并发同 `sessionId` 的两个调用各追加一份是已知窗口。
- **跨入口**：提示词给来源会话分配 `import-` 前缀的哈希 ID，与内置适配器和 Hook 的会话 ID 不同；跨入口不保证去重。没有原生 ID 时按解析结果哈希，修改内容或改变解析结果会改变会话 ID。

#### 数据流

```
LogSource.discoverSessions()  →  SessionRef（harness, nativeSessionId, locator, …）
        ↓
LogSource.readMessages(ref, cursor, limit)  →  NormalizedMessage[] + 新游标
        ↓
IngestService：SessionService.create / addMessage / commitPhase1
        ↓
ingest_cursor：原生会话 → 我们的 session URI + 读到的位置
```

`NormalizedMessage` 是宿主无关的对话轮（`role` / `text` / `createdAt` / `model` /
`cwd`）。适配器只负责把各自的日志格式翻译成它，编排层不认识任何宿主的字段。

#### 导入后的处理：为什么默认等阶段二

阶段一只写归档、建任务（`pending`），阶段二由 `CommitRunner` 认领（§10.4）。一次性
命令退出后没有东西再驱动执行器，任务就停在 `pending`——**「导了 908 个会话、`find`
0 命中」不是检索坏了，是抽取从未发生**。所以 `IngestService.run` 默认
`waitForExtraction: true`：每导完 `ingest.extractionBatchSize`（默认 20）个会话，
就把执行器跑到队列空。

| 选项 | 默认 | 作用 |
|---|---|---|
| `waitForExtraction` | `true` | 导入后等阶段二。关掉时报告里的 `extraction` 是 `null`；没有可用模型时是 `{ skipped: true, reason: 'llm_disabled' }` |
| `ingest.extractionBatchSize` | `20` | 每批等多少个会话；来源见 `config/schema.ts` 的注释 |
| `ingest.extractionTimeoutMs` | `1800000`（30 分钟） | 每批的最长等待。`0` = 不等 |
| `--no-wait` | — | 只导入、立即返回 |
| `--timeout <秒>` | — | 覆盖每批超时（`--timeout 600` = 10 分钟） |

**为什么分批。** 908 个会话 × 每会话 1–2 次模型调用 ≈ 2–3 小时。等全部导完再等阶段
二，用户几个小时看不到一行进度；一批发生异常也会把整次等待算失败。分批之后超时按
**批**算（不是按总量），用户按「批」看到进度，一批失败不阻塞后面的批。

**超时不是取消。** 到点后不再认领新任务，**在途任务跑完再返回**（与
`CommitRunner.stop` 同一取舍：中断一个跑到一半的合并会留下「部分步骤已标完成、却
没有 `.done`」的归档）。没跑完的任务留在队列里，服务端执行器或下一次 `pnpm ingest`
继续。

**执行器是全局 FIFO 队列，不按来源过滤。** 任务表没有 `source` 列；`--source` 决定
「导什么」，不决定「抽什么」。历史积压会被先认领，报告里的完成数照实统计。要清理
积压可以起服务端，或清掉对应 `ingest_cursor` 行重导。

**报告里的 `memoriesPendingReview` 必须单独看。** `experiences` / `rules`
（`memory.reviewRequired`）写入时 `status = 'pending'`，**不参与检索**（§11.6）。报
告里「抽取 100 条记忆（30 条待复核）」意味着 70 条能搜到、30 条要
`POST /api/v1/memories/{id}/approve` 之后才会出现；只报总数会让用户以为 100 条都在。

**`--dry-run` 忽略 `waitForExtraction`。** 没有任务可跑；为了「看看抽取效果」真的
调模型会产生费用且不可逆。报告里的 `extraction` 是 `null`。

#### 游标：为什么必须有

源日志是**追加式**的。今天导了一半，明天又多了 500 条；没有游标就只能全量重导，
而重导会产生重复会话。`ingest_cursor`（`0001_init.sql`）的主键是
`(harness, native_session_id)`，同一个原生 ID 在不同宿主里是不同会话。

两种游标：

| 类型 | 用于 | 值 |
|---|---|---|
| `byte_offset` | 追加式 JSONL（Claude Code、Codex） | 最后消费完的那一行**结束之后**的字节位置 |
| `tree_node` | 树形导出（DeepSeek、Qwen） | 最后消费完的节点 ID；空串 = 还没读过 |

**游标只在消息落盘之后前进。** 反过来（先写游标再写消息）时，一次磁盘满或进程被杀
就会永久丢掉那一段——日志还在，但游标越过去了。

**解析失败的行跳过并计数，不中断导入。** 一行坏 JSON 不该让 908 个会话都导不进
来。会话层面的失败才进报告，且每个会话独立 `try/catch`。

#### 幂等与续跑

同一个 `(harness, nativeSessionId)` 跑第二次：游标已经在末尾，`readMessages` 不
前进，报告里 `skipped + 1`，不建会话、不写消息、不提交。首次导入在游标行里记下
`session_uri`，续跑靠它找回同一个会话。

**游标之外还有一层去重。** 游标只在消息落盘之后前进，所以「一批消息写完、游标还没
写」处崩溃时，重跑会从**同一个**游标再读一遍。消息 ID 因此是**确定性**的：
`services/session.ts` 导出的 `stableMessageId`（`sha256(role + \0 + text + \0 + createdAt)`）。
**这是唯一实现**：`remember` 与 ingest 都直接 import 它，没有第二份公式——各算一份时
公式一漂，两条写入路径就互相看不见对方的去重。追加前先收集会话已有的消息 ID——live
加全部归档的 `archivedMessageIds`——命中就跳过。

| 崩溃点 | 重跑行为 |
|---|---|
| 消息写完、游标未写（**同一会话**，即第 2 批及之后） | 按稳定 ID 跳过，不重复追加 |
| 消息写完、**第一条**游标未写 | 会话 URI 只存在游标行里，重跑会新建一个会话，原会话成为孤儿 |
| 源日志没有 `createdAt` | 只能填当前时刻，ID 不稳定，这一段仍会重复 |

前两行是**顺序**决定的：`session_uri` 记在游标行上，而游标行在消息之后写。要让第一
条游标也不丢，得先写「原生 ID → 会话 URI」的映射再写消息——那与「游标只在消息落盘
之后前进」是同一类顺序问题的另一面，不在本 wave。

#### 各宿主的过滤规则

| 宿主 | 路径 | 保留什么 | 丢弃什么 |
|---|---|---|---|
| Claude Code | `~/.claude/projects/<slug>/<uuid>.jsonl` | `type` 为 user / assistant；`content` 里的 text block | `isSidechain`（子 agent）、`isMeta`（合成记录）、`tool_use` / `tool_result` / `thinking`、取完为空（纯工具轮） |
| Codex | `~/.codex/sessions/**/rollout-*.jsonl` | `type = response_item` 且 `payload.type = message`；`input_text` / `output_text` | `reasoning`、`function_call*`、`custom_tool_call*`、`event_msg`、`developer` 角色 |
| DeepSeek | `~/Downloads/**/conversations.json` | `message.fragments` 里的 `REQUEST`（user）/ `RESPONSE`（assistant） | `THINK`、`TOOL_*`、`FILE`、`SEARCH` |
| Qwen | `~/Downloads/**/Qwen-chat-export-*.json` | `history.messages` 的 user / assistant；正文优先 `content`，为空时取 `content_list` 里 `phase = answer` | `thinking_summary` / `web_search` / `think` 等 phase |

`~/.claude/history.jsonl` 是命令历史，不是对话（没有 `type` 字段，发现阶段跳过）。
DeepSeek / Qwen 的树按 `children[0]` 取**第一条子分支**：分叉是编辑 / 重新生成的
产物，它们共享同一段前缀，把每个叶子都导一遍会让同一句话出现 N 次。

Qwen 的导出格式与 DeepSeek 不同（`chat.history.messages`，正文在 `content_list`
的 answer 段），实测文件里还存在未转义的引号导致整份 JSON 不可解析。**这种情况明确
抛 `INVALID_ARGUMENT` 并带 `locator`**——静默返回 0 个会话会让「导入完了但什么都
没发生」看起来像正常状态（AGENTS.md §1）。

#### dry-run

`--dry-run` 不建会话、不写消息、不写游标、不提交。它仍然读游标与源日志，所以
「会新建多少 / 会跳过多少」是真实判断。CLI 在 dry-run 下只打开**只读**数据库连接
（库文件不存在就当作没有游标），文件系统层面也不创建 `_meta`。

#### 溯源的边界

`SessionMeta` 是冻结契约，没有 `source` 字段，`metadata-file.ts` 读回时也会丢弃未
知字段。所以「这条会话从哪来」记在 `ingest_cursor` 行的
`(harness, nativeSessionId, locator → session_uri)` 上，而不是伪造一个读不回来的
`.meta.json` 字段。要在会话元数据里直接看到来源，需要先扩 `SessionMeta` 这个冻结
契约。

#### 配置

```yaml
ingest:
  enabled: false       # 默认关：导入会写大量数据，必须显式开启
  batchSize: 100       # 每个会话一次读多少条
  paths:               # 留空用各宿主默认路径
    claude-code: []
    codex: []
    deepseek: []
    qwen: []
```

#### 已知限制

- **导出前的脱敏会破坏 JSON。** 数字串被替换成中文字符串 `密码保护`
  （`"total_tokens":4密码保护811`、`"create_time": 1791275310.6密码保护9`），三份
  真实文件（Qwen 导出、ChatGPT 的 `conversations-000.json` / `library_files.json`）
  因此不是合法 JSON。解析器先按「`密码保护` → `0`」修复再试一次；仍然失败才跳过该
  文件并记进 `report.errors`，**不中断同一来源的其它文件**。被抹掉的是计数与时间戳
  的高位，会话结构与正文都在。
- **会话消息是文档节点，但抽取出的记忆仍要等阶段二。** `messages.jsonl` 写完
  `ContentStore` 之后同样走 `IndexObserver`，所以 `find` / `glob` / `read` 都能
  到达它（live 会话与归档目录一致，见 §6.5）；阶段二的 `memory_extract` 产出的
  记忆不在这个文件里。`pnpm ingest` 默认等阶段二（见「导入后的处理」），
  `--no-wait` 时报告会明确说明「`find` 暂时搜不到抽取出的记忆」。没有可用模型时
  阶段二被跳过，报告里的 `extraction.skipped` 为 `true`。
- **ChatGPT 的 HTML 导出不做适配器。** `chat.html` 是「另存为网页」，DOM 解析脆弱
  且不是官方导出格式；官方导出里的 `conversations.json` 才是稳定接口。
- **Qwen 的损坏导出不可用。** 未转义的引号（`Expecting ',' delimiter`）不是脱敏
  伪影，修复救不回来；适配器跳过该文件并记进报告，不静默返回 0 个会话。
- **Codex 的 94 个 rollout 文件只对应 20 个 `session_id`。** 文件名带 `_<threadId>`
  后缀的是同一会话的续写 / 分叉，`session_id`（`session_meta.payload`）才是幂等键。
  按文件导入会得到 4.7 倍重复；适配器按 `session_id` 发现会话。
- **`.meta.json` 里没有 `source`。** 见「溯源的边界」。

### 11.10 记忆关联边（links / backlinks）

**关系建模的边界。** 实体身份、别名与记忆到实体的关联已经在文件 frontmatter 闭合；SQLite 的 `memory_entity`、`memory_alias`、`memory_entity_ref` 是派生索引。它们支持一跳实体邻域，不是通用图数据库。`sources` 与 `memory_link` 仍提供溯源；`derived_from` 的归档邻居不自动注入。跨实体的业务谓词关系、任意多跳检索与图服务器未实现。

**文件优先与迁移。** 所有实体引用和显式 URI 关联均随起点 Markdown 原子更新，结构索引由 `0009_memory_structure.sql` 所建表从文件离线重建；不提供全库边文件。首次服务启动和 `reindex` 会把旧数据库中的 `references` / `related` 先导出到 `_meta/migration/memory-links-*.json`，再迁入起点文件。失败时保留导出和原表并报告；缺失起点无法成为正常 Markdown 记忆，仍留在导出以供人工处置。实体邻域只对问题明确提及且可读、未冲突的具体实体展开，名称匹配要求文本边界；候选按原查询 FTS 和已生成的 query embedding 过滤，最后仍经现有预算、ACL、融合、重排与上下文装配。

文件结构、用户目录示例、召回边界与迁移取舍见[文件实体记忆设计说明](design/file-first-memory.md)。

记忆之间可以有**关联边**：一条记忆指向另一条记忆（谁引用了谁、一条结论从哪条资源
推出来）。这一节定义它的存储、产生端与查询面。**它不是多跳检索**——`links` 不参与
`find`、不进 `node_fts` / 向量索引、检索时不展开邻居。它是**关联数据 / 溯源**，与
「检索到之后展开上下文」是两件事。

#### 当前存储与已知缺口

现有实现将边写入 `memory_link` 表（迁移 `0003_memory_link.sql`）。其中 `derived_from`
可以从记忆文件的 `sources` 重建；`references` / `related` 尚无对应的文件记录，只保存在
数据库中。这是现有关联功能的持久化缺口，不能作为后续实体关系的存储方案；仅备份记忆
文件目前不能恢复这两类边。补齐文件格式与迁移前，仍需保留原数据库来保全已有记录。

SQLite 适合保存正向与反向关系的查询索引：`from_uri` 与 `to_uri` 分别建索引，
`backlinks` 不必逐次扫描文件。关系事实写在文件与反查走数据库可以同时成立；索引可以
派生，用户明确表达的关系本身需要文件记录，不能只在数据库里保存。

表结构（列名与语义）：

| 列 | 类型 | 含义 |
|---|---|---|
| `from_uri` | TEXT | 边的起点（记忆 URI） |
| `to_uri` | TEXT | 边的终点 |
| `link_type` | TEXT | 语义标签（`references` / `derived_from` / `related` …），开放字符串 |
| `weight` | REAL | 关联强度，默认 1.0 |
| `match_text` | TEXT | 触发链接的原文片段；空串 = 无具体出处 |
| `description` | TEXT | 一句话说明 |
| `created_at` / `updated_at` | TEXT | ISO 8601；`weight` 被抬高时刷新 `updated_at` |

去重键是 `(from_uri, to_uri, match_text)` 的唯一索引。**`match_text` 用空串而不是
`NULL`**：`NULL` 在唯一索引里互不相等，同一条裸链接（无出处）会被反复插入。

**不设跨存储外键。** 记忆正文在文件系统里，不在本库；`from_uri` / `to_uri` 指向的
记忆是否存在，SQLite 无从校验。悬空边写时不拦、读时容忍——删一条记忆不级联删边，
但反查只回答「谁指向这个 URI」，悬空边不会污染别的记忆的查询。

#### 谁产生 links：归档管线的两个写入步骤

**`sources`（frontmatter）是真相，`memory_link` 是它的派生读模型。** 一条记忆从哪几次
归档来，答案写在文件的 `sources` 里；`memory_link` 只补 `sources` 回答不了的反查
（「这次归档产生了哪些记忆」）。

产生端是归档管线的两个写入步骤，都在记忆文件写成功之后写 `derived_from` 边：

- `MemoryMergeStep`（阶段二第 3 步）：每条记忆 `upsertMemory` 成功后，写入一条
  `from = 记忆 URI`、`to = 本次归档 URI` 的边。这次写入的原始材料就是本次归档，
  抽取模型看不到归档 URI；`sources` 里更早的归档，边在各自那次归档里已经写过。
- `ExperienceDistillStep`（阶段二第 5 步）：每条经验写盘后，同样写入一条指向本次
  归档的 `derived_from` 边。

**links 写失败只记 `error`，不让归档失败。** 记忆文件已经正确落盘，派生物晚一步或
缺失可以由 `sources` 重建；为了派生读模型回滚真相、或者把一次归档标成失败，方向都是
反的。先写文件、后写派生也是同一个理由：反过来会让派生物比真相更早存在。

**重建入口是 `pnpm reindex --only=links`**（`--only=all` 含这一段；`src/commands/reindex.ts`
的 `needsLinks` 与 `MemoryLinkService.rebuildDerived`）。语义有四条：

- **范围只限 `derived_from`。** `references` / `related` 在 frontmatter 里没有真相，推不出
  来，也不能被这次重建误删——`MemoryLinkRepository.replaceByLinkType` 只 `DELETE` 调用方
  指定的那个 `link_type`。
- **先清空再整批写入**，在一个短事务里。读盘与嵌入都不在事务内，被杀后重跑得到同一份边，
  所以是幂等的；增量补齐做不到这一点——它删不掉「`sources` 里已经没有了、表里还留着」的
  边，而那正是手工改过 `sources` 之后的形态。
- **归档 URI 已被清理时照写边，不查存在性。** `sources` 是真相，那条溯源在归档目录被 TTL
  物理删除之后仍然成立（与上面「悬空边写时不拦」同一条口径）。查存在性会让同一份输入因为
  磁盘现状不同而得到不同的边，重建不再幂等。
- **版本文件不贡献边。** 版本文件是旧值快照，它的 `sources` 说的是那份旧值的来历，不是一条
  独立记忆的来源；`collectDerivedEdges` 跳过路径里含 `.history` 的节点。

**一条后果：`sources` 上限 20，重建会删掉写路径累积下来的更早的边。** 写路径按次追加
（`appendSources`，超限留最近 20 条，§11.1），一条记忆的 `sources` 被截断过时，最早的边
在表里仍然存在；重建只复现磁盘上这 20 条，那些边随之消失。这是「`sources` 是真相」的直接
结果——要更长的溯源先抬高 `MAX_SOURCES`。

HTTP 层仍然只暴露读端点（见下），没有写端点：不开一个「谁能写边」的授权面。抽取端
也不产出实体间链接——那要改抽取提示词与 `memory_extract` 的输出契约；`add_resource`
不建资源 → 记忆的边，它写资源，不产出记忆。

#### 查询面：HTTP 端点，links 不进 `read`

`GET /api/v1/memories/{uri}/links?direction=links|backlinks`（`direction` 缺省
`links`）。返回 `{ uri, direction, links: [{ from, to, linkType, weight, matchText,
description }] }`。

**links 不进 `read` 输出。** `read` 是 15 个 MCP 工具之一，它的返回形状是模型可见的
**契约**；把 links / backlinks 塞进 `read` 会改变每个调用 `read` 的模型的输入，属于
MCP 契约变更。`links` 不是「读这条记忆的正文」的一部分——它是查询另一张表才能拿到
的派生关系。所以走独立 HTTP 端点：控制台与运维脚本按需查，MCP 契约不动，仍是 15 个
工具。

**`sources` 走另一条路：以可选的 `## provenance` 块进 `read`。** 理由不同——`links` 是
派生读模型，`sources` 是文件 frontmatter 里的真相，`read` 本来就是读这份文件；块只在
`sources` 非空时出现，旧文件与普通资源的输出逐字节不变（§11.1、§13.2）。

#### 去重口径：weight 取 max，不累加

同一条边（同 `from_uri` + `to_uri` + `match_text`）被写两次时，`weight` **取 max**：

- `weight` 是这条关联的**强度判断**，不是「被看见的次数」。累加会把「反复跑同一批
  抽取」混进「有多相关」，跑 10 次的边会比真正强关联的边更重。
- max 保留产生方给出的最强判断；重复写不改变它，重跑幂等。
- 去重键就是 `(from_uri, to_uri, match_text)`：撞键时 `weight` 取两者较大值，
  `link_type` / `description` 以最新一次写入为准（说明是文字，取最新比留多版本好）。

### 11.11 记忆版本文件与回退

**覆盖写不销毁旧值。** `upsertMemory` 在三个条件同时成立时，把磁盘上的旧文档**原样**
写成一份版本文件：旧文档 `status = 'active'`、记忆类型的 `operationMode` 是 `upsert`、
正文真的变了（`src/services/memory/service.ts` 的 `contentChanged` 与 `snapshot` 判据）。快照放在
记忆类型目录下的 `.history/`，路径镜像 identity 的相对路径：

```
memories/preferences/code-style.md                        ← 规范文件（当前有效）
memories/preferences/.history/code-style.md--20261110T022746123Z.md
                                                          ← 旧值，valid_until 非空
```

`rules` 的 `{scenario}/{rule}.md` 两层在 `.history` 里同样镜像
（`.history/{scenario}/{rule}.md--{stamp}.md`）。文件名时间戳是 `YYYYMMDDTHHMMSSmmmZ`，
同一毫秒撞名时追加 `-1`、`-2`。版本文件与原文档的差别只有三处：`uri` 换成版本文件自己
的地址、`valid_until = 本次写入时刻`、`valid_from` 沿用旧值自己的起点（缺键时退回
`created_at`）。写入后规范文件是 `valid_from = 本次写入时刻`、不写 `valid_until`、
`supersedes = 版本文件 URI`（§6.6）。

**正文没变不写快照。** 同一份正文再写一遍（重放、补 `sources`）没有旧值可丢，快照只会
凭空多出几份一样的文件。`addOnly` 类型（`events`）不允许覆盖写，不会走到这里。`pending`
旧值同样不快照——`pending` 不是有效值，没有「正确的旧值」可回退；但新文档**继承**它的
`supersedes`（`src/services/memory/service.ts`），否则拒绝一次基于 `pending` 的覆盖写会丢掉
上一条有效版本的指向。

**每个 identity 只留最新 5 份**（`MAX_VERSIONS`，`src/services/memory/versioning.ts`）。来源是
经验假设：「回到上一次正确值」的粒度是上一次覆盖写，5 步够覆盖连续几次错误写入，同时把
每个 identity 的历史占用固定在 5 份以内（一份与规范文件同量级）。**版本文件不参与 TTL**：
清扫的两条 SQL 都带 `NOT_VERSION_FILE_SQL`（`src/adapters/sqlite/node-repository.ts`），
第一段不归档它们、第二段也不物理删除它们，所以 `memory.ttl.defaultDays` / `retentionDays`
配成什么都动不到 `.history`。磁盘有界只靠这次截断——它也是版本文件唯一的删除点。截断失败
只记 `warn`：写盘已经成功，下一轮覆盖写会再试一次。

**`NOT_VERSION_FILE_SQL` 是两条 GLOB，不是一条。** 它要求 URI 既不匹配
`*/memories/*/[.]history`，也不匹配 `*/memories/*/[.]history/*`。只写带 `/*` 的那一条会漏掉
目录节点自身（`memories/preferences/.history`）：它在 `.history` 后面没有字符，而 `/*` 要求
至少一个 `/` 加内容。漏掉它的后果是 `pnpm reindex` 为目录建的那一行（`memory_type = NULL`、
`status = 'active'`）被第一段当成过期记忆归档，而路径工具按 `status = 'active'` 取节点，
`.history` 目录从此在 `list` / `tree` 里消失，磁盘上却还在。判定按路径段、不看子串：
`memories/preferences/.history.md` 是同一目录下的一条普通记忆文件（`.history` 不是路径段），
必须照常过期，所以两条 GLOB 都要求 `.history` 两侧是 `/`。

**`approve` 保留三个键。** 复核通过也是一次完整重写，`sources` 与 `valid_from` /
`valid_until` / `supersedes` 都原样带过来（`src/services/memory/review.ts` 的
`approveMemory`）；通过一次复核不改「这条记忆从哪一刻开始有效、顶替了谁」。

**`reject` 先回退，回退不了才删。** `reject` 读当前文件的 `supersedes`：是合法 URI、
指向的文件存在、且能读出记忆类型时，把那份版本写回规范 URI 并清掉 `valid_until`（它现在
又有效了）；字段与时间戳取版本文件自己的——目标是「与写入前的那份文件相同」，所以不刷新
`updated_at`，也不再过一次复核闸门（那个版本本来就是 `active`）。版本文件本身留在
`.history`，`valid_until` 仍非空，检索看不到它。`supersedes` 为空、不是合法 URI、文件
不存在、类型读不出来时，维持原来的行为：删掉 pending 文件。`supersedes` 为空没有目标，
不记 warn；另外三种失败各记一条 `warn`（`src/services/memory/versioning.ts` 的
`restoreSuperseded`）。版本文件本身也按同一口径解析：手改成非法 `status` 后它读不出来，
恢复目标随之消失，`reject` 退回删除（日志里表现为「指向的文件不存在」）。

**HTTP 出口如实报告终态。** `POST /memories/{uri}/reject` 回 `{ uri, outcome, reason }`，
`outcome` 是 `'restored' | 'removed'`：`restored` 时另带 `restoredFrom`（被写回的那份
版本文件的 URI），`removed` 时没有这个键。不合并成 `{ removed: true }`——恢复时没有删除
任何东西，两个终态对用户是相反的结论，一个布尔会让恢复看起来像删除
（`src/services/memory/review.ts` 的 `MemoryRejectResult`）。

**`.history` 不参与目录摘要。** 每次覆盖写都会在 `.history` 新增文件；照常传播会让每次
覆盖多出两次 LLM 摘要调用（`.history` 目录与它上面的类型目录），而版本文件不是给检索用
的内容。`SummaryService` 对路径里含 `.history` 的目录直接返回 `unchanged`，摘要传播在
那里停（`src/services/summary/refresh.ts`）。

**`reconcile` 重放必须带上 `valid_*`。** 从磁盘重建索引行时，有效期从 frontmatter 重新
解析（`src/services/reconcile.ts`），不取旧行。漏掉这一步（或退回只重放 status 与
正文的旧实现）会让 `valid_until` 变成 NULL：一份已经失效的历史版本在重放之后重新出现在
`find` / `search` 里。`reindex` 整行覆盖 `node`，所以这是现有实现里**唯一**会静默破坏
「检索只看当前值」这条不变量的路径——写路径的 `parseValidityInstant` 与索引观察者的
`parseValidityField` 口径由 `frontmatter-validity-consistency` 测试对拍，不会把非空
`valid_until` 写丢；重放器只要少读一次这两列就会。

**`supersedes` 只跟一跳，不回溯链。** `reject` 只读当前文档的 `supersedes`，恢复那份
版本后不会再沿它的 `supersedes` 往上找。TTL 删不到版本文件（见上），所以让回退目标消失的
只有 `MAX_VERSIONS` 截断：同一个 identity 覆盖写超过 5 次之后，`reject` 拿到的是「指向的
文件不存在」，静默退化成删除——日志里一条「指向的文件不存在，拒绝时按删除处理」的 `warn`，
终态是这条记忆消失，不是回到更早的版本。没有沿链回溯的代码；要做需要 `supersedes` 指向的
每一跳都还在盘上，而截断不保证这一点，链越长越早的跳越可能已经被删。

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

**ACL 条目是授权的唯一来源。** `app_group.owner_user_id` 是元数据，只回答「这个组归谁管」，
决定谁能调 `POST /admin/groups/{id}/owner`；它本身不产生任何权限，也不能作为求权的输入。
owner 的 `manage` 只来自组根 `.acl.json` 里的 `user:{owner} = manage` 条目。

这条边界在删账号时最容易被破坏：残留的 `owner_user_id` 在账号重建后与新的主体同 ID，
让路由把「当前 owner」判成成立、跳过组根求权。所以 `IdentityService.deleteUser` 必须把
该组的 `owner_user_id` 清成 `NULL`——删除与重建同 ID 是常规操作，残留的元数据不能在重建
后变成权限。置 `NULL` 的组没有 manage 持有者，只能通过 `pnpm group:owner` 恢复（§12.6）。

**元数据列由外键兜底。** `app_group.owner_user_id` 带
`REFERENCES app_user(id) ON DELETE SET NULL`：绕过 `IdentityService.deleteUser` 直接
`DELETE FROM app_user` 时，组的目录行保留、owner 清空。应用层的 `clearOwnerOfUser`
仍然保留（删除日志要计数），外键保证仓储这条公开入口也收口——与 `group_member` /
`api_key` 的外键同一个判据：清理逻辑负责留痕，外键负责堵住绕过用例的路径。

**删账号也要清空它命名空间里的直接授权。** `purgePrincipal('user:{uid}')` 只移除该主体
作为条目的授权；`comem://user/{uid}/...` 上 `group:{gid} = read` 这样的条目不是它的。
账号不存在了，这些条目挂在一条谁都解释不了的路径上，同 ID 重建后组员仍然能读旧数据——
删账号没有撤销共享范围。所以 `DELETE /admin/users/{id}` 在 `purgePrincipal` 之后调
`purgeSubtree('comem://user/{uid}')`，与删组同一套语义：保留数据与 `mode`，清空条目，
按清空后的文件重算整棵子树的 `node_permission`。

**召回账本也要删。** `_meta/recall/{scopeKey}.recall_log.json` 记的是「这个作用域投过
哪些 URI」（`scopeKeyOf` = `user_alice` / `group_eng`）。删账号 / 组后账本仍在，同 ID
重建的账号会继承去重状态——第一次召回被当成「刚投过」而返回空。账本是缓存，删除的代价
只是多投一次。

服务层也要自己校验 owner 主体：`AclService.ensureRootPreset` / `setGroupOwner` 拒绝通配
主体 `*` 与非 `user` 格式（`assertOwnerUserId`）。HTTP 路径的 `assertValidUserId` 不能
替服务方法兜底——绕过路由直接调用的代码不会补这一遍。

**同一判据适用于凭据状态。** `app_user.session_epoch`（§12.7）只决定已签发的 token
还能不能用，不产生任何权限；`api_key.revoked_at` 同理。它们与 ACL 条目分开存，是因为
「这个凭据属于账号的哪一段生命周期」与「这个主体在哪个节点能做什么」是两个问题，
混在一张表里会让撤权与撤凭据变成同一个动作——而它们的撤销语义不同（前者要改文件，
后者只改行）。

**删组要清空组子树里的全部直接授权。** 撤权只按主体做是不够的：`DELETE
/admin/groups/{id}` 移除的是 `group:{gid}` 这个 principal 的条目，组子树里
`user:bob = write` 这样的直接授权不会被动。组不存在了，授权还挂在一条谁都不认识
的路径上；同 ID 重建（测试环境重置、离职回归）会让它立刻生效——删组没有撤销共享
范围，和删账号的残留是同一类缺陷。所以删组走两步：`AclService.purgePrincipal`
移除组主体，`AclService.purgeSubtree` 清空组根以下所有 `.acl.json` 的条目，
再重算整棵子树的 `node_permission`（子树里的节点可能从组根**之外**的祖先继承
权限，只删行会让物化表比文件更严）。**保留数据与 `mode`**：删组不是删数据，
`restricted` 清空后仍然收得最紧，重置成 `inherit` 反而可能让祖先的 `user:*`
放开数据。要连数据一起删，用文件系统显式删除目录。

### 12.3 继承不存快照

`effective(N)` 递归到 `parent(N)`，**不预存继承快照**。存了必然在祖先变更后过期，而这类 bug 只在演示时暴露。

每请求维护 `Map<uri, Acl>` 缓存，请求结束丢弃。

检索侧的 `node_permission` 是物化结果，不是快照：改 ACL 时整棵子树重算，保证它等于「此刻的 `effective()`」。

**新节点在写路径的求权步骤物化。** 新建节点在 `node_permission` 里还没有行，写操作（`write` / `edit` / `mkdir` / `mv` 的目标）由 `InheritingAuthorizer` 在缓存未命中时先 `materializeNode` 再判定；读操作只给**磁盘上已存在**的节点补物化，拼错的 URI 不会因为一次 GET 就在库里多一条权限行。读的目标不存在、但祖先链对调用方**可读**时抛 `NOT_FOUND`（404）——调用方问的是「这条记忆在哪」，不是「我有没有权限」；祖先链也不可读时仍是 `PERMISSION_DENIED`，跨作用域探测不能靠错误码判断节点是否存在。祖先链判定复用 `readChain` + `effectiveAcl`（`services/acl/guard.ts`），不写第二份 ACL 求值，也不为探测物化新行。因此 `write` 的 `create` / `append` 模式必须先按 write 求权，再做「目标是否存在 / 读现有正文」的预读——预读是 read 操作，顺序反过来时新路径会先撞上读路径的「不存在不物化」，把一次写操作误报成 `需要 read（1）级别`。MCP `write` 与 HTTP `POST /content/write` 共用这一条顺序。

### 12.4 出口清单

每一个出口都必须过 `Authorizer`，漏一个就是泄露：

| 出口 | 所需级别 |
|---|---|
| `read` / `stat` / `abstract` / `overview` | read |
| `list` / `tree` | 逐条 read |
| `find` / `search` / `grep` / `glob` | 逐条 read |
| `GET /memories/pending` | scope 根 read，再逐条按记录 URI 求 read |
| `GET /memories/{uri}/links` | 查询 URI read，边的另一端也求 read |
| `GET /memories/{uri}` | 查询 URI read（与 `content/read` 同一档） |
| `write` / `edit` / `mkdir` | write |
| `rm` / `mv` | manage |
| `getAcl` / `setAcl` | manage |
| 改组 owner（`POST /admin/groups/{id}/owner`） | 当前 owner、系统管理员，或组根 manage |
| 用户管理（委派改密码、改资料、启用禁用、删除） | 对目标 `comem://user/{id}` 求 manage；改密码不能以自己的 ID 为目标 |
| 自助改密码（`POST /auth/password`） | 只更新当前 `subject`，并校验 `currentPassword` |
| API Key（签发、列出、吊销） | 对**持有者**的 `comem://user/{id}` 求 manage |
| 组管理（改资料、删除、加退成员） | 对 `comem://group/{gid}` 求 manage |
| 提示词（`GET`） | 任何已认证身份 |
| 提示词（`PUT` / `DELETE` / `preview`） | 系统管理员 |
| 列全部用户 / 建用户 / 列全部组 / 建组、`/tasks` 三个端点 | 系统管理员 |

**列表语义**：无权限节点完全不出现，不返回「存在但无权」的占位。文件名和摘要本身就是信息。

**「不存在」与「没有权限」用错误码分开。** 读类出口（`read` / `stat` / `download` / `grep` / `glob` 的范围、`find` / `search` 的 `targetUri`、HTTP `GET /content/read`）的目标既不在物化表、也不在磁盘上时，按祖先链求一次 read：有则 `NOT_FOUND`（404），无则保持 `PERMISSION_DENIED`（403）。祖先链求值复用 `readChain` + `effectiveAcl`（`services/acl/guard.ts`），不写第二份 ACL 求值；探测本身不物化新行。写路径不变：新路径照旧先物化再求权。

两个容易漏的出口按「无权限完全不出现」各多做一道求权：

- `GET /memories/pending`：`listPending` 递归扫 `memories/`，走的是**不传 `principals`** 的 `rawFilesystem`——`restricted` 切断或显式 `deny` 的子目录照样会被列出，而一条待复核记录的 URI、`fields`、`sources` 全是内容。路由层在 scope 根求 read 之后，再按**每条记录自己的 URI** 逐条求 read，无权限的记录整条不返回。路由先处理完整队列再做 ACL 过滤、统计和截页：`total` 是当前身份可读记录的全量，`oldestPendingAgeSeconds` 也只从这些记录计算；`limit` 只截 `memories` 数组。因此第 101 条以后、排在受限记录之后的记录仍会计入摘要。精确统计的代价是每次请求遍历该 scope 的完整待复核队列。
- `GET /memories/{uri}/links`：查询的 URI 已求 read，边的**另一端**是独立资源，要再求一次 read（`links` 查 `to`，`backlinks` 查 `from`）。`backlinks` 列出的 `comem://user/bob/memories/profile/health-condition.md` 已经说出了 Bob 有哪些记忆，所以无权限的边也整条不返回，不留占位或打码。

**待复核列表的三个有效期字段始终输出。** `GET /memories/pending` 的每条记录都带
`validFrom` / `validUntil` / `supersedes`，没有值时是显式 `null`，不省略键。理由：前端要
区分「这个字段不存在于响应里」与「这条记忆没有该值」——前者是契约漂移，后者是正常状态，
省略键把两者压成同一个 `undefined`。字段原样取自 frontmatter（与 `updatedAt` 同为 ISO 8601
UTC 形态，不在序列化层换格式）；`supersedes` 非空即「这条记忆顶替了某个版本」。复核页靠这
三个键回答「是否只在某段区间有效、是否替换了上一版本」。`GET /memories/{uri}` 是单条记忆
的只读元数据出口：`memoryType` / `status` 取自检索索引（`n.status` 就是能不能被搜到的判据），
`validFrom` / `validUntil` 取自记忆文件，供文件详情页回答「这条记忆为什么能／不能被搜到」
（§16）；`supersedes` 仍只出现在待复核列表。

**管理端点判定的是目标资源，不是调用方自己的根。** 对「自己的根」求 `manage` 对每个登录用户都成立（user 根 owner 恒为本人），用它当门禁等于任何登录用户都是管理员。所以改密码、改资料、启用禁用、删除用户，签发 / 列出 / 吊销 API Key，改组资料、删除组、加退组成员，一律对目标用户根或组根求 `manage`。吊销 API Key 的请求里只有 key ID，先反查持有者，再对持有者的根求权——否则任何登录用户都能吊销别人的凭据。组 owner 变更不能只看组根 manage 的历史原因见下。

**跨主体端点只认系统管理员。** 列全部用户 / 组、建用户、建组，以及 `/tasks` 的三个端点（`GET /tasks`、`GET /tasks/{id}`、`POST /tasks/{id}/retry`）在数据模型里没有可求权的目标：`task` 表没有 scope 或 uri 列，`payload` 是 `unknown`，从它里面猜路径等于把授权建在不可校验的 JSON 上。系统管理员包括通过 `POST /bootstrap/admin` 初始化的管理员和 `auth.adminUserIds` 中列出的用户 ID。名单默认为空；这不影响初始化管理员。普通建用户流程和回环绑定本身不会授予系统管理员角色。

**提示词分读写。** 提示词是全局的（不分作用域），读它不会暴露任何节点内容，所以 `GET /prompts` 与 `GET /prompts/{id}` 任何已认证身份可读；`PUT` / `DELETE` / `POST /prompts/{id}/preview` 改的是所有身份的注入行为，要系统管理员。没有「目标资源」可以表达这件事——它不是某个节点上的权限。

**`GroupMember.role` 是派生字段。** 唯一真相是 `app_group.owner_user_id`：只有 `userId === ownerUserId` 才是 `owner`。`group_member.role` 列已废弃、写入只落常量 `member`，读取时不采用；`POST /admin/groups/{id}/members` 显式传 `role` 返回 `INVALID_ARGUMENT`，改 owner 的入口只有 `POST /admin/groups/{id}/owner`。

**存量部署。** 没有初始化管理员的部署可用 `auth.adminUserIds: [<uid>, ...]` 指定管理员。回环信任（`auth.trustLoopback`）只确定调用身份；若 `server.subject` 对应的用户未通过初始化获得管理员角色，同样需要列入名单。

管理面的组 owner 变更不能只看「自己根的 manage」：那对任何登录用户都成立（owner 恒 manage），等于任何成员都能接管别人的组。判定改用组根的主体集合。

### 12.5 组空间的三层共享

| 场景 | 做法 |
|---|---|
| 组内全员可读写 | 组根预置 `group:{gid} = write` |
| 个人文件给全组看 | 在 `comem://user/{uid}/...` 该节点挂 `group:{gid} = read` |
| 组内只给部分人看 | 在更深节点设 `restricted` 切断继承，再挂 `user:{uid2}` 直接授权 |

退组立即生效：ACL 存的是 `group:{gid}` 这个 principal，不展开成成员列表，不需要回写。

### 12.6 根预置

| 根 | 预置 | 谁写 |
|---|---|---|
| `comem://user/{uid}/` | `user:{uid} = manage` | 启动时物化（owner 规则，`bootstrap/container.ts`） |
| `comem://group/{gid}/` | `user:{owner} = manage` + `group:{gid} = write` | 创建组时预置（`POST /admin/groups` → `AclService.ensureRootPreset`），owner 是创建者 |

两个预置都是普通 ACL 条目，可以改（owner 那一条除外）。写死会让组空间无法降级成只读。组的默认级别来自 `acl.groupDefaultLevel`（`write` / `read`），只作用于 `group:{gid}` 那一条，不把 owner 的 `manage` 一起降级。

**组必须有 owner。** 组根只有 `group:{gid} = write`（级别 3）时，没有任何主体能求 `manage`（级别 7）——`levelSatisfies(3, 7)` 为 false，`setAcl` / `getAcl` 永远 403，组内成员既不能给同组另一人开只读，也不能设 `restricted` 或建子目录授权。owner 记在 `app_group.owner_user_id`，是「这个组归谁管」的权威来源；owner 的 `manage` 仍然要作为条目真的写进 `.acl.json`，因为求权只查物化表。owner 为 `NULL` 的组保持只有 `group:{gid} = write`，`ensureRootPreset` 的返回值用 `ownerMissing` 报告这个状态。

**删账号会清掉 owner。** `IdentityService.deleteUser` 把该用户名下的 `owner_user_id` 置 `NULL`（§12.2），`ON DELETE SET NULL` 外键兜住绕过用例的直接删行：残留的 ID 在同 ID 重建后会被当成当前 owner。组里如果没有第二个 manage 持有者，`POST /groups/{id}/owner` 在求权阶段就 403，这个组从此不能改 ACL、不能加成员。恢复走命令行：

```bash
pnpm group:owner <groupId> <userId>
```

它直接打开数据库写行，再调 `AclService.setGroupOwner` 补组根条目，绕开「管理端点自己也要认证」的循环——与 `pnpm password` 解决的是同一类问题（§12.7 的引导循环）。命令用 `setGroupOwner` 而不是 `ensureRootPreset`：后者的幂等判断是「文件里有没有 `group:{gid}` 这一条」，正常组一定已经有，早退之后 owner 的 `manage` 永远补不上。`GET /admin/groups` 的行带 `ownerMissing: true`（`ownerUserId` 为 `null`），控制台据此显示「无所有者」。

改 owner 走 `POST /api/v1/admin/groups/{id}/owner`（body `{userId}`），当前 owner、组根的 `manage` 持有者或系统管理员能改。改 owner 会同步替换组根 `.acl.json` 里的 `user:{owner} = manage` 条目，保留其它条目与 `mode`。**当前 owner 单独成立**：迁移回填的存量组有 `owner_user_id` 但没有 manage 条目（SQL 迁移写不了文件），owner 调一次这个端点即可补齐预置；否则这条修复路径会被自己的求权挡住。

**根预置的幂等判断看条目，不看文件是否存在。** 删组时 `.acl.json` 会被保留（`restricted` 语义需要空文件），只是条目被清掉；按存在性判断会让重建的组根不再写 `group:{gid}`——组空间对所有人永久空 ACL。group 作用域的判断是「文件里有没有 `group:{gid}` 这一条」，user 根保持「文件存在就跳过」：user 的 manage 来自 owner 规则（URI 根标识），不依赖条目。

**为什么不统一放 bootstrap。** 配置里声明的用户根是启动期就能确定的，组不是：控制台可以在运行期建组，而根预置必须在组 ID 存在之后写。把组根留给 bootstrap，新建的组就没有任何可授权的节点，成员也拿不到可读范围——这个组是死的。

**为什么要真改 `.acl.json`。** 根预置与普通授权一样，`node_permission` 是它的物化结果。删用户 / 删组时只删物化行不够：下次 `materializeNode` 会把文件里的条目重新算出来，删掉的账号重新创建同 ID 的用户就继承了旧授权（提权）。撤销主体走 `AclService.purgePrincipal`，它改写所有 `.acl.json` 再删两张表的行；命名空间里的直接授权走 `purgeSubtree`（删用户时是 `comem://user/{uid}`，删组时是 `comem://group/{gid}`），它清空子树内的条目并重算整棵子树。两条路径都在管理面；账本（`_meta/recall/`）跟着一起删。

### 12.7 请求身份与认证

ACL 求值需要「这次请求是谁」。**认证恒开**：身份来自凭据（session token 或
API Key）。唯一的例外是**回环信任**——没有凭据、来源是回环地址、且 `Host` 也
指向本机的请求被认证为服务图绑定的主体（`server.subject`）。

```ts
interface RequestContext {
  readonly subject: string;              // 恒为 `user:{uid}`，组不能当认证主体
  readonly principals: readonly string[]; // [user:{uid}, ...group:{gid}, user:*]
  readonly apiKeyId: string | null;      // 走了哪把 key；session token 认证时为 null
}

type Credential =
  | { kind: 'password'; username: string; password: string }
  | { kind: 'api-key'; apiKey: string }
  | { kind: 'session'; userId: string };
```

**回环信任是一条信任策略，不是第二个模式。** 它不改变身份的来源：被认证的身份
仍然是一个真实的 `app_user` 行，仍然走同一套 ACL，仍然出现在 `principals` 里。
它省掉的只是「本机进程为什么还要存一份凭据」——`curl`、hook 插件、MCP 客户端
本来就和数据根在同一台机器上。

信任模型：**能连上本机端口的人本来就能读这个数据根**，与 `~/.ssh` 的权限模型
同级。`auth.trustLoopback` 默认 `true`，但只允许在 `server.host` 是回环地址时
打开（`cross-checks.ts`）：非回环监听意味着任何能连上端口的人都成为
`server.subject`，这种组合在启动期失败，不能配了不生效。容器部署绑 `0.0.0.0`，
必须设 `trustLoopback: false`。

**判定来源必须是连接事实，不能是请求头。** 来源地址取
`request.socket.remoteAddress`；额外要求 `Host` 指向本机，是为了挡 DNS rebinding
（远程页面用自己的域名解析到 `127.0.0.1`，浏览器发出的连接来源就是回环地址）。
`x-comem-subject` 不再是身份来源，服务端不读它。

**凭据优先。** 带了 `Authorization` 就按凭据解析；无效一律 401，**不回退**到
回环信任——一个过期的 token 静默变成 `server.subject` 比 401 危险得多。

**两种凭据。** 用户名 + 密码（`app_user.password_hash`，`node:crypto` 的 scrypt，
`N=16384, r=8, p=1`，16 字节盐）换 session token；API Key（`api_key` 表，一个
用户多把，`name` 区分用途）直接作为 `Authorization: Bearer comem_...`。

**API Key 没有 scope。** 一把 key 就是 `(user_id)` 的完整凭证，范围由路径级 ACL
决定。加 key 级 scope 会让每次求权变成两次范围求交，排查「为什么这把 key 看不到」
时要同时看 key 和路径；而且 scope 与「owner 恒 manage」不变量冲突（owner 的 key
被 scope 限制住就不是 owner 了）。用户 + 组 + 路径已经足够表达共享。

**组关系每请求查库，不缓存。** `resolve(credential)` 每次都调
`GroupRepository.listGroupIdsOfUser`。SQLite 单机是微秒级；缓存只会把「退组立即
生效」变成「重启后生效」——§12.5 的那条承诺就是靠这里兑现的。

**孤儿行由外键兜底。** `group_member` / `api_key` 的 `user_id` / `group_id` 带
`ON DELETE CASCADE`。正常路径由 `IdentityService.deleteUser` 显式
清理（删除日志要计数），外键保证**绕过用例直接删行**时不留孤儿行——仓储是公开
入口，孤儿成员关系会让同 ID 重建的用户立刻拿到 `group:{gid}` 主体。连接级
`PRAGMA foreign_keys = ON` 在 `openDatabase` 里设置（SQLite 默认关闭，且 PRAGMA
在事务里是 no-op，所以必须在迁移之前设）。

**Session token 是无状态 HMAC。** 形如 `v1.<base64url(payload)>.<签名>`，服务端
不存 session 行。载荷是 `{sub, iat, exp, epoch}`：`sub` 是用户 ID，`epoch` 是账号
的身份版本（`app_user.session_epoch`）。**撤销走身份版本**：创建账号
时生成、改密码时轮换，所以删账号重建同 ID、改密码都会让已签发的 token 在下一个
请求就 401。`epoch` 为空串（迁移遗留的「版本未知」）永不匹配任何 token，等于强制
重新登录——这是安全降级方向，宁可多一次登录，不能让旧 token 继续有效。代价是
**登出只能客户端丢弃 token**：服务端没有「已签发」的行可以删，只能靠改密码或吊销
API Key 让某个凭据失效，不能一次作废某个用户除此之外的全部 token。
`auth.sessionSecret` 为空时装配层生成进程随机值，重启即失效。

**认证失败一律 401 `UNAUTHENTICATED`，不区分原因**（用户不存在 / 密码错 / key
过期 / key 已撤销）。区分开就是账号枚举。

| 入口 | 端点 | 说明 |
|---|---|---|
| 引导状态 | `GET /api/v1/bootstrap` | 只读探测，**恒定 200**（匿名）。回 `needsSetup` / `boundSubject` / `adminConfigured`。控制台在拿到身份之前调它；`needsSetup` 就是「`app_user` 里没有任何密码哈希」。**不返回令牌本身** |
| 登录 | `POST /api/v1/auth/login` | `{username, password}` → `{token, expiresAt, subject, principals}` |
| 登出 | `POST /api/v1/auth/logout` | 无服务端状态，只回 `{loggedOut: true}` |
| 当前身份 | `GET /api/v1/auth/me` | `{subject, principals, isAdmin}`；`isAdmin` 使用系统管理员策略 |
| 自助改密码 | `POST /api/v1/auth/password` | 已认证请求，`{currentPassword, newPassword}`；只改当前 `subject`，成功后轮换 `session_epoch`，已有 session token 下次请求 401 |
| 建用户 | `POST /api/v1/admin/users` | `{id, displayName, email?, password?}`，系统管理员（§12.4）。`password` 省略时建出无密码账号（先当 ACL 主体用），传了则**先过口令策略再建账号**、一次完成建账号 + 设密码；响应带 `hasPassword` |
| 列用户 | `GET /api/v1/admin/users` | 每一项带 `hasPassword`：只由 `app_user.password_hash` 非空派生，不回哈希或其任何派生值 |
| 委派设密码 | `POST /api/v1/admin/users/{id}/password` | 对**其他**目标用户根 `manage`，或系统管理员；请求目标必须是当前 `subject` 以外的用户，否则 400 并指向自助入口；口令策略与建用户同一份 |
| 签发 key | `POST /api/v1/admin/users/{id}/api-keys` | 对目标用户根 `manage`，或系统管理员；明文只在创建响应里出现一次 |
| 列出 key | `GET /api/v1/admin/users/{id}/api-keys` | 同上；只回 `prefix`，永不回哈希 |
| 撤销 key | `DELETE /api/v1/admin/api-keys/{keyId}` | 先反查持有者，再对持有者的根求 `manage`，或系统管理员；幂等 |

**改密码 / 撤销凭据是唯一的「让 token 立刻失效」入口。** 认证恒开之后没有
「关掉认证」这个开关，撤销只能针对具体凭据（§12.7 的 session token 段）。

**自助改密码与委派重置是两条不同的信任路径。** 自助入口从认证中间件取得当前
`subject`，请求体没有目标用户 ID，因此不能改另一个账号；它先校验
`currentPassword`，再用旧哈希作为比较交换条件写新哈希。当前密码错误或并发请求
已先换掉哈希时返回 400 `INVALID_ARGUMENT`，`details.field` 为
`currentPassword`，前端保留登录态让用户重试。校验通过后沿用 `setPasswordHash`
轮换 `session_epoch`：session token 立即失效，API Key 不随密码轮换而撤销。

**管理端点的自助绕过已关闭。** 目标用户根对本人恒有 `manage`，所以管理端点若接受
`id === 当前用户`，任何登录用户都能跳过当前密码重置自己的密码。该组合现在返回
400，并只接受 `POST /auth/password`。委派重置其他用户仍走目标根 `manage` 或系统
管理员，这是管理员协助恢复账号的既有契约；忘记密码且没有可用登录态时仍用
`pnpm password` 恢复。

### 12.8 ACL 写入的锁契约

`AclService` 的每个写方法都是「读整个 `.acl.json` → 改 → 写回」。读在锁外时两个
并发写者各拿一份旧条目，后写者整份覆盖，先写者的条目**静默消失**：丢 `allow` 是
拒绝服务，丢 `deny` 是越权。所以互斥必须**覆盖读与写两步**，不能只包写盘。

| 方法 | 锁粒度 | 为什么 |
|---|---|---|
| `setAcl` / `ensureRootPreset` / `setGroupOwner` | `EXACT(uri)` | 互斥资源是**单个** `.acl.json`；同目录其它写入无关 |
| `purgeSubtree` | `TREE(root)` | 「扫子树 → 改每个文件」，只锁单文件会在扫描与写入之间漏掉新建目录（残留授权） |
| `purgePrincipal` | 全部目标 `EXACT`，**按 URI 升序** | 撤权横跨整库，没有单一路径能覆盖；多锁必须定序 |
| `getAcl` / `materializeNode` / `syncEntriesFromFile` | **不加锁** | 只读或只写派生表；且由 `IndexObserver` 在 `FileSystemService` 已持锁的回调里调用 |

**`setAcl` 的两种输入对应两种语义。** 完整快照是「整份替换」（`PUT /acl` 编辑器：
后写者赢是调用方选择覆盖，不是丢更新）；**转换函数**是「在现有条目上加/减一条」
（`/acl/grant`、`/acl/revoke`），它必须在 `EXACT(uri)` 锁内基于最新快照求值。路由层
禁止「锁外 `getAcl` + 整份 `setAcl`」——那是两端并发 grant 各拿旧条目、后写者覆盖的
丢更新路径。

**锁序规则（多锁时）。** 全部按 `Uri.toString()` 字典序**升序**获取，反序释放。
`FileSystemService.move` 用同一条全局顺序（源与目标两把 `TREE`），两个方向相反的
`move` 因此不会互等。任何新增的多锁路径必须沿用这条顺序。

**不可重入。** `PathLockManager` 不可重入（`adapters/fs/lock.ts` 按锁路径排队，持有
者再拿同路径的锁会等自己，超时抛 `CONFLICT`）。因此 `purgeSubtree` 持 `TREE(root)`
期间**直接写文件**，不调 `setAcl`——后者要 `EXACT(descendant)`，与祖先的 `TREE`
冲突。`#writeAcl` 因此要求调用方已持有 `EXACT(uri)`，回滚（`#restoreAclFiles`）也必须
仍在锁内，否则会覆盖并发写者刚写入的条目。

## 13. MCP 工具契约

15 个，只读 10 个、写 4 个、摄取 1 个。**不含 `get_acl` / `set_acl`**。

### 13.1 工具描述怎么写

MCP 工具的描述是给模型看的**使用说明**，不是 API 文档。每个描述必须回答三件事：

1. **什么时候用这个工具**（而不是别的）
2. **参数里最容易用错的是什么**
3. **返回结果怎么读**

例如 `find` 的描述不是「执行语义检索」，而是「不确定内容在哪个目录时用这个；如果你已经知道路径，用 `read` 更快」。

### 13.2 15 个工具

| 工具 | 参数 | 返回格式 |
|---|---|---|
| `find` | `query`、`targetUri?`、`limit=10`、`level?`、`contextType?`、`memoryTypes?`、`updatedAfter?`、`updatedBefore?` | 文本：`Found N item(s):` + 每条 `- [类型] uri` + 缩进摘要（**降序排列，不带分数**：四种引擎的分数量纲不可比，见 §8.4） |
| `search` | 同上 + `sessionId?`、`mode=list\|context` | `list`（默认）：同上，末尾附 `Query plan`。`context`：按 `retrieval.assembly` 的 token 预算与配额组装，返回 `Context: N item(s), T token(s), D dropped.` + 渲染好的 `<memory>` 块（§8.6）；传了 `sessionId` 才有召回账本去重 |
| `rule_search` | `taskContext`、`threshold=0.65`（相对阈值） | 文本：适用规则的完整正文块 |
| `read` | `uri` 或 `uris[]`、`offset=0`、`limit=-1` | 文本；记忆的返回末尾可能带 `## provenance` 块（`sources`），该块在 `offset` / `limit` 切片之后拼接，所以分页读也拿到完整一份；无 `sources` 时与改动前逐字节相同。`find` / `search` 的命中不带溯源（注入预算）。图片 / 音频返回二进制块。切片之后如果还有码点没返回，正文末尾另起一行 `... (truncated)`；`limit=-1` 与恰好切到末尾（`offset + 返回码点数 == 总码点数`）都不标记，多 URI 时每段正文各自标记 |
| `list` | `uri`、`recursive=false`、`offset`、`limit`、`sortBy` | 文本：`[dir] name` / `[file] name`。`recursive=true` 的展开超过深度（64）或节点（1000）上限时末尾追加一行 `... (truncated)`，不静默截断 |
| `tree` | `uri`、`levelLimit=3` | 文本树形，缩进表示层级 |
| `grep` | `uri`、`pattern`、`caseInsensitive=false`、`nodeLimit=10` | 文本：`Found N match(es):` + `uri` + `  L42 [pattern]: 内容` |
| `glob` | `pattern`、`uri`、`nodeLimit=100` | 文本：`Found N file(s):` + `  uri` |
| `download` | `uri` | 短期签名 URL（10 分钟） |
| `health` | — | 文本：服务状态、当前身份 `subject`、可寻址的根 `scopes`、索引条数、摘要降级标记 |
| `write` | `uri`、`content`、`mode=replace\|append\|create` | 文本：写入结果 + 索引状态 |
| `edit` | `uri`、`oldString`、`newString`、`replaceAll=false` | 文本：替换结果 |
| `remember` | `messages[]`（每条可带 `createdAt`）、`sessionId?` | 文本：`taskId`（没有新消息时是 `none`）+ 抽取在后台进行的提示 |
| `forget` | `uri`、`recursive=false` | 文本：`Deleted: uri` |
| `add_resource` | `parentUri`、`files[]` | 文本：`created` / `updated` / `skipped` 计数 + 索引状态 |

**截断标记是正文之后的一行文本，不是返回封套的字段。** `read` / `list` / `tree` 在被截断时于正文之后追加独立一行 `... (truncated)`，三个出口共用 `src/api/mcp/text.ts` 的常量 `TRUNCATED_MARKER`——宿主按这个字符串本身识别截断，措辞只定义一次（`tests/unit/api/truncated-marker.test.ts` 扫描字面量，挡住第四份定义）。`read` 的判据与 HTTP `GET /content/read` 的 `truncated` 字段是同一个公式：`offset + 返回码点数 < 总码点数`，同一份内容在两侧给出同一结论。`list` 只在 `recursive=true` 展开超过深度或节点上限时标记——此前 `tree` 会标记而 `list` 静默截断，调用方会把「前 1000 条」当成全部，得到一个静默的不完整答案。用独立一行而不用 JSON 字段：MCP 返回是纯文本，加字段要改返回封套，宿主和模型必须先解析封套才能读到正文；一行标记只占正文末尾，正文部分向后兼容，不认识标记的调用方照旧按正文处理。

**为什么返回文本而不是 JSON。** MCP 的返回值直接进模型上下文。文本格式的信息密度更高，模型也更容易读。JSON 适合程序消费，不适合模型消费。

**空参数直接拒绝，不返回空结果。** `grep` 的 `pattern` 为空串时返回 `INVALID_ARGUMENT`（空正则会匹配每一行，拿回一整页命中看起来像「搜索成功了」）；HTTP 的 `/search/grep` 同样拒绝。

**`write` / `add_resource` 没有 `wait` 参数。** 写入是同步完成的：`write` 返回时文件、索引与物化权限已经写完，`add_resource` 返回时整批文件已落盘。原先的 `wait` 只被写进日志、不改变行为，所以删掉了——一个不改变行为的布尔参数会让调用方以为存在可以等的异步路径。

**`write`（MCP）与 `POST /content/write`（HTTP）不丢 frontmatter，丢的是提交语义。** MCP `write` 的 `replace` / `append` 与 HTTP `POST /content/write` 都走 `ContentStore.writeText`：不传 `frontmatter` 时它保留磁盘上现有的 frontmatter，只替换正文（键、值与类型语义保留；YAML 会按统一格式重新序列化，注释、引号与流式数组写法会归一化——语义保留，字节不保证）。这两条路径绕过 `MemoryService`，因此跳过的是补丁合并、复核状态流转、`sources` 的追加与去重、字段类型校验，以及 **`addOnly` 类型（如 `events`）的既有文件保护**——记忆写入点（`services/memory/service.ts` 的 `upsertMemory`）对 `addOnly` 类型的既有文件抛 `ALREADY_EXISTS`，`write` 直接覆盖。一条记忆被 `write` 改过正文后仍然是一条记忆，`memory_type` / `status` 都还在，但**这次改动没有溯源**（`sources` 不追加），也**没有经过复核**；对 `events` 这类记忆，覆盖写等于改写「已经发生过的事」，被覆盖的正文没有第二份副本可以核对。想定点改一条记忆的正文，目前**没有既保提交语义的入口**：`edit`（文本级 patch）能改正文、保住 frontmatter（索引与父目录摘要照常失效重算），在**提交语义**上它与 `write` 一样：都不追加 `sources`、不经复核、不做字段类型校验；差别在**正文改法**（`edit` 是行级 patch，`write` 是整份替换）与**是否重写 frontmatter**（`edit` 不重写），所以 `edit` 不是「语义安全」的写入路径。`remember` 提交的是会话，由抽取决定改哪条记忆，不能指名。要连提交语义一起保留，只能走记忆抽取 / 合并那条链路，由系统决定写什么，而不是直接改。`create` 模式在目标已存在时抛 `ALREADY_EXISTS`，不会覆盖。

**检索分数的可比范围。** `find` / `search` 的分数只在同次检索、同一引擎内可比；FTS5、余弦、RRF 的量纲不同。`rule_search` 保留显式相对阈值参数，自动接入只使用排序与预算，不把相对分数当作相关概率。

**`remember` 复用提交管线**：造一个合成会话再提交，不另写一条记忆写入路径。传 `sessionId`
时用调用方给的稳定 ID 并跳过已有消息（`stableMessageId(role, text, createdAt)`，与 ingest
同一个实现），批量上传本机历史对话重跑不会产生重复会话（§11.9）。

**`add_resource` 有两种来源。** 纯文本资料只给 `content`（agent 已规范化的正文），MCP 单入口就能用；要保留原始附件时先 `POST /resources/temp-upload` 拿 `uploadId`，再与 `content` 一起提交——`uploadId` 落盘到 `.attachments/` 供 `download`，`content` 是索引与检索用的正文，两者可以同时给（原件 + 正文）。

**为什么 `files[]` 而不是 `name` / `to` / `description` / `source` / `tags`。** 一次调用可以导入多个文件，每个文件有自己的路径、附件、规范化文本和摘要；把描述性字段摊在顶层只能表达「一个资源」，表达不了「一个资源目录下的一批文件」。顶层保留 `parentUri` 表示「装到哪里」，其余全部下沉到 `files[]` 的每一项。**返回的是计数不是 `taskId`**：批量写入是同步完成的，没有后台任务可等。

```ts
// 第一步（可选）：上传原始字节
POST /api/v1/resources/temp-upload   // application/octet-stream + x-file-name 头，返回 { uploadId }

// 第二步：建资源
interface AddResourceInput {
  parentUri: string;         // 目标目录，如 comem://user/alice/resources；~ 是当前身份的根
  files: Array<{
    path: string;            // 逻辑路径，如 "docs/api.md"
    uploadId?: string;       // 可选：temp-upload 拿到的附件 id（原件）
    content?: string;        // 可选：规范化后的文本，用于检索（纯文本资料只给它就够）
    summary?: string;        // 可选：agent 给的文件摘要
  }>;
}
```

`files` 的每一项至少要给 `uploadId` 或 `content` 之一，两者可以同时给（原件 + 正文）；都缺时工具返回 `INVALID_ARGUMENT`。

**后端不做格式解析。** 文本提取的规则：

| 上传的 MIME | 后端行为 |
|---|---|
| `text/*`、`application/json`、代码文件 | 直接读文本，建索引 |
| 二进制（PDF / 图片 / Office） | 有 `content` 就用它建索引；没有就尝试按 UTF-8 解码附件（解不出来写空串），附件另存 `.attachments/`——正文为空时按内容检索不到，只能按路径 / 摘要找到 |

原始附件存在目标文件同级的 `.attachments/` 下（`resources/docs/.attachments/api.pdf`），`download` 直接给这个文件。规范化文本存在 `parentUri` 下按 `files[].path` 给出的位置，带 frontmatter 摘要。

**为什么让 agent 提供 `content`。** PDF、HTML、DOCX 的解析需要各自的库，版面、表格、公式的还原质量参差不齐。上传方是 agent——它本来就有读 PDF、抓网页、看图片的工具，比后端再实现一遍更强。后端只做「存附件 + 存文本 + 切分 + 摘要 + 建索引」，职责单一。

代价要说清楚：大文件要 agent 整个读进上下文，token 成本转移到调用方；不能「给个 URL 让后端去抓」。后者由 agent 自己 fetch 后再上传。

**原文不被污染。** 附件是原始字节，不做任何改写；规范化文本是独立文件。两者都能单独 `read` / `download`。

### 13.3 工具的时间上限与降级

**每个 `tools/call` 与 HTTP 检索的两条路由都套一个 30 秒的墙上时钟上限**，常数是 `src/api/deadline.ts` 的 `API_CALL_DEADLINE_MS = 30_000`。MCP 侧的包装点是 `ToolRegistry` 构造时的 `bindDeadline`，15 个工具一个不落（包括 `grep` / `glob` / `health` 这些不调模型的）；HTTP 侧是 `api/http/routes/search.ts` 的 `runRetrieval`，只包住 `/search/find` 与 `/search/search`（后者有 `list` / `context` 两种 `mode`）。HTTP 的 `/search/grep` 与 `/search/glob` 不调模型，没有这一层；它们没有上限不是因为「不读模型就不该限时」，而是 30 秒是检索路径的推导值，对不调模型、只查索引与读盘的操作没有意义（已知限制 28）。上限只在 `api/deadline.ts` 定义一次，工具与路由实现不各自计时。**包装在注册表而不是逐工具写，理由是缺口不可见**：少包一个工具就是一条没有上限的路径，而「哪个工具忘了」在 review 里看不出来。`~` 别名展开发生在被包装的 `execute` 内部，所以展开本身也在同一个预算里。

30000 是交互调用的硬上限。意图分析 10000、查询嵌入 10000、重排 15000 是各阶段上限，不是每段都应等满的累计承诺；前序阶段耗时后，`remainingBudget` 会继续收紧后续阶段，最终由接口层在 30 秒到点。三段预算的来源见 `services/retrieval/intent.ts` 的 `REWRITE_TIMEOUT_MS`、`services/retrieval/arms.ts` 的 `QUERY_EMBED_TIMEOUT_MS`、`services/retrieval/rerank.ts` 的 `QUERY_RERANK_TIMEOUT_MS`。Hook 侧是另一套预算（§15.9 的每事件总预算与单请求上限），不复用。

**这一层兜的是「上游预算本身失效」。** 没有它时 15 个工具没有任何工具级上限：`find` / `search` / `rule_search` 会一直等供应商返回，`search` 的最坏等待约 91 秒——意图分析 3 次重试 × 10 秒，查询嵌入与重排各 30 秒（5 路 `find` 并行，嵌入不叠加）。`providers.*.timeoutSeconds` 只校验正数（`src/config/schema.ts` 里都是 `positive()`），写 3600 也合法，因此那种配置下的最坏等待不封顶。宿主看到的现象是 agent 卡住，用户看不出卡在哪一环。

**到点返回的是失败，不是空结果。** MCP 结果是 `isError: true`，文本以 `TOOL_DEADLINE_EXCEEDED: ` 开头，写明这次调用的上限是多少毫秒、最后进入的上游是哪个、在那个上游上已经等了多少毫秒（`LLM 生成（意图分析）` / `向量嵌入（embedding）` / `重排（rerank）` / `检索索引（SQLite / FTS5）` / `文件系统`）。上游由工具经 `CallDeadline.mark` 上报：`FindOptions.onUpstream` 只覆盖会打网络的三类，`index` / `filesystem` 由工具自己标，`find` / `search` / `rule_search` 都在进入检索前先标 `index`。一次上报都没有时（例如挂在 `readScopes` 的 ACL 求权上，或 `read` 的文件系统调用上），文本写「卡住的位置在本地（索引 / 文件系统 / 锁）」，不把本地故障说成供应商的问题。服务端同时记一条 `warn`（`MCP 工具超过调用上限。`，带 `requestId` / `tool` / `code`），按 `TOOL_DEADLINE_EXCEEDED` 能在 `server.log` 里搜到。

HTTP 侧到点返回 **503 `PROVIDER_UNAVAILABLE`** 的错误封套，`details` 是 `{timeout: true, timeoutMs: 30000, reason: 'deadline_exceeded', upstream: 'llm'|'embedding'|'rerank'|'index'|'filesystem'|null, elapsedMs, requestId}`。`upstream` 为 `null` 表示一次外部上游都没进（卡在本地索引 / 文件系统 / 锁），`requestId` 由 `api/http/server.ts` 统一补进 `details`。两侧返回形态不同，规则是同一条：超时不能伪装成空结果——`200 + hits: []` 会被调用方读成「记忆里没有」。

**只停止等待，不取消在途调用。** `runWithDeadline` 用 `Promise.race` 加一个 `unref()` 的定时器；到点后调用方不再等，上游能不能立刻停下是上游契约的事——工具层不假设每个上游都正确响应 `AbortSignal`。

**到期之前先降级，降级在结果里可见。** 工具与 HTTP 检索路由把 `deadlineAt` 传给 `SearchService`，上游预算取 `min(上限, 剩余时间 - min(1s, 剩余/5))`，意图分析最多使用剩余的一半。provider 将预算视为上限，到期由 AbortController 中止在途 HTTP；总上限只停止等待。普通 Hook 的召回预算默认 8 秒（会话开局仍为 4 秒），断开客户端当前不会取消服务端的 30 秒任务，冷查询可能被宿主放弃。

`find` / `rule_search` / `search`（`mode=context`）在 `degradation` 或 `rerankFailure` 非空时，于命中列表后追加 `Degraded:` 行：

| 行 | 含义 |
|---|---|
| `Degraded: 向量检索不可用（…）；已退回关键词检索（FTS5），只覆盖关键词命中的内容。` | `hybrid` 引擎拿不到查询向量，退回 FTS5 |
| `Degraded: 向量检索不可用（…）；没有退回关键词检索，本次结果可能不完整。` | `vector` 引擎显式选了语义检索，不退回 |
| `Degraded: 重排不可用（…）；结果使用融合分。` | 重排超时 / 网络不可达 / 5xx，括号里是原因 |

**这行字的理由**：不写降级的 `Found 0 item(s):` 会被 agent 读成「记忆里没有」，而实际是上游没响应。`vector` 与 `hybrid` 的措辞不能互换：前者不退回关键词检索，写成「已退回」会让调用方以为还有兜底。行只在降级时出现（`src/api/mcp/registry.ts` 的 `formatDegradations`），与是否到达总上限无关——供应商不可达也会产生。

**连接被拒绝与预算到点是两条分支。** 前者由 `adapters/llm/provider-error-mapping.ts` 映射成 `PROVIDER_UNAVAILABLE` 且没有 `statusCode`（`fetch` 抛的 `TypeError`），重排归因 `network`；后者由 `budgetExceeded` 抛出，`details` 里带 `timeout: true` 与 `timeoutMs`，归因 `timeout`。两者都不重试同一次调用：嵌入适配器自己不做重试，意图分析靠 `AbortSignal` 跳过剩余两次尝试。但排查方向不同：前者查网络 / 端口 / 证书，后者查预算是否够用。

**实测**（`tests/integration/mcp/tool-deadline.test.ts`，上游是接受连接但永不回包的本地 HTTP 服务器，不可达端口是先监听再关闭的本地端口）：上游挂起 + 150 毫秒上限 → 212 毫秒返回 `isError`；慢嵌入 + 400 毫秒预算 → 330 毫秒返回 FTS 命中与降级说明；嵌入端口不可达 → 6 毫秒快速失败。

## 14. HTTP API

自动上下文新增 `POST /api/v1/context`：`{query?, sessionId?, contextEpoch?, maxTokens?, maxBytes?, limit?, budgetMs?, previousDeliveryToken?}`，空 query 取本人背景；认证身份确定可读范围，上限 30 秒，可用 `budgetMs` 收紧到宿主剩余预算。`POST /api/v1/context/ack` 接收 `{deliveryToken}`，只确认当前身份的签名回执。`GET /api/v1/auth/me` 返回当前请求的 `{subject, principals, isAdmin}`，含组成员身份与系统管理员判定。

统一前缀 `/api/v1`。记忆复核等端点把完整的 percent-encoded `comem://` URI 放在一个路径参数里；路由器允许该参数最多 4 KiB，避免合法的长主题和多层路径在进入 URI 校验前被 Fastify 默认的 100 字符限制拒绝。响应封套：

```json
{ "status": "ok", "result": { } }
{ "status": "error", "error": { "code": "PERMISSION_DENIED", "message": "..." } }
```

| 分组 | 端点 |
|---|---|
| 文件系统 | `GET /fs/ls`、`/fs/tree`、`/fs/stat`；`POST /fs/mkdir`、`/fs/mv`、`/fs/cp`；`DELETE /fs` |
| 内容 | `GET /content/read`、`/content/abstract`、`/content/overview`、`/content/download`；`POST /content/write`、`/content/edit` |
| 检索 | `POST /search/find`、`/search/search`、`/search/grep`、`/search/glob`。前两个（`/search/search` 的 `mode=context` 也走同一个包装）受 30 秒总上限约束，到点返回 503 `PROVIDER_UNAVAILABLE`（§13.3）；`grep` / `glob` 不调模型，没有这一层 |
| 会话 | `POST /sessions`、`/sessions/{id}/messages`、`/sessions/{id}/commit`；`GET /sessions`、`/sessions/{id}` |
| 任务 | `GET /tasks/{id}`、`GET /tasks`、`POST /tasks/{id}/retry`。三个都只认系统管理员（§12.4） |
| ACL | `GET /acl`、`PUT /acl`、`POST /acl/grant`、`POST /acl/revoke` |
| 记忆 | `GET /memories/pending`、`GET /memories/{uri}`（单条记忆元数据：类型、状态取自检索索引，有效期取自记忆文件；不是当前记忆时字段为 `null`）、`POST /memories`（新建记忆：类型 + 标题/主题 + 正文，路径由服务端算）、`POST /memories/dreamer`、`POST /memories/{uri}/approve`（空 body 兼容审批；编辑审批传 `{content, expectedUpdatedAt}`，§11.6）、`POST /memories/{uri}/reject`、`GET /memories/{uri}/links`（`?direction=links\|backlinks`，§11.10） |
| 资源 | `POST /resources`、`POST /resources/temp-upload` |
| 用户与组 | `GET /admin/users`、`POST /admin/users`、`PATCH /admin/users/{id}`、`DELETE /admin/users/{id}`、`POST /admin/users/{id}/password`、`GET /admin/users/{id}/api-keys`、`POST /admin/users/{id}/api-keys`、`DELETE /admin/api-keys/{keyId}`、`GET /admin/groups`、`POST /admin/groups`、`PATCH /admin/groups/{id}`、`DELETE /admin/groups/{id}`、`POST /admin/groups/{id}/owner`、`GET /admin/groups/{id}/members`、`POST /admin/groups/{id}/members`、`DELETE /admin/groups/{id}/members/{userId}`。授权口径见 §12.4 |
| 提示词 | `GET /prompts`、`GET /prompts/{id}`（任何已认证身份）；`PUT /prompts/{id}`、`DELETE /prompts/{id}`、`POST /prompts/{id}/preview`（系统管理员） |
| 本地推理 | `GET /inference/local`、`POST /inference/local/start`、`POST /inference/local/stop`。三个都只认系统管理员；启动命令与 pid 管理见 §18.2 |
| 遥测 | `POST /telemetry/hook`（Hook 上报阻塞开销，只做身份校验）；`GET /telemetry/llm-calls`（当前认证主体自己的最近模型调用，`limit` 1–100，cursor 分页） |
| 认证 | `GET /bootstrap`（恒定 200，见上）、`POST /bootstrap/admin`（仅 `needsSetup` 时可用；非回环请求要一次性初始化令牌）、`GET /auth/me`、`POST /auth/login`、`POST /auth/logout`、`POST /auth/password`（§12.7） |
| MCP | `GET /mcp/tools`（15 个工具的只读清单，控制台的「工具」页读它；工具说明的真相在 `api/mcp/registry.ts`） |
| 运维 | `GET /health`、`GET /metrics` |

**`POST /sessions` 只创建，不重置。** 已存在的 `sessionId` 返回 **409**（`ALREADY_EXISTS`），
`messages.jsonl` 原样保留；「已存在就复用」是服务层 `SessionService.ensure` 的语义，不是路由的。
判据是 `.meta.json` 是否存在（与 `GET /sessions/{id}` 相同），且检查与写入持 `TREE` 锁，
并发的同 ID 创建只有一个成功。

**为什么不能是 200。** Hook 的 `PostToolUse` 与 `Stop` 在同一轮里各 `POST /sessions` 一次，
两者都按「409 = 已存在，复用」实现。第二次拿到 200 意味着会话刚被创建——`messages.jsonl`
被覆写成空文件，上一轮采集到的工具消息就没了。这是静默数据丢失，不是「多建了一个会话」。

没有「重置会话」端点，也不预留 `?reset=true`：清空 live 消息没有合法调用方。归档走
`POST /sessions/{id}/commit`（消息移进 `history/`，不丢），删除由会话过期策略负责
（`SessionService.remove`，可审计）。

MCP 挂在 `/mcp`，Streamable HTTP 传输。

## 15. Agent 集成

15 个 MCP 工具里没有会话相关操作，真实会话靠 **Hook 插件**在宿主侧自动采集。这是独立于服务端的交付物，放在 `integrations/`，装进宿主。

独立维护的 [Hermes OpenUI](https://github.com/Micraow/hermes-openui/blob/main/README.md) 是 Hermes 的可选展示插件，不属于 CoMem 的 Hook、HTTP 或 MCP 接入。它在 Hermes 聊天记录中消费宿主流事件，渲染 OpenUI Lang；卡片状态保存在宿主浏览器，显式按钮回到原会话。插件不读写 CoMem 记忆，也不改变 CoMem 的接口契约。

### 15.1 为什么不在 MCP 工具里做

MCP 工具是模型主动调用的。会话提交不能靠模型「记得调」——它一忘，这次对话就丢了。而且提交要在**每轮结束后**发生，模型没有这个时机。

所以走宿主 Hook：宿主在固定生命周期点回调我们的脚本，脚本负责召回和采集。

### 15.2 生命周期点

| Hook | 做什么 |
|---|---|
| `SessionStart` | 请求 `/context` 的本人背景正文 |
| `UserPromptSubmit` | 请求 `/context`，服务端结合近期对话召回并组装个人及团队记忆 |
| `PreToolUse` | 拦住把 `comem://` 当本地路径的文件工具调用，指回 MCP 工具。判定全在本地、不发 HTTP，因此**不做开销上报**（预算仍然是 1000ms） |
| `PostToolUse` | 采集工具调用与结果（作为 `tool` 部分） |
| `Stop` | 采集本轮的 user / assistant 消息，提交会话 |
| `PreCompact` | 提交待处理消息（总预算 30 秒） |
| `SessionEnd` | 提交待处理消息（宿主只给约 1.5 秒，预算 1200ms） |

七个事件、六个脚本：`PreCompact` 与 `SessionEnd` 共用 `servers/pre-compact.mjs`，但内部事件名（`pre_compact` / `session_end`）与预算各自独立。

**这张表是 Claude Code / Codex 的 hook 脚本面。** DSH 通过原生 Cordis 插件订阅会话事件，另接 `tools/post-execute` 采集工具调用和结果；没有接管工具执行前权限。

**事件名有两套。** 内部事件名是 snake_case（`session_start` … `session_end`，7 个），出现在 `POST /telemetry/hook` 的 `event` 字段、`comem_hook_*` 的 `event` 标签与控制台的行键；PascalCase（`SessionStart` …）只出现在宿主载荷与返回信封里。两套名字的对应只写在 `integrations/lib/events.json`，两个 hook 宿主共享同一张表——各写一份时所有 hook 样本会塌进 `event="other"`（见 `lib/events.mjs` 的文件头）。这张表还标了 `reportsOverhead`：`pre_tool_use` 为 `false`，所以**进 `/metrics` 的事件是 6 个**，与「宿主会调的事件是 7 个」不是同一个集合。

**`SessionStart` 交付有界正文。** `<comem-profile>` 包含服务端已组装的个人背景，具体规则见 §8.6。Hook 只调一次上下文接口，不逐条拉摘要，不维护个人画像副本。宿主身份由认证结果确定，不要求另填 `userId`。

技能目录有独立 token 预算：放不下就只列名字，连一个名字都放不下就缩成一行计数。

**宿主字节上限。** Hook 请求时预留 64 字节供外层标签使用（标签实际小于此上界），服务端按 UTF-8 字节与 token 双重预算缩减；开局附加技能目录后还会复核整体字节数，先丢技能、再丢背景整块。只对返回的正文记账。

### 15.3 采集不阻塞对话

采集跑在**分离的 worker 进程**里，`Stop` 立刻返回。只有 `PreCompact` / `SessionEnd` 会等提交完成（在 hook 超时预算内）。

**为什么必须分离**：`Stop` 卡住等于把用户的输入延迟绑在 LLM 抽取上。抽取一次几秒到几十秒，用户会以为宿主卡死了。

**DSH 插件的采集不在分离进程里**：它在 `session/event` 的 `turn/end` 拿本轮消息，剥离后直接 `POST /sessions/{id}/messages` + `/commit`。这不会卡住模型——事件是 emit 模式，插件 fire-and-forget；提交失败时消息留在内存缓冲里，下一次 `turn/end` 重投（服务端按消息 `id` 幂等）。代价是进程被强杀时最后半轮会丢，见 DSH 插件 README 的已知限制。

### 15.4 去重与幂等

四层，前三层在插件里，最后一层在服务端：

1. **事件去重**：宿主可能重复投递同一个 hook 事件，按 `eventId` 去重，同一个事件 500ms 窗口内只处理一次。
2. **消息去重**：按轮次序号推进游标，只提交游标之后的消息。游标只在**服务端确认接收**后前进——没确认就重投，宁可重复不能丢。
3. **跨进程锁**：同一个 session 的多个 hook 进程可能并发（比如两次 Stop 挨得很近），用文件锁串行化。
4. **服务端按消息 `id` 幂等**：同一条消息重复提交时返回已有的那条，不新增、不推进轮次、不改会话状态（活会话与已归档会话都查）。上一层的「宁可重投」靠这一层收口，两道合起来才是「不丢也不重」。插件给的消息 `id` 是稳定值：对话消息取 transcript 里的 `uuid`，工具消息取 `tool_${toolUseId}`。

**幂等的前提是调用方给稳定 `id`。** `POST /sessions/{id}/messages` 在缺 `id` 时用 `crypto.randomUUID()` 补一个——重投会变成一条新消息，服务端不猜「这两条像不像同一条」。`id` 是空串时直接 `INVALID_ARGUMENT`：空串不是「没写」，是「写了个不能用的值」。

### 15.5 会话 ID

宿主没有统一的会话 ID 格式，插件按宿主加前缀：`cc-`（Claude Code）、`dsh-`（DSH 插件）、`cx-`（Codex）。前缀只在 ID 还没有这个前缀时补——`dsh-` 开头的原生会话 ID 不会被加成 `dsh-dsh-`。

### 15.6 MCP 接入

Hook 负责「自动注入 + 采集」，MCP 负责「agent 主动调用」，两条通道互补。装完 Hook 不等于接上了 MCP 工具。

服务端在 `/mcp` 暴露 **Streamable HTTP**，运行在无状态模式（`sessionIdGenerator: undefined`，不返回 `Mcp-Session-Id`，每个请求独立）。

**接入与宿主无关，两条路按部署约束选。** 需要让 Hook、DSH 原生插件和 MCP 共用
`~/.config/comem/config.yaml` 中的账号时，用 stdio 代理；宿主自己的安全变量机制
已经管理认证头时，可以 HTTP 直连。

| 场景 | 走哪条 | 配置里写什么 |
|---|---|---|
| 统一账号与共享客户端配置 | **stdio 代理**（`integrations/servers/mcp-proxy.mjs`） | `command: node` + `args: [<仓库>/integrations/servers/mcp-proxy.mjs]` |
| 宿主明确管理 HTTP 认证头 | **HTTP 直连** | 一个 URL；需要时再一个 `Authorization` 头 |

**`type` / `transport` 不能省**——Claude Code 把「只有 `url`、没有 `type`」的条目
当成 stdio 服务器并跳过（报 `has a "url" but no "type"`），DSH 的 `transport` 是
必填字段，取值 `stdio` 或 `streamable-http`。

认证走请求头（§12.7）：带 `Authorization: Bearer <API Key 或 session token>`，缺失或非法一律 401 `UNAUTHENTICATED`。唯一的例外是回环信任——来源是回环地址、又没有带凭据的请求被认证成 `server.subject`，本机的 `curl` 与 hook 插件因此不必存凭据。API Key 从 `POST /api/v1/admin/users/{id}/api-keys` 签发，明文只出现一次。**统一账号优先由 Hook、DSH 原生插件和 stdio 代理共享同一份扁平客户端配置的 `baseUrl` / `token`。** 该配置不做 `${ENV}` 插值，GUI 宿主也不保证继承终端环境。HTTP 直连只能使用该宿主自己的安全变量机制：Claude Code `${COMEM_TOKEN}`、Codex `bearer_token_env_var = "COMEM_TOKEN"`、DSH `!!js process.env.COMEM_TOKEN`，使用前必须证明对应进程确实拥有变量。Hermes Memory Provider 使用自己的 `memory.comem` 配置或 Hermes profile 的 `.env`；要统一账号，需要填入同一 API Key，而不是假定它读取 CoMem 的共享文件。

DSH `0.2.2-rc.1` 的 `dsh-mcp-client` 在启动 stdio 子进程前会清洗名称含
`TOKEN` 的父环境变量。因此 DSH GUI 场景应让代理读取共享文件，或用该条目的 `env`
显式传入值；只依赖在终端导出的 `COMEM_TOKEN` 不足以证明 GUI 进程会收到它。

**为什么还是做 stdio 代理。** 早先的判断是「Claude Code 和 DSH 都原生支持 Streamable HTTP，代理是多余的常驻进程」。**这个判断把「我验证过的两个宿主」当成了「所有宿主」**：MCP 规范里 `stdio` 是一等公民，只支持本地 stdio 服务器的宿主不会因为另外两个支持 HTTP 就不再存在。代理约 200 行，不引依赖、不重写认证——它复用 hook 的配置链（`integrations/lib/config.mjs`），把 stdin 的每一行 JSON-RPC 转发到 `POST /mcp`。**服务端无状态省掉了三块**：没有 `Mcp-Session-Id` 可缓存、没有 `DELETE` 可发、没有会话过期要重放 `initialize`。这是它比通用代理短的那部分。

**生态里已有的通用代理不替代它。** `mcp-remote` 这类工具能把 stdio 转到远程 MCP，CoMem 的端点它能直接连（`--transport http-only`）。不把它当默认路径的理由只有一条：它要求把凭据写进宿主的 MCP 配置，而 CoMem 自己的代理复用 Hook 的配置链，`~/.config/comem/config.yaml` 改一次两边都生效。已经用它的部署不需要迁移。

**工具发现靠描述自解释。** `initialize` → `tools/list` 的 `description` 是 agent 唯一能看到的用法说明，所以 16 条各自必须回答「什么时候用 / 什么时候不用」，`find` / `search` / `rule_search` 三个必须能互相分辨（`find` 是语义召回、`search` 多一次意图重写、`rule_search` 取规则完整正文）。URI 参数的描述统一写上 `~` 别名——agent 不该为了拼一个绝对 URI 去猜 uid。

**提示词与注入格式必须一致。** `<comem-profile>` 交付开局画像与偏好正文，`<comem-recall>` 交付当前问题相关的正文、概览或摘要；内部条目包含 URI、类型与 detail，不显示绝对分数。旧 `<comem-preferences>` 与 `<available-skills>` 仅为历史 transcript 清理而保留在捕获剥离表。`integrations/skills/` 下是独立安装到宿主的提示词包，不由 CoMem 服务端管理。

工具数仍然是 **15 个**（§13、`AGENTS.md` §3）：MCP 只暴露这 15 个，Hook 不经过 MCP，也不新增工具。配置片段、认证、提示词与验证步骤见 `integrations/README.md` 的「MCP 接入」。

### 15.7 支持哪些宿主

支持 **Claude Code**（Hook + MCP）、**Codex**（Hook + MCP）、**DSH**（原生插件 + MCP）和 **Hermes**（Memory Provider + 可选 MCP）。

**两个 hook 宿主**的事件名与载荷覆盖 §15.2 的七个事件：

| 宿主 | Hook 形态 | 事件名 | 配置文件 |
|---|---|---|---|
| Claude Code | settings 里的 hooks | `SessionStart` / `UserPromptSubmit` / `PreToolUse` / `PostToolUse` / `Stop` / `PreCompact` / `SessionEnd`（后两者都装 `pre-compact.mjs`，内部事件名不同） | `~/.claude/settings.json` |
| Codex | `hooks.json` 或 `config.toml` 内联 `[hooks]` | 同上（官方文档 <https://developers.openai.com/codex/hooks>；另有 `SubagentStart` / `SubagentStop` / `PermissionRequest` / `PostCompact` / `Interrupt`，CoMem 只接其中这七个） | `~/.codex/hooks.json` 或 `<repo>/.codex/hooks.json` |

**DSH 不是 hook 宿主。** DSH 0.2.2-rc.1 没有「宿主执行一个命令并读 JSON」的面：配置是
`$DSH_HOME/profiles/<name>/cordis.patch.yml` 里的插件条目，生命周期是同进程 Cordis
插件订阅的 typed 事件。接入物是独立包 `integrations/dsh-plugin/`，覆盖五个接缝：

| 接缝 | 等价于 | 实现 |
|---|---|---|
| `agent/created` | `SessionStart` | `handleSessionStart` + `agent.inject()` |
| `agent/pre-step`（waterfall） | `UserPromptSubmit` | 先 `await next()`；本步没有用户消息就原样返回；否则 `handleUserPromptSubmit` 并把块折进 `decision.messages` |
| `tools/post-execute`（waterfall） | `PostToolUse` | 保留 `next()` 的决定，缓冲调用/结果，随本轮提交 |
| `session/event` 的 `turn/end` | `Stop` | `sanitizeCapturedMessages` → `ensureSession` → `POST /sessions/{id}/messages` + `/commit` |
| `agent/disposed` | `SessionEnd` 的近似物 | 尽力补交，emit 模式没人等 |
| `session/event` 的 `compaction/start` | `PreCompact` | **做不到**：只记一条 warn，压缩前不归档 |

插件不写第二份渲染 / 预算 / 剥离：它 import `integrations/servers/*.mjs` 的
`handleSessionStart` / `handleUserPromptSubmit` / `ensureSession`，以及 `lib/` 的
`injection.mjs` / `sanitize.mjs` / `http.mjs` / `lifecycle.mjs`。
`hosts/dsh.mjs` 已删除——它假设的载荷形状、`transcriptPath` 与工具名都不存在，
永远不会被调用。`install --host dsh` 在写第一个字节之前失败并指向插件。
DSH patch 的 `config` 可以为空；插件从共享 `~/.config/comem/config.yaml` 或
`COMEM_*` 环境变量加载 `baseUrl` / `token`，只有 patch 显式写出的字段才覆盖。
显式 `token: ''` 会清空共享 token，因此统一接入的示例省略该字段。配置文件不存在
时使用既有默认值；文件存在但解析失败时插件停用注入与采集，不退回默认身份写数据。

Codex 与 Claude Code 的载荷字段同形（`session_id` / `transcript_path` / `cwd` /
`hook_event_name`，信封是 `hookSpecificOutput.additionalContext` 与
`permissionDecision: 'deny'`），所以适配器只在文件工具名上不同：Codex 没有 `Read`，
文件编辑走 `apply_patch`（别名 `Edit` / `Write`），路径在补丁命令里提取。Codex
的非托管 Hook 运行前需要用户在 `/hooks` 里审查并信任。

**不做 Cursor、TRAE、OpenCode 等的 Hook。** 它们的 hook 事件名和 payload 各不相同，
每个都要单独适配并对着真实宿主验证。适配器接口留好即可——加一个 **hook 宿主**仍然
只加一个 `hosts/<name>.mjs` 文件，再加一条 `cli.mjs` 的 `DEFAULT_SETTINGS` 条目。
DSH 这种没有 hook 面的宿主走自己的插件包，不塞进 `hosts/`。

**这条限制只约束 Hook，不约束 MCP。** MCP 走标准传输（§15.6），任何支持 Streamable HTTP 或本地 stdio 的宿主都能接——那两条是协议，不是适配器。加宿主只需要在文档里补一段配置片段，`src/` 一行都不用改。

**Hermes 用独立 Memory Provider。** `integrations/hermes-memory/` 按官方 v0.23.1 Provider 接口加载，v0.23.2 已对真实网关验证。每轮用当前请求调用 `POST /api/v1/context`，完成的用户和助手文本经 `/sessions`、`/messages` 和 `/commit` 进入原有归档管线。召回和写入用同一 `hermes-` 会话地址；回放队列保存在当前 Hermes 配置目录，核对服务地址、凭据指纹和账号后才重投。Provider 状态显示最近认证返回的 `subject`，凭据或服务地址变化后不展示旧绑定；控制台必须以同一主体登录，否则写入成功的数据在另一主体的会话、任务和文件树里不可见。该集成保留宿主的原生记忆文件；显式导入仍通过 MCP。可选展示插件 [Hermes OpenUI](https://github.com/Micraow/hermes-openui/blob/main/README.md) 在独立仓库维护并单独安装。见[快速上手](hermes-quickstart.md)。

### 15.8 目录

```
integrations/
├── package.json
├── README.md
├── cli.mjs                    # co-mem install / doctor / uninstall
├── servers/                   # 七个可执行入口
│   ├── session-start.mjs      # ┐
│   ├── user-prompt-submit.mjs # │
│   ├── pre-tool-use.mjs       # │ 六个 Hook 脚本：stdin JSON → stdout JSON
│   ├── post-tool-use.mjs      # │ `pre-compact.mjs` 同时服务 PreCompact 与 SessionEnd
│   ├── stop.mjs               # │
│   ├── pre-compact.mjs        # ┘
│   └── mcp-proxy.mjs          # stdio → POST /mcp（§15.6）
├── hosts/                     # 宿主适配（信封与载荷）
│   ├── claude-code.mjs
│   └── codex.mjs
├── dsh-plugin/                # DSH 原生插件（独立包，装进 profile）
│   ├── package.json           # main / engines.dsh
│   ├── lib/index.js           # 五个接缝的订阅者
│   └── README.md
├── lib/                       # 与宿主无关的共享模块（hook 与 DSH 插件共用）
│   ├── config.mjs             # 配置 + 宿主解析 + bypass
│   ├── http.mjs               # 超时 / 重试 / 错误封套
│   ├── hook-runner.mjs        # 入口骨架：stdin → 归一化 → 预算 → 信封（两个 hook 宿主共用）
│   ├── lifecycle.mjs          # 总预算 / stdin 上限 / 诊断与兜底退出
│   ├── is-main.mjs            # 入口判定：被直接执行还是被测试 import（六个入口共用）
│   ├── values.mjs             # 载荷取值：asRecord / text / renderToolOutput / describeEntry
│   ├── events.json            # 事件名映射表（内部 snake_case ↔ 宿主 PascalCase）
│   ├── events.mjs             # 读上面那张表，导出 EVENT_NAMES / REPORTED_EVENT_NAMES
│   ├── dedup.mjs              # 事件去重（500ms 窗口）
│   ├── lock.mjs               # 跨进程会话锁
│   ├── cursor.mjs             # 消息游标
│   ├── context-epoch.mjs      # 每个宿主会话的上下文重置标识
│   ├── sanitize.mjs           # 捕获侧剥离（去掉自己注入的块）
│   ├── injection.mjs          # 注入侧渲染：转义 / 索引截断 / 字节上限
│   ├── filter.mjs             # sed 风格查询过滤
│   └── telemetry.mjs          # 四阶段开销上报
├── skills/                    # 独立提示词包：装进宿主的技能目录
│   ├── comem-memory/SKILL.md  # 召回 + 写入 + 合规
│   └── comem-rules/SKILL.md   # 动手之前取规则
└── tests/                     # node:test
```

宿主适配器只回答五个问题：**事件名怎么叫**、**返回信封长什么样**、**prompt 从 payload 哪里读**、**一轮结束怎么判定**、**transcript 怎么解析**。入口骨架（读 stdin → 归一化 → 总预算 → 写信封 → 退出）不属于这五个问题，也没有宿主差异，两个 hook 宿主共用 `integrations/lib/hook-runner.mjs` 的 `createRunHook`（DSH 插件不经过它：它的载荷不是 stdin JSON）；「适配器之间不互相 import」约束的是信封与载荷解析，不是 `lib/`。

第五个是踩过的坑：`Stop` 拿到的 `transcript_path` 是**宿主自己的格式**，不是通用格式。Claude Code 的 JSONL 每行有顶层 `message.{role,content}`；Codex 的 rollout 是 `{"type":"response_item","payload":{"type":"message","role":…,"content":[{"type":"input_text","text":…}]}}`，没有顶层 `message`。**共用一个解析器就等于只支持一个宿主**——被共用的那个会静默返回 0 条消息，hook 正常退出 0、什么都不报，整条被动捕获链路根本不会启动。所以解析下放到 `integrations/hosts/*.mjs` 的 `parseTranscript`，`stop.mjs` 只负责「拿路径 → 交给宿主 → 拿消息」。其余状态机由 `lib/` 承担：去重（`dedup.mjs`）、游标（`cursor.mjs`）、跨进程锁（`lock.mjs`）、超时与重试（`http.mjs`）。

### 15.9 召回阻塞与预算

自动上下文请求把客户端剩余等待时间的 80% 传入 `budgetMs`（上限30秒），余下20%为网络返回、输出和回执落盘预留；这是工程预算分配假设，不是实测保证。服务端嵌入/重排沿用剩余预算收紧和先降级机制；即使查询在HTTP超时后继续完成，也只签发回执，未经确认不抑制下一次召回。上游能响应 AbortSignal 时预算中止网络请求；不响应取消的本地操作仍可能继续运行。

**这是整个设计最需要算清楚的一笔账。**

`UserPromptSubmit` 是**同步阻塞**的：用户按下回车 → 宿主启动 hook 进程 → hook 调 CoMem 检索 → 拿到注入内容 → 宿主把 prompt 和注入内容一起发给模型。

也就是说，**用户每打一轮，都要先等 CoMem 把记忆找完**。这笔延迟直接加在「回车到模型开始生成」之间。

**耗时拆解**（自动召回走 `POST /api/v1/context`，下表为未压缩路径的估计）：

| 阶段 | 阻塞 | 典型 |
|---|---|---|
| hook 进程启动 | 是 | 30–50ms |
| 输入过滤（§8.8） | 是 | < 1ms |
| 检索（FTS5 / 向量 / 融合） | 是 | 20–100ms（向量变体含查询嵌入的网络往返） |
| 上下文组装 + 序列化 | 是 | < 5ms |
| 写 worker 载荷（`Stop`） | 是 | 5–20ms |
| 归档 + 抽取 + 合并 + 摘要 | **否**（后台） | 几秒到几十秒 |

**每个事件一个总预算，不是「每个请求 5 秒」。** `timeoutMs`（默认 5 秒）只约束**一次 HTTP 尝试**；一个 hook 里顺序发三次请求就是三倍，`GET` 还有重试。用户在 `UserPromptSubmit` 上等的是这个端口上所有请求加起来的时间。预算按**墙上时钟**从**进程启动**算起（`performance.timeOrigin`）：读 stdin、检索、采集、上报都从同一个 deadline 里扣，子请求共享同一个 `AbortSignal`。值在 `integrations/lib/lifecycle.mjs` 的 `HOOK_BUDGETS_MS`（`SessionEnd` 单列在 `SESSION_END_BUDGET_MS`）。每轮自动召回可用客户端 `recallTimeoutMs` 或 `COMEM_RECALL_TIMEOUT_MS` 覆盖默认 8000ms（1000–29000ms）；其 HTTP 请求直接沿用事件剩余预算，不受通用 `timeoutMs` 限制。安装器为 Claude Code 和 Codex 的该事件设置 30 秒宿主上限，29 秒配置上限为启动和退出留余量。DSH 插件使用同一配置。

| 事件 | 总预算 | 依据 |
|---|---|---|
| `SessionStart` | 4000ms | 会话开局一次；上下文与技能目录并发请求。4 秒是已有宿主等待预算，新上下文路径未做真实模型延迟测量 |
| `UserPromptSubmit` | 默认 8000ms，可调 | **每轮按回车都付**。宿主默认给 30s；8s 覆盖慢网关与召回压缩，同时为宿主输出和退出保留余量，超了退化成「本轮没有记忆」 |
| `PreToolUse` | 1000ms | 纯本地判断、不发请求；本机实测 29ms。它出现在**每次工具调用**前，取实测的约 30 倍 |
| `PostToolUse` | 2000ms | 两次顺序 POST；§17.2 的采集写入 5–20ms，2s 是 100 倍 |
| `Stop` | 1000ms | 主进程只写载荷 + spawn；实测 44ms |
| `PreCompact` | 30000ms | 数据可能丢，必须等提交完成；与 `commitTimeoutMs`、§17.2 的 `rewriteTimeoutMs` 同一个数 |
| `SessionEnd` | 1200ms | Claude Code 给 `SessionEnd` 一组 hook 只有 1.5 秒共享预算，留 300ms 给启动与退出 |

**预算不能超过宿主给该事件的 hook 超时。** 超了宿主会先杀掉进程并丢弃输出，预算就成了空话；上表 `SessionEnd` 那一行正是按宿主上限倒推的。`SessionEnd` 的 1.2 秒比等锁的 `LOCK_WAIT_MS = 2000` 短，硬上限会在约 1.45 秒以退出码 0 收尾，代价是这次提交放弃、等下次重投（见 `docs/operations.md` 已知限制 29）。

**一次尝试的超时与总预算取小。** 每次 HTTP 尝试的超时是 `min(timeoutMs, 剩余预算)`，请求信号是「单请求超时」与「总 deadline」的 `AbortSignal.any`；预算用尽抛 `HOOK_BUDGET_EXCEEDED`，之后不再开新请求、不再重试。它与 `HOOK_TIMEOUT` 分开：前者是「这个请求慢」，后者是「整个 hook 的时间用完了」——排障时前者指向某个端点，后者指向预算。

**stdin 有 800ms 上限**（`STDIN_READ_CAP_MS`），超时按「没有事件」处理。宿主不写也不关 stdin 时 `for await` 永远不会返回；800ms 小于最短的事件预算（1000ms），所以「stdin 卡住」不会把任何 hook 拖过它的总预算。

**异常路径的契约**（所有 hook 入口一致）：

| 性质 | 实现 |
|---|---|
| stdout 零字节 | 只有 handler 正常返回且 `formatOutput` 产出信封时才写；任何异常都不进写路径 |
| stderr 一行诊断 | `co-mem hook <事件>: <消息>`，或一行 JSON `warn`；不含 prompt 正文、工具输出与凭据 |
| 退出码 0 | 0 是成功，2 是阻塞错误，其它非零按 non-blocking error 记；hook 是旁路，内部错误不该参与这个判定 |
| 进程一定退出 | 两道保险：逻辑结束后安排一个 `unref()` 的兜底定时器（没有残留句柄时不触发，有则 `process.exit(0)`）；`armHardDeadline` 再按「预算 + 250ms」架一道硬上限，handler 永不返回时进程也退出 |

**退出码必须是 0。** 除 0 与 2 之外的退出码在宿主侧只记成 non-blocking error，但 Claude Code 配了 `onFailure: "block"` 时会把它升级成**阻断这次调用**。改前 `--host` 参数非法会在顶层 await 抛出、进程以退出码 1 加堆栈结束；`runMain` 与 `installFatalGuards` 之后，`resolveHost()` / `loadConfig()` 的失败、未捕获异常、未处理的 Promise 拒绝都收敛成「一行 stderr + 退出码 0」。

**`PreToolUse` 的错误路径不会变成 deny。** 它的判定是本地字符串前缀（只认 `comem://`），`runHook` 的 catch 分支不写 stdout，宿主拿到「没有决定」后继续走正常权限流程；`handlePreToolUse` 只返回 `{deny}` 或 `undefined`，不存在「异常 → deny」的路径。「hook 挂了导致工具被拒」比卡住更难查，所以这条要写死。

**服务端采集与提交在 detached worker 里，不阻塞用户。** `Stop` 的主进程只做去重、bypass、写 worker 载荷文件、spawn（`integrations/servers/stop.mjs` 的文件头）：`POST /sessions/{id}/messages` 与 `POST /sessions/{id}/commit` 都在 `detached: true` + `unref()` 的子进程里跑，主进程不等它。只有 `PreCompact` / `SessionEnd` 会等提交完成（§15.3）。

**hook 路径不调 LLM，是刻意的取舍。** 意图分析（§8.4）能补全「那它呢」「继续」这类指代，代价是一次模型调用：估计 300–500ms 起，超时上限 10 秒（`REWRITE_TIMEOUT_MS`）。把这次调用放进每一轮的阻塞路径，等于把用户的输入延迟绑在供应商的尾延迟上。

**hook 路径不做查询扩展的代价是：口语化查询的召回会下降。**

| Prompt | 不扩展的召回 | 先扩展再检索 |
|---|---|---|
| `TypeScript strict 怎么配` | 好——关键词已经足够具体 | 略好 |
| `这个怎么又报错了` | **差**——「这个」「报错」匹配不到具体记忆 | 好——结合上几轮改写成「TypeScript 类型错误」 |
| `继续` | **空** | 好——改写成上一轮话题 |

口语化 prompt 里没有关键词，BM25 无从下手。需要这条召回时走 agent 主动调用的 `search`（带 `sessionId`）：它先做意图分析拿到 0–5 条 TypedQuery，再逐条 `find` 合并——这一次 LLM 调用发生在 agent 自己的工具调用里，不占用户的输入延迟。

**降级而不是等待。** 意图分析超时、输出被截断、结构化输出不合法时，整次分析退化成「原 query 跑一次」，`plan.analyzed = false` 且 `reason` 非空（§8.4）。宁可用粗糙的查询，也不让用户干等。

**MCP 的 `search` 是另一套预算。** 它发生在 agent 自己的工具调用里，不受上面「用户每轮等几十到几百毫秒」的约束，代价由服务端的 30 秒硬上限兜住（§13.3）；Hook 侧是**事件总预算**（上一张表），`timeoutMs` 只是它内部一次 HTTP 尝试的上限。`providers.*.timeoutSeconds` 是**单次外部调用**的预算，既不是 hook 的事件预算，也不是 MCP 的 30 秒；调大它只会让单次调用等更久，不会放宽任何一层的总上限。

**注入的三条前提**（缺一条，召回噪音就会盖过收益）：

1. **召回为空就不注入**——不要给模型一段「没有相关记忆」的废话；
2. **预算与权限通过服务端组装**——只返回可读且装得下的内容；自动接入不把 RRF 比例当作相关概率，不再使用 `recallScoreThreshold`；
3. **账本去重**——同一记忆不重复投喂（§8.7）。

**自动注入块里不写绝对分数。** 分数只在同一次检索的同一个引擎内可比（§13.2），RRF 不能作为相关概率。块内保留来源和实际交付粒度：

```
<comem-recall>
<memory uri="comem://user/alice/memories/profile.md" type="memory" detail="full">
后端工程师
</memory>
</comem-recall>
```

这三条任何一条不成立，召回延迟的收益就归零。这也是为什么 §17.2 的延迟归因必须做：**它要能证明「这一轮 CoMem 花了多少毫秒，帮模型省了几轮探索」**。

**注入的收益只在下游真的少探索时才成立。** 召回是噪音的话，用户付出的延迟什么都没换到，还会被错上下文带偏——这比没有记忆更糟。CoMem 目前没有「召回质量 → 下游轮次」的测量；这条链路依赖 §8.10 的检索质量评估，而不是反过来。

**能不能做到不阻塞**：

| 手段 | 可行性 | 省多少 |
|---|---|---|
| 长驻守护进程 + Unix socket | 可以，加复杂度 | 省掉 30–50ms 进程启动 |
| 预取 | 不行 | 按下回车前不知道 prompt |
| 异步注入 | 不行 | hook 协议是同步的，宿主不会等 |
| 缓存同 prompt 结果 | 有限 | 重复 prompt 很少 |

v1 每次起进程。如果实测发现进程启动占比过高（> 50%），再上 Unix socket 守护进程。

### 15.10 注入与捕获的去重

§15.9 保证「注入什么」，这一节保证**注入物不会反过来污染记忆**。三个机制，细节与用例在 `integrations/README.md` 的「注入与捕获的去重」：

1. **捕获侧剥离**（`integrations/lib/sanitize.mjs`）。`Stop` 把会话消息原样上报给 `POST /sessions/{id}/messages`，而会话里**带着 CoMem 自己注入的块**。不剥就是「上一轮注入的记忆」以「用户这轮说的话」的身份被重新抽取，跑几轮之后记忆库开始复读自己。剥离在 `captureSession` 里、**发 HTTP 之前**做一次：块级包括当前 `<comem-recall>` / `<comem-profile>` 与仅为历史兼容的 `<comem-preferences>` / `<available-skills>` / `<system-reminder>`，按「开标签 → 最近的闭标签」剥，不是贪婪正则；随后处理行首时间戳前缀与裸 epoch。剥空的消息整条丢弃，游标按剥离后的条数推进。两个宿主适配器不各剥一次——它们只回答「怎么解析」；DSH 插件的 `turn/end` 也调同一个函数。
2. **注入侧转义**（`integrations/lib/injection.mjs` 的 `escapeInjectionText`）。记忆正文里的 `<comem-` / `</comem-` 的 `<` 换成 `‹`（U+2039）：正文含 `</comem-recall><comem-recall>` 时，渲染后的块里开标签与闭标签各只有一个，结构没被破坏，内容仍然可读。反斜杠会把转义链引进来，删标签会改变记忆本身。
3. **服务端跨轮账本**（§8.7）。Hook 只保留每个地址/会话的随机 epoch 文件，DSH 在内存保留 epoch；内容指纹、窗口、会话隔离与并发写都由服务端处理。

**接口出口。** 自动接入走 `POST /context`；主动检索仍走 15 个 MCP 工具与原有 HTTP 检索接口。没有新增 MCP 工具。服务端正文按领域渲染器转义 `<>&`。

**剥离会误伤。** 规则认的是字符串：讨论 CoMem 时贴出的注入块示例、行首日志时间戳、恰好落在 epoch 范围的数字可能被吃掉。旧版 `<available-skills>` 仍在历史 transcript 的剥离路径；开局背景由服务端记账。已知限制见 integrations README。


## 16. Web 控制台

Nuxt 3 + shadcn-vue + Tailwind。业务页面与账号入口如下：

| 页面 | 内容 |
|---|---|
| 登录 | 有账号但浏览器里没有可用会话时出现；用户名 + 密码换 session token，成功后回 `redirect` |
| 我的账户 | 右上角进入；显示本人系统角色，管理自己的 API Key，验证当前密码后可换新密码并重新登录 |
| 概览 | 四个指标 + 待处理任务；全局健康指标来自 `GET /health`，当前空间可读待复核摘要来自 `GET /memories/pending`，任务卡来自 `GET /tasks`；新装空态可直接新建第一条记忆 |
| 文件树 | 左树右详情；工具栏可新建记忆；**目录树按需展开**（每次 `GET /fs/ls` 拉一层，不在首屏拉整棵树）；详情分 L0/L1/L2 三档切换；显示摘要来源与新鲜度；`memories/` 下的节点另有「关联」区块，文件还有「记忆」区块（类型、状态、能否被检索、有效期） |
| 检索 | 输入 query，选「直接查找 / 先理解再检索」，显示每条命中的名次、层级、命中原因（不显示分数：四种引擎的分数量纲不可比，见 §8.4）；结果标题用摘要或文件名、URI 降为第二行；右上角如实显示实际引擎（关键词匹配 / 向量检索 / 混合检索，读 `GET /health` 的 `retrieval.engine`）；0 命中区分「库空」与「无匹配」，并说明关键词引擎的边界 |
| 记忆复核 | 待确认列表优先显示更新与推断偏好；详情展示正文、真实的版本差异及来源；逐条更新通过 / 拒绝的结果 |
| ACL 管理 | 节点树 + 授权列表；切换 inherit / restricted；显示有效权限的推导链 |
| 用户与组 | 系统管理员入口；用户列表显示服务器判定的角色，组成员列表区分所有者和成员。管理员可以为其他用户设置或重置密码；查看或管理节点读写权限使用「权限管理」 |
| 会话与任务 | 会话列表、归档列表、最近 100 条任务（包含运行中、完成与失败）；已提交且 live 消息为空的会话展开后显示「已归档」，并直接链接到该会话的真实 `history/` 目录；「导入历史会话」打开 `/connect#import-history`；没有重试入口，也没有回收记录列表（理由见下） |
| 接入 Agent | 按宿主给出安装与 MCP 配置；Hermes 检查仅认可已经提交的 Hermes 会话，不根据任意归档推断自动召回已经生效 |
| 监控 | 记忆健康度、开销归因、吞吐与用量、请求记录（见 §17.10） |
| 提示词 | 内置提示词的正文、可用变量、渲染预览；保存 / 恢复默认（见 §18「提示词」） |
| 工具 | 15 个 MCP 工具的名字、分组、参数名与说明；读 `GET /mcp/tools`，文本来自注册表而不是界面重写 |
| 设置 | 表单显示可编辑值；草稿与运行值不同时显示运行值，保存后标记待重启；由环境变量控制的字段只读 |

**一个页面的多个区域各自取数，失败不互相污染。** 每一块数据有自己的端点与权限门槛，一块取不到只影响那一块：其余区域照常渲染，失败的位置显示能说明原因的空态。四处按这条原则实现：

- **概览页：`GET /tasks`、`GET /health` 与 `GET /memories/pending` 分开。** `/tasks` 是系统管理员专属（§12.4），因为 `task` 表没有可求权的目标；`/health` 对任何身份可用；待复核摘要按当前空间和当前身份过滤。三个请求各配加载态与错误：任务 403 不遮挡健康徽标和指标，待复核查询失败也不影响其它全局指标。
- **用户与组页：403 显示空态，并收起新建按钮。** `/admin/users` 与 `/admin/groups` 同样只给系统管理员，普通身份拿到的是 403。侧栏按 `GET /auth/me` 的 `isAdmin` 显示管理员入口，服务端仍独立校验权限。「我的账户」并排显示登录账号与系统角色。首次初始化的管理员和 `auth.adminUserIds` 名单使用同一角色判定，控制台不修改这份名单。
- **文件详情页：摘要失败只影响摘要区。** `/fs/stat` 失败（节点不存在、读不了）才整页失败；`/content/abstract` 取不到时只在摘要区显示「摘要没有取到」，元信息、正文与 ACL 照常渲染。两个端点对同一 URI 都要求读权限，摘要取不到不代表节点读不了（`web/pages/files/[...path].vue`）。
- **文件详情页的「关联」区块独立取数。** URI 第三段是 `memories` 时（`user/{uid}/memories/...`、`group/{gid}/memories/...`），左栏多一个「关联」区块：`direction=links` 与 `direction=backlinks` 各请求一次 `GET /memories/{uri}/links`，分「这条记忆指向」与「指向这条记忆」两组。`link_type` 翻译成中文（派生自 / 引用了 / 相关，反向分别是派生出 / 被引用 / 相关），未知值原样显示——新增关系类型时界面不会静默吞掉一条边。`weight` 与 `matchText` 不展示（前者是内部强度，后者当前产生端恒为空）。两个请求并行、切换节点后丢弃迟到响应；失败只置该区块的提示，不碰正文与摘要（`web/pages/files/[...path].vue`、`web/utils/memoryLinks.ts`）。
- **文件详情页的「记忆」区块回答「为什么搜不到」。** `memories/` 下的**文件**另请求一次 `GET /memories/{uri}`，显示记忆类型、状态、能否被检索与有效期。状态与类型取自**检索索引**而不是记忆文件的 frontmatter：TTL 归档只把索引行改成 `archived`，文件里仍是 `active`（§11.7），读文件会在归档后给出相反的答案。能否被检索由状态推导：检索只返回 `active`（索引的 `n.status = 'active'`），所以 `pending` 写「待复核，检索不到」并给「去复核」入口，`archived` 写「已归档，检索不到」并说明按 URI 仍可读取。没有恢复端点，因此不给恢复按钮——按了也做不成事。有效期来自记忆文件（索引的 `NodeStat` 没有这两列）。没有索引行、目录、`.history` 版本文件与 `.abstract.md` 显示「未知」，与请求失败分开。请求失败只影响这一块，正文、摘要、关联与权限照常渲染（`web/pages/files/[...path].vue`、`web/components/domain/SummaryPanel.vue`）。

**浏览器里能创建第一条记忆。** 概览页的「还没有数据」空态与文件树工具栏各有一个「新建记忆」入口，共用同一个对话框：选记忆类型（中文名来自 `web/utils/memoryTypeLabels.ts`），填标题/主题与正文，提交走 `POST /memories`。路径不在控制台拼——服务端把标题映射成 identity 值并用各类型自己的 `filename` 模板渲染，响应带最终 URI（见 §11.1）。成功后关闭对话框、刷新目录树、跳到那条文件；`experiences` / `rules` 落在复核队列里，提示语写「等待复核」而不是只说「已保存」。失败时按 `details.field` 把 400 的原文挂在标题或内容字段旁，其余失败（403、网络）挂在对话框内——表单不吞掉服务端的诊断信息（`web/components/domain/MemoryCreateDialog.vue`）。

**导入整段对话从「会话与任务」或概览空态进入。** 接入页提供可复制的[导入提示词](../web/assets/prompts/import-history.md)，浏览器不读取本机文件，也不提交对话。Agent 展示来源和预览后，等用户确认才走 MCP `remember`（§11.9）。目标由 MCP 登录身份决定，Agent 可用 `health` 核对账号和提炼能力。会话在「会话与任务」，原文可按返回的归档地址在「文件树」查看，待复核记忆在「记忆复核」。

**复核队列先展示覆盖写，其次是推断偏好，同一类保留接口顺序。** 新记忆从 `GET /memories/pending` 返回的正文直接展示，无需等待第二次请求；更新只读取 `supersedes` 所指向的快照，快照不可用时保留新正文。来源链接用已存档的地址，有明确的推断原话时单独呈现。详情保留有效期和错误。通过或拒绝立即在对应按钮显示处理中；只有服务端确认后才移走该条目并选中相邻一条。勾选后显示批量操作，执行时逐条更新进度，失败项留在队列并显示原因（`web/pages/review.vue`、`web/components/domain/MemoryDiff.vue`）。

**复核页可以生成整理建议。** 「整理建议」调用 `POST /memories/consolidate`，固定传 `dryRun: true`，按新增、更新和删除展示建议及理由。模型只能读取进入本次候选清单的生效记忆。控制台只展示预览、原记忆和提示词入口；它不发 `dryRun: false`，因为旧 API 的执行会重新向模型取方案，不能保证等于用户看到的预览（§11.8）。手动整理默认关闭，需要先在「设置」开启。

**403 的判定与文案分开。** `isForbidden`（`web/composables/useApi.ts`）是唯一的判定点，「取一条对应文案」与「置一个 forbidden 状态」都走它；句子由各页面按语义给：「需要管理员权限」（用户与组页、概览页任务卡、提示词页写操作）、「你没有权限复核这条记忆」、「你没有权限查看这条记忆的正文」、「你没有权限查看待复核队列」、「你没有权限查看这个节点」。403 显示状态或固定文案，其它失败仍显示服务端消息——服务端原文带 `auth.adminUserIds`、`需要 write（3）级别` 这类内部术语，进界面只会让人去搜文档；而存储 / IO 故障的原文正是排查依据，不该被 403 的文案盖掉。

**身份来自登录。** 控制台只有一个身份来源：浏览器里的会话。概览、监控与复核页都监听侧栏当前空间；切换空间后分别重新请求该空间的待复核摘要或队列，并用请求序号丢弃迟到响应。复核操作完成后从复核页返回概览时，概览会重新请求摘要，不复用上一空间的待复核缓存。
`web/plugins/console-identity.ts` 在应用挂载前先探测引导状态（`GET /bootstrap`
恒定 200；**不用** 404 推断，那会拿「错误」当正常信号，还会发一个登出语义的写
请求去做只读探测），再读 `sessionStorage`：

- **没有任何密码**（`needsSetup: true`，新装即如此）：整站进 `/setup`，创建第一个
  管理员后回 `/login`。这是控制台唯一一条首跑路径，单用户部署第一次打开浏览器也
  走它。
- **有账号但没有会话**（或会话已过期）：整页进 `/login?redirect=...`，登录成功用
  `POST /auth/login` 换 session token，之后每个请求带
  `Authorization: Bearer <token>`。刷新时用 `GET /auth/me` 获取当前主体、组关系和系统角色，控制台按
  `user:{uid}` / `group:{gid}` 推出候选根，再逐个用 `GET /fs/tree` 验证可读；读不到的根
  （组根未预置）不列出来。凭据存 `sessionStorage`（刷新保留、关标签页即清），不存
  `localStorage`；收到 401 时清掉本地会话并回登录页。

**两个状态是同一条路径的两段。** `setup-required` 建完账号就变成
`unauthenticated`，登录成功就是 `ready`；`web/utils/consoleGuard.ts` 里没有按部署
形态分叉的规则。

插件是 `await` 的，所以页面渲染时身份已经确定——先渲染再补身份，页面在身份到达前发出的
请求会没有凭据。拉取失败时整页显示错误，**不猜一个默认身份**：即使回环信任会让服务端
接受不带凭据的本机请求，控制台也不在没有身份的情况下渲染页面——那会让「服务端不可达」
看起来像正常状态。侧栏底部显示**当前空间**。有多个可读根时在这里切换「个人空间」和团队；只有一个时显示名称，无可读根时显示「暂无可访问空间」。选择存 `sessionStorage`；切换后文件树、权限管理等按新空间加载，文件详情不在新根下时回 `/files`。

**跨空间查找使用「所有可访问」。** 检索默认不传 `scopes`，由服务端按当前身份展开个人空间、可读团队与直接授权的范围，结果仍逐项检查 ACL。选「当前空间」仅查侧栏选中的空间；拿到具体地址时可选择「指定地址」。团队共享内容可从团队文件树浏览；他人个人空间中单独获授权的子树不会出现在侧栏，可用「所有可访问」查找该子树内可检索的内容。

**为什么不该给控制台加 `NUXT_PUBLIC_SUBJECT`。** 那只是把登录身份换成第二处配置：
运维改 `server.subject` 时还要记得改控制台，而控制台的真实身份来自登录响应。

**任务历史与待处理队列分开查询。** `GET /tasks` 默认保留可认领队列契约，概览继续使用它；会话页传 `view=recent`，按更新时间倒序列出全部状态，`status` 过滤在 `limit` 之前执行（上限 1000，默认 100）。已完成任务保留可见，运行中或排队中继续轮询。任务接口仍只允许系统管理员；不从任务 payload 推断授权。

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

**界面文案原则**：不把提示词抄到 UI 上。开发期内部术语（page_id、digest、summary_pending）不进用户可见区域，用「基线」「待刷新」这类词。

**头像只显示当前登录用户的首字母。** 主体名是内部标识，`user:alice` → `A`；没有主体时显示 `?`。唯一出现部署身份的地方是 `/setup` 的默认用户名——那一次它就是要创建的那个账号（本机 `curl` 与 hook 插件以它发请求，控制台建同一个 ID 才不会出现「两个都是我的账号」的分裂）。表单占位符写真实输入约束（如邮箱格式 `name@example.com`、用户 ID 的字符集），不写示例人名。

**界面上不存在的元素，都是刻意删掉的。** 下面这些位置读起来像「漏了」，实际是取舍，不要按「应该有」补回去：

- 概览页与监控页的待复核卡**只请求一页 `/memories/pending`**：响应里的 `total` 与 `oldestPendingAgeSeconds` 已由服务端对完整可读队列计算，`limit=1` 不把返回数组长度冒充总数。`GET /health` 的 `memory.*` 保留为公开全库运维口径，不再用于当前空间待复核卡。
- 每张 Hook 事件卡里的「后台处理」行**并成全局一行**：后台耗时按阶段，同一份进程级快照不属于任何事件（§17.2）。
- 「模型成本累计」卡片在没配 `providers.llm.default.pricing` 时显示「未配置单价，成本不可计算」，不显示 `$0.0000`；配了单价时真实花费 0 才显示 0（§17.4）。
- 任务表与会话页**没有重试按钮**：`POST /tasks/{id}/retry` 只接受 `failed`，而 `GET /tasks` 只列可认领的任务（`pending` 或租约过期），界面上永远点不到一个能重试的行；重启会把租约过期的任务重置回排队。要重试只能走接口。
- 会话页**没有「回收记录」**：`TaskService.recover()` 在启动时把租约过期的 `running` 重置回 `pending`，只返回重置条数（`bootstrap/main.ts` 把它记进一条日志）；`task` 表不留回收历史，也没有端点返回逐条记录。控制台只能看到任务当前状态——被回收的任务重新出现在待处理里，但不显示「它是被回收的」。
- 概览页「最近任务」改名「待处理任务」，并删掉「已完成 / 失败」两个状态文案：`GET /tasks` 不返回这两种状态。
- 文件详情里**文档的 L1「概览」档删掉**：`GET /content/overview` 对 document 恒返回 `overview: null`，前端没有合成逻辑；目录的 L1 是真实的（来自摘要文件），保留。
- 记忆复核页的**「置信度」徽章删掉**：`confidence` 只出现在查询改写的结果里（§8.8），抽取产出的记忆没有这个字段，徽章从来不会显示。
- API Key 的**「最后使用」列删掉**：`api_key` 表没有使用时间列，服务端从未记录。
- ACL 界面的 `read` / `write` / `manage`、`allow` / `deny`、`inherit` / `restricted` **全部换成中文**（读取 / 写入 / 管理、允许 / 拒绝、继承父级 / 仅本节点）：服务端枚举不进用户可见区域（AGENTS §11）。

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
/metrics                  /api/v1/health
Prometheus 文本              JSON 诊断快照
机器可读、低基数               控制台与运维读
```

**为什么分两套**：Prometheus 的抓取模型要求低基数（标签组合不能爆炸），适合时序累加；`/health` 是某一刻的状态快照（积压数、最老年龄、画像格式自查），不是指标序列，也没有标签维度。把快照塞进 `/metrics` 会造出一堆没有意义的 gauge，把高基数细节塞进去又会撑爆指标库。**没有第三套聚合端点**：按记忆类型分布、冷热分桶这类全表聚合没有调用方，已删除（§17.5）。

### 17.2 延迟归因（核心）

这是回答「用 CoMem 让每个请求慢了多少」的唯一方式。

**先分清阻塞与异步**：

| 阶段 | 阻塞用户？ | 典型值 |
|---|---|---|
| Hook 进程启动（`node hook.mjs`） | **是** | 30–50ms |
| 检索（`find` / `search`） | **是** | 20–100ms |
| 注入序列化 | **是** | < 5ms |
| 写 worker 载荷（`Stop`） | **是** | 5–20ms |
| 归档 + 抽取 + 合并 + 摘要 + 经验归纳 | 否（后台） | 几秒到几十秒 |

**服务端采集与提交在 detached worker 里，不阻塞用户。** `Stop` 只写 worker 载荷并 spawn（`integrations/servers/stop.mjs` 的 `main`）；`/messages` 与 `/commit` 的 HTTP 往返都在 `detached: true` + `unref()` 的子进程里。

**单轮阻塞开销 = 进程启动 + 检索 + 序列化 + 写 worker 载荷**，典型 60–180ms。异步部分不算进去——用户没等它。

**为什么必须单独测进程启动**：hook 起一个新 Node 进程就是 30–50ms 纯开销。把它藏在「检索 20ms」后面会误导人，让人以为 CoMem 只花 20ms。

**异步阶段里嵌入是最贵的一段，所以它必须批量、必须缓存。** 归档的五个步骤（归档摘要 → 记忆抽取 → 补丁合并 → 摘要失效 → 经验归纳）由 `CommitRunner` 轮询 `task` 表、按租约认领后依次执行（`config.task.concurrency` 控制同时在跑的任务数），不计入上面那 60–180ms。`IndexObserver` 只负责派生数据的排期：节点落盘后的 `index.upsert`、权限物化、摘要失效投递，以及 `#scheduleEmbedding` 的嵌入批。**嵌入的单价不随条数摊薄**——它随 token 数线性增长，批量省下的是请求数，不是算力。本地 GPU（`Qwen3-Embedding-0.6B`，`local/bench/embedding-stage.ts`，走完整写路径 + `drain()`）实测：

| 场景 | 逐条（`maxBatchSize: 1`） | 批量（`maxBatchSize: 128`） | 请求数 |
|---|---:|---:|---:|
| 32 条文档（约 170 字/条），冷启动 | 4.62s（144ms/条） | 3.86s（121ms/条） | 32 → 2 |
| 32 条文档，预热后 | 3.89s（122ms/条） | 3.36s（105ms/条） | 32 → 2 |
| 52 条文档，冷启动 | 7.40s（142ms/条） | 6.29s（121ms/条） | 52 → 3 |
| 52 条文档，预热后 | 6.27s（121ms/条） | 5.86s（113ms/条） | 52 → 2 |
| 单条短查询（关缓存，`eval/README.md`） | 69ms p50 / 101ms p95 | — | 1 |

批量的收益是「省 14–16%（冷）或 6–14%（暖）的墙钟时间 + 把 N 次请求压成 `ceil(N / maxBatchSize)` 次」，不是「12.5ms/条」。**4.60s / 7.43s 是「逐条 + 冷启动」那一行，不是批量**——把它当成批量会得出「32 条 144ms/条」的结论，而同样 32 条文档批量（冷）是 121ms/条。文档原来的「32 条只要 400ms（12.5ms/条）」比任何一行都快 8–11 倍，不复现。**「批量比单条慢一倍」是拿文档（约 170 字）的 144ms/条去比短查询的 69ms**：两者 token 数差一个量级，不是同一件事。单条文档 168ms 里约 63ms 是写路径与 `drain()` 的固定开销，边际计算约 105ms；HTTP 往返只占 17ms/条（122 − 105）。**所以批量仍然值得做**（请求数从 32 降到 2，供应商侧的连接与限流成本随之下降），但不要指望它把延迟摊薄一个数量级：供应商的算力是主要成本，不是网络。远程供应商的单条查询嵌入是 300–900ms（`eval/README.md` 的缓存关闭路径），量级差异来自模型大小与网络，不是「每条一次往返」。所以写路径把一次合并窗口里排队的记录按 `providers.embedding.maxBatchSize` 切片：N 条记录产生 `ceil(N / maxBatchSize)` 次请求；`(model, 正文摘要)` 命中 `embedding_cache`（§8.1）时一次都不产生。两件事都不改变 `drain()` 的契约——它返回时每个排队项要么已写入 `node_embedding`，要么已降级并记了日志。

**一批失败只影响这一批。** 供应商整体不可用时这一批记录跳过（记 `warn`），其它批照常；单条坏输入（超长、非法字符，供应商回 400）则**二分重试**，把失败收敛到它自己，剩下的记录照常写入。二分不会放大请求数：供应商挂掉时熔断在 5 次连续失败后打开，`EmbeddingService.available` 转 `false`，后续子树直接跳过、不打网络。

**指标**：

```
comem_hook_overhead_seconds{event, phase}      # phase = process_start | recall | serialize | capture
comem_hook_overhead_total_seconds{event}        # 单轮合计
comem_hook_async_seconds{phase}                 # 后台部分耗时，phase = archive | extract | merge | summary | distill
```

**五段后台计时落在 `CommitPipeline` 的五个步骤上**：`archive` → `archive_summary`（生成 `archive_NNN/` 的摘要）、`extract` → `memory_extract`、`merge` → `memory_merge`、`summary` → `summary_invalidate`、`distill` → `dreamer`。阶段一（写归档目录、建任务）是请求内的同步工作，不计入后台；把它算进来会把用户等过的时间重复计一次。管线用 `phase()` 包住整段 `run`（含重试），后台任务不在请求作用域里，因此值写进进程级 `#asyncPhases`，`/metrics` 直接按阶段输出 `comem_hook_async_seconds{phase}`——**不依赖下一次 hook 上报，也不挂任何事件**。`phase` 是真维度（五个操作各记各的耗时），`event` 是假维度（同一份进程级快照会被贴到多个事件上，看起来像每个事件都有各自的后台耗时）。省略 `phase` 的管线（单测直接构造）原样执行，不记。

**报告路径**：hook 在退出前 `POST /api/v1/telemetry/hook`，带 `{event, sessionId, phases: {processStartMs, recallMs, serializeMs, captureMs}}`。服务端**按事件覆盖保存最近一次的值**（gauge），不存直方图：历史分布由 Prometheus 按抓取间隔自己算（§17.10）。

**服务端只测得到其中两个阶段。** `request_log.phases`（§17.6）落的是**单个 HTTP 请求**的阶段，不是整轮：`processStart` 是 hook 进程启动（`performance.timeOrigin`），`serialize` 是 hook 把命中格式化成注入块（`formatRecallBlock`），两者都只发生在 hook 进程里，服务端没有对应边界——**不要为了凑齐四个阶段在这里造一个**。服务端包得出边界的只有两个：

| 阶段 | 边界 | 说明 |
|---|---|---|
| `recall` | `src/api/http/routes/search.ts` 的 `/search/find` 与 `/search/search` | 包住 `SearchService` 的 `find` / `search` / `context`；`mode=context` 的上下文组装与渲染在 `SearchService.context` 内部，随它一起计时，所以这段 `recall` 偏大 |
| `capture` | `src/api/http/routes/sessions.ts` 的 `POST /sessions/{id}/messages` | 包住逐条 `SessionService.addMessage`；hook 侧「写 worker 载荷 + spawn」在客户端，不在这里 |

**记录入口只有一个：`ObservabilityService.phase(name, fn)`。** 它用 `performance.now()`（单调时钟，NTP 校时不会让它倒退），同名阶段**累加**——一次请求里 `recall` 可能跑几轮，累加保住「这一段总共花了多少」，覆盖会只留下最后一轮。不在 `withRequestScope()` 里调用时阶段被丢弃并记一条 `warn`（后台阶段是例外：它们在任务里跑，不挂在某个请求下，记进程级 gauge）。HTTP 路由之外没有别的调用点：MCP 工具不记 HTTP 阶段。

**阶段之和是下界，不是等式。** 请求里还有身份解析、路由、参数校验、请求体解析、响应编码这些没被计时的部分，所以 `sum(phases) ≤ durationMs`，差额是未归因间隙（`#attribute()` 的 `unattributedMs`）。只有阶段之和**超过**总耗时（容差 0.5ms）才记 `warn`——那说明同一段被套了两层 `phase()`，不是间隙。§20 的验收点按这个口径。

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
| `comem_http_request_duration_seconds` | Summary（`_sum` / `_count`） | 无；`telemetry.metrics.includeAccountLabel` 打开时按 `account` | 完整耗时。没有直方图桶，也就没有分位数 |
| `comem_http_requests_total` | Counter | `route, method, status` | 请求总数，TPS 用 `rate()[10s]` |
| `comem_http_requests_per_second` | Gauge | `route` | 10 秒滑窗，给不跑 Prometheus 的场景直接看 |
| `comem_http_inflight_requests` | Gauge | `route` | 当前在途请求数 |

**上表里只有 `comem_http_request_duration_seconds` 是当前实现**：v1 的 `renderMetrics()` 只输出它的 `_sum` / `_count`。`comem_http_ttfb_seconds`、`comem_http_requests_total`、`comem_http_requests_per_second`、`comem_http_inflight_requests` 都没有实现，不要照名字写 Prometheus 查询。实际指标清单见 `docs/operations.md`「`/metrics`」。

**TTFB 和总耗时什么时候不同**：JSON 响应两者相等；MCP 的 SSE 流式响应才真正体现「首事件时间」。分开测是因为流式接口的 TTFB 才是用户感知的延迟。

### 17.4 模型用量与成本

**Prometheus 的模型指标仍是进程级总量，不带 `purpose` / `provider` / `model` 标签**：

```
comem_llm_tokens_total{kind="prompt"|"completion"}   # 进程启动以来的累计
comem_llm_cost_usd_total                              # 无标签；只在配了单价时输出
comem_llm_pricing_configured                          # 0 = 没配单价，成本不可计算
```

数据源是 `LlmService` 的进程级累加器（`LlmCallStats`：`calls` / `promptTokens` / `completionTokens` / `costUsd` / `truncated` / `failed`）。它继续服务 Prometheus 的低基数总量，进程重启清零。

**逐次调用的用途与时间线在 `llm_call_log`。** `generate` 与 `generateJson` 都接受
`purpose`；生产调用点使用 `query_rewrite` / `recall_compression` /
`directory_summary` / `archive_summary` / `working_memory` / `memory_extract` /
`dreamer` / `config_probe`。一行表示一次**逻辑调用**（覆盖内部重试），记录模型、开始/结束
时间、总耗时、尝试次数、成功/稳定错误码、prompt/completion token 与单价可用时的美元成本。
不记录 prompt、system message、模型输出正文、API Key 或供应商原始错误。记录写入失败只记
`warn`，不能让业务模型调用失败。

**结构化输出现在也有精确 usage。** `LlmProvider.completeJson` 返回对象时同时返回
`usage` 与 `finishReason`，因此记忆抽取、查询改写等 JSON 调用的 token 与成本不再漏记。
AI SDK 的结构化解析异常也带回了供应商 usage。一次逻辑调用发生重试时，只有**每次尝试**
都报告 usage，记录才把各次 token 相加；任一次缺少 usage 时整行的 token 与成本都是 `null`，
不能把末次部分值冒充整个逻辑调用的总量。`attempts` 始终记录实际供应商尝试数，界面必须
与 token 一起展示。供应商明确报告 0 时才写 `0`。没配 pricing 时 `costUsd` 为 `null`。
`/metrics` 的进程级累加器仍只累计拿到结果对象的尝试，因此是下界；未配单价时不输出
`comem_llm_cost_usd_total` 样本并输出 `comem_llm_pricing_configured 0`。

**查询端点按认证主体隔离。** `GET /api/v1/telemetry/llm-calls?limit=50&cursor=...`
只查询 `subject = requestContext.subject`，普通用户可读自己的记录；客户端不能指定主体，
记录主体为 `NULL` 的后台孤立调用不会出现在该端点。排序为 `started_at DESC, id DESC`，
游标绑定最后一条的 `(startedAt, id)`。默认 50、最大 100。HTTP 内发起的调用通过
`AsyncLocalStorage` 关联 `requestId`；已有会话参数时关联 `sessionId`。后台归档从会话 URI
补 owner subject 与 `sessionId`，目录摘要至少补 owner subject。异步目录摘要没有请求上下文，
所以 `requestId` 为 `null`。

**保留沿用 `telemetry.requestLog`。** `telemetry.requestLog.enabled` 关闭后停止写新的
HTTP 请求与 LLM 调用记录；`retainDays` / `retainRows` 同时裁剪两张表。调度器每轮各调用一次
`prune`，调度器关闭时启动期各裁一次。查询端点仍可读取尚未被裁掉的旧记录。

### 17.5 记忆健康度与热度

**没有按身份的聚合端点。** `src/api/http/routes/` 里没有 `stats.ts`，也没有 `GET /stats/memories`：按记忆类型分布、冷热分桶、最老记忆年龄都需要全表聚合，而调用方只有控制台的「监控」页——它现在读 `GET /health`。

`GET /health` 的 `memory` 与 `summary` 两段是治理视图：`memory.pendingReview`（全库待复核）、`memory.orphanTasks`（租约过期的任务）、`memory.oldestPendingAgeSeconds`（全库最老待复核）、`summary.pendingDirs` / `summary.degradedDirs`（待刷新 / 降级摘要的目录数）、`memory.profileFormat`（画像格式自查，§11.1）。全库规模看 `index.totalNodes`。这些字段不带请求空间或逐条 ACL 语义；控制台当前空间的待复核摘要走 `GET /memories/pending`。分类分布、冷热分桶、最老记忆年龄没有出口；要看就用 `sqlite3` 查 `_meta/comem.sqlite` 的 `node` 表。

**`GET /api/v1/stats/sessions/{id}` 未实现。** `src/api/http/routes/` 里没有单会话视图的路由。下面的 JSON 保留的是需求形状（归档次数、消息数、抽取增删改、召回与提交耗时、Hook 开销），不是可调用的接口：

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

它依赖按会话聚合请求记录与请求阶段耗时，而 `request_log` 没有会话列——`phases` 现在有数据（§17.2：`recall` 在 `/search/find`、`/search/search`，`capture` 在 `POST /sessions/{id}/messages`），但请求行不带 `sessionId`，阶段也只在部分路由上存在。所以 `latency.recallP50` / `latency.commitP50` / `overhead` 这三组字段仍然没有数据来源；要落地，先让请求带上会话标识，再定聚合口径（P50 还得先决定取哪个时间窗口的样本）。已知限制同步写在 `docs/operations.md`。

**热度参与排序，默认关闭。** `telemetry.hotness.weight` 为 0（默认）时整条热度路径不执行，命中里的 `hotness` 恒为 `null`（「没算」），与「算出来是 0」（从没被访问过）不是一回事。非 0 时是乘性加权：`finalScore = score × (1 + weight × hotness)`，`hotness ∈ [0, 1]`，`weight = 1` 时最高把相关性分翻倍。

**算法**：`sigmoid(log1p(accessCount)) × exp(-ln2 × ageDays / halfLifeDays)`，`accessCount` 是记忆被检索命中并注入、或按 URI 读取的次数，半衰期取 `telemetry.hotness.halfLifeHours`（默认 168 小时 = 一周）。实现在 `domain/hotness.ts` 的 `hotnessScore`；读的是 `node.access_count` / `node.last_accessed_at`，不碰 `updated_at`（访问不是修改）。

**`weight = 0` 不等于不记访问。** 交付给调用方的检索结果（`find` / `search` 返回的命中列表，或 `mode=context` 注入的条目）与按 URI 读取仍然写 `node.access_count` / `node.last_accessed_at`（§11.7 的滑动窗口依赖后者，它没有开关）。所以默认部署下这两列反映真实的检索命中，只是不参与排序。

为什么是乘性而不是加性：RRF 融合分是 `0.016–0.033` 量级，热度是 `[0, 1]`。加法会让热度完全压过相关性——一条只被单路命中、但刚被读过几十次的记忆，加 `0.3` 就排到双路第一前面。乘性保住「先按相关性排序，热度只在同档次内做区分」这条语义。

为什么不用归一化后线性混合：RRF 分数没有绝对尺度，归一化等于每次查询按当前结果集重新缩放，多返回一条结果就会改变所有分数，「为什么这条排第一」无法复现。乘性不依赖结果集。

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
  "errorCode": null
}
```

**只有完整耗时，没有 TTFB 与响应体大小。** `request_log` 没有 `ttfb_ms` / `response_bytes` 列（`0001_init.sql`）：TTFB 只在流式响应上与总耗时不同，v1 不采这个点；响应体大小也不落库。

**JSON 里的键是展示用的短名，落库映射见建表注释**：`at` → `created_at`、`route` → `path`、`status` → `status_code`、`userId` → `subject`。`phases` 列只在请求作用域里调过 `phase()` 时非空：当前落地的是 `recall`（`/search/find`、`/search/search`）与 `capture`（`POST /sessions/{id}/messages`），§17.2 的 `processStart` / `serialize` 发生在 hook 进程里，不会出现在这一列。没有任何阶段边界的路由（`/health`、`/sessions` 等）仍然写 NULL——**NULL 表示「没计时」，不是「花了 0ms」**。阶段之和是总耗时的下界，差额是未归因间隙（§17.2）。

**保留策略**：默认 7 天或 10 万条，先到先删，两条规则在同一个事务里。裁剪挂在后台调度器上，**每轮（30 秒）执行一次**；删除行数进轮次摘要的 `requestLogPruned`，有删除时记一条 `info`（带条数），失败只记 `error`、下一轮重试（§10.7）。四个维护开关全关、调度器不启动时，容器构造期裁一次——那是该配置下唯一的裁剪路径。

**仓储的 `prune` 先 `COUNT(*)`，超限时按 `created_at` 升序只删溢出的行**，走 `request_log_created` 覆盖索引；旧的 `id NOT IN (SELECT … LIMIT ?)` 在 10 万行上即使一行都不删也要约 75 ms，而它现在每 30 秒被调一次，稳态成本约 1 ms。表上只保留 `request_log_created`（按天数的 `WHERE created_at < ?` 与按行数的 `ORDER BY created_at` 都靠它）；`status_code` / `request_id` / `subject` 三个索引已由 `0006` 删除——没有查询用到它们，只为不存在的读页付写入放大。

**这张表当前只写不读。** `src/api/http/routes/` 里没有 `GET /stats/requests`，控制台也没有请求明细页；`/metrics` 与 `GET /health` 都不查它。它是给运维用 `sqlite3` 查的诊断归档，不是控制台的数据源。删掉那三个索引减少的是写放大、页缓存压力与库体积，**不是请求延迟**：`recordRequest` 每行一个独立事务，这条写入路径的真实成本在 commit / fsync 上，不在索引维护上。

**采样**：默认全量。高频写入场景可开采样（`telemetry.requestLog.sampleRate`），但**错误请求永远全量记录**。

**LLM 调用记录不采样。** `llm_call_log` 默认按逻辑调用全量写入，因为采样会让
“最近一次为什么慢/为什么失败”在最需要时缺失。它的体积由时间与行数上限控制；运维关闭
`telemetry.requestLog.enabled` 时两张诊断表都停止新增。`sampleRate` 只作用于 HTTP
`request_log`，不作用于 LLM 调用。

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
| `status` | `ok` / `degraded`。判定收在 `src/api/health-status.ts`，两个入口共用；没有第三种状态 |
| `subject` | 服务图绑定的主体（`server.subject`），也是回环信任使用的身份（§12.7） |
| `scopes` | 该主体可寻址且可读的根，个人根在前。为空 = 没有可访问的命名空间 |
| `index.totalNodes` | `node` 表全量条数（`GET /health`），不是当前身份可见的条数 |
| `queue` | `{pending, processing}` |
| `summary.degraded` | 是否降级到规则摘要 |
| `summary.pendingDirs` | 待刷新目录数 |
| `retrieval.engine` | 仅 `GET /health`：实际生效的检索策略（`fts5` / `vector` / `hybrid`）；控制台据此显示「关键词匹配 / 向量检索 / 混合检索」 |
| `rerank.configured` | 是否配了重排（`retrieval.rerank.enabled` + `providers.rerank.type: http`） |
| `rerank.degraded` | 最近一次重排调用是否失败（已退回融合分） |
| `rerank.failures` | 进程启动以来重排失败的累计次数（间歇性失败看得出来） |
| `rerank.lastFailure` | 最近一次失败的 `reason` / `durationMs` / `topN`；从未失败时为 `null` |
| `overhead.p50Ms` | 最近 5 分钟阻塞开销中位数 |
| `memory.profileFormat` | 仅 `GET /health`：画像格式自查（§11.1），`checked` / `invalid` / `violations` / `truncated`；`truncated` 为真时前三个计数是下界 |
| `version` | 服务版本 |

**`subject` / `scopes` 两边同义。** MCP 的 `health` 工具与服务端 `GET /health` 返回同一组字段：同一个服务，两种接口，语义相同。**索引条数是唯一的例外**：`GET /health` 的 `index.totalNodes` 是 `node` 表全量（运维要知道库有多大），MCP `health` 的 `index.visibleNodes` 是权限与状态过滤后当前身份**可检索**的条数（`glob` 与四个检索面共用 `status = 'active'` 谓词，归档 / 待复核节点不计入；工具不能绕过权限数别人的节点）。两者**不同名**，因为它们是两个不同的问题；同名会让「库有 19 条、我能看到 12 条」被误读成同一个数在漂移。`scopes` 的算法是「个人根 + 可读的组根」，与 MCP 的 `readScopes` 一致；`/health` 没有请求身份，所以只报告**绑定主体**读得到的根。

**`/health` 是公开端点，因此会暴露部署身份。** 它不认证（§17.1），`subject` 是 `user:alice` 这类部署标识。回环信任让本机调用本来就被当成绑定主体，这个值不是秘密；跨网络的调用方要拿它得先登录。

**`degraded` 的判定**：模型不可用且开了规则降级、存在降级摘要的目录、最近一次重排调用失败（已退回融合分），或 MCP 侧的索引计数失败。降级必须可见——静默降级等于骗人。重排的降级状态与摘要走同一个模式，不另造一套：`rerank.degraded` 为真时 `status` 也是 `degraded`；`rerank.failures` 是累计值，`lastFailure` 在成功一次后清空，两者分别回答「历史上失败过几次」与「现在还在不在跑」。

**「一项统计失败」不算服务故障。** MCP 的 `health` 数不到索引时记 `degraded`，并把 `index.visibleNodes` 写成 `unavailable`（不是 `0`）：`0` 会被读成「库里什么都没有」。HTTP 侧拿不到 `ObservabilityService.health()` 时直接返回 500 错误封套。两种返回形态不同，但都不把「统计失败」升级成第三种 `status`——那会让监控里「服务坏了」与「一项计数失败」变成同一件事。

**MCP 工具侧的降级另有一条出口。** 向量与重排在单次工具调用里降级时，`find` / `search` / `rule_search` 直接把 `Degraded:` 行写进本次结果（§13.3），调用方当场就知道这批结果缺了哪一路，不必等上线采样 `/health`。两条出口不矛盾：`Degraded` 行回答「这次结果缺了什么」，`rerank.degraded` 回答「服务现在是否健康」。重排失败会同时出现在两边，恢复后行消失、`rerank.degraded` 也跟着变回 `false`（`services/retrieval/rerank.ts` 在成功一次后清空 `#lastFailure`）；向量不可用只在结果行里出现，`/health` 没有对应的嵌入字段。

### 17.10 控制台「监控」页

控制台「监控」页（§16），数据源是 `GET /health`、`GET /memories/pending`、
`GET /metrics` 与 `GET /telemetry/llm-calls`：

页面可见时每 3 秒刷新当前账号个人根的 `/sessions` 与模型调用第一页，隐藏时暂停；
后台刷新并入新记录并保留用户已加载的更早分页。Hermes 捕获只认个人根里已完成提交的
`hermes-*` 会话，模型表只统计 CoMem 内部调用，不包含 Hermes 回答生成。

| 区块 | 内容 |
|---|---|
| 记忆健康度 | 四张卡：全局索引节点数、待处理任务与摘要降级目录数读 `GET /health`；待复核条数与最老一条的年龄读当前空间的 `GET /memories/pending` 摘要。服务端先按 scope 与逐条 ACL 过滤完整队列，再计算 `total` / `oldestPendingAgeSeconds`；`limit=1` 只限制返回数组，不影响统计 |
| 开销归因 | 每个 Hook 事件**最近一轮**的四阶段阻塞耗时；后台异步耗时另起一行，**按阶段不按事件** |
| 吞吐与用量 | 进程启动以来的请求数、平均耗时、prompt / completion token、成本累计（未配单价时卡片显示「未配置单价，成本不可计算」而不是 `$0`） |
| 最近的模型调用 | 当前认证主体自己的最近记录：用途、模型、开始时间、耗时、输入/输出/合计 token、成本、状态、错误码、`requestId` 与 `sessionId`；cursor 继续加载更早记录 |

**只有「最近一次」，没有历史分布。** `recordHookOverhead` 把每次上报按事件覆盖进 `Map`（`comem_hook_overhead_seconds` 是 gauge，不是直方图），所以这一页给不出 P50/P95，也不给阶段饼图历史。历史分布要靠 Prometheus 按抓取间隔自己算，见 `src/services/observability.ts` 的同名注释。

**吞吐只有平均值。** `comem_http_request_duration_seconds` 是 summary 形态（`_sum` / `_count`），平均耗时 = `_sum / _count`；P95 需要直方图桶，v1 没有桶边界也就不报分位数。**没有 TPS 曲线与错误率**：`comem_http_requests_total` / `comem_http_requests_per_second` / `comem_http_inflight_requests` / `comem_http_ttfb_seconds` 都没有实现（清单见 `docs/operations.md`「`/metrics`」）。

**模型调用明细按主体隔离。** 普通用户看自己的逐次调用，不提供管理员跨用户列表；这与
`/metrics` 的进程级累计分开。页面不能拿累计数反推明细，也不能把空 `items` 解释成
“Hermes 未接入”：Hermes 可能以另一个回环主体写入记录。完整字段和限制见
`local/notes/hermes-monitor-audit/contract-response.md`。

**HTTP 请求明细仍没有查询端点。** `request_log` 只落 SQLite；本次新增的是
`llm_call_log` 读取面，不把 HTTP 行、任务行或模型调用混成一张“最近请求”。

**不画不存在的指标。** 每张卡片由数据是否存在决定：一张 TTFB 恒为 0 的图会让人以为「首字节很快」，而实际是「没测」。

### 17.11 不做

- **不部署 Prometheus + Grafana**：`/metrics` 输出标准格式，接不接是运维的事。
- **不做 OpenTelemetry 分布式追踪**：单进程服务，`requestId` 串起来就够。
- **不做日志聚合**（ELK/Loki）：`error.log` + `grep` 够用。
- **不做告警**：单实例自托管部署没有值班表，告警没有接收方。`/metrics` 与 `/health` 提供查询接口，由部署方接入自己的监控。

## 18. 配置

```yaml
# 数据根。留空表示按运行形态推导（见 6.5），容器里由镜像钉死为 /var/lib/comem
dataDir: ""

providers:
  llm:
    default:
      type: openai-compatible      # openai-compatible | anthropic | disabled
      # 占位值：api.example.com 是 IANA 保留域名（RFC 2606），永远不可达。
      # 保持它启动时会打 warn；不需要模型时把 type 改成 disabled 并把
      # summary.generator 改成 rule（否则启动期交叉校验失败）。
      baseUrl: https://api.example.com/v1
      model: gpt-4o-mini
      # 空串 = 没有密钥：能启动，调用时失败。接真实模型时填 key，或用
      # COMEM_PROVIDERS_LLM_DEFAULT_API_KEY 覆盖。
      apiKey: ""
      maxTokens: 32768
      timeoutSeconds: 120
      pricing:                  # 用于成本换算，按 1M token 计
        inputPerMillion: 0.15
        outputPerMillion: 0.60
  rerank:
    type: disabled            # http | disabled；http 走 Cohere / Jina 兼容的 POST /rerank
    baseUrl: ""               # 如 https://api.jina.ai/v1
    model: BAAI/bge-reranker-v2-m3
    apiKey: ""
    timeoutSeconds: 30        # 本地 0.6B 重排 50 条 8.05s p50 / 9.35s p95，10s 会静默降级
    topN: 50                  # 送去重排的候选条数上限

summary:
  generator: llm          # llm | rule
  abstractMaxChars: 256
  overviewMaxChars: 4000

retrieval:
  # fts5 | vector | hybrid
  #   fts5   关键词检索（BM25 + 中文 unigram 分词），零依赖
  #   vector 语义检索，需要 providers.embedding
  #   hybrid 并行跑两者再按 RRF 融合
  engine: hybrid
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
    compressRecall: true  # 配置了模型时，自动尝试压缩
    compressRecallTimeoutMs: 5000 # 毫秒，受请求剩余时间约束
  rerank:
    enabled: false        # 默认关；关掉时 find 路径不调用重排模型
    keepTopN: 0           # 重排后保留前 N 条；0 = 只重排不截断

session:
  autoCommit:
    enabled: true
    pendingTokenThreshold: 150000
    messageCountThreshold: 100
    minCommitIntervalSeconds: 0
    idleTimeoutSeconds: 0     # 0 = 关；开了需要服务端扫描器
    keepRecentCount: 0
  # 会话过期（与 autoCommit.idleTimeoutSeconds 是两件事：那个是「空闲多久该提交」，
  # 这个是「空闲多久该归档 / 删除」）。默认全关：删数据必须是显式选择。
  expiry:
    idleTimeoutSeconds: 0     # 空闲多久后归档。0 = 关
    action: archive           # archive | delete。默认归档——删除是不可逆的

memory:
  reviewRequired:
    - experiences
    - rules
  workingMemory:
    enabled: false        # 开它会多一次 LLM 调用。没有可用 LLM 时启动失败（没有规则生成器，不能降级）
  # 记忆的 TTL。两段式：先软归档（status = archived），归档满 retentionDays 天再物理删除。
  ttl:
    defaultDays: 0        # 滑动窗口：最后一次使用后多少天过期。0 = 永不过期（默认）
    sweepBatchSize: 100   # 每轮最多清扫多少条，防止一次清太多把库锁住
    retentionDays: 0      # 归档后保留多少天再物理删除。0 = 永不物理删除（默认）
  # Dreamer 手动整理（§11.8），可能删除记忆，需显式开启。
  dreamer:
    manualConsolidation: false
    maxIterations: 10     # 探索轮次上限；到上限还没给出操作就整次失败

acl:
  groupDefaultLevel: write   # write | read

server:
  host: 127.0.0.1
  port: 1933
  # 回环信任使用的身份：不带凭据的本机请求被认证成它（§12.7）。
  # 默认 user:local 只是为了让 pnpm dev 开箱即用；生产部署应显式配置。
  subject: user:local

auth:
  # 认证恒开：控制台永远登录，每个请求带 Authorization: Bearer <凭据>。
  # trustLoopback 是回环信任，不是第二个模式；只有 server.host 是回环地址时
  # 才允许打开（否则启动期失败）。容器部署必须设成 false。
  trustLoopback: true

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

**控制台写的是第二份配置文件。** 服务端配置只在启动时读一次，没有热重载（没有
`SIGHUP`、没有 `fs.watch`）。控制台把修改写到
`{dataDir}/_meta/config.override.yaml`，优先级是：

```
环境变量 COMEM_* > 覆盖文件 > config.yaml > 内置默认值
```

加载是两阶段的：`dataDir` 本身在配置里，覆盖文件的位置又由它决定，所以先合并
`config.yaml` + 环境变量 + 默认值、只解析出 `dataDir`，再读覆盖文件并合并进**文件
层**（仍在环境变量之下），最后完整 `safeParse` 一次。合并是深合并。覆盖文件不允许
写 `dataDir`（改它等于换库）；未知键（zod 默认会剥掉）与类型错误都在启动期失败，
错误消息带覆盖文件路径与字段。

三个端点都只给系统管理员（`auth.adminUserIds` + 引导管理员）：

| 端点 | 行为 |
|---|---|
| `GET /api/v1/config` | 86 个叶子，每项带 `path` / `value` / `source`（`default` / `file` / `override` / `env`）/ `envName` / `group` / `editable`；顶层 `overridePath` / `overrideWritable`。密钥类只回 `configured` 与 `masked`（末 4 位），`value` 是 `null` |
| `PATCH /api/v1/config` | 写覆盖文件。先完整校验，合法才原子写（临时文件 + `rename`，`0600`）；回 `restartRequired: true` |
| `POST /api/v1/config/test` | 接收 `target: llm/embedding/rerank` 与可选 `values` 草稿；无草稿测运行配置，有草稿按配置优先级合并磁盘覆盖与表单，临时构造供应商，不保存、不热更新、不建索引。LLM 发短 completion，草稿 embedding 检测实际维度，rerank 发测试请求；错误返回类型与排查方向，不透传供应商原文 |

**明文永不出现在响应里。** `apiKey` / `auth.sessionSecret` 只回 `configured` 与
`masked`（`****abcd`）；`apiKey` 写空串等于清除，不写等于不改。`dataDir`、
`auth.sessionSecret`、`auth.adminUserIds`、`auth.trustLoopback`、`server.host`、
`server.port`、`logging.file`、`ingest.paths.*`、`task.*` 除了 `editable: false`
之外，`value` 也置 `null` 并附 `reason`——只靠 `editable` 仍然是「值在响应里，
只是看起来不可写」。`retrieval.queryFilters` 可见但不可写（非法正则没有启动期
校验）。写入不改变运行中的配置；「保存成功」与「已经生效」在控制台上必须分开。

**`server.subject` 是回环信任使用的身份，不是认证配置。** `auth.trustLoopback` 打开时，来源是回环地址、又没有带凭据的请求被认证成它；`Authorizer` 收的是每请求的 `principals`，这条路径只展开「绑定的那个用户 + 它加入的组」+ `user:*`（`src/bootstrap/container/api.ts` 的 `resolveBoundSubject`）。带凭据的请求每个独立求权（§12.7）。默认 `user:local` 只服务于 `pnpm dev` 的桌面形态；生产部署要显式写成实际的用户（如 `user:alice`）。格式校验在 `loadConfig` 里做（`user:{id}` / `group:{id}`，id 与用户目录同一套字符集），非法值在启动时抛 `INVALID_ARGUMENT`，不会拖到第一个请求。`group:{gid}` 能通过格式校验，但绑定身份只接受 `user` 主体，`createContainer` 会以 `INVALID_ARGUMENT` 拒绝——组永远不能当认证主体。

**控制台不读这个值。** 它的身份来自登录响应；`GET /bootstrap` 只回 `boundSubject` 作为 `/setup` 的默认用户名（§16）。给控制台加 `NUXT_PUBLIC_SUBJECT` 只是把配置复制一份，两边迟早不一致。

**`type` 决定用哪个 AI SDK provider。** 写 `openai-compatible` 走 `@ai-sdk/openai-compatible`，写 `anthropic` 走 `@ai-sdk/anthropic`。换供应商只改配置，不改代码。

**`providers.embedding.cache` 默认开。** 缓存的是 `(model, 正文摘要) → 向量`，命中就不打供应商。读失败 / 写失败都降级成「没命中」，生产写入路径不受影响（§7 的同一原则）。`enabled: false` 只对「每次都要拿新向量」的调试有意义；`maxEntries` 默认 20,000，淘汰策略与失效场景见 §8.1。

**`providers.embedding` 与 `providers.rerank` 都有自己的 `type`，默认 `disabled`。** 未配置的供应商不产生网络调用。默认 `retrieval.engine: hybrid` 在 embedding 尚未配置时允许服务启动，以便从控制台完成设置；管理、文件与会话归档可用，语义检索请求返回 `PROVIDER_UNAVAILABLE`（HTTP 503，原因 `embedding_not_configured`），健康检查提示待配置。显式选择 `fts5` 可进行离线关键词检索。`retrieval.rerank.enabled` 为 `true` 而 `providers.rerank.type` 仍是 `disabled` 时，`loadConfig` 继续抛 `INVALID_ARGUMENT`，避免重排配置无效。

**重排的实际语义。** `retrieval.rerank.enabled` 打开后，`find` / `search` / `context` 在融合（或单引擎排序）之后、热度加权之前调用重排模型：

- **候选文本摘要优先、正文兜底。** `SearchHit.abstract` 在索引里就有，取值不花钱；`abstract` 为空（存量记忆、非记忆文件）时读正文前 **512 个字符**。不兜底时空文本候选会被 `applyRerank` 全部跳过——重排看起来开着，实际一个候选都没送模型，只多了一次延迟。512 的来源：重排模型的输入上限是 32k token，但重排只判断相关性，按摘要量级（L0 预算 256 的两倍）取足够。
- **记忆写入时把 L0 摘要写进 frontmatter 的 `summary`**，`IndexObserver` 把它当 `abstract` 索引。新记忆因此零 I/O 就能重排；存量记忆走正文兜底，不需要 reindex 回填。
- **层级先验在重排后保留。** 重排把相关性分换成模型分，但层级是**文档先验**（摘要经过压缩，模型从文本本身看不出出处）。先验按符号保序地乘回模型分：非负分乘权重、负分除以权重（模型分未归一化时直接乘会把负分惩罚得更狠，把先验反过来）。`weight = 1` 时是恒等变换。
- **全部候选都没有可用文本时不发请求。** 模型对空串打不出有意义的分数，一次没有输入的调用只花延迟预算。
- **`providers.rerank.topN` 是送去重排的条数上限。** 开启重排时候选集放宽到 `max(limit, topN)`，否则「融合排第 20 但最相关」的候选永远上不来；关闭时 `candidateLimit === limit`。
- **`retrieval.rerank.keepTopN` 在重排之后截断**（`0` = 只重排不截断）。
- **分数未归一化、可以是负数。** `jina/jina-reranker-v3` 的 `relevance_score` 没有约定值域，不要 clamp 到 `[0, 1]`，直接按原值降序。
- **顺序是「先重排、再按热度乘性加权」。** 重排是相关性判断，热度是相关性同档内的微调；反过来会让「最近访问过」压过「更相关」。
- **失败全部兜底，但降级可见。** 模型调用抛错时整批退化成融合分，只记 `warn`——重排是质量增强，不能让检索失败。warn 里带 `reason`（`timeout` / `http_5xx` / `network` / `other`）、`durationMs` 与 `topN`；最近一次失败同时写进 `GET /health` 的 `rerank.degraded`（成功一次即复位，`rerank.failures` 保留累计次数）。**默认 `timeoutSeconds: 30` 来自实测**：本地 0.6B 重排 50 条 8.05s p50 / 9.35s p95，10 秒会让超过一半的查询在返回前被中止、退回融合分，而用户以为用了重排。

**`telemetry.metrics.enabled` 与 `includeAccountLabel` 真的生效。** 前者为 `false` 时 `GET /metrics` 返回 404 并说明「指标已关闭」；后者为 `true` 时 `comem_http_request_duration_seconds` 的样本带 `account` 标签（关闭时是全局汇总，两种形态不能混着输出）。

**`telemetry.requestLog.retainDays` / `retainRows` 由后台调度器每轮执行。** 调度器不启动（四个维护开关全关）时，容器构造期裁一次，这是该配置下唯一的裁剪路径。仓储的 `prune` 先数再删，稳态成本约 1 ms（§17.6）。

**`session.autoCommit.*` / `session.expiry.*` / `memory.ttl.*` 由后台调度器消费（§10.7、§11.7）。** 调度器每 30 秒扫一遍会话。**四个开关全关时不起定时器**：`session.autoCommit.enabled === false` 且 `session.expiry.idleTimeoutSeconds === 0` 且 `memory.ttl.defaultDays === 0` 且 `memory.ttl.retentionDays === 0`。`memory.ttl.defaultDays` 在清扫时与 `max(node.updated_at, node.last_accessed_at)` 比较（滑动窗口，§11.7），只对 `context_type = 'memory'` 生效——资源不会被套上记忆的存活时间。

**检索参数只留 `retrieval.engine` 与 `retrieval.rerank`。** 查询扩展由
`search` 的意图分析承担（§8.4），没有独立的召回模式配置；需要更细的召回控制时再加配置。

**并发控制。** SQLite 开 `PRAGMA journal_mode=WAL` + `PRAGMA busy_timeout=5000`，允许并发读、单写者。写事务统一走一个 `withWriteTransaction()` 包装，超过 `busy_timeout` 抛 `CONFLICT` 由任务层重试。这是 SQLite 的标准用法，不需要额外的写队列。

**路径锁的单元是「一次读改写」，不是「一次写」。** 锁的存在意义是让「读正文 → 应用
修改 → 写回」不被别人插进来；只锁写等于让两个写者各自基于同一份旧内容构造新内容，
后写者的结果覆盖先写者——并发丢更新。所以下面三处的锁都包住整个读改写，而**不是**
在写方法内部加一把了事。

| 数据 | 锁 | 覆盖范围 | 谁持有 |
|---|---|---|---|
| 记忆文件 `memories/**` | `exact(uri)` | `upsertMemory` / `approve` / `reject` / `remove` 的读 → 序列化 → 写 | `MemoryService` 自己 |
| 会话元数据 `sessions/sess_xxx/.meta.json` | `tree(sessionUri)` | `archive()` 的读 → 写；与 `addMessage` / `commitPhase1` 同一把 | `SessionService` |
| 正文文件（`write` / `edit`） | `exact(uri)` | `write` 的 `exists` → 写；`edit` 的读 → 打补丁 → 写 | `FileSystemService` |

**记忆写入是字段级合并。** `upsertMemory` 只对自己拿到的字段负责，没传的字段保留
磁盘上的值。整份替换时，调用方（`memory_merge` 步骤、记忆合并）那份陈旧的字段集
会把并发写者的新值抹掉；合并之后两个写者的结果按字段收敛，最后写者赢。

**字段级合并只保护「不同字段」，补丁必须在锁内应用。** `profile` 只有一个
`content` 字段，两个并发写者各带一份基于旧正文算出的 `content` 时，字段级合并
救不了它——后写者仍然覆盖先写者。所以 `upsertMemory` 的第三个参数除了「最终值」
还接受 `{ uri, update }`：

```ts
await memory.upsertMemory(scope, schema, {
  uri,
  update: (current) => applyOperations(current, operations).value,  // 锁内执行
});
```

`update` 在 `exact(uri)` 锁内拿到磁盘上的**最新**字段，返回要写的字段；返回 `null`
表示没有可写的字段（例如补丁一条都没命中），此时不落盘（否则只会白改一次
`updated_at`、把已复核的记忆打回 `pending`），结果的 `written` 为 `false`。

URI 由调用方给出，不是服务渲染的：`update` 的输入依赖磁盘内容，渲染路径只能发生
在读之后，而锁的键就是路径，两者不能同时由服务推出。写盘前服务会用 identity 字段
重渲染一次并比对，补丁改掉 identity（如 `name`）时抛 `INVALID_ARGUMENT`——那会把
结果写进另一个文件，目标文件里只剩半个结果。

并发补丁的语义是**串行化**，不是合并、也不是报冲突：第 2 条补丁在第一条写回后的
正文上匹配。两条补丁改同一段文本时，后一条的 SEARCH 可能仍然命中（各取所需），也
可能因为正文已被改掉而落空；落空按 `patch_not_found` 记进
`memory_diff.json` 的 `skippedOperations`，不做模糊匹配，也不回滚已应用的那条。
`applyOperations` 抛错时写盘不会开始，锁由 `withLock` 的 `finally` 释放。

**锁不可重入。** `PathLockManager` 是文件锁，同一进程内按锁路径排队：持有
`exact(uri)` 时再拿同一把锁会等自己，5 秒后抛 `CONFLICT`。所以「锁归谁」只有一
个答案：锁在 `MemoryService` 里，一条记忆一把 `exact` 锁；记忆合并逐条调用它，不自己
加锁。不用 CAS（`expectedDigest`）的原因：CAS 需要每个调用方写重试循环，而重试会重放
「读 → 模型决策 → 写」里不可重放的那一段（模型已经把这次操作的正文给出去了）。

**新路径的锁要先建目录。** 锁文件与目标同目录，父目录不存在时没有地方放锁文件。
写者传 `createParentDirectory`（读者不传，读一个不存在的路径不该造目录）：两个并发
写者同时新建同一个记忆文件时，这个窗口里「同一时刻只有一个写者」本来不成立。

### 18.1 提示词

提示词的静态骨架在仓库的 `prompts/*.md`，动态部分由 `services/prompts/*.ts` 渲染成
字符串后用 `{{name}}` 注入。存储是两层：

内置提示词共十条，按业务链路分为五对：抽取、经验归纳、记忆整理、摘要与查询重写的
系统 / 用户消息。控制台按这个顺序展示；`memory.dreamer.maxIterations` 等运行
参数通过变量进入模板，默认模板与覆盖都不需要复制代码里的配置值。

| 层 | 位置 | 谁改 | 优先级 |
|---|---|---|---|
| 默认 | `prompts/{id}.md` | 改代码（进 review、可 diff） | 低 |
| 覆盖 | `prompt_override` 表（`0001_init.sql`） | 控制台 | 高 |

**为什么默认值不放数据库。** 默认值是产品行为的一部分，要跟代码一起 review、一起 diff、
一起回滚。

**为什么覆盖不放仓库文件。** 容器只读挂载、多副本部署、`git status` 被污染——三种场景下
「服务端改仓库文件」都不成立。数据库覆盖是标准做法，恢复默认 = 删掉那一行。

**版本漂移。** 覆盖行记下保存时默认模板的摘要（`base_digest`）。新版本改过默认值之后
摘要就对不上，接口返回 `stale: true`，控制台显示「默认值已更新」——覆盖仍然生效，但它
基于的是旧版本的默认值。没有这个字段，用户的覆盖会**静默盖住**新的默认值，而唯一的
证据是「模型表现变了」，那时已经无法归因。

**校验在 `domain/prompt.ts`，三个条件都抛错**：模板语法错误（`{{` 没有配对的变量名）、
引用了定义外的变量（拼写错误）、模板需要的变量没有传。第三条是「代码少传了」的失败——
渲染成 `{{pages}}` 字面量时模型会把它当正文，而错误只会在模型的输出里出现。

**渲染器是进程级绑定。** 提示词链路的调用点有五个（`services/retrieval/intent.ts`、
`services/summary.ts`、`services/commit/steps/memory-extract.ts`、
`services/dreamer/archive-prompt.ts`、`services/dreamer/prompt.ts`，
每处渲染一对系统 / 用户提示词），这些文件不在本 wave 的文件所有权内，而
`REWRITE_SYSTEM_PROMPT` 在 `retrieval/intent.ts` 里是一个**值**（`system: REWRITE_SYSTEM_PROMPT`），
没法通过参数注入。数据库覆盖只能通过 `services/prompts/registry.ts` 的模块级绑定进入
渲染路径。**这是为「不改别人的文件」付的代价**：下一个 wave 把 `PromptService` 注入
`SearchServiceDeps` / `MemoryExtractStepDeps` / `LlmSummarizer` 之后，这个文件应当删掉。

**不做 ACL。** 提示词是进程级配置，不属于任何 `comem://` 命名空间；给一条提示词授
「谁能改」需要先有「谁的配置」这个概念，而 v1 是单租户部署（§12.4）。和 `/telemetry`、
`/health` 一样不鉴权——它们都不碰用户内容。

控制台的「试填变量」不是 Markdown 阅读器，也不调用模型。它把当前编辑器草稿和用户填写的
示例值交给与实际调用相同的模板渲染器，返回模型将收到的原始提示词文本；没有填写的变量仍
用变量说明占位。请求是 `POST /api/v1/prompts/{id}/preview`，可选 body 为
`{body, variables}`，省略 `body` 时预览当前生效正文；预览不会保存覆盖，也不会改变下一次
模型调用。没有变量的提示词不显示这个按钮，避免把原文再打开一次伪装成预览。

### 18.2 本地推理服务

设置页的「本地推理服务」卡片让用户在浏览器里完成「选择 + 启动 + 使用」。三个端点
都只给系统管理员：

| 端点 | 行为 |
|---|---|
| `GET /api/v1/inference/local` | 回 `available` / `running` / `managed` / `endpoint` / `dimension` / `backend` / `device` / `model` / `missing` / `startCommand`。`endpoint` 固定为 `http://127.0.0.1:8089`，与向量供应商的网关配置无关。外部启动但就绪的服务显示为可用，`managed` 为 false |
| `POST /api/v1/inference/local/start` | 用服务端写死的命令拉起子进程并等到就绪。成功回 `{started: true, ready: true, endpoint, dimension}`；端口已有其他服务、进程退出或超时回 409 `CONFLICT`（`details` 带 `started` / `ready` / `reason`）；缺依赖回 400 `INVALID_ARGUMENT`（`details` 带 `missing` / `startCommand`） |
| `POST /api/v1/inference/local/stop` | 只停本进程管理的推理服务，回 `{stopped: true}`；无法确认归属时回 409 |

**`available` 的判据是本机文件**：`local-inference/.venv/bin/python`、
`local-inference/server.py`、`local-inference/models/` 下至少一个 embedding `.gguf`。
缺项列进 `missing`（`venv` / `server` / `embedding-model` / `rerank-model`）；
`rerank-model` 缺失不阻止启动（命令自动加 `--no-rerank`）。核心镜像里没有
`local-inference/`，因此恒为 `available: false`；`comem:local-inference` 镜像把源码
放在 `/app/local-inference`、虚拟环境在 `/opt/comem-inference/.venv`、模型挂到
`/models`，同样不满足判据——容器部署仍按 `docs/operations.md` 的「本地推理（可选镜像）」
手动启动，卡片只用于本机源码部署。

**启动命令写死在服务端**：`nice -n 10 taskset -c 0-5 .venv/bin/python server.py
--device cpu --threads 6`。请求体不参与任何决策；路径、device、threads 都不接受
调用方输入。

**只管理自己启动的进程。** spawn 用 `detached: true` + `stdio: 'ignore'`，pid 写进
`{dataDir}/_meta/local-inference.pid`；`stop` 只对 pid 文件里的进程组发
SIGTERM / SIGKILL，不按名字 `pkill`——用户可能在终端里手动跑着同一个 `server.py`。
记录同时包含 Linux 进程启动时刻。停止时核对 pid、启动时刻和 `/proc/<pid>/cmdline`；旧格式或对不上只清文件。

**等待与失败。** `start` 最多等 25 秒（控制台请求超时是 30 秒）：模型加载实测 8 秒
左右，留出的余量够慢机器用。`dimension` / `backend` / `device` / `model` 都来自子进程
的 `/health`，不是配置值——服务实际加载的模型与配置里想用的模型可能不是同一个。

**「一键填入」只改表单。** 向量配置写 `type` / `baseUrl` / `model` / `apiKey` /
`dimension`，重排配置写 `type` / `baseUrl` / `model` / `apiKey`；不自动保存，也不代填
`retrieval.engine` / `retrieval.rerank.enabled`（前者是检索策略，后者默认关是刻意的）。

**仓库根从模块位置推导。** 服务可能从任意工作目录启动，不能用 `process.cwd()`；
`src/adapters/local-inference/` 与 `dist/adapters/local-inference/` 深度相同，
`../../..` 在两处都指向仓库根（与 `config/prompt-defaults.ts` 同一理由）。

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
| `PROVIDER_UNAVAILABLE` | 503 | 模型不可用；或检索超过 30 秒总上限（`details.timeout: true`、`reason: 'deadline_exceeded'`，§13.3） |
| `INTERNAL` | 500 | 未预期错误 |

**文件系统 errno → code**（`src/adapters/fs/error-map.ts`）。三个 fs 适配器共用一张表，各自只声明覆盖项，表外的一律 `INTERNAL`：

| errno | code | 备注 |
|---|---|---|
| `ENOENT` | `NOT_FOUND` | 三者一致 |
| `EEXIST` | `ALREADY_EXISTS` | 三者一致 |
| `EISDIR` | `INVALID_ARGUMENT` | 三者一致 |
| `ENOSPC` | `RESOURCE_EXHAUSTED` | 三者一致 |
| `EACCES` / `EPERM` | `PERMISSION_DENIED` | `content-store` 曾经缺这两行，写盘权限不足会落成 `INTERNAL`（500） |
| `ENOTDIR` | `INVALID_ARGUMENT` / `NOT_FOUND` | **有意的差异**，见下 |

**`ENOTDIR` 的差异是语义，不是漂移。** `content-store` 面对的是「`memories` 这个路径段其实是个文件」，此时路径类型不匹配，`INVALID_ARGUMENT` 比 `NOT_FOUND` 准确；`metadata-file` 与 `acl-file` 面对的是「没有这个元数据文件 / ACL 文件」，而且多处直接把 `ENOTDIR` 当成「文件不存在」吞掉，`NOT_FOUND` 才符合调用方语义。差异集合由 `tests/integration/fs/error-map-consistency.test.ts` 逐个 errno 钉住——只有 `content-store` 的 `ENOTDIR` 与另外两个不同，抹平或扩大差异都会让测试变红。

中文消息同样共享结构：`INVALID_ARGUMENT` / `NOT_FOUND` / `PERMISSION_DENIED` / `ALREADY_EXISTS` / `INTERNAL` 的文案由各适配器自己给，「文件不存在」「摘要文件不存在」「ACL 文件不存在」是有诊断价值的定位信息，不强行统一。新增错误码时 `AdapterMessageCode` 自动落到适配器一侧，三个适配器的消息表会各自报缺键（编译期发现）。

**重放语义分两套集合，互补而不是重复。** `domain/errors.ts` 的 `RETRYABLE_CODES`（`CONFLICT` / `RESOURCE_EXHAUSTED` / `PROVIDER_UNAVAILABLE`）回答「一次模型调用再发一次会不会成功」，由 `services/llm.ts` 消费；`domain/archive.ts` 的 `isTerminalStepError`（`INVALID_URI` / `INVALID_ARGUMENT` / `PERMISSION_DENIED` / `UNAUTHENTICATED`）回答「一步提交重放一次会不会成功」，由 `services/commit/pipeline.ts` 与 `services/task.ts` 消费。**两边都不在的 code 会被当成可重试**——`UNAUTHENTICATED` 曾经因此白重试 `(stepAttempts + 1) × taskAttempts` 次（默认 2 × 3 = 6 次）：一把错的 API Key 在模型调用层正确地不重试，到了步骤层却被当成瞬态失败。

`INTERNAL` 是未知异常的兜底，步骤级重试；`NOT_FOUND` 是确定性失败，当前仍按可重试处理——已知缺口：它只在步骤循环之外抛出，没有超时成本，所以不进终态集合。`ALREADY_EXISTS` 已经降级：`memory_merge` 捕获它并把冲突操作记进 `skippedOperations`（§11.5），归档照常完成。把它加进终态集合只是把「一步一步重试到失败」变成「第一次就失败」，并不能让那条记录生效，还会把这批操作里其余十九条一起赔进去。新增错误码时两套集合都要判断，检查方法见 `domain/errors.ts` 的 `RETRYABLE_CODES` 注释。

**供应商错误 → 领域失败由一份共享映射决定。** `adapters/llm/provider-error-mapping.ts` 被生成（`ai-sdk-provider.ts`）、嵌入（`embedding-provider.ts`）与重排（`rerank-provider.ts`）三条链路共用。三份各自复制时，同一个供应商故障（例如 429）可能在对话补全里被判成可重试、在嵌入里被判成不可重试，且没有任何机制能拦住这种漂移。

判定顺序：超时 → 生成链路的结构化输出分类 → HTTP 状态码 → 网络 `TypeError` → 兜底 `INTERNAL`。

| 供应商错误 | 领域码 | `isRetryable` | 依据 |
|---|---|---|---|
| 401 / 403 | `UNAUTHENTICATED` | 否 | API Key 或模型权限错误，同一请求重发结果一样 |
| 400 / 404 / 413 / 422 | `INVALID_ARGUMENT` | 否 | 请求本身不合法；413 表示请求体 / 上下文超出供应商上限 |
| 429 | `RESOURCE_EXHAUSTED` | 是 | 限流或配额不足，等待后可能成功 |
| 5xx | `PROVIDER_UNAVAILABLE` | 是 | 供应商暂时不可用 |
| 超时 | `PROVIDER_UNAVAILABLE` | 是 | 重排额外带 `details.timeout: true`，供 `rerank.degraded` 归因 |
| 网络不可达（`TypeError`） | `PROVIDER_UNAVAILABLE` | 是 | DNS 失败、连接被拒等瞬态故障 |
| 结构化输出解析失败 | `INVALID_ARGUMENT` | 否（由 `services/llm.ts` 单独重试一次） | 模型输出不符合 schema |
| 结构化输出截断 | `PROVIDER_UNAVAILABLE` + `details.truncated` | 是（服务层见 `truncated` 跳过） | 同样的 `maxTokens` 只会再截断一次 |
| 其它未知异常 | `INTERNAL` | 否（步骤层兜底重试） | 不把未知异常泄漏成业务错误码 |

**`LlmOptions` / `EmbeddingOptions` / `RerankOptions` 的 `timeoutMs` 是上限，不是覆盖值。** 适配器取 `min(配置的 timeoutSeconds × 1000, timeoutMs)`：内部预算只能收紧用户配置，不能放宽。这是行为变更——早期传 `timeoutMs` 会直接覆盖配置，配置 1 秒、意图分析传 12 秒就真的等 12 秒；现在用户配置是上界，内部预算只往里收。到点由 `AbortController` 中止在途 HTTP（SDK 把信号透传给 `fetch`），连接随之中断，不是等它跑完再丢弃结果。

**不解析响应 body 里的错误码，也不读 `retry-after`。** 供应商的 JSON 错误形状没有稳定契约，按某一家写规则会在兼容实现上误判；`retry-after` 只影响退避时长，而退避在 `services/llm.ts`。这两类形态当前未覆盖，不是已支持。

**413 在合并前落进 `INTERNAL`。** `isRetryable` 对 `INTERNAL` 本来就是 false，所以合并前后的**一次模型调用重试结论相同**；差别在步骤层：`INTERNAL` 不在 `isTerminalStepError` 的终态集合里，会被重放，而 413 表示请求体 / 上下文超出供应商上限，重发同一份输入仍然超限。按保守原则把它并入 400 类，让领域码与「重发无意义」这个事实一致。这是本次合并唯一的映射变更，`isRetryable` 的逐条结论没有改变。

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
| 可观测性 | `request_log.phases` 落服务端可测的阶段（`recall` / `capture`），阶段之和不超过总耗时、差额即未归因间隙；`requestId` 从 HTTP 贯穿到后台任务与日志；`/metrics` 输出能被 Prometheus 解析 |

测试在本地跑。核心链路测试用 `fs.mkdtemp()` 造临时数据根、用 SQLite `:memory:` 造索引，不需要内存替身（AGENTS.md §9）。

**门禁一条链，`pnpm verify` 串完。** 顺序是 `typecheck → lint → check:config →
check:reachability → check:shape → build:web → test → test:integrations`（`package.json`
的 `verify`）。`check:shape`（`scripts/check-shape.ts`）是结构 ratchet：单文件行数、函数体
> 120 行的个数、`src/` 总行数、禁用指令与 `any` 计数都只能降；基线在
`scripts/shape-baseline.json`，更新要显式跑 `--update-baseline`，且拒绝任何让上限变大的
写入。各项口径与残余见 `docs/operations.md`「形状检查」。

**同一算法的两份实现靠测试对拍。** `domain/` 不能 import `adapters/`，所以保留名集合有两份副本：`domain/identity.ts` 的 `URI_RESERVED_NAMES` 管根标识，`adapters/fs/path.ts` 的 `RESERVED_NAMES` 管 URI 路径段；`tests/unit/domain/identity.test.ts` 与 `tests/integration/fs/path.test.ts` 对同一批候选名断言两边判定相同。曾经还有一对 UTF-8 字节计数实现（`domain/node.ts` 的手写编码区间版与 `services/resource.ts` 的 `Buffer.byteLength` 版），前者唯一的消费者是已删除的 `Document.size`，两份实现与对拍测试一起删掉，现在只剩 `services/resource.ts` 一份。

## 21. 里程碑

| 阶段 | 内容 | 验收 | 状态 |
|---|---|---|---|
| P1 | 骨架：工程结构、URI、错误、配置、SQLite 迁移 | `pnpm typecheck` 通过 | ✅ |
| P2 | 存储与文件系统：`ContentStore`、`FileSystemService`、元数据文件、**路径锁**、**元数据写保护** | `write`/`read`/`ls`/`tree` 可用；并发写不串 | ✅ |
| P3 | 索引与检索：FTS5、`find`/`grep`/`glob`、**层级加权**、**Context Assembly**、**Recall Ledger** | 检索链路测试通过；token 预算与分层投放可验 | ✅ |
| P4 | 摘要：生成、失效、降级 | 失效链路测试通过 | ✅ |
| P5 | 会话与管线：归档、抽取、**预取**、合并、**规则合并**、复核、**并发锁**、**ToolPart** | 提交链路端到端通过 | ✅ |
| P6 | ACL 与用户组 | 权限链路测试通过 | ✅ |
| P7 | 摄取：`add_resource`（**批量写入**）与**索引双写补偿** | 导入 100 文件不退化 | 完成：批量写入；双写补偿的写入侧、启动重放、调度器定期重放与日志原子清理都已接线（§10.6） |
| P8 | MCP 15 工具 | MCP 客户端可连 | ✅ |
| P9 | 可观测性：`/metrics`、任务查询 API、请求 ID、请求记录、`error.log`、开销归因、`health` 扩展、监控页 | 能看到「CoMem 让每个请求多花多少毫秒」 | ✅ |
| P10 | 控制台十个页面 | 完整演示路径 | ✅ |
| P11 | Hook 插件（Claude Code + Codex）与 DSH 原生插件 | 真实会话自动入库 | ✅ |
| P12 | 文档定稿 | 全部文档与实现一致 | 未完成 |

**路径锁与元数据写保护排在 P2，Context Assembly 与 Recall Ledger 排在 P3。** 前两者是**正确性**问题，晚补等于在错误的地基上盖楼；后两者跟检索是同一层，拆开做要改两遍。

**v1 之后（backlog）**：

| 项 | 为什么先不做 |
|---|---|
| 快照与回滚 | 归档级回滚（按 `memory_diff.json` 反向应用）比 git 风格快照便宜，仍是 P2 之后 |
| 检查点摘要 | 只在部分归档时需要，v1 全量归档 |
| Prometheus + Grafana 部署 | `/metrics` 输出标准格式，接不接是运维的事 |
