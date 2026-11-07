/**
 * Vercel AI SDK 适配器（架构文档 §4.4）。
 *
 * 这是整个仓库**唯一**允许 `import ... from 'ai'` 的文件：ESLint 在 `domain/` 与
 * `services/` 都挡死了 `ai` 与 `@ai-sdk/*`，适配层是它唯一合法的家。上层只看到
 * `LlmProvider` 的两个方法，换供应商只改配置里的 `type`（§18）。
 *
 * 这一层只做三件事：把 `LlmPrompt` 翻成 SDK 的调用参数、把 SDK 的
 * `finishReason` 映射回契约、把 SDK 的错误收敛成 `ComemError`。
 *
 * **不重试。** 重试策略在 `services/llm.ts`：SDK 默认会重试 2 次，那会绕过上层
 * 「截断不重试」「认证失败不重试」的判断，所以调用时显式 `maxRetries: 0`。
 *
 * **不换算成本。** 只返回 `usage`，单价在 `services/llm.ts` 里乘——适配器不知道
 * 配置里配了什么价格。
 */

import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import {
  generateObject,
  generateText,
  JSONParseError,
  NoObjectGeneratedError,
  TypeValidationError,
  type LanguageModel,
  type ModelMessage,
} from 'ai';
import type { ZodType } from 'zod';

import { ComemError } from '../../domain/errors.js';
import type {
  LlmMessage,
  LlmOptions,
  LlmPrompt,
  LlmProvider,
  LlmResult,
  LlmUsage,
} from '../../domain/llm.js';
import type { Logger } from '../../domain/log.js';

export interface AiSdkProviderOptions {
  /** 对应 `config.providers.llm.default`（§18）。 */
  readonly type: 'openai-compatible' | 'anthropic';
  readonly baseUrl?: string;
  readonly model: string;
  readonly apiKey: string;
  readonly maxTokens: number;
  readonly timeoutSeconds: number;
  /** 用于成本换算，按 1M token 计；换算在上层做，这里只透传。 */
  readonly pricing?: {
    readonly inputPerMillion: number;
    readonly outputPerMillion: number;
  };
  readonly logger: Logger;
}

/**
 * openai-compatible 的 SDK 设置要求 `baseURL` 非空字符串（`@ai-sdk/openai-compatible`
 * 的类型是必填）。`config.providers.llm.default.baseUrl` 有默认值，正常路径不会
 * 走到这里；兜底成 OpenAI 官方地址，避免把 `undefined` 拼进请求 URL。
 */
const OPENAI_DEFAULT_BASE_URL = 'https://api.openai.com/v1';

/** 毫秒与秒的换算。`timeoutSeconds` 的单位是秒，`setTimeout` 的单位是毫秒。 */
const MILLISECONDS_PER_SECOND = 1000;

/**
 * 契约里的 `finishReason` 只有三个值（`domain/llm.ts`）。
 *
 * AI SDK 给的是 `'stop' | 'length' | 'content-filter' | 'tool-calls' | 'error' |
 * 'interrupted' | 'other'`。多出来的值一律按 `stop` 处理并记 warn：当成 `length`
 * 会让上层误报「调大 maxTokens」，当成 `refusal` 会掩盖供应商故障。
 */
function mapFinishReason(reason: string, logger: Logger, model: string): LlmResult['finishReason'] {
  switch (reason) {
    case 'stop':
      return 'stop';
    case 'length':
      return 'length';
    case 'content-filter':
      return 'refusal';
    default:
      logger.warn('模型返回契约外的 finishReason，按 stop 处理', { model, finishReason: reason });
      return 'stop';
  }
}

/**
 * AI SDK 的 usage 字段名在不同版本 / provider 之间不一致：v4 起是
 * `inputTokens` / `outputTokens`，更早的版本与部分兼容实现仍是
 * `promptTokens` / `completionTokens`。两种都兼容，缺的按 0 算。
 */
interface RawUsage {
  readonly promptTokens?: number;
  readonly completionTokens?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}

function readUsage(usage: RawUsage): LlmUsage {
  return {
    promptTokens: usage.promptTokens ?? usage.inputTokens ?? 0,
    completionTokens: usage.completionTokens ?? usage.outputTokens ?? 0,
  };
}

/** `APICallError` 的 `statusCode`。用结构判断而不是 `instanceof`：测试替身不必构造真类。 */
function readStatusCode(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('statusCode' in error)) {
    return undefined;
  }
  const statusCode: unknown = error.statusCode;
  return typeof statusCode === 'number' ? statusCode : undefined;
}

