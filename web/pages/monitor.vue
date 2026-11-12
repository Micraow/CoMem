<script lang="ts">
/**
 * Prometheus 文本解析（架构文档 §17.1 的 `/metrics`）。
 *
 * `/metrics` 是 Prometheus 的**抓取格式**，不套 `{status, result}` 封套，所以
 * `useApi()` 用不了——它可以解包任何带封套的响应，但这里没有封套可解。控制台需要
 * 的只是「按指标名取样本」，写一个 30 行的解析器比引入 `prom-client` 的
 * `parseText` 更小，而 `prom-client` 是**服务端**依赖，打进浏览器没有意义。
 *
 * 解析范围限定在 `src/services/observability.ts` 实际输出的子集：注释行、空行、
 * `name{labels} value`、`name value`。直方图桶（`_bucket{le=...}`）与 exemplar
 * 都不出现，因此不实现——按需实现，不预留。
 *
 * 解析失败的行**跳过而不是抛错**：`/metrics` 是运维端点，一行脏数据不该让整个
 * 监控页白屏。
 */

export interface PrometheusSample {
  readonly labels: Readonly<Record<string, string>>
  readonly value: number
}

/** 指标名 → 样本列表。样本顺序与文本一致。 */
export type PrometheusSeries = Readonly<Record<string, readonly PrometheusSample[]>>

const SAMPLE_PATTERN = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{(.*)\})?\s+(\S+)(?:\s+\S+)?$/
const LABEL_PATTERN = /([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g

/** Prometheus 的标签转义：只有 `\\`、`\"`、`\n` 三种。 */
function unescapeLabel(value: string): string {
  return value.replace(/\\(.)/g, (_match, char: string) => {
    if (char === 'n') {
      return '\n'
    }
    return char
  })
}

function parseLabels(text: string): Readonly<Record<string, string>> {
  const labels: Record<string, string> = {}
  LABEL_PATTERN.lastIndex = 0
  let match = LABEL_PATTERN.exec(text)
  while (match !== null) {
    const key = match[1]
    const value = match[2]
    if (key !== undefined && value !== undefined) {
      labels[key] = unescapeLabel(value)
    }
    match = LABEL_PATTERN.exec(text)
  }
  return labels
}

export function parsePrometheus(text: string): PrometheusSeries {
  const series: Record<string, PrometheusSample[]> = {}

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) {
      continue
    }

    const match = SAMPLE_PATTERN.exec(line)
    if (match === null) {
      continue
    }
    const name = match[1]
    const rawValue = match[3]
    if (name === undefined || rawValue === undefined) {
      continue
    }

    const value = Number(rawValue)
    if (!Number.isFinite(value)) {
      continue
    }

    const labels = match[2] === undefined ? {} : parseLabels(match[2])
    const bucket = series[name] ?? []
    bucket.push({ labels, value })
    series[name] = bucket
  }

  return series
}

/** §17.2 的四个阻塞阶段。`key` 是指标 `phase` 标签值。 */
const HOOK_PHASES: readonly { readonly key: string; readonly label: string }[] = [
  { key: 'process_start', label: '进程启动' },
  { key: 'recall', label: '检索' },
  { key: 'serialize', label: '序列化' },
  { key: 'capture', label: '采集' },
]

/**
 * §15.2 的六个 Hook 生命周期点 + 兜底的 `other`。
 *
 * `PreToolUse` 不发 HTTP，也不做开销上报，所以不在这里——留一行永远没有样本的
 * 事件会被读成「这个事件没发生」，而不是「这个事件没被采集」。它的耗时排查走
 * 宿主自己的日志。
 */
const HOOK_EVENTS: readonly { readonly key: string; readonly label: string }[] = [
  { key: 'session_start', label: '会话开始' },
  { key: 'user_prompt_submit', label: '提交提示' },
  { key: 'post_tool_use', label: '工具调用后' },
  { key: 'stop', label: '轮次结束' },
  { key: 'pre_compact', label: '上下文压缩前' },
  { key: 'session_end', label: '会话结束' },
  { key: 'other', label: '其他' },
]

const MILLISECONDS_PER_SECOND = 1000

function eventLabelOf(event: string): string {
  return HOOK_EVENTS.find((candidate) => candidate.key === event)?.label ?? event
}

