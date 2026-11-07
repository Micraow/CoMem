<script setup lang="ts">
/**
 * 进度条（架构文档 §17.5 的降级比例）。
 *
 * 只表达「一个量占另一个量的多少」：`value` / `max` 都必须是调用方算好的真实计数，
 * 组件不做单位换算，也不为 `max = 0` 编造一个分母——没有分母时进度是 0，
 * 调用方应当改成显示「—」而不是画一条空槽。
 *
 * 圆角 6、高度 8：与设计稿的 `.footbar` / `.gauge__track` 对齐，比 4px 的
 * 分数条更粗，读的是「占比」而不是「分数」。
 */
const props = withDefaults(
  defineProps<{
    value: number
    max: number
    /** 轨道上方的说明文字；缺省不占一行。 */
    label?: string
  }>(),
  { label: undefined },
)

const percent = computed<number>(() => {
  const { value, max } = props
  if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0) {
    return 0
  }
  return Math.min(100, Math.max(0, (value / max) * 100))
})

/** 无障碍值用原始计数：读屏念「3 / 12」比念「25%」更有信息量。 */
const ariaValueText = computed<string>(() =>
  Number.isFinite(props.value) && Number.isFinite(props.max) && props.max > 0
    ? `${props.value} / ${props.max}`
    : '不可用',
)
</script>

<template>
  <div class="progress">
    <div v-if="props.label" class="progress__head">
      <span class="progress__label">{{ props.label }}</span>
      <span class="progress__num">{{ Math.round(percent) }}%</span>
    </div>
    <div
      class="progress__track"
      role="progressbar"
      :aria-valuenow="percent"
      :aria-valuemin="0"
      :aria-valuemax="100"
      :aria-valuetext="ariaValueText"
      :aria-label="props.label ?? '完成比例'"
    >
      <i class="progress__fill" :style="{ width: `${percent}%` }" />
    </div>
  </div>
</template>

<style scoped>
.progress {
  display: grid;
  gap: 8px;
}

.progress__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
}

.progress__label {
  font-size: 13px;
  color: var(--label-3);
  letter-spacing: 0;
}

.progress__num {
  font-family: var(--mono);
  font-size: 13px;
  font-variant-numeric: tabular-nums;
  color: var(--label-2);
}

.progress__track {
  height: 8px;
  border-radius: 6px;
  background: var(--fill-2);
  box-shadow: var(--inset-hair);
  overflow: hidden;
}

.progress__fill {
  display: block;
  height: 100%;
  border-radius: 6px;
  background: linear-gradient(90deg, var(--accent), var(--accent-ink));
  transition: width var(--dur) var(--ease);
}
</style>
