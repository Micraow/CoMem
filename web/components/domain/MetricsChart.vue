<script lang="ts">
/**
 * 吞吐与用量（架构文档 §17.3 的 TTFB / TPS、§17.4 的模型用量）。
 *
 * ## 只画 `/metrics` 里真有的
 *
 * §17.3 列了 `comem_http_ttfb_seconds`、`comem_http_requests_per_second`、
 * `comem_http_inflight_requests` 三个指标，但 v1 的 `renderMetrics()` 只输出
 * `comem_http_request_duration_seconds_sum` / `_count` 与 hook 指标。**没实现的
 * 指标不画**：一张 TTFB 恒为 0 的图会让人以为「首字节很快」，而实际是「没测」。
 * 每张卡片都由数据是否存在决定，不是写死的一行。
 *
 * ## 成本卡与「未配置单价」
 *
 * `comem_llm_cost_usd_total` 只在配置了 `providers.llm.default.pricing` 时输出；
 * `comem_llm_pricing_configured` 用 0/1 说明原因。成本序列缺失且配置指标为 0 时
 * 显示「未配置单价，成本不可计算」；配置了单价时，真实花费 0 也显示 `$0.0000`。
 *
 * ## 为什么平均耗时是 `_sum / _count`
 *
 * v1 的请求耗时是 summary 形态（只有 `_sum` 与 `_count`，没有直方图桶，§17.11
 * 不部署 Prometheus）。平均值是这份数据唯一能算出来的集中趋势；P95 需要桶边界，
 * 这里给不出来，也不编一个。
 */

/** `MetricsChart` 的入参。每一个 `null` 都表示「`/metrics` 里没有这个指标」。 */
export interface MonitorUsage {
  /** `comem_http_request_duration_seconds_count`：已记录的请求数。 */
  readonly requestCount: number | null
  /** `_sum / _count` 换算成毫秒。 */
  readonly avgDurationMs: number | null
  /** `comem_llm_tokens_total{kind="prompt"}`。 */
  readonly promptTokens: number | null
  /** `comem_llm_tokens_total{kind="completion"}`。 */
  readonly completionTokens: number | null
  /** `comem_llm_cost_usd_total`；未配置单价时这个序列不存在，为 null。 */
  readonly costUsd: number | null
  /** `comem_llm_pricing_configured`：1 = 已配置单价，0 = 未配置；序列缺失时为 null。 */
  readonly pricingConfigured: number | null
}
</script>

<script setup lang="ts">
import { BarChart3 } from 'lucide-vue-next'

import { formatMilliseconds } from '~/components/domain/PhaseBreakdown.vue'

const props = defineProps<{ usage: MonitorUsage | null }>()

const numberFormat = new Intl.NumberFormat('en-US')

interface UsageCard {
  readonly key: string
  readonly label: string
  readonly value: string
  readonly sub: string | null
  /** 值是说明文字而不是数字：用小一号的正文字号，避免长句撑破卡片。 */
  readonly prose?: boolean
}

const cards = computed<readonly UsageCard[]>(() => {
  const usage = props.usage
  if (usage === null) {
    return []
  }

  const result: UsageCard[] = []
  if (usage.avgDurationMs !== null) {
    result.push({
      key: 'duration',
      label: '平均请求耗时',
      value: formatMilliseconds(usage.avgDurationMs),
      sub: '所有已记录请求的平均值',
    })
  }
  if (usage.requestCount !== null) {
    result.push({
      key: 'count',
      label: '请求总数',
      value: numberFormat.format(usage.requestCount),
      sub: '进程启动以来',
    })
  }
  if (usage.costUsd !== null) {
    result.push({
      key: 'cost',
      label: '模型成本累计',
      value: `$${usage.costUsd.toFixed(4)}`,
      sub: '按配置单价换算',
    })
  } else if (usage.pricingConfigured === 0) {
    result.push({
      key: 'cost',
      label: '模型成本累计',
      value: '未配置单价，成本不可计算',
      sub: null,
      prose: true,
    })
  }
  return result
})

const tokenData = computed<readonly { label: string; value: number }[]>(() => {
  const usage = props.usage
  if (usage === null) {
    return []
  }
  const data: { label: string; value: number }[] = []
  if (usage.promptTokens !== null) {
    data.push({ label: 'Prompt', value: usage.promptTokens })
  }
  if (usage.completionTokens !== null) {
    data.push({ label: 'Completion', value: usage.completionTokens })
  }
  return data
})

const isEmpty = computed(() => cards.value.length === 0 && tokenData.value.length === 0)
</script>

<template>
  <div v-if="isEmpty" class="empty">
    <span class="empty__icon">
      <BarChart3 :size="20" :stroke-width="1.4" />
    </span>
    <span class="empty__title">还没有指标数据</span>
  </div>

  <div v-else class="usage">
    <div v-if="cards.length > 0" class="usage__cards">
      <div v-for="card in cards" :key="card.key" class="stat">
        <span class="stat__v" :class="card.prose ? 'stat__v--prose' : ''">{{ card.value }}</span>
        <span class="stat__k">{{ card.label }}</span>
        <span v-if="card.sub !== null" class="stat__sub">{{ card.sub }}</span>
      </div>
    </div>

    <div v-if="tokenData.length > 0" class="usage__tokens">
      <h3 class="usage__title">模型 Token 累计</h3>
      <UiChart :data="tokenData" unit=" token" />
    </div>
  </div>
</template>

<style scoped>
.usage {
  display: grid;
  gap: 20px;
}

.usage__cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 14px;
}

.stat__v--prose {
  display: block;
  font-size: 15px;
  font-weight: 590;
  letter-spacing: 0;
  line-height: 1.4;
  color: var(--label-2);
}

.stat__sub {
  font-size: 13px;
  line-height: 1.35;
  color: var(--label-4);
  letter-spacing: 0;
}

.usage__tokens {
  display: grid;
  gap: 12px;
}

.usage__title {
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.01em;
  color: var(--label-3);
  text-transform: uppercase;
}
</style>
