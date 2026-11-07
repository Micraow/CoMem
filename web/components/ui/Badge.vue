<script setup lang="ts">
/**
 * 标记（shadcn-vue 的 Badge）。
 *
 * 颜色只表达语义，不单独表意：调用方必须同时给出文字（§16.1「不用颜色单独表意」）。
 */
type BadgeVariant =
  | 'blue'
  | 'green'
  | 'red'
  | 'orange'
  | 'purple'
  | 'teal'
  | 'gray'
  | 'outline'

withDefaults(defineProps<{ variant?: BadgeVariant }>(), { variant: 'gray' })
</script>

<template>
  <span class="pill" :class="`pill--${variant}`"><slot /></span>
</template>
