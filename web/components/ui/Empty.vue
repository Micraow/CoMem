<script setup lang="ts">
import { ShieldAlert } from 'lucide-vue-next'

/**
 * 空状态。图标由调用方给：各处的 lucide 图标不同，尺寸默认 20（多数派）。
 *
 * `forbidden` 是「需要管理员权限」的固定形状：标题和盾牌图标都由组件给。
 *
 * `extra` 放标题与副标题之后的附加内容（入口按钮、说明小字）。
 */
withDefaults(
  defineProps<{
    title?: string
    text?: string
    size?: 20 | 22
    forbidden?: boolean
  }>(),
  { title: undefined, text: undefined, size: 20, forbidden: false },
)
</script>

<template>
  <div class="empty">
    <span v-if="$slots.default || forbidden" class="empty__icon">
      <slot :size="size">
        <ShieldAlert v-if="forbidden" :size="size" :stroke-width="1.4" />
      </slot>
    </span>
    <span v-if="forbidden || title !== undefined" class="empty__title">
      {{ forbidden ? '需要管理员权限' : title }}
    </span>
    <span v-if="text !== undefined" class="empty__text">{{ text }}</span>
    <slot name="extra" />
  </div>
</template>
