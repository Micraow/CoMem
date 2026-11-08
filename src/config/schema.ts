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

const llmProviderSchema = z.object({
  /**
   * `openai-compatible` 走 `@ai-sdk/openai-compatible`，`anthropic` 走 `@ai-sdk/anthropic`，
   * `offline` 不连网络、对任何请求返回空结果（演示与端到端测试用，见
   * `adapters/llm/offline-provider.ts` 的说明）。
   */
  type: z.enum(['openai-compatible', 'anthropic', 'offline']).default('openai-compatible'),
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
     */
    maxBatchSize: z.number().int().positive().default(128),
    /** 单批超时，秒。30 秒是经验值：嵌入是短请求，卡住不该占着租约等两分钟。 */
    timeoutSeconds: z.number().int().positive().default(30),
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
  recall: z
    .object({
      /** fast(0 次 LLM) | balanced(1) | deep(2) */
      mode: z.enum(['fast', 'balanced', 'deep']).default('balanced'),
      /** 首轮自动 fast */
      expandOnlyWithContext: z.boolean().default(true),
      /** 快速检索 top1 低于此分则升级 */
      escalateBelowScore: z.number().min(0).max(1).default(0.5),
      expansionTimeoutMs: z.number().int().positive().default(5000),
      rewriteTimeoutMs: z.number().int().positive().default(30000),
      /** 超了就用已拿到的结果 */
      budgetMs: z.number().int().positive().default(500),
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
    })
    .prefault({}),

  memory: z
    .object({
      reviewRequired: z.array(z.string()).default(['experiences', 'rules']),
      /** 开它会多一次 LLM 调用 */
      workingMemory: z
        .object({
          enabled: z.boolean().default(false),
        })
        .prefault({}),
    })
    .prefault({}),

  acl: z
    .object({
      enabled: z.boolean().default(true),
      /** write | read */
      groupDefaultLevel: z.enum(['write', 'read']).default('write'),
    })
    .prefault({}),

  server: z
    .object({
      host: z.string().default('127.0.0.1'),
      port: z.number().int().min(1).max(65535).default(1933),
    })
    .prefault({}),

  logging: z
    .object({
      level: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
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
  return config;
});

export type ComemConfig = z.infer<typeof configSchema>;

export { configSchema };
