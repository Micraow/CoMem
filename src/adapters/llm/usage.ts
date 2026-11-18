import type { LlmUsage } from '../../domain/llm.js';

interface RawUsage {
  readonly promptTokens?: number;
  readonly completionTokens?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}

export function readUsage(usage: RawUsage): LlmUsage {
  return {
    promptTokens: usage.promptTokens ?? usage.inputTokens ?? 0,
    completionTokens: usage.completionTokens ?? usage.outputTokens ?? 0,
  };
}
