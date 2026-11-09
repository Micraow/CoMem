/**
 * LLM 应用封装（架构文档 §4.4、§11.4、§17.4）。
 *
 * 这一层只依赖 `domain/llm.ts` 的 `LlmProvider` 接口，**永远不** import `ai`：
 * 供应商适配器在 `adapters/llm/`，重试、截断判定与用量统计在这里。
 *
 * ## 重试策略
 *
 * | 情况 | 是否重试 | 理由 |
 * |---|---|---|
 * | `PROVIDER_UNAVAILABLE` / `RESOURCE_EXHAUSTED` / `INTERNAL` | 是 | 同样的请求再来一次可能成功 |
 * | `UNAUTHENTICATED` / `INVALID_ARGUMENT` | 否 | 配置错了，重试多少次都一样 |
 * | `finishReason === 'length'` | 否 | 同样的输入与上限只会再截断一次，必须报错让人调大 `maxTokens`（§11.4） |
 * | `finishReason === 'refusal'` | 否 | 内容被安全策略过滤，重试同样的输入只会再被过滤 |
 *
 * 重试上限是 `maxAttempts`（**含首次**，默认 3，与 §10.4 的任务重试同源但少一次：
 * 任务重试 3 次 = 4 次尝试，LLM 是 3 次尝试 = 2 次重试）。
 *
 * ## 结构化输出的解析失败
 *
 * `generateJson` 的「解析失败重试一次」（§11.4）与上面的错误重试**共享**
 * `maxAttempts` 预算：一次解析失败会消耗一次 attempt，不会另开一条重试链路。
 * 第一次解析失败重试，第二次仍失败抛 `INVALID_ARGUMENT`。
 */

import type { ZodType } from 'zod';

import { ComemError, isRetryable } from '../domain/errors.js';
import type { LlmOptions, LlmPrompt, LlmProvider, LlmResult } from '../domain/llm.js';
import type { Logger } from '../domain/log.js';

export interface LlmPricing {
  /** 每 1M 输入 token 的美元单价（§18 的 `providers.llm.default.pricing`）。 */
  readonly inputPerMillion: number;
  /** 每 1M 输出 token 的美元单价。 */
  readonly outputPerMillion: number;
}

export interface LlmServiceOptions {
  readonly provider: LlmProvider;
  readonly logger: Logger;
  readonly pricing?: LlmPricing;
  /** 默认 3（含首次），来源见文件头。 */
  readonly maxAttempts?: number;
  /** 默认 500ms 起步，指数退避，上限 8s。 */
  readonly retryBaseDelayMs?: number;
  /**
   * 日志字段 `model` 的取值（§17.4 的指标标签）。
   *
   * `LlmProvider` 接口故意不暴露模型名——上层不该知道自己用的哪家模型。但每条
   * 调用日志都要能回答「刚才花的是哪个模型」，所以由装配方（bootstrap）显式传入。
   */
  readonly model?: string;
}

export interface LlmCallStats {
  readonly calls: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
  /** 按 pricing 换算；没配 pricing 时为 null。 */
  readonly costUsd: number | null;
  readonly truncated: number;
  readonly failed: number;
}

/** 重试上限含首次：3 次尝试 = 2 次重试（§10.4 的任务重试是 3 次重试，LLM 少一次）。 */
const DEFAULT_MAX_ATTEMPTS = 3;

/**
 * 退避起点。
 *
 * 500ms / 8s 都是**经验值，来源未知**：架构文档只给了「重试」和「指数退避」，
 * 没给具体参数。取值依据是「第一次重试不要立刻打回供应商，最后一次退避不要
 * 让后台任务等太久」，没有实测数据。
 */
const DEFAULT_RETRY_BASE_DELAY_MS = 500;

/** 退避上限，来源同上。 */
const MAX_RETRY_DELAY_MS = 8_000;

/** §18 的 pricing 按 1M token 计。 */
const TOKENS_PER_MILLION = 1_000_000;

/** 解析失败最多尝试 2 次（§11.4：只重试一次）。 */
const JSON_PARSE_ATTEMPTS = 2;

/** 抖动下界：`0.5 + Math.random() * 0.5` 即 50%–100% 的「equal jitter」。 */
const JITTER_FLOOR = 0.5;

/** 未配置模型名时的日志取值。机器可读日志不留空，用固定串。 */
const UNKNOWN_MODEL = 'unknown';

interface MutableStats {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  costUsd: number | null;
  truncated: number;
  failed: number;
}

