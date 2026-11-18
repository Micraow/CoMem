import { APICallError, embedMany, type EmbeddingModel } from 'ai';

import { ComemError } from '../../domain/errors.js';

export type EmbeddingBatchResult = {
  readonly embeddings: Awaited<ReturnType<typeof embedMany>>['embeddings'];
  readonly usage: Awaited<ReturnType<typeof embedMany>>['usage'];
};

const CONTEXT_LIMIT_PATTERNS = [
  /\bsequence too long:\s*\d+\s*>\s*\d+\b/i,
  /\b(?:max(?:imum)? context(?: length| window)? (?:exceeded|reached)|context (?:length|window)(?: limit)? (?:exceeded|reached))/i,
  /\b(?:exceed(?:s|ed)?|longer than|larger than).{0,80}\bcontext (?:length|window)(?: limit)?\b/i,
  /\bcontext (?:length|window)(?: limit)?.{0,80}\b(?:exceed(?:s|ed)?|too (?:long|large)|limit reached)\b/i,
  /\binput.{0,40}\btoo long.{0,80}\bmodel\b/i,
  /\bmaximum context length is \d+ tokens\b.{0,120}\b(?:resulted in|exceed|too (?:long|large)|reduce|your (?:input|messages?))\b/i,
] as const;

function isContextLimitError(error: unknown): error is APICallError {
  if (!APICallError.isInstance(error)) return false;
  if (error.statusCode === 413) return true;
  if (error.statusCode !== 400 && error.statusCode !== 422) return false;
  const message = error.message.slice(0, 1024);
  return CONTEXT_LIMIT_PATTERNS.some((pattern) => pattern.test(message));
}

async function request(
  model: EmbeddingModel,
  texts: readonly string[],
  abortSignal: AbortSignal,
): Promise<EmbeddingBatchResult> {
  const result = await embedMany({
    model,
    values: [...texts],
    maxRetries: 0,
    abortSignal,
  });
  if (result.embeddings.length !== texts.length) {
    throw new ComemError(
      'INVALID_ARGUMENT',
      '嵌入供应商返回的向量数量与输入数量不一致。',
      { expected: texts.length, actual: result.embeddings.length },
    );
  }
  return result;
}

/**
 * 只在供应商明确报告 payload / context 超限时收缩请求。
 *
 * 多条输入二分，结果按原顺序拼接；单条输入按 Unicode 码点折半，最终尝试一个码点后
 * 停止。所有尝试共享调用方传入的 abortSignal，因此不会为每个重试重置单批预算。
 */
export async function embedBatchWithContextFallback(options: {
  readonly model: EmbeddingModel;
  readonly texts: readonly string[];
  readonly abortSignal: AbortSignal;
}): Promise<EmbeddingBatchResult> {
  const { model, texts, abortSignal } = options;
  try {
    return await request(model, texts, abortSignal);
  } catch (error) {
    if (!isContextLimitError(error)) throw error;

    if (texts.length > 1) {
      const midpoint = Math.floor(texts.length / 2);
      const left = await embedBatchWithContextFallback({
        model,
        texts: texts.slice(0, midpoint),
        abortSignal,
      });
      const right = await embedBatchWithContextFallback({
        model,
        texts: texts.slice(midpoint),
        abortSignal,
      });
      return {
        embeddings: [...left.embeddings, ...right.embeddings],
        usage: { tokens: left.usage.tokens + right.usage.tokens },
      };
    }

    const text = texts[0];
    if (text === undefined) throw error;
    const codePoints = Array.from(text);
    let terminalError = error;
    for (
      let length = Math.floor(codePoints.length / 2);
      length >= 1;
      length = Math.floor(length / 2)
    ) {
      try {
        return await request(model, [codePoints.slice(0, length).join('')], abortSignal);
      } catch (retryError) {
        if (!isContextLimitError(retryError)) throw retryError;
        terminalError = retryError;
      }
    }
    throw terminalError;
  }
}
