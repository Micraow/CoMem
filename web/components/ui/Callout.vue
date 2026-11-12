<script setup lang="ts">
/**
 * 提示条。图标放 `icon` 插槽，正文放默认插槽。
 *
 * 只有 `danger` 是错误：读屏器立即播报（`role="alert"`）。`warn` / `info` 是静态
 * 说明，`success` 是操作结果，三者都不进播报队列；结果要播报时由调用方传
 * `role="status"`。
 */
type CalloutTone = 'danger' | 'warn' | 'info' | 'success'

withDefaults(defineProps<{ tone?: CalloutTone }>(), { tone: 'danger' })
</script>

<template>
  <div class="callout" :class="`callout--${tone}`" :role="tone === 'danger' ? 'alert' : undefined">
    <slot name="icon" />
    <slot />
  </div>
</template>
