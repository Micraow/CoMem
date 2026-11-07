<script lang="ts">
/**
 * 延迟归因（架构文档 §17.2，**本页最重要的一块**）。
 *
 * 展示形式就是文档里那张图：
 *
 * ```
 * 本轮 CoMem 开销  142ms
 * ├── 进程启动      38ms  ██████
 * ├── 检索         104ms  █████████████████
 * ├── 序列化         0ms
 * └── 采集           0ms
 * 后台处理        12.4s（不阻塞用户）
 * ```
 *
 * ## 后台耗时为什么单独一行
 *
 * §17.2 的核心结论是「异步部分不算进去——用户没等它」。把 12.4 秒的后台处理和
 * 142 毫秒的阻塞开销画进同一根条里，读者会得出「CoMem 每轮要 12.5 秒」的结论，
 * 而这正好是相反的事实。所以两段之间有一条分隔线，后台那行用弱化色，并写明
 * 「不阻塞用户」。
 *
 * ## 为什么没有数据时不画图
 *
 * 全 0 的图表看起来像「CoMem 不花时间」，实际上是「还没有 hook 上报」。两种结论
 * 完全相反，所以没有数据时只留一句「还没有 hook 上报」。
 *
 * ## 四条阶段条为什么按最大值归一
 *
 * 见 `UiChart`：绝对毫秒下 38 与 104 差不出视觉差异，归一是为了回答「哪一段占的
 * 比例最大」。
 */

/** 一个阻塞阶段。`key` 是 Prometheus 的 `phase` 标签值，只用于技术详情。 */
export interface HookPhase {
  readonly key: string
  readonly label: string
  readonly ms: number
}

/** 一个 hook 事件的归因。 */
export interface HookEventBreakdown {
  readonly event: string
  readonly label: string
  /** 单轮阻塞开销合计（四阶段相加）。 */
  readonly totalMs: number
  readonly phases: readonly HookPhase[]
  /** 后台处理耗时；指标里没有这个事件时为 null。 */
  readonly asyncMs: number | null
}

const numberFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 })

/** 毫秒 → `38ms` / `12.4s`。超过 1 秒换成秒，读起来才有「后台很慢」的直觉。 */
export function formatMilliseconds(ms: number): string {
  if (!Number.isFinite(ms)) {
    return '—'
  }
  if (ms < 1000) {
    return `${numberFormat.format(Math.round(ms * 10) / 10)}ms`
  }
  return `${numberFormat.format(Math.round((ms / 1000) * 10) / 10)}s`
}
</script>

<script setup lang="ts">
import { Timer } from 'lucide-vue-next'

const props = defineProps<{ events: readonly HookEventBreakdown[] }>()

function chartDataOf(breakdown: HookEventBreakdown) {
  return breakdown.phases.map((phase) => ({ label: phase.label, value: phase.ms }))
}
</script>

<template>
  <div v-if="props.events.length === 0" class="empty">
    <span class="empty__icon">
      <Timer :size="20" :stroke-width="1.4" />
    </span>
    <span class="empty__title">还没有 hook 上报</span>
    <span class="empty__text">
      宿主侧的 Hook 插件会在每轮结束时上报各阶段耗时。装好插件并跑过一轮对话后，
      这里会显示开销归因。
    </span>
  </div>

  <div v-else class="hooks">
    <article v-for="breakdown in props.events" :key="breakdown.event" class="hook">
      <header class="hook__head">
        <span class="hook__event">{{ breakdown.label }}</span>
        <span class="hook__total">
          本轮 CoMem 开销
          <b>{{ formatMilliseconds(breakdown.totalMs) }}</b>
        </span>
      </header>

      <UiChart :data="chartDataOf(breakdown)" unit="ms" />

      <div v-if="breakdown.asyncMs !== null" class="hook__async">
        <span class="hook__async-label">后台处理</span>
        <span class="hook__async-value mono">{{ formatMilliseconds(breakdown.asyncMs) }}</span>
        <span class="hook__async-note">不阻塞用户</span>
      </div>
    </article>
  </div>
</template>

<style scoped>
.hooks {
  display: grid;
  gap: 26px;
}

.hook {
  display: grid;
  gap: 14px;
}

.hook__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 14px;
  flex-wrap: wrap;
}

.hook__event {
  font-size: 15px;
  font-weight: 590;
  letter-spacing: -0.006em;
  color: var(--label);
}

.hook__total {
  font-size: 13px;
  color: var(--label-3);
  font-variant-numeric: tabular-nums;
}

.hook__total b {
  margin-left: 6px;
  font-family: var(--mono);
  font-size: 15px;
  font-weight: 650;
  letter-spacing: -0.01em;
  color: var(--accent-ink);
}

/* 后台处理：与阻塞部分之间一条分隔线，颜色弱化，并写明不阻塞。 */
.hook__async {
  display: flex;
  align-items: baseline;
  gap: 10px;
  flex-wrap: wrap;
  padding-top: 12px;
  border-top: 0.5px dashed var(--separator);
}

.hook__async-label {
  font-size: 14px;
  color: var(--label-3);
}

.hook__async-value {
  font-size: 14px;
  font-weight: 600;
  color: var(--label-2);
}

.hook__async-note {
  font-size: 13px;
  color: var(--label-4);
}
</style>
