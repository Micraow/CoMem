import { ComemError, isRetryable } from '../domain/errors.js';
import type {
  LlmCallKind,
  LlmOptions,
  LlmProvider,
  LlmUsage,
} from '../domain/llm.js';
import type { Logger } from '../domain/log.js';

import { persistLlmCall, type LlmCallLogPort } from './llm-call-log.js';
import { llmCostUsd, type LlmPricing } from './llm-cost.js';

export interface LlmStatsState {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  costUsd: number | null;
  truncated: number;
  failed: number;
}

export interface LlmRuntimeState {
  readonly provider: LlmProvider;
  readonly logger: Logger;
  readonly pricing: LlmPricing | undefined;
  readonly maxAttempts: number;
  readonly retryBaseDelayMs: number;
  readonly modelName: string;
  readonly callLog: LlmCallLogPort | undefined;
  readonly totals: LlmStatsState;
}

export interface LlmUsageTally {
  promptTokens: number;
  completionTokens: number;
  complete: boolean;
}

const MAX_RETRY_DELAY_MS = 8_000;
const JITTER_FLOOR = 0.5;

function sleep(durationMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, durationMs);
  });
}

export function canRetry(
  runtime: LlmRuntimeState,
  error: unknown,
  attempt: number,
  options: LlmOptions | undefined,
): boolean {
  return (
    isRetryable(ComemError.from(error)) &&
    attempt < runtime.maxAttempts &&
    options?.retry !== false &&
    options?.abortSignal?.aborted !== true
  );
}

function retryDelay(runtime: LlmRuntimeState, attempt: number): number {
  const exponential = Math.min(
    runtime.retryBaseDelayMs * 2 ** (attempt - 1),
    MAX_RETRY_DELAY_MS,
  );
  return exponential * (JITTER_FLOOR + Math.random() * (1 - JITTER_FLOOR));
}

function logRetry(
  runtime: LlmRuntimeState,
  error: ComemError,
  attempt: number,
  parseFailure: boolean,
): void {
  runtime.logger.warn('模型调用失败，准备重试', {
    model: runtime.modelName,
    attempt,
    maxAttempts: runtime.maxAttempts,
    code: error.code,
    message: error.message,
    parseFailure,
  });
}

function failCall(
  runtime: LlmRuntimeState,
  error: unknown,
  attempt: number,
  startedAt: number,
  options: LlmOptions | undefined,
): ComemError {
  const failure = ComemError.from(error);
  if (options?.abortSignal?.aborted === true) {
    runtime.logger.warn('模型调用被上游取消', { model: runtime.modelName, attempt });
    return failure;
  }
  if (failure.details?.['truncated'] === true) {
    runtime.totals.truncated += 1;
  } else {
    runtime.totals.failed += 1;
  }
  runtime.logger.error('模型调用失败', {
    model: runtime.modelName,
    attempt,
    maxAttempts: options?.retry === false ? 1 : runtime.maxAttempts,
    code: failure.code,
    message: failure.message,
    durationMs: Date.now() - startedAt,
  });
  return failure;
}

function recordUsage(
  runtime: LlmRuntimeState,
  usage: LlmUsage,
  kind: 'text' | 'json',
  finishReason: 'stop' | 'length' | 'refusal',
  startedAt: number,
  attempt: number,
): void {
  runtime.totals.calls += 1;
  runtime.totals.promptTokens += usage.promptTokens;
  runtime.totals.completionTokens += usage.completionTokens;
  const cost = llmCostUsd(runtime.pricing, usage.promptTokens, usage.completionTokens);
  if (cost !== null) {
    runtime.totals.costUsd = (runtime.totals.costUsd ?? 0) + cost;
  }
  runtime.logger.info(kind === 'text' ? '模型调用完成' : '模型结构化输出完成', {
    model: runtime.modelName,
    attempt,
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    finishReason,
    durationMs: Date.now() - startedAt,
  });
}

function addAttemptUsage(tally: LlmUsageTally, usage: LlmUsage): void {
  tally.promptTokens += usage.promptTokens;
  tally.completionTokens += usage.completionTokens;
}

function addFailedAttemptUsage(tally: LlmUsageTally, error: unknown): void {
  const details = ComemError.from(error).details?.['usage'];
  if (typeof details !== 'object' || details === null || Array.isArray(details)) {
    tally.complete = false;
    return;
  }
  const usage = details as Record<string, unknown>;
  const promptTokens = usage['promptTokens'];
  const completionTokens = usage['completionTokens'];
  if (
    typeof promptTokens !== 'number' ||
    !Number.isInteger(promptTokens) ||
    promptTokens < 0 ||
    typeof completionTokens !== 'number' ||
    !Number.isInteger(completionTokens) ||
    completionTokens < 0
  ) {
    tally.complete = false;
    return;
  }
  addAttemptUsage(tally, { promptTokens, completionTokens });
}

