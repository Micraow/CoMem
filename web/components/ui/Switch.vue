<script setup lang="ts">
/**
 * 开关（shadcn-vue 的 Switch）。
 *
 * 用 `role="switch"` + `aria-checked` 而不是隐藏的 checkbox：读屏器直接播报
 * 开/关状态，不需要额外包一层 label。滑块位移 160ms，与设计稿的 `--dur-fast`
 * 一致。
 *
 * 只用于**立即生效**的二元状态。需要「确认后再生效」的状态不要用它——开关
 * 的语义是「拨了就变」，加确认会让它退化成按钮。
 */
const props = withDefaults(
  defineProps<{
    ariaLabel?: string
    disabled?: boolean
  }>(),
  {
    ariaLabel: undefined,
    disabled: false,
  },
)

const model = defineModel<boolean>({ default: false })
</script>

<template>
  <button
    type="button"
    role="switch"
    class="switch"
    :class="{ 'is-on': model }"
    :aria-checked="model"
    :aria-label="props.ariaLabel"
    :disabled="props.disabled"
    @click="model = !model"
  >
    <span class="switch__thumb" aria-hidden="true" />
  </button>
</template>

<style scoped>
.switch {
  position: relative;
  flex: none;
  width: 42px;
  height: 25px;
  padding: 0;
  border: 0;
  border-radius: var(--r-pill);
  background: var(--fill-3);
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease);
}

.switch.is-on {
  background: var(--accent);
}

.switch:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.switch:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3px var(--accent-tint);
}

.switch__thumb {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 21px;
  height: 21px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.32);
  transition: transform 160ms var(--ease);
}

.switch.is-on .switch__thumb {
  transform: translateX(17px);
}
</style>
