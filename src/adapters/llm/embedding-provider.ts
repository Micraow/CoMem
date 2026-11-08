/**
 * Vercel AI SDK 嵌入适配器（架构文档 §4.4、§18 的 `providers` 段）。
 *
 * 与 `ai-sdk-provider.ts` 并列而不是合并：两者都用 `ai`，但一个做生成、一个做
 * 嵌入。合并之后 `LlmProvider` 的每个实现都要实现两套方法，而 `FakeLlmProvider`
 * 之类只关心生成的替身会被迫带上一个永远不用的 `embed`。
 *
 * 这一层只做三件事：把 `texts` 切成供应商能接受的批、把 SDK 的 usage 映射回契约、
 * 把 SDK 的错误收敛成 `ComemError`。
 *
 * **不重试。** 与 `ai-sdk-provider.ts` 同一条理由：重试策略在上层，SDK 默认的 2 次
 * 重试会绕过「认证失败不重试」「维度不匹配不重试」的判断，所以调用时显式
 * `maxRetries: 0`。
 *
 * **错误映射是复制的。** `ai-sdk-provider.ts` 的 `mapProviderError` 没有导出，
 * 本 wave 的文件所有权也不包含它。规则逐条对齐（401/403、400/404/422、429、5xx、
 * 网络错误），复制而不是共享；等两边都需要改的时候再抽公共模块，现在抽只会多一层
 * 间接。
 */

import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { embedMany, type EmbeddingModel } from 'ai';

import type {
  EmbeddingOptions,
  EmbeddingProvider,
  EmbeddingResult,
} from '../../domain/embedding.js';
import { ComemError } from '../../domain/errors.js';
import type { Logger } from '../../domain/log.js';

export interface AiSdkEmbeddingProviderOptions {
  /**
   * 与 `config.providers.llm.default.type` 同一组取值。
   *
   * `anthropic` 在构造时就抛 `INVALID_ARGUMENT`：Anthropic 不提供嵌入接口
   * （官方推荐接第三方嵌入服务），SDK 的 `embeddingModel()` 会抛
   * `NoSuchModelError`。提前失败比让 `embed()` 在第一次回填时炸更清楚。
   */
  readonly type: 'openai-compatible' | 'anthropic';
  /** `openai-compatible` 必填；`anthropic` 分支在读到它之前就抛错了。 */
  readonly baseUrl?: string;
  readonly model: string;
  readonly apiKey: string;
  /** 期望的向量维度。供应商返回的每条向量都要等于它，否则是配置错误。 */
  readonly dimension: number;
  /** 单次请求的文本条数上限。默认 128，见 `DEFAULT_MAX_BATCH_SIZE`。 */
  readonly maxBatchSize?: number;
  /** 单批调用的超时，秒。默认 30，见 `DEFAULT_TIMEOUT_SECONDS`。 */
  readonly timeoutSeconds?: number;
  readonly logger: Logger;
}

/**
 * 单批的最大条数。
 *
 * 128 是经验值，来源是「供应商常见上限」而不是任何一份文档的具体数字：OpenAI 的
 * embeddings 接口单次最多 2048 条输入，Azure OpenAI 是 16，多数兼容实现落在
 * 100–2048 之间。取 128 对常见供应商都安全——分批是必须的（一次传 10000 条会被
 * 拒绝），但批太小会把一次回填变成上千次往返。真实供应商有更小的上限时用配置
 * `maxBatchSize` 覆盖。
 */
const DEFAULT_MAX_BATCH_SIZE = 128;

/**
 * 单批超时，秒。
 *
 * 30 秒是经验值：嵌入是短请求，一次 128 条的往返通常在秒级；`LlmProvider` 的
 * 120 秒是按「生成长文本」定的，照搬到嵌入上只会让卡住的回填任务占着租约等两分钟。
 */
const DEFAULT_TIMEOUT_SECONDS = 30;

/** 毫秒与秒的换算。`timeoutSeconds` 的单位是秒，`setTimeout` 的单位是毫秒。 */
const MILLISECONDS_PER_SECOND = 1000;

/**
 * openai-compatible 的 SDK 设置要求 `baseURL` 非空字符串。
 * 与 `ai-sdk-provider.ts` 同一个兜底值，正常路径不会走到。
 */
const OPENAI_DEFAULT_BASE_URL = 'https://api.openai.com/v1';