/** 取某个指标的一个样本值；没有就返回 null（界面据此省略卡片）。 */
function sampleValue(
  series: PrometheusSeries,
  name: string,
  labels?: Readonly<Record<string, string>>,
): number | null {
  const samples = series[name]
  if (samples === undefined) {
    return null
  }
  const found = samples.find((sample) =>
    labels === undefined
      ? true
      : Object.entries(labels).every(([key, value]) => sample.labels[key] === value),
  )
  return found === undefined ? null : found.value
}

function hookBreakdownOf(series: PrometheusSeries): readonly HookEventBreakdown[] {
  const overhead = series['comem_hook_overhead_seconds'] ?? []
  const totals = series['comem_hook_overhead_total_seconds'] ?? []

  const present = new Set<string>()
  for (const sample of [...overhead, ...totals]) {
    const event = sample.labels['event']
    if (event !== undefined) {
      present.add(event)
    }
  }
  if (present.size === 0) {
    return []
  }

  // 已知事件按 §15.2 的生命周期顺序排；指标里出现但不在白名单里的排到最后。
  const known = HOOK_EVENTS.filter((event) => present.has(event.key))
  const unknown = [...present].filter(
    (event) => !HOOK_EVENTS.some((candidate) => candidate.key === event),
  )

  return [...known.map((event) => event.key), ...unknown].map((event) => {
    const phases = HOOK_PHASES.map((phase) => ({
      key: phase.key,
      label: phase.label,
      ms:
        (sampleValue(series, 'comem_hook_overhead_seconds', {
          event,
          phase: phase.key,
        }) ?? 0) * MILLISECONDS_PER_SECOND,
    }))

    const reportedTotal = sampleValue(series, 'comem_hook_overhead_total_seconds', { event })

    return {
      event,
      label: eventLabelOf(event),
      totalMs:
        reportedTotal === null
          ? phases.reduce((sum, phase) => sum + phase.ms, 0)
          : reportedTotal * MILLISECONDS_PER_SECOND,
      phases,
    }
  })
}

function usageOf(series: PrometheusSeries): MonitorUsage {
  const durationSum = sampleValue(series, 'comem_http_request_duration_seconds_sum')
  const durationCount = sampleValue(series, 'comem_http_request_duration_seconds_count')

  return {
    requestCount: durationCount,
    avgDurationMs:
      durationSum !== null && durationCount !== null && durationCount > 0
        ? (durationSum / durationCount) * MILLISECONDS_PER_SECOND
        : null,
    promptTokens: sampleValue(series, 'comem_llm_tokens_total', { kind: 'prompt' }),
    completionTokens: sampleValue(series, 'comem_llm_tokens_total', { kind: 'completion' }),
    costUsd: sampleValue(series, 'comem_llm_cost_usd_total'),
    pricingConfigured: sampleValue(series, 'comem_llm_pricing_configured'),
  }
}

/**
 * 「最近的请求」区块里列出的指标。
 *
 * 只有**标签**（给人读的名字）不带指标名：指标名属于技术细节，放在页面底部的
 * 折叠区（AGENTS §11：开发期内部术语不进用户可见区域）。
 */
const VISIBLE_METRICS: readonly { readonly name: string; readonly label: string }[] = [
  { name: 'comem_http_request_duration_seconds_sum', label: '请求耗时合计' },
  { name: 'comem_http_request_duration_seconds_count', label: '请求总数' },
  { name: 'comem_llm_tokens_total', label: '模型 Token 累计' },
  { name: 'comem_llm_cost_usd_total', label: '模型成本累计' },
  { name: 'comem_llm_pricing_configured', label: '模型单价是否配置' },
  { name: 'comem_index_nodes', label: '索引节点数' },
  { name: 'comem_pending_review', label: '待复核记忆条数' },
  { name: 'comem_hook_overhead_seconds', label: 'Hook 分阶段阻塞开销' },
  { name: 'comem_hook_overhead_total_seconds', label: 'Hook 单轮阻塞开销' },
  { name: 'comem_hook_async_seconds', label: '后台处理耗时' },
]
</script>