function sleep(durationMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, durationMs);
  });
}

export class LlmService {
  private readonly provider: LlmProvider;
  private readonly logger: Logger;
  private readonly pricing: LlmPricing | undefined;
  private readonly maxAttempts: number;
  private readonly retryBaseDelayMs: number;
  private readonly modelName: string;
  private totals: MutableStats;

  constructor(options: LlmServiceOptions) {
    this.provider = options.provider;
    this.logger = options.logger;
    this.pricing = options.pricing;
    this.maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
    this.retryBaseDelayMs = Math.max(0, options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS);
    this.modelName = options.model ?? UNKNOWN_MODEL;
    this.totals = this.emptyStats();
  }

  /**
   * 生成文本。
   *
   * 截断（`finishReason === 'length'`）与拒绝（`'refusal'`）**不重试**：直接抛
   * `PROVIDER_UNAVAILABLE`，调用方（抽取管线）据此不写 `.done`（§10.1）。
   */
  async generate(prompt: LlmPrompt, options?: LlmOptions): Promise<LlmResult> {
    let attempt = 0;
    for (;;) {
      attempt += 1;
      const startedAt = Date.now();
      let result: LlmResult;
      try {
        result = await this.provider.complete(prompt, options);
      } catch (error) {
        const failure = ComemError.from(error);
        // 上游已经取消时不再重试：同一个信号会立刻中止下一次调用，只会白等一个退避。
        const canRetry =
          isRetryable(failure) && attempt < this.maxAttempts && options?.abortSignal?.aborted !== true;
        if (canRetry) {
          this.logRetry(failure, attempt, { parseFailure: false });
          await sleep(this.retryDelay(attempt));
          continue;
        }
        throw this.failCall(failure, attempt, startedAt, options);
      }

      this.recordCall(result, startedAt);

      // 截断：重试同样的 maxTokens 只会再截断一次，必须报错让人调大（§11.4）。
      if (result.finishReason === 'length') {
        this.totals.truncated += 1;
        throw new ComemError(
          'PROVIDER_UNAVAILABLE',
          '模型输出被截断，请调大 maxTokens 后重试。',
          { finishReason: result.finishReason, completionTokens: result.usage.completionTokens },
        );
      }
      // 拒绝：内容被安全策略过滤，重试同样的输入只会再被过滤。
      if (result.finishReason === 'refusal') {
        this.totals.failed += 1;
        throw new ComemError('PROVIDER_UNAVAILABLE', '模型拒绝了这次请求：内容被安全策略过滤。', {
          finishReason: result.finishReason,
        });
      }
      return result;
    }
  }

  /**
   * 生成结构化对象（§11.4）。
   *
   * 解析失败（provider 返回了不合 schema 的 JSON）由适配器映射成
   * `INVALID_ARGUMENT`，这里**只重试一次**；第二次仍失败就原样抛出
   * `INVALID_ARGUMENT`，调用方不写 `.done`。解析失败与传输错误共享
   * `maxAttempts` 预算。
   */
  async generateJson<T>(
    prompt: LlmPrompt,
    schema: ZodType<T>,
    options?: LlmOptions,
  ): Promise<T> {
    let attempt = 0;
    let parseFailures = 0;
    for (;;) {
      attempt += 1;
      const startedAt = Date.now();
      let value: T;
      try {
        value = await this.provider.completeJson(prompt, schema, options);
      } catch (error) {
        const failure = ComemError.from(error);
        // 截断不是解析失败：模型没说完，重试同样的 maxTokens 只会再截断一次
        // （§11.4 明确要求不重试）。适配层用 `truncated` 标记区分这一种。
        if (failure.details?.['truncated'] === true) {
          throw this.failCall(failure, attempt, startedAt, options);
        }
        // 解析失败只重试一次；其余错误按 §19 的可重试集合判断。两者共享
        // maxAttempts 预算：一次解析失败会消耗一次 attempt。
        const parseFailure = failure.code === 'INVALID_ARGUMENT';
        if (parseFailure) {
          parseFailures += 1;
        }
        const canRetry = parseFailure ? parseFailures < JSON_PARSE_ATTEMPTS : isRetryable(failure);
        // 上游已取消时不再重试：同一个信号会立刻中止下一次调用。
        if (canRetry && attempt < this.maxAttempts && options?.abortSignal?.aborted !== true) {
          this.logRetry(failure, attempt, { parseFailure });
          await sleep(this.retryDelay(attempt));
          continue;
        }
        throw this.failCall(failure, attempt, startedAt, options);
      }

      // 结构化输出拿不到 usage（`LlmProvider.completeJson` 只返回对象），
      // 所以这里只累加调用次数，token 与成本保持 0，日志里也不写 token——
      // 写 0 会被读成「这次调用没花钱」。
      this.totals.calls += 1;
      this.logger.info('模型结构化输出完成', {
        model: this.modelName,
        attempt,
        durationMs: Date.now() - startedAt,
      });
      return value;
    }
  }

