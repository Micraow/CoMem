<script setup lang="ts">
/**
 * 滚动容器（shadcn-vue 的 ScrollArea 的最小形态）。
 *
 * 浏览器原生滚动条已经按设计稿调过样式，这里不实现自定义滚动条：
 * 一层 `overflow-y: auto` 就够用，多包一层 JS 只会带来高度计算问题。
 */
const props = withDefaults(
  defineProps<{
    maxHeight?: string
    ariaLabel?: string
  }>(),
  {
    maxHeight: undefined,
    ariaLabel: undefined,
  },
)
</script>

<template>
  <div
    class="scroll-area"
    :style="props.maxHeight === undefined ? undefined : { maxHeight: props.maxHeight }"
    :aria-label="props.ariaLabel"
    tabindex="0"
  >
    <slot />
  </div>
</template>
