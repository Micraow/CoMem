/**
 * 配置结构（架构文档 §18）。
 *
 * 字段与 §18 的 YAML 一一对应，默认值也照抄 §18。
 * 所有魔法数字集中在这里，判断标准是「改一个值要翻几个文件」。
 *
 * 嵌套对象用 `.prefault({})` 而不是 `.default({})`：zod 4 的 `.default()` 收的是
 * 输出类型，子字段全部有默认值时仍要求传完整对象；`.prefault()` 收输入类型，
 * 先把 `{}` 填进输入再走子字段默认值，因此「整个段省略」也是合法的。
 */

import { z } from 'zod';

import { ComemError } from '../domain/errors.js';
import { USER_ID_PATTERN } from '../domain/identity.js';

const llmProviderSchema = z.object({
  /**
   * `openai-compatible` 走 `@ai-sdk/openai-compatible`，`anthropic` 走 `@ai-sdk/anthropic`，
   * `disabled` 表示「没有模型，不产生任何调用」。
   *
   * **`disabled` 不是 `offline` 假提供者。** 曾经有过一个「不连网络、返回空结果」的
   * 假提供者，用来让演示在没有模型凭据时跑通。删掉的理由：它让「阶段二从未真正执行」
   * 这个缺陷看起来像正常状态——任务显示 `done`，但没有一条记忆被抽出来。演示脚本
   * 现在直接读 `COMEM_LLM_*` 环境变量，没配就明确说「这一步需要模型」。
   *
   * `disabled` 与 `providers.embedding` / `providers.rerank` 的同名档一致：它不
   * 假装成功，只表达「不产生调用」。需要模型的功能（摘要、记忆抽取、合并）由
   * 下面的交叉校验在启动期拒绝，见 `configSchema` 的 `transform`。
   */
  type: z.enum(['openai-compatible', 'anthropic', 'disabled']).default('openai-compatible'),
  baseUrl: z.string().default('https://api.example.com/v1'),
  model: z.string().default('gpt-4o-mini'),
  apiKey: z.string().default(''),
  maxTokens: z.number().int().positive().default(32768),
  timeoutSeconds: z.number().positive().default(120),
  /** 用于成本换算，按 1M token 计 */
  pricing: z
    .object({
      inputPerMillion: z.number().nonnegative().default(0.15),
      outputPerMillion: z.number().nonnegative().default(0.6),
    })
    .prefault({}),
});

/**
 * 嵌入结果缓存（架构文档 §8.1 的 `embedding_cache` 表）。
 *
 * 缓存是**派生数据的派生**：`(model, content_digest) → 向量`。命中就不打供应商，
 * 未命中照常打。读失败 / 写失败一律降级成「没命中」，生产写入路径不受影响。
 *
 * 默认开启：省掉的是**重复**的网络调用，不影响正确性——同样的模型、同样的正文，
 * 供应商返回的向量是同一个。关掉只对「每次都要拿新向量」的调试场景有意义。
 */
const embeddingCacheSchema = z
  .object({
    /** 关掉之后每次嵌入都打供应商（调试 / 排障用）。 */
    enabled: z.boolean().default(true),
    /**
     * 最多保留多少行，超过按插入顺序淘汰最旧的行。
     *
     * 20,000 是**保守取值**，不是容量上限：1024 维每行约 4 KiB（共约 80 MiB），
     * 1536 维约 120 MiB。磁盘不是无限的，而缓存未命中的代价只是多一次供应商调用
     * ——延迟成本，不是正确性成本。按 1,000 条/秒的导入速度，20,000 条足够覆盖
     * 一次中等规模导入里重复出现的正文。推导与失效场景见
     * `adapters/sqlite/embedding-cache.ts` 的文件头。
     */
    maxEntries: z.number().int().positive().default(20_000),
  })
  .prefault({});

