import { ComemError } from '../domain/errors.js';
import type { LlmOptions, LlmPrompt, LlmResult } from '../domain/llm.js';

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

export async function executeTextCall(
  runtime: LlmRuntimeState,
  prompt: LlmPrompt,
  options?: LlmOptions,
): Promise<LlmResult> {
  const callStartedAt = new Date();
  const callStartedMonotonic = performance.now();
  const usageTally: LlmUsageTally = {
    promptTokens: 0,
    completionTokens: 0,
    complete: true,
  };
  let attempt = 0;
  for (;;) {
    attempt += 1;
    const startedAt = Date.now();
    let result: LlmResult;
    try {
      result = await runtime.provider.complete(prompt, options);
    } catch (error) {
      addFailedAttemptUsage(usageTally, error);
      if (canRetry(runtime, error, attempt, options)) {
        logRetry(runtime, ComemError.from(error), attempt, false);
        await sleep(retryDelay(runtime, attempt));
        continue;
      }
      const failure = failCall(runtime, error, attempt, startedAt, options);
      persistLlmCall(runtime, {
        startedAt: callStartedAt,
        durationMs: performance.now() - callStartedMonotonic,
        kind: 'text',
        options,
        status: 'error',
        errorCode: failure.code,
        attempts: attempt,
        usage: talliedUsage(usageTally),
      });
      throw failure;
    }

    addAttemptUsage(usageTally, result.usage);
    recordUsage(runtime, result.usage, 'text', result.finishReason, startedAt, attempt);
    if (result.finishReason !== 'stop') {
      runtime.totals[
        result.finishReason === 'length' ? 'truncated' : 'failed'
      ] += 1;
      const failure = new ComemError(
        'PROVIDER_UNAVAILABLE',
        result.finishReason === 'length'
          ? '模型输出被截断，请调大 maxTokens 后重试。'
          : '模型拒绝了这次请求：内容被安全策略过滤。',
        result.finishReason === 'length'
          ? {
              finishReason: result.finishReason,
              completionTokens: result.usage.completionTokens,
            }
          : { finishReason: result.finishReason },
      );
      persistLlmCall(runtime, {
        startedAt: callStartedAt,
        durationMs: performance.now() - callStartedMonotonic,
        kind: 'text',
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
      kind: 'text',
      options,
      status: 'success',
      errorCode: null,
      attempts: attempt,
      usage: talliedUsage(usageTally),
    });
    return result;
  }
}
