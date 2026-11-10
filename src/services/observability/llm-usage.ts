/**
 * 模型用量与计价在 `/metrics` 上的样本（§17.4、§18）。
 *
 * 成本只在真算得出来的时候才有样本：`costUsd` 为 `null` 表示「没配单价，成本不可
 * 计算」。另外恒发一条 `comem_llm_pricing_configured`，抓取端不用猜「成本序列为什么
 * 不见了」。
 */

import type { LlmCallStats } from '../llm.js';

import { metricValue } from './format.js';

/** `/metrics` 里 LLM 用量、成本与计价开关的那一段，按固定顺序输出。 */
export function llmUsageLines(stats: LlmCallStats): string[] {
  const lines: string[] = [
    '# HELP comem_llm_tokens_total 模型 token 累计',
    '# TYPE comem_llm_tokens_total counter',
    `comem_llm_tokens_total{kind="prompt"} ${metricValue(stats.promptTokens)}`,
    `comem_llm_tokens_total{kind="completion"} ${metricValue(stats.completionTokens)}`,
  ];

  // 成本只在真算得出来的时候才有样本。`costUsd` 为 `null` 表示「没配
  // `providers.llm.default.pricing`，成本不可计算」；配了单价它就是 0 起步的累加
  // 值（`LlmService.emptyStats`）。写成 `?? 0` 会让「没配单价」与「确实花了 0
  // 美元」在 `/metrics` 上长得一模一样——控制台的「模型成本累计」就永远是
  // `$0.0000`，看起来像一份正常数据。
  // Prometheus 里「序列不存在」本身就是「未知」，不需要 `-1` 之类的哨兵值。
  if (stats.costUsd !== null) {
    lines.push(
      '# HELP comem_llm_cost_usd_total 模型成本累计，美元（§18 的 pricing 换算）',
      '# TYPE comem_llm_cost_usd_total counter',
      `comem_llm_cost_usd_total ${metricValue(stats.costUsd)}`,
    );
  }

  // 再给一个 0/1，抓取端不用猜「成本序列为什么不见了」。
  lines.push(
    '# HELP comem_llm_pricing_configured 是否配置了模型单价（0 = 未配置，成本不可计算）',
    '# TYPE comem_llm_pricing_configured gauge',
    `comem_llm_pricing_configured ${stats.costUsd === null ? 0 : 1}`,
  );

  return lines;
}
