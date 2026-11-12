<script setup lang="ts">
import { RefreshCw } from 'lucide-vue-next'

/**
 * 图标刷新按钮。图标与尺寸固定，只有读屏文案、禁用状态和点击回调由调用方给。
 *
 * 各处的文案不同（拉取的是目录树、复核队列、提示词还是工具清单），所以文案不做默认值。
 */
defineProps<{ label: string; disabled?: boolean }>()

const emit = defineEmits<{ click: [] }>()
</script>

<template>
  <button type="button" class="iconbtn" :aria-label="label" :disabled="disabled" @click="emit('click')">
    <RefreshCw :size="15" :stroke-width="1.5" />
  </button>
</template>
