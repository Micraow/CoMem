<script setup lang="ts">
/**
 * 分页条，放在卡片的 `foot` 插槽里。是否显示由调用方判断（`total > limit`），
 * 因为空掉的 footer 会留下边框和内边距。
 *
 * `shown` 是当前页已渲染的行数：最后一页可能少于 `limit`。
 */
const props = defineProps<{
  total: number
  limit: number
  offset: number
  shown: number
  loading: boolean
}>()

const emit = defineEmits<{ page: [offset: number] }>()

const pageStart = computed(() => (props.shown === 0 ? 0 : props.offset + 1))
const pageEnd = computed(() => props.offset + props.shown)
const canPrev = computed(() => props.offset > 0)
const canNext = computed(() => props.offset + props.limit < props.total)
</script>

<template>
  <span class="caption">{{ pageStart }}–{{ pageEnd }} / {{ props.total }}</span>
  <span class="spacer" />
  <UiButton
    variant="secondary"
    size="sm"
    :disabled="!canPrev || props.loading"
    @click="emit('page', Math.max(0, props.offset - props.limit))"
  >
    上一页
  </UiButton>
  <UiButton
    variant="secondary"
    size="sm"
    :disabled="!canNext || props.loading"
    @click="emit('page', props.offset + props.limit)"
  >
    下一页
  </UiButton>
</template>