/** `APICallError` 的 `statusCode`。用结构判断而不是 `instanceof`：测试替身不必构造真类。 */
function readStatusCode(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('statusCode' in error)) {
    return undefined;
  }
  const statusCode: unknown = error.statusCode;
  return typeof statusCode === 'number' ? statusCode : undefined;
}

interface ErrorContext {
  /** 超时定时器是否已经触发。区分「超时」与「上游取消」只能靠这个标记。 */
  readonly timedOut: boolean;
  readonly timeoutMs: number;
}

/**
 * 错误映射（架构文档 §19），规则与 `ai-sdk-provider.ts` 逐条对齐：
 *
 * - 401 / 403 → `UNAUTHENTICATED`（API Key 无效或没有模型权限）；
 * - 400 / 404 / 422 → `INVALID_ARGUMENT`（模型名写错、请求体不合法，重试结果一样）；
 * - 429 → `RESOURCE_EXHAUSTED`（限流 / 配额不足，可重试）；
 * - 5xx 与网络错误 → `PROVIDER_UNAVAILABLE`（可重试）；
 * - 其余 → `INTERNAL`。
 */
function mapEmbeddingError(error: unknown, context: ErrorContext): ComemError {
  if (error instanceof ComemError) {
    return error;
  }
  if (context.timedOut) {
    return new ComemError(
      'PROVIDER_UNAVAILABLE',
      `嵌入调用超时（${context.timeoutMs} 毫秒），请检查供应商可用性或调大 timeoutSeconds。`,
      { timeoutMs: context.timeoutMs },
    );
  }

  const statusCode = readStatusCode(error);
  if (statusCode === 401 || statusCode === 403) {
    return new ComemError(
      'UNAUTHENTICATED',
      '嵌入供应商拒绝了这次请求：API Key 无效，或没有访问该模型的权限。',
      { statusCode },
    );
  }
  if (statusCode === 400 || statusCode === 404 || statusCode === 422) {
    return new ComemError(
      'INVALID_ARGUMENT',
      '嵌入供应商拒绝了这次请求：请检查模型名、maxBatchSize 与请求体格式。',
      { statusCode },
    );
  }
  if (statusCode === 429) {
    return new ComemError('RESOURCE_EXHAUSTED', '嵌入供应商限流或配额不足，请稍后重试。', {
      statusCode,
    });
  }
  if (statusCode !== undefined && statusCode >= 500) {
    return new ComemError('PROVIDER_UNAVAILABLE', `嵌入供应商暂时不可用（HTTP ${statusCode}）。`, {
      statusCode,
    });
  }
  // fetch 在网络不可达时抛 TypeError；SDK 不会把它包成 APICallError。
  if (error instanceof TypeError) {
    return new ComemError('PROVIDER_UNAVAILABLE', '无法连接嵌入供应商，请检查网络。', {
      cause: error.message,
    });
  }
  return ComemError.from(error);
}

/**
 * 构造嵌入模型实例。
 *
 * `anthropic` 分支在构造时抛错，理由见 `AiSdkEmbeddingProviderOptions.type`。
 */
function createEmbeddingModel(options: AiSdkEmbeddingProviderOptions): EmbeddingModel {
  if (options.type === 'anthropic') {
    throw new ComemError(
      'INVALID_ARGUMENT',
      'Anthropic 不提供嵌入接口，无法用它做向量检索。请改用 openai-compatible 的嵌入模型。',
      { type: options.type, model: options.model },
    );
  }
  const provider = createOpenAICompatible({
    // `name` 只进日志与 telemetry，与 `ai-sdk-provider.ts` 用同一个产品名。
    name: 'comem',
    baseURL: options.baseUrl ?? OPENAI_DEFAULT_BASE_URL,
    apiKey: options.apiKey,
  });
  return provider.embeddingModel(options.model);
}

export class AiSdkEmbeddingProvider implements EmbeddingProvider {
  readonly model: string;
  readonly dimension: number;

  private readonly embeddingModel: EmbeddingModel;
  private readonly maxBatchSize: number;
  private readonly timeoutSeconds: number;
  private readonly logger: Logger;

