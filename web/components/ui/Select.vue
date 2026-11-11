<script lang="ts">
/** 一个选项。值必须是字符串：控制台的选择项都会原样进查询串或请求体。 */
export interface SelectOption {
  readonly value: string
  readonly label: string
}
</script>

<script setup lang="ts" generic="T extends string">
/**
 * 下拉选择（shadcn-vue 的 Select，按 Apple 令牌实现）。
 *
 * 用原生 `<select>`：控制台的选择项都在 10 个以内，自绘列表要自己补键盘导航、
 * 移动端滚轮和读屏器语义，收益为零。外观上的差异（箭头、内边距）由外壳负责。
 *
 * 高度 36 / 圆角 10 与输入框一致；聚焦环用系统蓝，`focus-visible` 只在键盘
 * 操作时出现，鼠标点击不闪。
 */
import { ChevronDown } from 'lucide-vue-next'

const props = withDefaults(
  defineProps<{
    options: readonly SelectOption[]
    ariaLabel?: string
    /**
     * 原生 `<select>` 的 id。
     *
     * 根节点是 `<span>` 包装，`id` 不会像单根组件那样自动落到控件上；表单里要用
     * `<label for>` 关联时显式传它。
     */
    id?: string
    /** 与错误 / 说明文字的 `id` 关联（`aria-describedby`）。 */
    describedBy?: string
    size?: 'md' | 'sm'
    disabled?: boolean
  }>(),
  {
    ariaLabel: undefined,
    id: undefined,
    describedBy: undefined,
    size: 'md',
    disabled: false,
  },
)

const model = defineModel<T>({ required: true })
</script>

<template>
  <span class="select" :class="{ 'select--sm': props.size === 'sm' }">
    <select
      v-model="model"
      :id="props.id"
      :aria-label="props.ariaLabel"
      :aria-describedby="props.describedBy"
      :disabled="props.disabled"
    >
      <option v-for="option in props.options" :key="option.value" :value="option.value">
        {{ option.label }}
      </option>
    </select>
    <ChevronDown :size="13" :stroke-width="1.7" aria-hidden="true" />
  </span>
</template>

<style scoped>
.select {
  position: relative;
  display: inline-flex;
  align-items: center;
  min-width: 0;
}

.select select {
  appearance: none;
  width: 100%;
  height: 36px;
  padding: 0 30px 0 12px;
  border: 0;
  border-radius: var(--r-control);
  background: var(--fill-2);
  box-shadow: var(--inset-hair);
  color: var(--label);
  font: inherit;
  font-size: 14px;
  letter-spacing: 0;
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease), box-shadow var(--dur-fast) var(--ease);
}

.select select:hover {
  background: var(--fill-3);
}

.select select:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3px var(--accent-tint), var(--inset-hair);
}

.select select:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.select option {
  background: var(--surface);
  color: var(--label);
}

.select > svg {
  position: absolute;
  right: 10px;
  color: var(--label-3);
  pointer-events: none;
}

.select--sm select {
  height: 30px;
  font-size: 13px;
}
</style>
