<script setup lang="ts">
/**
 * 输入框（shadcn-vue 的 Input）。
 *
 * `defineModel` 直接绑定字符串：控制台的输入全是文本，没有需要转换的类型。
 */
const model = defineModel<string>({ default: '' })

const props = withDefaults(
  defineProps<{
    type?: 'text' | 'search' | 'url'
    placeholder?: string
    ariaLabel?: string
    size?: 'md' | 'sm'
    /** `ghost` 用于嵌在已填充容器里的输入（例如带图标的搜索框）。 */
    variant?: 'default' | 'ghost'
    disabled?: boolean
  }>(),
  {
    type: 'text',
    placeholder: undefined,
    ariaLabel: undefined,
    size: 'md',
    variant: 'default',
    disabled: false,
  },
)
</script>

<template>
  <input
    v-model="model"
    class="input"
    :class="{ 'input--sm': props.size === 'sm', 'input--ghost': props.variant === 'ghost' }"
    :type="props.type"
    :placeholder="props.placeholder"
    :aria-label="props.ariaLabel"
    :disabled="props.disabled"
  >
</template>
