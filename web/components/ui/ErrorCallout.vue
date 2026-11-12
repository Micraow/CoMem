<script setup lang="ts">
import { AlertTriangle } from 'lucide-vue-next'

/**
 * 取数失败的提示条：红底、警告图标、读屏器立即播报。
 *
 * 图标不给调用方：这类条目的图标一律是警告三角。正文除了错误文案还有列表、
 * 标题行或按钮时，用 `UiCallout` 自己拼。
 */
defineProps<{ message: string }>()
</script>

<template>
  <UiCallout>
    <template #icon><AlertTriangle :size="15" :stroke-width="1.4" /></template>
    <div>{{ message }}</div>
  </UiCallout>
</template>
