<script setup lang="ts">
/**
 * 多行文本（shadcn-vue 的 Textarea）。
 *
 * 检索词与拒绝原因是多行的：前者可能粘进一段带换行的 prompt，后者要写完整句子。
 * 单行输入会把换行压成空格，用户看不到自己实际提交了什么。
 *
 * 高度用 `min-height` 而不是固定值：拒绝原因两行就够，检索词可能粘贴十行，
 * 手动纵向拉伸的默认行为保留。
 */
const props = withDefaults(
  defineProps<{
    placeholder?: string
    ariaLabel?: string
    rows?: number
    disabled?: boolean
  }>(),
  {
    placeholder: undefined,
    ariaLabel: undefined,
    rows: 4,
    disabled: false,
  },
)

const model = defineModel<string>({ default: '' })
</script>

<template>
  <textarea
    v-model="model"
    class="textarea"
    :rows="props.rows"
    :placeholder="props.placeholder"
    :aria-label="props.ariaLabel"
    :disabled="props.disabled"
    spellcheck="false"
  />
</template>

<style scoped>
.textarea {
  display: block;
  width: 100%;
  min-height: 96px;
  padding: 10px 12px;
  border: 0;
  border-radius: var(--r-control);
  background: var(--fill-2);
  box-shadow: var(--inset-hair);
  color: var(--label);
  font: inherit;
  font-size: 15px;
  line-height: 1.47;
  letter-spacing: -0.006em;
  resize: vertical;
  transition: background var(--dur-fast) var(--ease), box-shadow var(--dur-fast) var(--ease);
}

.textarea::placeholder {
  color: var(--label-4);
}

.textarea:hover {
  background: var(--fill-3);
}

.textarea:focus {
  outline: none;
  background: var(--surface-2);
  box-shadow: 0 0 0 3px var(--accent-tint), var(--inset-hair);
}

.textarea:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
