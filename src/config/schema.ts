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

const levelWeightsSchema = z
  .object({
    l0: z.number().positive().default(1.15),
    l1: z.number().positive().default(1.05),
    l2: z.number().positive().default(1.0),
  })
  .prefault({});

const retrievalSchema = z.object({
  /** `fts5` | `vector`（v1 只有 fts5） */
  engine: z.enum(['fts5', 'vector']).default('fts5'),
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

const configSchema = z.object({
  /** 数据根。留空表示按运行形态推导（见 §6.5），容器里由镜像钉死为 /var/lib/comem */
  dataDir: z.string().default(''),

  providers: z
    .object({
      llm: z
        .object({
          default: llmProviderSchema.prefault({}),
        })
        .prefault({}),
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

export type ComemConfig = z.infer<typeof configSchema>;

export { configSchema };