/**
 * 嵌入供应商（架构文档 §18 的 `providers.embedding`）。
 *
 * `type: 'disabled'` 是默认值：没配就不该产生嵌入调用。线上写记忆是热路径，一次
 * 悄悄打出去的网络请求会把「本地数据库」变成「依赖第三方可用性的数据库」，而失败
 * 还是静默降级的——用户只会看到语义检索查不出东西。
 *
 * 默认维度 1536 对应 `text-embedding-3-small`。**写错在第一次嵌入时抛
 * `PROVIDER_UNAVAILABLE`**（见 `adapters/llm/embedding-provider.ts` 的维度校验），
 * 不在配置加载期拦：维度是否与模型一致只有问过供应商才知道。
 */
const embeddingProviderSchema = z
  .object({
    /** `openai-compatible` | `anthropic` | `disabled` */
    type: z.enum(['openai-compatible', 'anthropic', 'disabled']).default('disabled'),
    baseUrl: z.string().default(''),
    /** 如 `text-embedding-3-small` */
    model: z.string().default('text-embedding-3-small'),
    apiKey: z.string().default(''),
    /**
     * 向量维度。必须与模型一致，写错在第一次嵌入时抛 `PROVIDER_UNAVAILABLE`。
     *
     * 1536 是 `text-embedding-3-small` 的维度。换模型时要同步改这里，否则
     * `node_embedding.dimension` 与查询向量长度不一致，向量检索会把所有行当噪音跳过。
     */
    dimension: z.number().int().positive().default(1536),
    /**
     * 单次请求的条数上限。
     *
     * 128 是经验值，来源是「供应商常见上限」：OpenAI 单次最多 2048 条，Azure
     * 只有 16 条，多数兼容实现落在 100–2048 之间。取 128 对常见供应商都安全，
     * 真实供应商有更小的上限时用这个字段覆盖。
     *
     * 写路径按它把**一次 `drain()` 里排队的记录**切片：N 条记录产生
     * `ceil(N / maxBatchSize)` 次请求，而不是 N 次。取 1 会退化成「每条一次」，
     * 大于供应商上限会被拒绝（400）。
     */
    maxBatchSize: z.number().int().positive().default(128),
    /** 单批超时，秒。30 秒是经验值：嵌入是短请求，卡住不该占着租约等两分钟。 */
    timeoutSeconds: z.number().int().positive().default(30),
    cache: embeddingCacheSchema.prefault({}),
  })
  .prefault({});

/**
 * 重排供应商（架构文档 §18 的 `providers.rerank`）。
 *
 * `type: 'disabled'` 是默认值：重排是检索路径上的一次额外模型调用，没配就不该
 * 产生。**不要静默降级**——`retrieval.rerank.enabled` 为 `true` 而这里仍是
 * `disabled` 时 `loadConfig` 抛 `INVALID_ARGUMENT`，见下面的交叉校验。
 *
 * 与 `providers.embedding` 分开而不是合并：两者的失败处置不同（嵌入维度不匹配是
 * 配置错误，重排超时该降级到融合分），合并之后配置层就没法为它们分别做交叉校验。
 */