<script setup lang="ts">
/**
 * 监控（架构文档 §17.10；控制台十个页面里的第十页）。
 *
 * 四块对应 §17 的四个问题：开销归因（§17.2）、吞吐与用量（§17.3 / §17.4）、
 * 记忆健康度（§17.5）、请求记录（§17.6）。
 *
 * ## 请求记录为什么只有一句说明
 *
 * §17.6 把每个请求写进 SQLite 的 `request_log`，但**服务端没有暴露查询端点**：
 * `src/api/http/routes/` 里没有 `GET /stats/requests`。控制台不能凭空造一份请求
 * 明细，也不能拿聚合值冒充逐条记录。这里只说明「看不到」，并列出 `/metrics` 里
 * 真有的聚合项——运维至少知道该去 `curl /metrics` 看什么。
 *
 * ## 数据源为什么不统一
 *
 * `/health` 是封套 JSON，`/metrics` 是 Prometheus 文本，两者形状不同、口径也不同
 * （§17.1 的「两套」是有意的）。这里各取所需，不做合并：合并会造出第三套口径。
 */
import { AlertTriangle, RefreshCw } from 'lucide-vue-next'

import type { MonitorUsage } from '~/components/domain/MetricsChart.vue'
import type { HookEventBreakdown } from '~/components/domain/PhaseBreakdown.vue'
import {
  errorMessageOf,
  useApi,
  type HealthPayload,
} from '~/composables/useApi'
import { healthBadgeOf } from '~/utils/healthLabels'

useHead({ title: '监控 · CoMem 控制台' })

const api = useApi()
const config = useRuntimeConfig()

const health = ref<HealthPayload | null>(null)
const metricsText = ref<string | null>(null)

const loading = ref(false)
const error = ref<string | null>(null)

const series = computed<PrometheusSeries>(() =>
  metricsText.value === null ? {} : parsePrometheus(metricsText.value),
)

const usage = computed<MonitorUsage | null>(() =>
  metricsText.value === null ? null : usageOf(series.value),
)

const hookEvents = computed<readonly HookEventBreakdown[]>(() => hookBreakdownOf(series.value))

/**
 * 后台处理耗时（毫秒）。**取最近一次最慢的后台阶段。**
 *
 * 服务端的 `#asyncPhases` 按阶段（归档 / 抽取 / 合并 / 摘要 / 经验归纳）记录「最近一次」的
 * 耗时，`renderMetrics` 以 `comem_hook_async_seconds{phase="..."}` 输出。这些值来自
 * 各自的阶段，不属于任何一个 hook 事件；其中一个阶段可能由不同事件触发，逐事件
 * 展示会读出「每个事件各自的后台耗时」。这里取所有阶段样本里的最大值，含义是
 * 「最近一次观察到的、最慢的那个后台阶段」。
 */
const asyncOverheadMs = computed<number | null>(() => {
  const samples = series.value['comem_hook_async_seconds'] ?? []
  if (samples.length === 0) {
    return null
  }
  return Math.max(...samples.map((sample) => sample.value)) * MILLISECONDS_PER_SECOND
})

const availableMetrics = computed<readonly string[]>(() =>
  VISIBLE_METRICS.filter((metric) => series.value[metric.name] !== undefined).map(
    (metric) => metric.label,
  ),
)

const healthBadge = computed(() =>
  health.value === null ? null : healthBadgeOf(health.value),
)

/**
 * 取 Prometheus 文本。
 *
 * 用 `$fetch` 而不是 `useApi()`：后者负责解封套，而 `/metrics` 没有封套。走同一个
 * base 路径，避免控制台里出现第二个「后端地址」常量。
 */
async function fetchMetricsText(): Promise<string> {
  const base = String(config.public.apiBase).replace(/\/+$/, '')
  return await $fetch<string>(`${base}/metrics`, {
    responseType: 'text',
    headers: { accept: 'text/plain' },
    timeout: 30_000,
  })
}

async function load(): Promise<void> {
  loading.value = true
  error.value = null

  const failures: string[] = []

  const [healthResult, metricsResult] = await Promise.allSettled([
    api.get<HealthPayload>('/health'),
    fetchMetricsText(),
  ])

  if (healthResult.status === 'fulfilled') {
    health.value = healthResult.value
  } else {
    health.value = null
    failures.push(`健康度：${errorMessageOf(healthResult.reason)}`)
  }

  if (metricsResult.status === 'fulfilled') {
    metricsText.value = metricsResult.value
  } else {
    metricsText.value = null
    failures.push(`指标：${errorMessageOf(metricsResult.reason)}`)
  }

  error.value = failures.length === 0 ? null : failures.join(' ')
  loading.value = false
}

onMounted(load)
</script>

