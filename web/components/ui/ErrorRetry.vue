<script setup lang="ts">
/**
 * 侧栏取数失败：错误条 + 一个重试按钮，放在 `.aside-pad` 里。
 *
 * 图标由调用方给（`icon` 插槽）：三处的 lucide 图标不同。文案统一是「重试」，
 * 回调由调用方的 `@retry` 决定。
 */
defineProps<{ message: string }>()

const emit = defineEmits<{ retry: [] }>()
</script>

<template>
  <div class="aside-pad">
    <UiCallout>
      <template #icon><slot name="icon" /></template>
      <div>{{ message }}</div>
    </UiCallout>
    <UiButton variant="secondary" size="sm" @click="emit('retry')">重试</UiButton>
  </div>
</template>
