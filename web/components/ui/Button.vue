<script setup lang="ts">
/**
 * 按钮（shadcn-vue 的 Button，按 Apple 令牌改配色与高度）。
 *
 * 四个语义变体对应设计稿的四种操作层级：主要（实心蓝）/ 次要（半透明底）/
 * 纯文字 / 危险。高度 36px，不小于 36px 是 §16.1 的硬要求。
 */
import { cva, type VariantProps } from 'class-variance-authority'

const buttonVariants = cva('btn', {
  variants: {
    variant: {
      primary: 'btn--primary',
      secondary: 'btn--secondary',
      plain: 'btn--plain',
      danger: 'btn--danger',
    },
    size: {
      md: '',
      sm: 'btn--sm',
    },
  },
  defaultVariants: {
    variant: 'secondary',
    size: 'md',
  },
})

type ButtonVariant = NonNullable<VariantProps<typeof buttonVariants>['variant']>
type ButtonSize = NonNullable<VariantProps<typeof buttonVariants>['size']>

const props = withDefaults(
  defineProps<{
    variant?: ButtonVariant
    size?: ButtonSize
    type?: 'button' | 'submit' | 'reset'
    disabled?: boolean
  }>(),
  {
    variant: 'secondary',
    size: 'md',
    type: 'button',
    disabled: false,
  },
)
</script>

<template>
  <button
    :type="props.type"
    :class="buttonVariants({ variant: props.variant, size: props.size })"
    :disabled="props.disabled"
  >
    <slot />
  </button>
</template>
