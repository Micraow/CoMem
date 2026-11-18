import { ComemError } from '../domain/errors.js';
import type { LlmOptions, LlmPrompt, LlmResult } from '../domain/llm.js';

import { canRetry, executeCall, type LlmRuntimeState } from './llm-runtime.js';

export function executeTextCall(
  runtime: LlmRuntimeState,
  prompt: LlmPrompt,
  options?: LlmOptions,
): Promise<LlmResult> {
  return executeCall(runtime, options, {
    kind: 'text',
    invoke: () => runtime.provider.complete(prompt, options),
    usageOf: (result) => result.usage,
    finishOf: (result) => result.finishReason,
    finishFailure: (result) =>
      result.finishReason === 'length'
        ? new ComemError('PROVIDER_UNAVAILABLE', '模型输出被截断，请调大 maxTokens 后重试。', {
            finishReason: result.finishReason,
            completionTokens: result.usage.completionTokens,
          })
        : new ComemError('PROVIDER_UNAVAILABLE', '模型拒绝了这次请求：内容被安全策略过滤。', {
            finishReason: result.finishReason,
          }),
    mayRetry: (failure, attempt) => canRetry(runtime, failure, attempt, options),
  });
}