  constructor(options: AiSdkEmbeddingProviderOptions) {
    if (!Number.isInteger(options.dimension) || options.dimension <= 0) {
      throw new ComemError('INVALID_ARGUMENT', '嵌入维度必须是正整数。', {
        dimension: options.dimension,
      });
    }
    const maxBatchSize = options.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE;
    if (!Number.isInteger(maxBatchSize) || maxBatchSize <= 0) {
      throw new ComemError('INVALID_ARGUMENT', 'maxBatchSize 必须是正整数。', { maxBatchSize });
    }

    this.model = options.model;
    this.dimension = options.dimension;
    this.maxBatchSize = maxBatchSize;
    this.timeoutSeconds = options.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
    this.logger = options.logger;
    this.embeddingModel = createEmbeddingModel(options);
  }

  /**
   * 批量嵌入。
   *
   * 空输入直接返回，**不调网络**：回填任务在「没有待处理节点」时不应该产生一次
   * 计费请求，更不应该因为供应商不可用而失败。
   *
   * 分批是顺序的，不并发。并发会把回填在供应商侧打成突发流量，而回填的瓶颈本来
   * 就在供应商的限流上，不在本地等待。
   */
  async embed(texts: readonly string[], options?: EmbeddingOptions): Promise<EmbeddingResult> {
    if (texts.length === 0) {
      return { vectors: [], usage: { promptTokens: 0, totalTokens: 0 } };
    }

    const vectors: number[][] = [];
    let tokens = 0;
    let batches = 0;

    for (let start = 0; start < texts.length; start += this.maxBatchSize) {
      const batch = texts.slice(start, start + this.maxBatchSize);
      const result = await this.run(
        (abortSignal) =>
          embedMany({
            model: this.embeddingModel,
            values: [...batch],
            // 重试在上层；SDK 的默认重试（2 次）会绕过「认证失败不重试」的判断。
            maxRetries: 0,
            abortSignal,
          }),
        options,
      );
      batches += 1;
      tokens += result.usage.tokens;

      for (const embedding of result.embeddings) {
        if (embedding.length !== this.dimension) {
          // 维度不一致是配置错误（模型换了、配置写错），但它落在供应商的返回里，
          // 按契约映射成 PROVIDER_UNAVAILABLE；`details` 里的 expected / actual
          // 是唯一能让人一眼看出问题的那条信息。
          //
          // 注意 PROVIDER_UNAVAILABLE 在 `domain/errors.ts` 的 `RETRYABLE_CODES` 里：
          // 上层重试一次仍然会拿到同样的维度。这条映射与「配置错误不重试」的原则
          // 冲突，改成 INVALID_ARGUMENT 是一次调用方兼容性变更，需要先确认。
          throw new ComemError(
            'PROVIDER_UNAVAILABLE',
            `嵌入模型返回的向量维度与配置不一致：期望 ${this.dimension}，实际 ${embedding.length}。`,
            { expected: this.dimension, actual: embedding.length, model: this.model },
          );
        }
        vectors.push([...embedding]);
      }
    }

    this.logger.debug('嵌入调用', { model: this.model, texts: texts.length, batches, tokens });
    // 嵌入只有输入 token，`promptTokens` 与 `totalTokens` 是同一个数。
    return { vectors, usage: { promptTokens: tokens, totalTokens: tokens } };
  }

  /**
   * 单批调用的超时与取消。
   *
   * 超时用 `AbortController` + `setTimeout`：SDK 会把信号透传给 fetch，底层连接
   * 随之中断。`EmbeddingOptions.signal`（HTTP 请求断开时由接口层传入）与超时信号
   * 用 `AbortSignal.any` 合并——任一触发都中止这次调用。
   *
   * 定时器 `unref()`：正常结束时它会清掉，但进程退出时不该被一个 30 秒的计时器拖住。
   */
  private async run<T>(
    operation: (abortSignal: AbortSignal) => Promise<T>,
    options?: EmbeddingOptions,
  ): Promise<T> {
    const timeoutMs = options?.timeoutMs ?? this.timeoutSeconds * MILLISECONDS_PER_SECOND;
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    timer.unref();

    const abortSignal =
      options?.signal === undefined
        ? controller.signal
        : AbortSignal.any([controller.signal, options.signal]);

    try {
      return await operation(abortSignal);
    } catch (error) {
      throw mapEmbeddingError(error, { timedOut, timeoutMs });
    } finally {
      clearTimeout(timer);
    }
  }
}