<template>
  <div class="content">
    <div class="page">
      <DomainPageHeader title="监控">
        <template #actions>
          <template v-if="healthBadge !== null">
            <UiBadge :variant="healthBadge.variant">{{ healthBadge.label }}</UiBadge>
            <NuxtLink
              v-if="healthBadge.action === 'configure-model'"
              to="/settings"
              class="model-cta"
            >
              去配置模型
            </NuxtLink>
          </template>
          <UiButton variant="secondary" size="sm" :disabled="loading" @click="load">
            <RefreshCw :size="14" :stroke-width="1.5" />
            刷新
          </UiButton>
        </template>
      </DomainPageHeader>

      <UiErrorCallout v-if="error !== null" class="mb-24" :message="error" />

      <section class="section">
        <h2 class="section__title">记忆健康度</h2>
        <DomainHealthCards :health="health" :loading="loading" />
      </section>

      <section class="section">
        <UiCard title="开销归因" panel>
          <template #head>
            <span class="caption">单轮阻塞开销的四阶段拆分</span>
          </template>
          <div v-if="loading && metricsText === null" class="stack-10" aria-busy="true">
            <UiSkeleton width="34%" height="15px" />
            <UiSkeleton width="72%" height="10px" />
            <UiSkeleton width="58%" height="10px" />
          </div>
          <DomainPhaseBreakdown
            v-else-if="metricsText !== null"
            :events="hookEvents"
            :async-ms="asyncOverheadMs"
          />
          <p v-else class="unavailable">指标没有取到，无法展示开销归因。</p>
        </UiCard>
      </section>

      <section class="section">
        <UiCard title="吞吐与用量" panel>
          <template #head>
            <span class="caption">进程启动以来的累加值</span>
          </template>
          <div v-if="loading && metricsText === null" class="stack-10" aria-busy="true">
            <UiSkeleton width="64%" height="10px" />
            <UiSkeleton width="48%" height="10px" />
          </div>
          <DomainMetricsChart v-else-if="metricsText !== null" :usage="usage" />
          <p v-else class="unavailable">指标没有取到，无法展示吞吐与用量。</p>
        </UiCard>
      </section>

      <section class="section">
        <UiCard title="最近的请求" panel>
          <UiCallout tone="info" class="mb-16">
            <template #icon><AlertTriangle :size="15" :stroke-width="1.4" /></template>
            <div>请求明细还没有查询端点。</div>
          </UiCallout>

          <p class="requests__lead">指标里的聚合项：</p>

          <ul v-if="availableMetrics.length > 0" class="requests__list">
            <li v-for="label in availableMetrics" :key="label">{{ label }}</li>
          </ul>
          <p v-else class="requests__lead faint">
            {{ metricsText === null ? '指标没有取到。' : '还没有任何指标被记录。' }}
          </p>

          <template #foot>
            <details class="tech">
              <summary>技术详情</summary>
              <pre v-if="metricsText !== null" class="tech__raw">{{ metricsText }}</pre>
              <p v-else class="tech__raw">还没有取到指标文本。</p>
            </details>
          </template>
        </UiCard>
      </section>
    </div>
  </div>
</template>

<style scoped>
.section {
  margin-bottom: 26px;
}

/* 徽章旁边的下一步入口。 */
.model-cta {
  font-size: 13px;
  font-weight: 500;
  color: var(--accent-ink);
  text-decoration: none;
  white-space: nowrap;
}

.model-cta:hover {
  text-decoration: underline;
  text-underline-offset: 2px;
}

.section__title {
  margin-bottom: 12px;
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.01em;
  color: var(--label-3);
  text-transform: uppercase;
}

.requests__lead {
  font-size: 14px;
  line-height: 1.55;
  color: var(--label-2);
}

.unavailable {
  font-size: 14px;
  line-height: 1.55;
  color: var(--label-3);
}

.requests__list {
  display: grid;
  gap: 6px;
  margin-top: 10px;
  padding-left: 18px;
  list-style: disc;
  font-size: 14px;
  line-height: 1.5;
  color: var(--label-2);
}

.tech {
  width: 100%;
}

.tech > summary {
  cursor: pointer;
  font-size: 13px;
  color: var(--label-3);
}

.tech > summary:hover {
  color: var(--label);
}

.tech__raw {
  margin: 10px 0 0;
  padding: 12px 14px;
  max-height: 320px;
  overflow: auto;
  border-radius: var(--r-control);
  background: var(--bg-2);
  box-shadow: var(--inset-hair);
  font-family: var(--mono);
  font-size: 12px;
  line-height: 1.6;
  color: var(--label-2);
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