/**
 * 结构化输出解析失败（模型返回了不合 schema 的 JSON）。
 *
 * `generateObject` 在解析或校验失败时抛 `NoObjectGeneratedError`，其 `cause` 是
 * `JSONParseError` 或 `TypeValidationError`。三种都算解析失败：上层据此重试一次
 * （§11.4）。映射成 `INVALID_ARGUMENT` 而不是 `INTERNAL`，是为了让
 * `services/llm.ts` 能把它和供应商故障区分开。
 *
 * **截断是例外，必须单独判。** `finishReason === 'length'` 时模型根本没说完，
 * 抛出来的 `NoObjectGeneratedError` 也是「解析失败」，重试只会用同样的上限再截断
 * 一次（§11.4 明确要求不重试）。所以先看 `finishReason`，命中就映射成
 * `PROVIDER_UNAVAILABLE` 并带 `truncated` 标记，让上层跳过重试。
 */
function isJsonGenerationFailure(error: unknown): boolean {
  return (
    NoObjectGeneratedError.isInstance(error) ||
    JSONParseError.isInstance(error) ||
    TypeValidationError.isInstance(error)
  );
}

interface ProviderErrorContext {
  /** 超时定时器是否已经触发。区分「超时」与「上游取消」只能靠这个标记。 */
  readonly timedOut: boolean;
  readonly timeoutMs: number;
}

/**
 * 错误映射（架构文档 §19）。
 *
 * - 401 / 403 → `UNAUTHENTICATED`（API Key 无效或没有模型权限）；
 * - 400 / 404 / 422 → `INVALID_ARGUMENT`（模型名写错、请求体不合法）；
 * - 429 → `RESOURCE_EXHAUSTED`（限流 / 配额不足）；
 * - 5xx 与网络错误 → `PROVIDER_UNAVAILABLE`；
 * - 其余 → `INTERNAL`。
 *
 * **400 类必须映射成不可重试的错误。** 模型名拼错、`maxTokens` 超出供应商上限这类
 * 问题，重试三次的结果完全一样，只是把「立刻失败」拖成「几秒后失败」，还会在监控
 * 里留下三条假故障。`INTERNAL` 是可重试的，所以不能落到那条分支。
 *
 * 不在这一层重试：重试是 `services/llm.ts` 的职责，它还需要根据 `finishReason`
 * 决定「截断不重试」。
 */
function mapProviderError(error: unknown, context: ProviderErrorContext): ComemError {
  if (error instanceof ComemError) {
    return error;
  }
  if (context.timedOut) {
    return new ComemError(
      'PROVIDER_UNAVAILABLE',
      `模型调用超时（${context.timeoutMs} 毫秒），请检查供应商可用性或调大 timeoutSeconds。`,
      { timeoutMs: context.timeoutMs },
    );
  }
  if (isJsonGenerationFailure(error)) {
    if (NoObjectGeneratedError.isInstance(error) && error.finishReason === 'length') {
      return new ComemError(
        'PROVIDER_UNAVAILABLE',
        '模型输出被截断，结构化结果不完整。请调大 maxTokens 后重试。',
        { truncated: true, finishReason: error.finishReason },
      );
    }
    return new ComemError('INVALID_ARGUMENT', '模型输出不是合法的结构化数据，无法按 schema 解析。', {
      cause: error instanceof Error ? error.name : typeof error,
    });
  }

  const statusCode = readStatusCode(error);
  if (statusCode === 401 || statusCode === 403) {
    return new ComemError(
      'UNAUTHENTICATED',
      '模型供应商拒绝了这次请求：API Key 无效，或没有访问该模型的权限。',
      { statusCode },
    );
  }
  if (statusCode === 400 || statusCode === 404 || statusCode === 422) {
    return new ComemError(
      'INVALID_ARGUMENT',
      '模型供应商拒绝了这次请求：请检查模型名、maxTokens 与请求体格式。',
      { statusCode },
    );
  }
  if (statusCode === 429) {
    return new ComemError('RESOURCE_EXHAUSTED', '模型供应商限流或配额不足，请稍后重试。', {
      statusCode,
    });
  }
  if (statusCode !== undefined && statusCode >= 500) {
    return new ComemError('PROVIDER_UNAVAILABLE', `模型供应商暂时不可用（HTTP ${statusCode}）。`, {
      statusCode,
    });
  }
  // fetch 在网络不可达时抛 TypeError；SDK 不会把它包成 APICallError。
  if (error instanceof TypeError) {
    return new ComemError('PROVIDER_UNAVAILABLE', '无法连接模型供应商，请检查网络。', {
      cause: error.message,
    });
  }
  return ComemError.from(error);
}

