<script setup lang="ts">
import { ref, watch } from 'vue'
import { FileWarning } from 'lucide-vue-next'

import {
  errorMessageOf,
  useApi,
  type ContentReadPayload,
} from '~/composables/useApi'
import { useToast } from '~/composables/useToast'

const model = defineModel<boolean>({ default: false })

const props = defineProps<{
  uri: string | null
}>()

const emit = defineEmits<{
  saved: []
}>()

const api = useApi()
const toast = useToast()

const text = ref('')
const loading = ref(false)
const saving = ref(false)
const truncated = ref(false)
const loadedUri = ref<string | null>(null)
const error = ref<string | null>(null)
let request = 0

async function load(uri: string): Promise<void> {
  const generation = ++request
  loading.value = true
  loadedUri.value = null
  error.value = null
  truncated.value = false
  text.value = ''
  try {
    const payload = await api.get<ContentReadPayload>('/content/read', {
      uri,
      limit: -1,
    })
    if (generation === request) {
      text.value = payload.text
      truncated.value = payload.truncated
      loadedUri.value = uri
    }
  } catch (caught) {
    if (generation === request) error.value = errorMessageOf(caught)
  } finally {
    if (generation === request) loading.value = false
  }
}

async function save(): Promise<void> {
  const uri = props.uri
  if (uri === null || loadedUri.value !== uri || loading.value || truncated.value || saving.value) {
    return
  }

  saving.value = true
  error.value = null
  try {
    await api.post('/content/write', {
      uri,
      content: text.value,
      mode: 'replace',
    })
    toast.show('success', '文档已保存')
    emit('saved')
    model.value = false
  } catch (caught) {
    error.value = errorMessageOf(caught)
  } finally {
    saving.value = false
  }
}

watch(
  [model, () => props.uri],
  ([open, uri]) => {
    if (open && uri !== null) {
      void load(uri)
    } else {
      request += 1
      loadedUri.value = null
    }
  },
  { immediate: true },
)
</script>

<template>
  <UiDialog v-model="model" title="编辑文档">
    <form class="editor" @submit.prevent="save">
      <UiErrorCallout v-if="error !== null" :message="error" />
      <div v-if="truncated" class="truncated">
        <FileWarning :size="16" :stroke-width="1.5" />
        <span>文档过大，已停止编辑以保护原文。</span>
      </div>
      <div v-if="loading" class="editor__loading" aria-busy="true">
        <UiSkeleton width="100%" height="52px" />
        <UiSkeleton width="92%" height="52px" />
        <UiSkeleton width="84%" height="52px" />
      </div>
      <UiTextarea
        v-else
        v-model="text"
        :rows="18"
        :disabled="loadedUri !== props.uri || truncated || saving"
        aria-label="文档正文"
      />
      <div class="rowflex">
        <span class="spacer" />
        <UiButton variant="secondary" :disabled="saving" @click="model = false">取消</UiButton>
        <UiButton
          type="submit"
          variant="primary"
          :disabled="loadedUri !== props.uri || loading || truncated || saving"
        >
          {{ saving ? '保存中' : '保存' }}
        </UiButton>
      </div>
    </form>
  </UiDialog>
</template>

<style scoped>
.editor {
  display: grid;
  gap: 14px;
}

.truncated {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 10px 12px;
  border-radius: 10px;
  background: var(--orange-tint);
  color: var(--orange-ink);
  font-size: 13px;
}

.editor__loading {
  display: grid;
  gap: 8px;
}
</style>
