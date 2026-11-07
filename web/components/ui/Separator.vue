<script setup lang="ts">
/**
 * 分割线（shadcn-vue 的 Separator）。
 *
 * 只是视觉分隔，不属于内容结构：对辅助技术隐藏，避免把「一条线」读成内容。
 */
withDefaults(
  defineProps<{
    orientation?: 'horizontal' | 'vertical'
  }>(),
  { orientation: 'horizontal' },
)
</script>

<template>
  <div
    class="divider"
    :class="{ 'divider--vertical': orientation === 'vertical' }"
    role="presentation"
    aria-hidden="true"
  />
</template>
