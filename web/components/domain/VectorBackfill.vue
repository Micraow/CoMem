<script setup lang="ts">
import { RefreshCw } from 'lucide-vue-next'
import { useIntervalFn } from '@vueuse/core'

import { errorMessageOf, isForbidden, useApi } from '~/composables/useApi'

interface BackfillStatus {
  readonly missing: number | null
  readonly running: boolean
  readonly progress: { readonly remaining: number; readonly total: number; readonly failed: number; readonly embedded: number } | null
  readonly error: string | null
}

const api = useApi()
const path = '/tasks/vector-backfill'
const status = ref<BackfillStatus | null>(null)
const error = ref<string | null>(null)
const hidden = ref(false)
const busy = ref(false)

async function load(start = false): Promise<void> {
  if (busy.value) return
  busy.value = true
  try {
    status.value = start ? await api.post<BackfillStatus>(path) : await api.get<BackfillStatus>(path)
    error.value = null
  } catch (caught) {
    hidden.value = isForbidden(caught)
    error.value = errorMessageOf(caught)
  } finally {
    busy.value = false
  }
}

const { pause, resume } = useIntervalFn(() => { void load() }, 3_000, { immediate: false })
watch(() => status.value?.running, (running) => { if (running) resume(); else pause() })
onMounted(() => { void load() })
</script>

<template>
  <UiCard v-if="!hidden" title="向量索引" panel>
    <template #actions>
      <UiRefreshButton label="刷新向量索引状态" :disabled="busy" @click="load()" />
      <UiButton v-if="status?.missing != null" variant="secondary" size="sm" :disabled="busy || status.running || status.missing === 0" @click="load(true)">
        <RefreshCw :size="14" />
        {{ status.running ? '正在补齐' : '补齐缺失向量' }}
      </UiButton>
    </template>
    <UiErrorCallout v-if="error ?? status?.error" :message="error ?? status?.error ?? ''" />
    <UiSkeleton v-else-if="status === null" width="25%" height="14px" />
    <div v-else class="stack-8" role="status">
      <div>{{ status.missing === null ? '未启用向量检索' : status.missing === 0 ? '向量索引完整' : `${status.missing} 项缺失` }}</div>
      <UiProgress v-if="status.running && status.progress && status.progress.total > 0" :value="status.progress.total - status.progress.remaining" :max="status.progress.total" label="已处理" />
      <div v-if="status.progress && status.progress.total > 0" class="body-sm">
        已补齐 {{ status.progress.embedded }} 项<span v-if="status.progress.failed > 0"> · {{ status.progress.failed }} 项失败</span>
      </div>
    </div>
  </UiCard>
</template>