/** `LlmMessage` 的三分法正好对应 AI SDK 的三种消息类型，逐分支构造让类型收窄。 */
function toModelMessage(message: LlmMessage): ModelMessage {
  if (message.role === 'system') {
    return { role: 'system', content: message.content };
  }
  if (message.role === 'user') {
    return { role: 'user', content: message.content };
  }
  return { role: 'assistant', content: message.content };
}

/**
 * 按 `type` 选 SDK 并构造模型实例（§18：换供应商只改配置，不改代码）。
 *
 * `type` 是字符串字面量联合，两个分支各构造一家 provider；运行期实例类型都兼容
 * AI SDK 的 `LanguageModel`。
 */
function createLanguageModel(options: AiSdkProviderOptions): LanguageModel {
  if (options.type === 'anthropic') {
    const provider = createAnthropic({ apiKey: options.apiKey, baseURL: options.baseUrl });
    return provider(options.model);
  }
  const provider = createOpenAICompatible({
    // `name` 只进日志与 telemetry，用产品名便于归因（§17.4 的 provider 标签）。
    name: 'comem',
    baseURL: options.baseUrl ?? OPENAI_DEFAULT_BASE_URL,
    apiKey: options.apiKey,
  });
  return provider(options.model);
}

export class AiSdkLlmProvider implements LlmProvider {
  private readonly model: LanguageModel;
  private readonly modelId: string;
  private readonly maxTokens: number;
  private readonly timeoutSeconds: number;
  private readonly logger: Logger;

  constructor(options: AiSdkProviderOptions) {
    this.modelId = options.model;
    this.maxTokens = options.maxTokens;
    this.timeoutSeconds = options.timeoutSeconds;
    this.logger = options.logger;
    this.model = createLanguageModel(options);
  }

  async complete(prompt: LlmPrompt, options?: LlmOptions): Promise<LlmResult> {
    const result = await this.run(
      (abortSignal) =>
        generateText({
          model: this.model,
          ...(prompt.system === undefined ? {} : { instructions: prompt.system }),
          messages: prompt.messages.map(toModelMessage),
          maxOutputTokens: options?.maxTokens ?? this.maxTokens,
          ...(options?.temperature === undefined ? {} : { temperature: options.temperature }),
          // 重试在上层；SDK 的默认重试（2 次）会绕过「截断不重试」的判断。
          maxRetries: 0,
          abortSignal,
        }),
      options,
    );

    const usage = readUsage(result.usage);
    return {
      text: result.text,
      usage,
      finishReason: mapFinishReason(result.finishReason, this.logger, this.modelId),
    };
  }

  async completeJson<T>(prompt: LlmPrompt, schema: ZodType<T>, options?: LlmOptions): Promise<T> {
    const result = await this.run(
      (abortSignal) =>
        generateObject({
          model: this.model,
          schema,
          ...(prompt.system === undefined ? {} : { instructions: prompt.system }),
          messages: prompt.messages.map(toModelMessage),
          maxOutputTokens: options?.maxTokens ?? this.maxTokens,
          ...(options?.temperature === undefined ? {} : { temperature: options.temperature }),
          maxRetries: 0,
          abortSignal,
        }),
      options,
    );
    return result.object;
  }

  /**
   * 单次调用的超时与取消。
   *
   * 超时用 `AbortController` + `setTimeout`：SDK 会把信号透传给 fetch，底层连接
   * 随之中断。`LlmOptions.abortSignal`（HTTP 请求断开时由接口层传入）与超时信号
   * 用 `AbortSignal.any` 合并——任一触发都中止这次调用。
   *
   * 定时器 `unref()`：生成正常结束时它会清掉，但进程退出时不该被一个 120 秒的
   * 计时器拖住。
   */
  private async run<T>(
    operation: (abortSignal: AbortSignal) => Promise<T>,
    options?: LlmOptions,
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
      options?.abortSignal === undefined
        ? controller.signal
        : AbortSignal.any([controller.signal, options.abortSignal]);

    try {
      return await operation(abortSignal);
    } catch (error) {
      throw mapProviderError(error, { timedOut, timeoutMs });
    } finally {
      clearTimeout(timer);
    }
  }
}
