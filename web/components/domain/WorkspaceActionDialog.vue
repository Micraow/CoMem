<script setup lang="ts">
import { computed, ref, watch } from 'vue'

export type WorkspaceActionMode = 'directory' | 'file' | 'rename' | 'copy'

const model = defineModel<boolean>({ default: false })

const props = defineProps<{
  mode: WorkspaceActionMode
  initialValue?: string
  busy: boolean
  error: string | null
}>()

const emit = defineEmits<{
  submit: [value: string]
}>()

const value = ref('')
const validationError = ref<string | null>(null)

const title = computed(() => {
  switch (props.mode) {
    case 'directory':
      return '新建文件夹'
    case 'file':
      return '新建文档'
    case 'rename':
      return '重命名'
    case 'copy':
      return '创建副本'
  }
})

const placeholder = computed(() =>
  props.mode === 'directory' ? '文件夹名称' : '文档名称，例如 notes.md',
)

watch(
  [model, () => props.mode, () => props.initialValue],
  ([open]) => {
    if (open) {
      value.value = props.initialValue ?? ''
      validationError.value = null
    }
  },
  { immediate: true },
)

function submit(): void {
  const next = value.value.trim()
  if (next === '' || next.includes('/') || next.includes('\\') || next === '.' || next === '..') {
    validationError.value = '名称不能为空，也不能包含斜杠。'
    return
  }
  validationError.value = null
  emit('submit', next)
}
</script>

<template>
  <UiDialog v-model="model" :title="title">
    <form class="stack-16" @submit.prevent="submit">
      <UiErrorCallout v-if="props.error !== null" :message="props.error" />
      <label class="field">
        <span class="field__label">名称</span>
        <UiInput
          v-model="value"
          :placeholder="placeholder"
          :disabled="props.busy"
          autocomplete="off"
          @input="validationError = null"
        />
        <span v-if="validationError !== null" class="field__error" role="alert">
          {{ validationError }}
        </span>
      </label>
      <div class="rowflex">
        <span class="spacer" />
        <UiButton variant="secondary" :disabled="props.busy" @click="model = false">取消</UiButton>
        <UiButton type="submit" variant="primary" :disabled="props.busy">
          {{ props.busy ? '处理中' : '完成' }}
        </UiButton>
      </div>
    </form>
  </UiDialog>
</template>

<style scoped>
.field {
  display: grid;
  gap: 7px;
}

.field__label {
  color: var(--label-2);
  font-size: 13px;
  font-weight: 600;
}

.field__error {
  color: var(--red-ink);
  font-size: 13px;
}
</style>