const rerankProviderSchema = z
  .object({
    /** `http` 走 Cohere / Jina 兼容的 `POST /rerank`；`disabled` 不产生调用 */
    type: z.enum(['http', 'disabled']).default('disabled'),
    baseUrl: z.string().default(''),
    /** 如 `BAAI/bge-reranker-v2-m3` */
    model: z.string().default('BAAI/bge-reranker-v2-m3'),
    apiKey: z.string().default(''),
    /**
     * 单次重排超时，秒。
     *
     * 30 秒来自实测，不是拍的：本地 `Qwen3-Reranker-0.6B` 重排 50 条候选要
     * 8.05 秒 p50、9.35 秒 p95（`eval/README.md` 的 105 条基线，含候选正文读取
     * 与查询嵌入）。原来的 10 秒低于 p95，105 条里超过一半的查询在重排返回前被
     * 中止、静默退回融合分——用户以为用了重排，实际用的是融合分。30 秒是 p95 的
     * 3.2 倍，也与 `providers.embedding.timeoutSeconds` 的默认值一致。
     *
     * 远程供应商（`bge-reranker-v2-m3` / `Qwen3-Reranker-8B`）50 条只要
     * 1.8–2.7 秒，30 秒同样够用。延迟敏感、且能接受候选宽度变窄时，把 `topN`
     * 降到 20：本地约 3.6 秒。
     *
     * 超时不是异常路径：它退化成融合分（检索仍然成功），但会在 `warn` 日志里带
     * `reason: timeout`，并把最近一次失败写进 `GET /health` 的 `rerank.degraded`。
     */
    timeoutSeconds: z.number().int().positive().default(30),
    /**
     * 最多重排多少条候选。
     *
     * 50 是经验值：重排是串行的额外延迟，5 条以内的区别用户感知不到；而向量召回
     * 的 top-50 里噪声比 BM25 大，重排正是为了解决这一段。取 50 与「混合检索先
     * 取 `candidateMultiplier × limit` 候选」的量级一致（4 × 10 = 40，向上取到
     * 50）。本地 0.6B 重排 50 条约 8 秒，由 `timeoutSeconds` 的 30 秒默认值覆盖。
     */
    topN: z.number().int().positive().default(50),
  })
  .prefault({});

const levelWeightsSchema = z
  .object({
    l0: z.number().positive().default(1.15),
    l1: z.number().positive().default(1.05),
    l2: z.number().positive().default(1.0),
  })
  .prefault({});

const retrievalSchema = z.object({
  /**
   * 检索后端（§8.3、§18）。
   *
   * `fts5` 是关键词检索（`SqliteFtsIndex`），`vector` 是语义检索（`SqliteVectorIndex`），
   * `hybrid` 并行跑两者再按 `reciprocalRankFusion` 融合。三个取值都必须能写进配置：
   * 值域与 `domain/retrieval.ts` 的 `RetrievalEngine` 是同一个联合，少一个就是「写进
   * 去不生效」的假配置。
   */
  engine: z.enum(['fts5', 'vector', 'hybrid']).default('fts5'),
  /** 先取 limit×N 候选，再按权限过滤 */
  candidateMultiplier: z.number().int().positive().default(4),
  /** 层级加权，用于 BM25 平局时打破 */
  levelWeights: levelWeightsSchema,
  /** sed 风格正则，作用在 prompt 上，产物才是查询 */
  queryFilters: z.array(z.string()).default([]),
  assembly: z
    .object({
      /** 注入模型的 token 预算 */
      maxTokens: z.number().int().positive().default(1600),
      /** 这么多轮内投过的 URI 不再投 */
      dedupTurns: z.number().int().nonnegative().default(3),
      /** chat | coding */
      quotaPreset: z.enum(['chat', 'coding']).default('coding'),
    })
    .prefault({}),
  /**
   * 重排（§8.5 的「后续的 rerank」）。
   *
   * **默认关**：重排多一次模型调用，默认开会让「查一下」变慢。它是「召回质量不够
   * 时再打开」的旋钮，不是默认路径的一部分。
   */
  rerank: z
    .object({
      enabled: z.boolean().default(false),
      /** 重排后保留前多少条；0 = 不过滤（只重排，不截断） */
      keepTopN: z.number().int().nonnegative().default(0),
    })
    .prefault({}),
});

