<script setup lang="ts">
/**
 * 提示条。图标放 `icon` 插槽，正文放默认插槽。
 *
 * 只有 `danger` 是错误：读屏器立即播报（`role="alert"`）。`warn` / `info` 是静态
 * 说明，不进播报队列。
 */
type CalloutTone = 'danger' | 'warn' | 'info'

withDefaults(defineProps<{ tone?: CalloutTone }>(), { tone: 'danger' })
</script>

<template>
  <div class="callout" :class="`callout--${tone}`" :role="tone === 'danger' ? 'alert' : undefined">
    <slot name="icon" />
    <slot />
  </div>
</template>
