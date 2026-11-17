import { ComemError, isRetryable } from '../domain/errors.js';
import type {
  LlmOptions,
  LlmProvider,
  LlmUsage,
} from '../domain/llm.js';
import type { Logger } from '../domain/log.js';

import type { LlmCallLogPort } from './llm-call-log.js';
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

export function sleep(durationMs: number): Promise<void> {
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
    options?.abortSignal?.aborted !== true
  );
}

export function retryDelay(runtime: LlmRuntimeState, attempt: number): number {
  const exponential = Math.min(
    runtime.retryBaseDelayMs * 2 ** (attempt - 1),
    MAX_RETRY_DELAY_MS,
  );
  return exponential * (JITTER_FLOOR + Math.random() * (1 - JITTER_FLOOR));
}

export function logRetry(
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

export function failCall(
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
    maxAttempts: runtime.maxAttempts,
    code: failure.code,
    message: failure.message,
    durationMs: Date.now() - startedAt,
  });
  return failure;
}

export function recordUsage(
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

export function addAttemptUsage(tally: LlmUsageTally, usage: LlmUsage): void {
  tally.promptTokens += usage.promptTokens;
  tally.completionTokens += usage.completionTokens;
}

export function addFailedAttemptUsage(tally: LlmUsageTally, error: unknown): void {
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

export function talliedUsage(tally: LlmUsageTally): LlmUsage | null {
  return tally.complete
    ? { promptTokens: tally.promptTokens, completionTokens: tally.completionTokens }
    : null;
}
