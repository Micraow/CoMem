import type { ZodType } from 'zod';

import { ComemError } from '../domain/errors.js';
import type { LlmJsonResult, LlmOptions, LlmPrompt, LlmUsage } from '../domain/llm.js';

import { persistLlmCall } from './llm-call-log.js';
import {
  addAttemptUsage,
  addFailedAttemptUsage,
  canRetry,
  failCall,
  logRetry,
  recordUsage,
  retryDelay,
  sleep,
  talliedUsage,
  type LlmUsageTally,
  type LlmRuntimeState,
} from './llm-runtime.js';

const JSON_PARSE_ATTEMPTS = 2;

export async function executeJsonCall<T>(
  runtime: LlmRuntimeState,
  prompt: LlmPrompt,
  schema: ZodType<T>,
  options?: LlmOptions,
): Promise<T> {
  const callStartedAt = new Date();
  const callStartedMonotonic = performance.now();
  const usageTally: LlmUsageTally = {
    promptTokens: 0,
    completionTokens: 0,
    complete: true,
  };
  let attempt = 0;
  let parseFailures = 0;

  for (;;) {
    attempt += 1;
    const startedAt = Date.now();
    let result: LlmJsonResult<T>;
    try {
      result = await runtime.provider.completeJson(prompt, schema, options);
    } catch (error) {
      const failure = ComemError.from(error);
      addFailedAttemptUsage(usageTally, failure);
      if (failure.details?.['truncated'] === true) {
        const mapped = failCall(runtime, failure, attempt, startedAt, options);
        persistFailure(
          runtime,
          callStartedAt,
          callStartedMonotonic,
          options,
          mapped,
          attempt,
          talliedUsage(usageTally),
        );
        throw mapped;
      }
      const parseFailure = failure.code === 'INVALID_ARGUMENT';
      if (parseFailure) {
        parseFailures += 1;
      }
      const mayRetry =
        options?.retry !== false &&
        (parseFailure
          ? parseFailures < JSON_PARSE_ATTEMPTS
          : canRetry(runtime, failure, attempt, options));
      if (mayRetry && attempt < runtime.maxAttempts && options?.abortSignal?.aborted !== true) {
        logRetry(runtime, failure, attempt, parseFailure);
        await sleep(retryDelay(runtime, attempt));
        continue;
      }
      const mapped = failCall(runtime, failure, attempt, startedAt, options);
      persistFailure(
        runtime,
        callStartedAt,
        callStartedMonotonic,
        options,
        mapped,
        attempt,
        talliedUsage(usageTally),
      );
      throw mapped;
    }

    addAttemptUsage(usageTally, result.usage);
    recordUsage(runtime, result.usage, 'json', result.finishReason, startedAt, attempt);
    if (result.finishReason !== 'stop') {
      runtime.totals[
        result.finishReason === 'length' ? 'truncated' : 'failed'
      ] += 1;
      const failure = new ComemError(
        'PROVIDER_UNAVAILABLE',
        result.finishReason === 'length'
          ? '模型输出被截断，结构化结果不完整。请调大 maxTokens 后重试。'
          : '模型拒绝了这次请求：内容被安全策略过滤。',
        result.finishReason === 'length'
          ? { truncated: true, finishReason: result.finishReason }
          : { finishReason: result.finishReason },
      );
      persistLlmCall(runtime, {
        startedAt: callStartedAt,
        durationMs: performance.now() - callStartedMonotonic,
        kind: 'json',
        options,
        status: 'error',
        errorCode: failure.code,
        attempts: attempt,
        usage: talliedUsage(usageTally),
      });
      throw failure;
    }

    persistLlmCall(runtime, {
      startedAt: callStartedAt,
      durationMs: performance.now() - callStartedMonotonic,
      kind: 'json',
      options,
      status: 'success',
      errorCode: null,
      attempts: attempt,
      usage: talliedUsage(usageTally),
    });
    return result.value;
  }
}

function persistFailure(
  runtime: LlmRuntimeState,
  startedAt: Date,
  startedMonotonic: number,
  options: LlmOptions | undefined,
  failure: ComemError,
  attempts: number,
  usage: LlmUsage | null,
): void {
  persistLlmCall(runtime, {
    startedAt,
    durationMs: performance.now() - startedMonotonic,
    kind: 'json',
    options,
    status: 'error',
    errorCode: failure.code,
    attempts,
    usage,
  });
}
