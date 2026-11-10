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
import { MILLISECONDS_PER_SECOND } from '../../domain/time.js';
import { OPENAI_DEFAULT_BASE_URL } from './provider-defaults.js';
import {
  mapProviderError,
  type ProviderErrorMapOptions,
} from './provider-error-mapping.js';

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

/**
 * 结构化输出失败 → 领域失败；不认识的形态返回 `undefined`，交给共享映射按状态码
 * 处理。这是三家适配器里唯一的「真正的差异」：只有生成链路有 `generateObject`。
 */
function classifyJsonGenerationFailure(error: unknown): ComemError | undefined {
  if (!isJsonGenerationFailure(error)) {
    return undefined;
  }
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

/**
 * 生成链路的错误映射参数（架构文档 §19）。状态码、超时与网络错误的判定在
 * `provider-error-mapping.ts` 里与嵌入 / 重排共用，这里只声明本链路的文案与
 * 结构化输出分类。
 */
const ERROR_MAP_OPTIONS: ProviderErrorMapOptions = {
  call: '模型调用',
  vendor: '模型供应商',
  invalidArgumentHint: '请检查模型名、maxTokens 与请求体格式',
  networkHint: '请检查网络',
  classify: classifyJsonGenerationFailure,
};

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
   * `LlmOptions.timeoutMs` 是**上限**：实际取
   * `min(构造时的 timeoutSeconds * 1000, timeoutMs)`，内部预算（意图分析的
   * `REWRITE_TIMEOUT_MS`）只能收紧用户配置。
   *
   * 定时器 `unref()`：生成正常结束时它会清掉，但进程退出时不该被一个 120 秒的
   * 计时器拖住。
   */
  private async run<T>(
    operation: (abortSignal: AbortSignal) => Promise<T>,
    options?: LlmOptions,
  ): Promise<T> {
    // 与重排、嵌入同一语义：`timeoutMs` 只能收紧 `providers.llm.*.timeoutSeconds`，
    // 不能放宽。意图分析的 10 秒预算不该把用户配的 1 秒变成 10 秒。
    const configuredMs = this.timeoutSeconds * MILLISECONDS_PER_SECOND;
    const timeoutMs =
      options?.timeoutMs === undefined ? configuredMs : Math.min(configuredMs, options.timeoutMs);
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
      throw mapProviderError(error, { timedOut, timeoutMs }, ERROR_MAP_OPTIONS);
    } finally {
      clearTimeout(timer);
    }
  }
}
