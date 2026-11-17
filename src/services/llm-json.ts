import type { ZodType } from 'zod';

import { ComemError } from '../domain/errors.js';
import type { LlmJsonResult, LlmOptions, LlmPrompt } from '../domain/llm.js';

import { canRetry, executeCall, type LlmRuntimeState } from './llm-runtime.js';

const JSON_PARSE_ATTEMPTS = 2;

export async function executeJsonCall<T>(
  runtime: LlmRuntimeState,
  prompt: LlmPrompt,
  schema: ZodType<T>,
  options?: LlmOptions,
): Promise<T> {
  let parseFailures = 0;
  const result = await executeCall<LlmJsonResult<T>>(runtime, options, {
    kind: 'json',
    invoke: () => runtime.provider.completeJson(prompt, schema, options),
    usageOf: (value) => value.usage,
    finishOf: (value) => value.finishReason,
    finishFailure: (value) =>
      value.finishReason === 'length'
        ? new ComemError(
            'PROVIDER_UNAVAILABLE',
            '模型输出被截断，结构化结果不完整。请调大 maxTokens 后重试。',
            { truncated: true, finishReason: value.finishReason },
          )
        : new ComemError('PROVIDER_UNAVAILABLE', '模型拒绝了这次请求：内容被安全策略过滤。', {
            finishReason: value.finishReason,
          }),
    mayRetry: (failure, attempt) => {
      if (failure.details?.['truncated'] === true) {
        return false;
      }
      if (failure.code === 'INVALID_ARGUMENT') {
        parseFailures += 1;
        return (
          options?.retry !== false &&
          parseFailures < JSON_PARSE_ATTEMPTS &&
          attempt < runtime.maxAttempts &&
          options?.abortSignal?.aborted !== true
        );
      }
      return canRetry(runtime, failure, attempt, options);
    },
    isParseFailure: (failure) => failure.code === 'INVALID_ARGUMENT',
  });
  return result.value;
}