const configObjectSchema = z.object({
  /** 数据根。留空表示按运行形态推导（见 §6.5），容器里由镜像钉死为 /var/lib/comem */
  dataDir: z.string().default(''),

  providers: z
    .object({
      llm: z
        .object({
          default: llmProviderSchema.prefault({}),
        })
        .prefault({}),
      embedding: embeddingProviderSchema.prefault({}),
      rerank: rerankProviderSchema.prefault({}),
    })
    .prefault({}),

  summary: z
    .object({
      /** llm | rule */
      generator: z.enum(['llm', 'rule']).default('llm'),
      abstractMaxChars: z.number().int().positive().default(256),
      overviewMaxChars: z.number().int().positive().default(4000),
    })
    .prefault({}),

  retrieval: retrievalSchema.prefault({}),

  session: z
    .object({
      autoCommit: z
        .object({
          enabled: z.boolean().default(true),
          pendingTokenThreshold: z.number().int().positive().default(150000),
          messageCountThreshold: z.number().int().positive().default(100),
          minCommitIntervalSeconds: z.number().int().nonnegative().default(0),
          /** 0 = 关；开了需要服务端扫描器 */
          idleTimeoutSeconds: z.number().int().nonnegative().default(0),
          keepRecentCount: z.number().int().nonnegative().default(0),
        })
        .prefault({}),
      /**
       * 会话过期（架构文档 §11.7）。与 `autoCommit.idleTimeoutSeconds` 是两件事：
       * 那个是「空闲多久该**提交**」，这个是「空闲多久该**归档 / 删除**」。
       *
       * 默认全关：删数据必须是显式选择，「没人管就会话消失」不是可以默认接受的行为。
       */
      expiry: z
        .object({
          /** 空闲多久后归档。0 = 关。 */
          idleTimeoutSeconds: z.number().int().nonnegative().default(0),
          /**
           * 过期后是归档还是删除。
           *
           * 默认 `archive`：归档只改 `.meta.json` 的 `status`，可以改回来；删除是不可
           * 逆的，不该是默认行为。
           */
          action: z.enum(['archive', 'delete']).default('archive'),
        })
        .prefault({}),
    })
    .prefault({}),

  memory: z
    .object({
      reviewRequired: z.array(z.string()).default(['experiences', 'rules']),
      /**
       * 用户画像的收敛预算（架构文档 §11.1）。
       *
       * 画像正文整段注入每次会话的开头，是每次请求的固定成本。超过 `maxChars` 时，
       * 抽取提示词要求这次输出一条 `replace content` 的整份重写，只保留稳定身份。
       * **这不是额外一次模型调用**：压缩骑在本来就要跑的 `memory_extract` 上。
       *
       * 默认 800 字的依据：稳定身份约 10–12 条 bullet，每条「≤30 字正文 + 17 字
       * 日期后缀」≈ 47 字，合计 ≈ 570 字；800 给真正长期的事实留约 40% 余量，同时
       * 把每次会话的注入成本限制在 ≈ 800 字（中英混排约 0.5–0.6K token）。实测样本
       * 8 次归档累计 1,259 字，超过默认值——正是要触发的形态。
       */
      profile: z
        .object({
          /** 画像正文的字符上限。超过即整份重写。 */
          maxChars: z.number().int().positive().default(800),
        })
        .prefault({}),
      /** 开它会多一次 LLM 调用 */
      workingMemory: z
        .object({
          enabled: z.boolean().default(false),
        })
        .prefault({}),
      /**
       * 记忆的 TTL（架构文档 §11.7）。
       *
       * **滑动窗口 + 两段式**：`defaultDays` 从「最后一次被使用」（写入或检索命中）起算，
       * 到点先把 `status` 置 `archived`（只标不删）；归档后超过 `retentionDays` 再物理
       * 删除文件与索引行。`profile` / `identity` / `soul` / `rules` 四类永不过期
       * （`domain/memory-types/index.ts` 的 `TTL_EXEMPT_MEMORY_TYPES`，硬编码）。
       */
      ttl: z
        .object({
          /** 滑动窗口长度（天）。0 = 永不过期（默认）。改它对存量立即生效。 */
          defaultDays: z.number().int().nonnegative().default(0),
          /** 每轮最多清扫多少条，防止一次清太多把库锁住 */
          sweepBatchSize: z.number().int().positive().default(100),
          /**
           * 归档后保留多少天才物理删除。`0`（默认）= 永不物理删除（只软归档）。
           *
           * **默认 0 而不是「立即删」**：物理删除不可逆，默认不能删任何东西。
           * 要省磁盘必须显式配一个正数，先观察一轮归档量再定。
           *
           * 30 天是参考实现同类保留期的常见取值（目录 TTL 的会话 30 天），作为
           * 「想开物理删除时」的经验起点，不是默认。
           */
          retentionDays: z.number().int().nonnegative().default(0),
        })
        .prefault({}),
      /**
       * 记忆合并（架构文档 §11.8）。
       *
       * **默认关**：合并会 `delete`，是破坏性操作。关着的时候端点明确拒绝（不是
       * 返回空结果——那会让「没开」看起来像「没有可合并的记忆」）。
       */
      consolidation: z
        .object({
          enabled: z.boolean().default(false),
          /**
           * 最大轮次。
           *
           * 10 是设计约定的上界（来源见 `services/consolidation.ts` 的
           * `DEFAULT_MAX_ITERATIONS`）：每轮至少一次完整模型调用，10 轮已经足够
           * 读完一个 scope 的主要记忆；再往上只会让一次合并烧掉几十次调用。
           */
          maxIterations: z.number().int().positive().default(10),
        })
        .prefault({}),
    })
    .prefault({}),

  acl: z
    .object({
      /**
       * 组空间根的预置级别（`write` | `read`）。
       *
       * 没有 `enabled`：ACL 是硬约束（§12），关掉它不会让请求跳过鉴权，
       * 保留一个「看起来能关」的开关比没有更糟。
       */
      groupDefaultLevel: z.enum(['write', 'read']).default('write'),
    })
    .prefault({}),

  server: z
    .object({
      host: z.string().default('127.0.0.1'),
      port: z.number().int().min(1).max(65535).default(1933),
      /**
       * 服务图绑定的主体，形如 `user:alice`。
       *
       * **这是单用户部署的绑定身份**：HTTP 的 `x-comem-subject` 与它不一致时拒绝。
       * 默认 `user:local` 只是为了让 `pnpm dev` 开箱即用——生产部署应该显式配置。
       *
       * 格式与用户目录的 ID 同一套（`domain/identity.ts` 的 `USER_ID_PATTERN`），
       * 前缀只允许 `user` / `group`；服务图目前只接受 `user` 主体，`group` 形式
       * 在启动时由 `createContainer` 以 `INVALID_ARGUMENT` 拒绝。
       */
      subject: z
        .string()
        .regex(
          new RegExp(`^(?:user|group):${USER_ID_PATTERN.source.slice(1, -1)}$`),
          'server.subject 必须是 user:{id} 或 group:{id} 形式，id 为小写字母或数字开头、最长 64 个字符',
        )
        .default('user:local'),
    })
    .prefault({}),

  auth: z
    .object({
      /**
       * 是否启用多用户认证（架构文档 §12.7）。
       *
       * **默认 false = v1 单用户行为**：身份由反向代理注入 `x-comem-subject`，
       * 且必须等于 `server.subject`，否则 401。现有部署与测试全部依赖这条路径，
       * 打开它是一次显式的部署选择。
       *
       * 打开后 `x-comem-subject` **被忽略**，必须带
       * `Authorization: Bearer <session token>` 或 `Authorization: Bearer comem_...`
       * （API key）。缺失或非法一律 401 `UNAUTHENTICATED`。
       */
      enabled: z.boolean().default(false),
      /**
       * 系统管理员的用户 ID（`app_user.id`，不是 `user:{id}` 主体字符串）。
       *
       * 用户 / 组目录这类**跨主体**的端点没有「被操作的目标资源」可以求权
       * （列全部用户、创建用户、列全部组、建组），只能由这份显式名单回答
       * 「谁可以管理目录」。默认 `[]` = 本部署没有系统管理员：这些端点对所有
       * 人 403。
       *
       * 默认值取空不是「保守」，是唯一安全的一侧：任何非空默认（绑定主体、
       * 第一个用户、最后一个用户）都会在部署者没有意识到的情况下产生一个
       * 管理员。要打开管理面就显式写自己的 ID，没有隐式规则。
       */
      adminUserIds: z.array(z.string()).default([]),
      /**
       * session token 的 HMAC 密钥。
       *
       * 留空时进程启动生成随机值：**重启即失效**，多实例部署必须显式配置同一个
       * 值，否则一个实例签发的 token 在另一个实例上校验失败。这是「单机默认可用、
       * 多实例必须配置」的取舍，不提供静默降级。
       */
      sessionSecret: z.string().default(''),
      /**
       * session token 有效期，秒。默认 86400（一天）。
       *
       * 来源：一天是「agent 长任务跑得完、泄露窗口又可接受」的常见经验值；
       * 不是测量结果。API key 的有效期由创建时的 `expiresAt` 单独控制，不受
       * 这个值影响。
       */
      sessionTtlSeconds: z.number().int().positive().default(86400),
    })
    .prefault({}),

  logging: z
    .object({
      level: z.enum(['debug', 'info', 'warn', 'error', 'fatal']).default('info'),
      /** 留空只写 stdout；填路径则额外写 error.log */
      file: z.string().default(''),
    })
    .prefault({}),

  telemetry: z
    .object({
      metrics: z
        .object({
          enabled: z.boolean().default(true),
          /** 单账号部署没必要，开了会放大基数 */
          includeAccountLabel: z.boolean().default(false),
        })
        .prefault({}),
      requestLog: z
        .object({
          enabled: z.boolean().default(true),
          retainDays: z.number().int().nonnegative().default(7),
          retainRows: z.number().int().nonnegative().default(100000),
          /** 1.0 = 全量；错误请求永远全量记录 */
          sampleRate: z.number().min(0).max(1).default(1.0),
        })
        .prefault({}),
      /** Hook 上报阻塞开销，控制台「监控」页用 */
      hookOverhead: z
        .object({
          enabled: z.boolean().default(true),
        })
        .prefault({}),
      hotness: z
        .object({
          /** 一周 */
          halfLifeHours: z.number().positive().default(168),
          /**
           * 热度对最终排序的影响。0 = 只用于冷热标记，1 = 与检索分同权。
           *
           * 默认 0 是架构文档 §17.5 的结论：热度是治理指标（「哪些记忆该清理」），
           * 不是检索指标；混进排序会让老记忆永远赢，新记忆永远出不来。非 0 是
           * 运维显式选择的取舍，不是我们推荐的默认值。
           */
          weight: z.number().min(0).max(1).default(0),
        })
        .prefault({}),
    })
    .prefault({}),

  task: z
    .object({
      leaseSeconds: z.number().int().positive().default(60),
      maxAttempts: z.number().int().positive().default(3),
      concurrency: z.number().int().positive().default(4),
    })
    .prefault({}),

  /**
   * 本机 Agent 对话导入（架构文档 §11.9）。
   *
   * **默认关闭**：导入会往数据根写大量会话与消息，必须是显式选择。关着时
   * `pnpm ingest` 拒绝真正写入，只允许 `--dry-run` 报告。
   */
  ingest: z
    .object({
      enabled: z.boolean().default(false),
      /**
       * 每个会话一次读多少条。
       *
       * 100 的来源是 W24 任务约定：与 MCP 单次批量写入的量级一致（架构文档
       * §10.6 的验收场景就是 100 个文件）。100 条消息的内存占用可忽略，又足够
       * 摊薄「每批一次游标写」的代价。
       */
      batchSize: z.number().int().positive().default(100),
      /**
       * 阶段二每批等多少个会话。
       *
       * 20 的来源是 W25 任务约定：一批 20 个会话 × 每会话 1–2 次模型调用 ≈
       * 20–40 次调用，按 5 秒/次约 100–200 秒。用户在终端里按「批」看到进度，
       * 而不是等 908 个会话全部导完才出第一行；批量再小会让执行器每几个任务
       * 空转一次，且批次日志过多。与 `batchSize`（每个会话读多少条消息）是
       * 两个不同的量。
       */
      extractionBatchSize: z.number().int().positive().default(20),
      /**
       * 每批阶段二的最长等待，毫秒。
       *
       * 30 分钟（1_800_000）的来源：「908 个会话 × 1–2 次模型调用 × 5 秒/次
       * ≈ 2–3 小时」的总量换算到一批 20 个会话约 3–7 分钟，30 分钟留了
       * 4–10 倍余量覆盖供应商尾延迟与单步重试。超时按**批**算，不是按总量算。
       * `0` = 不等（等价于 `--no-wait`）。
       */
      extractionTimeoutMs: z.number().int().nonnegative().default(1_800_000),
      /**
       * 源路径覆盖。空数组表示用各宿主的默认路径：
       *
       * - `claude-code`：`~/.claude/projects`（目录，递归）
       * - `codex`：`~/.codex/sessions`（目录，递归找 `rollout-*.jsonl`）
       * - `deepseek`：`~/Downloads/<任意子目录>/conversations.json`（文件）
       * - `qwen`：`~/Downloads/<任意子目录>/Qwen-chat-export-*.json`（文件）
       */
      paths: z
        .object({
          'claude-code': z.array(z.string()).default([]),
          codex: z.array(z.string()).default([]),
          deepseek: z.array(z.string()).default([]),
          qwen: z.array(z.string()).default([]),
        })
        .prefault({}),
    })
    .prefault({}),
});

