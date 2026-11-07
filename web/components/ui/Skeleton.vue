<script setup lang="ts">
/**
 * 骨架屏（shadcn-vue 的 Skeleton）。
 *
 * 加载中一律用骨架屏，不用转圈：转圈只表达「在等」，骨架屏同时表达「等的是什么形状」。
 */
const props = withDefaults(
  defineProps<{
    width?: string
    height?: string
    radius?: string
  }>(),
  {
    width: '100%',
    height: '12px',
    radius: 'var(--r-sm)',
  },
)
</script>

<template>
  <span
    class="skeleton"
    :style="{ width: props.width, height: props.height, borderRadius: props.radius }"
    aria-hidden="true"
  />
</template>