  /** 用量统计（§17.4）。返回快照，调用方改不到内部状态。 */
  get stats(): LlmCallStats {
    return { ...this.totals };
  }

  /**
   * 失败收尾：记日志、计数、返回要抛的错误。
   *
   * 单独抽出来是因为 `generate` 与 `generateJson` 的重试判定不同（后者多一条
   * 「解析失败」），但失败后的记账与日志完全一样。
   */
  private failCall(
    error: unknown,
    attempt: number,
    startedAt: number,
    options: LlmOptions | undefined,
  ): ComemError {
    const failure = ComemError.from(error);
    if (options?.abortSignal?.aborted === true) {
      // 上游取消不是供应商故障：不计数、不重试（重试会立刻被同一个信号中止）。
      this.logger.warn('模型调用被上游取消', { model: this.modelName, attempt });
      return failure;
    }
    // 截断不是「失败」：模型正常回答了，只是没说完。两个计数器回答的是不同问题
    // （「要不要调大 maxTokens」vs「供应商是不是坏了」），混在一起会让监控页给出
    // 错误建议。结构化输出路径只能从 `truncated` 标记看出这一点。
    if (failure.details?.['truncated'] === true) {
      this.totals.truncated += 1;
    } else {
      this.totals.failed += 1;
    }
    this.logger.error('模型调用失败', {
      model: this.modelName,
      attempt,
      maxAttempts: this.maxAttempts,
      code: failure.code,
      message: failure.message,
      durationMs: Date.now() - startedAt,
    });
    return failure;
  }

  private logRetry(error: ComemError, attempt: number, extra: { readonly parseFailure: boolean }): void {
    this.logger.warn('模型调用失败，准备重试', {
      model: this.modelName,
      attempt,
      maxAttempts: this.maxAttempts,
      code: error.code,
      message: error.message,
      ...extra,
    });
  }

  /** 记录一次成功调用：调用数、token、成本、info 日志。 */
  private recordCall(result: LlmResult, startedAt: number): void {
    this.totals.calls += 1;
    this.totals.promptTokens += result.usage.promptTokens;
    this.totals.completionTokens += result.usage.completionTokens;

    const cost = this.costOf(result.usage.promptTokens, result.usage.completionTokens);
    if (cost !== null) {
      this.totals.costUsd = (this.totals.costUsd ?? 0) + cost;
    }

    this.logger.info('模型调用完成', {
      model: this.modelName,
      promptTokens: result.usage.promptTokens,
      completionTokens: result.usage.completionTokens,
      finishReason: result.finishReason,
      durationMs: Date.now() - startedAt,
    });
  }

  /** 按 §18 的单价换算成美元；没配 pricing 时返回 null（「不知道」不是「0」）。 */
  private costOf(promptTokens: number, completionTokens: number): number | null {
    if (this.pricing === undefined) {
      return null;
    }
    return (
      (promptTokens * this.pricing.inputPerMillion +
        completionTokens * this.pricing.outputPerMillion) /
      TOKENS_PER_MILLION
    );
  }

  /**
   * 指数退避 + 抖动。
   *
   * 第 n 次重试等 `base × 2^(n-1)`，上限 8s；再乘 50%–100% 的随机系数，
   * 避免多个后台任务在同一时刻一起重试造成尖峰。
   */
  private retryDelay(attempt: number): number {
    const exponential = Math.min(
      this.retryBaseDelayMs * 2 ** (attempt - 1),
      MAX_RETRY_DELAY_MS,
    );
    return exponential * (JITTER_FLOOR + Math.random() * (1 - JITTER_FLOOR));
  }

  private emptyStats(): MutableStats {
    return {
      calls: 0,
      promptTokens: 0,
      completionTokens: 0,
      costUsd: this.pricing === undefined ? null : 0,
      truncated: 0,
      failed: 0,
    };
  }
}