/**
 * 交叉校验：检索后端要向量，就必须有嵌入供应商。
 *
 * **不能静默降级成 FTS5。** 用户把 `retrieval.engine` 改成 `vector`，是因为他要
 * 语义检索；退回关键词检索会给出「看起来能用、实际没按配置生效」的结果，正是
 * AGENTS.md §1 说的「假配置」。这种错误在启动时抛，比在第一次查询时发现好。
 *
 * 为什么写在 `transform` 里而不是 `superRefine`：`config/index.ts` 的
 * `validate()` 只按 issue 的 `code` 生成消息（`describeIssue`），自定义 refine 的
 * `message` 会被丢掉；而这条要求「说明 `retrieval.engine` 需要
 * `providers.embedding`」，消息必须完整。`ComemError` 不是 `ZodError`，
 * `safeParse` 会原样抛出。
 *
 * `anthropic` 不提供嵌入接口，但它在 `AiSdkEmbeddingProvider` 构造期抛
 * `INVALID_ARGUMENT`——这里只判断 `disabled`，不重复判断供应商能力。
 */
const configSchema = configObjectSchema.transform((config) => {
  const engine = config.retrieval.engine;
  if (engine !== 'fts5' && config.providers.embedding.type === 'disabled') {
    throw new ComemError(
      'INVALID_ARGUMENT',
      `retrieval.engine 需要 providers.embedding：engine 是 ${engine} 时必须配置嵌入模型，否则没有可用的向量来源。`,
      {
        engine,
        embeddingType: config.providers.embedding.type,
        field: 'providers.embedding',
      },
    );
  }

  /**
   * 交叉校验：开了重排就必须有重排供应商。
   *
   * **不能静默降级成「不重排」。** 用户把 `retrieval.rerank.enabled` 打开，是因为
   * 他认为召回噪声需要模型压一压；退回融合分排序会给出「看起来能用、实际没按配置
   * 生效」的结果。这类错误在启动时抛，比在「为什么检索质量没变」的排查里发现好。
   *
   * 与上面 embedding 的校验同一条理由、同一个写法（`transform` 而不是
   * `superRefine`，见那段注释）。两条校验独立：同时配错时先报 embedding。
   */
  if (config.retrieval.rerank.enabled && config.providers.rerank.type === 'disabled') {
    throw new ComemError(
      'INVALID_ARGUMENT',
      'retrieval.rerank.enabled 需要 providers.rerank：开启重排时必须配置重排供应商，否则重排不会发生。',
      {
        rerankType: config.providers.rerank.type,
        field: 'providers.rerank',
      },
    );
  }

  /**
   * 交叉校验：开了记忆合并就必须有真的模型。
   *
   * 规则生成器（`summary.generator: rule`）产不出操作列表——它的存在是为了让没有
   * 模型凭据的部署（以及不需要模型的测试）仍能生成摘要。开着合并却用它，端点的
   * 每一次调用都会停在模型之前，看起来像「没有可合并的记忆」而实际是配置没生效。
   * `providers.llm.default.type: disabled` 是同一个判据的另一种写法：两者都表示
   * 「没有可用的模型」。这种错误在启动时抛，比在第一次合并时发现好。
   *
   * 与上面两条同一条理由、同一个写法（`transform` 而不是 `superRefine`）。
   */
  const llmEnabled = config.providers.llm.default.type !== 'disabled';
  if (
    config.memory.consolidation.enabled &&
    (config.summary.generator !== 'llm' || !llmEnabled)
  ) {
    throw new ComemError(
      'INVALID_ARGUMENT',
      'memory.consolidation.enabled 需要可用的 LLM：summary.generator 必须是 llm，且 providers.llm.default.type 不能是 disabled。',
      {
        field: 'memory.consolidation.enabled',
        summaryGenerator: config.summary.generator,
        llmType: config.providers.llm.default.type,
      },
    );
  }

  /**
   * 交叉校验：开了工作记忆就必须有真的模型。
   *
   * **这里和 `ingest` 的判据不同，不能降级。** 导入的阶段一（归档 + 建任务 +
   * 游标）不依赖模型，跳过后面的阶段二仍然留下「会话已经进库」这个独立产物；工作
   * 记忆没有对应的「一半」——它在 `archive_summary` 步骤里，前面是规则生成器也能
   * 做的目录摘要，后面只有工作记忆本身。开了它却没有模型，这一步就只剩「跳过一个
   * 空步骤」，配置项等于在撒谎。所以启动时失败，而不是每次归档都投递一个注定失败
   * 的任务。
   *
   * 与上面几条同一条理由、同一个写法（`transform` 而不是 `superRefine`）。
   */
  if (config.memory.workingMemory.enabled && !llmEnabled) {
    throw new ComemError(
      'INVALID_ARGUMENT',
      'memory.workingMemory.enabled 需要可用的 LLM：providers.llm.default.type 是 disabled。工作记忆没有规则生成器——摘要可以降级成 rule，它不能，开了就必须能调模型。关掉它，或配置 providers.llm。',
      {
        field: 'memory.workingMemory.enabled',
        llmType: config.providers.llm.default.type,
      },
    );
  }

  /**
   * 交叉校验：摘要生成器是 `llm` 就必须有可用的 LLM 提供者。
   *
   * 默认生成器是 `llm`，而 `providers.llm.default.type` 的占位默认值指不到任何
   * 真实网关。没有模型凭据的部署（本地开发、CI、只用规则摘要）必须能把 LLM 显式
   * 关掉——但「关掉」与「摘要仍然走 llm」互相矛盾，此时每一次摘要都会停在模型
   * 之前。让它在启动时失败，而不是每次写文件都投递一次注定失败的摘要失效。
   *
   * 与上面几条同一条理由、同一个写法（`transform` 而不是 `superRefine`）。
   */
  if (config.summary.generator === 'llm' && !llmEnabled) {
    throw new ComemError(
      'INVALID_ARGUMENT',
      'summary.generator 是 llm 但没有可用的 LLM 提供者：providers.llm.default.type 是 disabled。把 summary.generator 改成 rule，或配置 providers.llm。',
      {
        field: 'providers.llm.default',
        summaryGenerator: config.summary.generator,
        llmType: config.providers.llm.default.type,
      },
    );
  }

  return config;
});

export type ComemConfig = z.infer<typeof configSchema>;

export { configSchema };
