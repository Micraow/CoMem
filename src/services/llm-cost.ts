/** 每次模型调用可配置的两项单价。 */
export interface LlmPricing {
  readonly inputPerMillion: number;
  readonly outputPerMillion: number;
}

/** 单价按每 100 万 token 配置。 */
const TOKENS_PER_MILLION = 1_000_000;

export function llmCostUsd(
  pricing: LlmPricing | undefined,
  promptTokens: number,
  completionTokens: number,
): number | null {
  if (pricing === undefined) {
    return null;
  }
  return (
    (promptTokens * pricing.inputPerMillion +
      completionTokens * pricing.outputPerMillion) /
    TOKENS_PER_MILLION
  );
}
