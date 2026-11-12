<script setup lang="ts">
/**
 * 空状态。图标由调用方给：各处的 lucide 图标不同，尺寸默认 20（多数派）。
 *
 * `extra` 放标题与副标题之后的附加内容（入口按钮、说明小字）。
 */
withDefaults(
  defineProps<{
    title: string
    text?: string
    size?: 20 | 22
  }>(),
  { text: undefined, size: 20 },
)
</script>

<template>
  <div class="empty">
    <span v-if="$slots.default" class="empty__icon">
      <slot :size="size" />
    </span>
    <span class="empty__title">{{ title }}</span>
    <span v-if="text !== undefined" class="empty__text">{{ text }}</span>
    <slot name="extra" />
  </div>
</template>