function talliedUsage(tally: LlmUsageTally): LlmUsage | null {
  return tally.complete
    ? { promptTokens: tally.promptTokens, completionTokens: tally.completionTokens }
    : null;
}

/**
 * 一次逻辑调用的差异面：怎么发、成功的返回值怎么读、不完整时抛什么、失败后还重不重试。
 * 重试循环、用量累计、调用日志与统计都在 `executeCall` 里，只有这一份。
 */
export interface LlmCallAttempt<T> {
  readonly kind: LlmCallKind;
  invoke(): Promise<T>;
  usageOf(result: T): LlmUsage;
  finishOf(result: T): 'stop' | 'length' | 'refusal';
  /** `finishReason` 不是 `stop` 时抛的错误，消息按调用形态区分。 */
  finishFailure(result: T): ComemError;
  mayRetry(failure: ComemError, attempt: number): boolean;
  isParseFailure?(failure: ComemError): boolean;
}

function errorReason(failure: ComemError, options: LlmOptions | undefined): string {
  if (typeof failure.details?.['timeoutMs'] === 'number') return 'timeout';
  if (options?.abortSignal?.aborted === true) {
    const reason: unknown = options.abortSignal.reason;
    return reason instanceof ComemError && reason.details?.['timeout'] === true ? 'timeout' : 'cancelled';
  }
  if (failure.details?.['truncated'] === true) return 'truncated';
  const status = failure.details?.['statusCode'];
  if (typeof status === 'number') return `upstream_http_${status}`;
  return failure.details?.['cause'] !== undefined && failure.code === 'INVALID_ARGUMENT' ? 'invalid_output' : 'unknown';
}

export async function executeCall<T>(
  runtime: LlmRuntimeState,
  options: LlmOptions | undefined,
  call: LlmCallAttempt<T>,
): Promise<T> {
  const callStartedAt = new Date();
  const callStartedMonotonic = performance.now();
  const usageTally: LlmUsageTally = { promptTokens: 0, completionTokens: 0, complete: true };
  let attempt = 0;

  for (;;) {
    attempt += 1;
    const startedAt = Date.now();
    let result: T;
    try {
      result = await call.invoke();
    } catch (error) {
      const failure = ComemError.from(error);
      addFailedAttemptUsage(usageTally, failure);
      if (call.mayRetry(failure, attempt)) {
        logRetry(runtime, failure, attempt, call.isParseFailure?.(failure) ?? false);
        await sleep(retryDelay(runtime, attempt));
        continue;
      }
      const mapped = failCall(runtime, failure, attempt, startedAt, options);
      persist(runtime, callStartedAt, callStartedMonotonic, call, options, attempt, usageTally, {
        status: 'error',
        errorCode: mapped.code,
        errorReason: errorReason(mapped, options),
      });
      throw mapped;
    }

    const usage = call.usageOf(result);
    const finishReason = call.finishOf(result);
    addAttemptUsage(usageTally, usage);
    recordUsage(runtime, usage, call.kind, finishReason, startedAt, attempt);
    if (finishReason !== 'stop') {
      runtime.totals[finishReason === 'length' ? 'truncated' : 'failed'] += 1;
      const failure = call.finishFailure(result);
      persist(runtime, callStartedAt, callStartedMonotonic, call, options, attempt, usageTally, {
        status: 'error',
        errorCode: failure.code,
        errorReason: errorReason(failure, options),
      });
      throw failure;
    }

    persist(runtime, callStartedAt, callStartedMonotonic, call, options, attempt, usageTally, {
      status: 'success',
      errorCode: null,
    });
    return result;
  }
}

function persist<T>(
  runtime: LlmRuntimeState,
  startedAt: Date,
  startedMonotonic: number,
  call: LlmCallAttempt<T>,
  options: LlmOptions | undefined,
  attempts: number,
  usageTally: LlmUsageTally,
  outcome: { status: 'success' | 'error'; errorCode: string | null; errorReason?: string },
): void {
  persistLlmCall(runtime, {
    startedAt,
    durationMs: performance.now() - startedMonotonic,
    kind: call.kind,
    options,
    ...outcome,
    attempts,
    usage: talliedUsage(usageTally),
  });
}
