<script setup lang="ts" generic="T extends string">
/**
 * 分段控件（shadcn-vue 的 Tabs，按 macOS 分段控件的外观实现）。
 *
 * 用 `aria-selected` 而不是自己维护选中类：设计稿的样式也挂在
 * `button[aria-selected="true"]` 上，两者共用一份真相。
 *
 * 组件对取值类型泛型：调用方传 `'l0' | 'l1' | 'l2'` 时，`v-model` 仍然是同一组
 * 字面量，不需要在页面里写类型断言。
 */
export interface TabItem {
  readonly label: string
  /** 前置短标记，例如层级 `L0`。 */
  readonly lead?: string
}

const props = defineProps<{
  items: readonly (TabItem & { readonly value: T })[]
  ariaLabel?: string
}>()

const model = defineModel<T>({ required: true })

function select(value: T): void {
  model.value = value
}
</script>

<template>
  <div
    class="segmented segmented--full"
    role="tablist"
    :aria-label="props.ariaLabel ?? '切换视图'"
  >
    <button
      v-for="item in props.items"
      :key="item.value"
      type="button"
      role="tab"
      :aria-selected="model === item.value"
      @click="select(item.value)"
    >
      <span v-if="item.lead" class="mono">{{ item.lead }}</span>
      <span class="seg-label">{{ item.label }}</span>
    </button>
  </div>
</template>
