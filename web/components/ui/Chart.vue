<script setup lang="ts">
/**
 * 横向条形图（架构文档 §17.2 的四阶段开销、§17.4 的 Token 用量）。
 *
 * 不用图表库：控制台要的只是「一组标签 + 一条按最大值归一的长条」，引入 canvas
 * 库换来的是主题、字体、响应式三处额外适配。用 div 的宽度百分比表达长度，
 * 条长随容器变化，深浅两套外观自动跟随令牌。
 *
 * **宽度按最大值归一**（§17.2 的展示形式）：绝对值下 38ms 与 104ms 看起来差不多，
 * 归一后「检索占了大部分开销」一眼可见。`max` 由调用方显式给定时用它，否则取
 * 数据里的最大值——同一张图里两组数字要能横向比较，就不能各归各的。
 *
 * 值为 0 的行保留文字、不画条：§17.2 的示例里「序列化 0ms」是要被看见的，
 * 藏掉会让四阶段少一行，读者以为漏了。
 */
import { formatOneDecimal } from '~/utils/format'

export interface ChartDatum {
  readonly label: string
  readonly value: number
}

const props = withDefaults(
  defineProps<{
    data: readonly ChartDatum[]
    /** 归一化基准；缺省取 `data` 里的最大值。 */
    max?: number
    /** 数值后缀，例如 `ms` / `s` / `token`。 */
    unit?: string
  }>(),
  { max: undefined, unit: '' },
)

const scale = computed<number>(() => {
  const values = props.data.map((datum) => (Number.isFinite(datum.value) ? datum.value : 0))
  if (props.max !== undefined && Number.isFinite(props.max)) {
    values.push(props.max)
  }
  return Math.max(0, ...values)
})

function widthOf(value: number): string {
  if (!Number.isFinite(value) || value <= 0 || scale.value <= 0) {
    return '0%'
  }
  return `${Math.min(100, (value / scale.value) * 100)}%`
}

function textOf(value: number): string {
  if (!Number.isFinite(value)) {
    return '—'
  }
  return `${formatOneDecimal(value)}${props.unit}`
}
</script>

<template>
  <dl class="chart">
    <div v-for="datum in props.data" :key="datum.label" class="chart__row">
      <dt class="chart__label">{{ datum.label }}</dt>
      <dd class="chart__body">
        <span class="chart__track">
          <i class="chart__bar" :style="{ width: widthOf(datum.value) }" />
        </span>
        <span class="chart__num">{{ textOf(datum.value) }}</span>
      </dd>
    </div>
  </dl>
</template>

<style scoped>
.chart {
  display: grid;
  gap: 9px;
  margin: 0;
}

.chart__row {
  display: grid;
  grid-template-columns: 84px minmax(0, 1fr);
  align-items: center;
  gap: 12px;
}

.chart__label {
  font-size: 14px;
  line-height: 1.4;
  color: var(--label-2);
  letter-spacing: -0.003em;
  white-space: nowrap;
}

.chart__body {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 0;
  min-width: 0;
}

.chart__track {
  flex: 1;
  min-width: 0;
  height: 8px;
  border-radius: 6px;
  background: var(--fill-2);
  overflow: hidden;
}

.chart__bar {
  display: block;
  height: 100%;
  border-radius: 6px;
  background: linear-gradient(90deg, var(--accent), var(--accent-ink));
  transition: width var(--dur-slow) var(--ease);
}

.chart__num {
  flex: none;
  min-width: 62px;
  text-align: right;
  font-family: var(--mono);
  font-size: 13px;
  font-variant-numeric: tabular-nums;
  color: var(--label-2);
}
</style>
