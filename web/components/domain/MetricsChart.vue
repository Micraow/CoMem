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

import { formatMilliseconds } from '~/utils/format'

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

const httpCards = computed<readonly UsageCard[]>(() => {
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
  return result
})

const modelCards = computed<readonly UsageCard[]>(() => {
  const usage = props.usage
  if (usage === null) {
    return []
  }

  const result: UsageCard[] = []
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

const hasHttp = computed(() => httpCards.value.length > 0)
const hasModel = computed(() => modelCards.value.length > 0 || tokenData.value.length > 0)
const isEmpty = computed(() => !hasHttp.value && !hasModel.value)
</script>

<template>
  <UiEmpty v-if="isEmpty" v-slot="{ size }" title="还没有指标数据">
    <BarChart3 :size="size" :stroke-width="1.4" />
  </UiEmpty>

  <div v-else class="usage">
    <section v-if="hasHttp" class="usage__group" aria-labelledby="http-usage-title">
      <header class="usage__group-head">
        <h3 id="http-usage-title" class="usage__title">HTTP 请求</h3>
        <span class="usage__note">进程启动以来服务收到的请求，包含非模型接口</span>
      </header>
      <div class="usage__cards">
        <div v-for="card in httpCards" :key="card.key" class="stat">
          <span class="stat__v">{{ card.value }}</span>
          <span class="stat__k">{{ card.label }}</span>
          <span v-if="card.sub !== null" class="stat__sub">{{ card.sub }}</span>
        </div>
      </div>
    </section>

    <section v-if="hasModel" class="usage__group" aria-labelledby="model-usage-title">
      <header class="usage__group-head">
        <h3 id="model-usage-title" class="usage__title">模型调用</h3>
        <span class="usage__note">进程启动以来的 Token 与成本，只统计模型服务消费</span>
      </header>
      <div v-if="modelCards.length > 0" class="usage__cards">
        <div v-for="card in modelCards" :key="card.key" class="stat">
          <span class="stat__v" :class="card.prose ? 'stat__v--prose' : ''">{{ card.value }}</span>
          <span class="stat__k">{{ card.label }}</span>
          <span v-if="card.sub !== null" class="stat__sub">{{ card.sub }}</span>
        </div>
      </div>
      <div v-if="tokenData.length > 0" class="usage__tokens">
        <h4 class="usage__subtitle">Token 累计</h4>
        <UiChart :data="tokenData" unit=" token" />
      </div>
    </section>
  </div>
</template>

<style scoped>
.usage {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 22px 24px;
}

.usage__group {
  display: grid;
  align-content: start;
  gap: 12px;
}

.usage__group + .usage__group {
  padding-left: 24px;
  border-left: 0.5px solid var(--separator);
}

.usage__group-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  flex-wrap: wrap;
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
  color: var(--label-2);
  text-transform: uppercase;
}

.usage__subtitle {
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0;
  color: var(--label-3);
}

.usage__note {
  font-size: 13px;
  color: var(--label-3);
}

@media (max-width: 820px) {
  .usage {
    grid-template-columns: minmax(0, 1fr);
  }

  .usage__group + .usage__group {
    padding-left: 0;
    padding-top: 20px;
    border-left: 0;
    border-top: 0.5px solid var(--separator);
  }
}
</style>
