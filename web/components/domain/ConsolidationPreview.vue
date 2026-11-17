<script setup lang="ts">
import { ApiClientError, forbiddenMessageOf, useApi } from '~/composables/useApi'
import { fileRouteOf } from '~/utils/fileRoute'

interface Preview {
  readonly adds: readonly string[]
  readonly updates: readonly string[]
  readonly deletes: readonly string[]
  readonly trace: readonly { readonly action: 'read' | 'finish'; readonly summary: string }[]
}

const api = useApi()
const scope = useScopeRoot()
const open = ref(false)
const loading = ref(false)
const error = ref<string | null>(null)
const disabled = ref(false)
const result = ref<Preview | null>(null)
let run = 0

// A preview can make several model calls. Bound the wait to the default timeout of one model call.
const PREVIEW_TIMEOUT_MS = 120_000

watch(scope, () => {
  run += 1
  open.value = false
  loading.value = false
  result.value = null
  error.value = null
  disabled.value = false
})

async function preview(): Promise<void> {
  if (loading.value || scope.value === '') return
  const request = ++run
  result.value = null
  error.value = null
  disabled.value = false
  loading.value = true
  try {
    const value = await api.post<Preview>(
      '/memories/consolidate', { scope: scope.value, dryRun: true }, { timeoutMs: PREVIEW_TIMEOUT_MS },
    )
    if (request === run) result.value = value
  } catch (caught) {
    if (request !== run) return
    const details = caught instanceof ApiClientError ? caught.details : null
    disabled.value = details !== null && typeof details === 'object' && 'field' in details &&
      details.field === 'memory.dreamer.manualConsolidation'
    error.value = disabled.value
      ? '当前未启用手动整理。'
      : forbiddenMessageOf(caught, '你没有权限整理这个空间的记忆。')
  } finally {
    if (request === run) loading.value = false
  }
}

const groups = computed(() => result.value === null ? [] : [
  { label: '建议新增', uris: result.value.adds, existing: false },
  { label: '建议更新', uris: result.value.updates, existing: true },
  { label: '建议删除', uris: result.value.deletes, existing: true },
].filter(group => group.uris.length > 0))
const summary = computed(() => result.value?.trace.findLast((step) => step.action === 'finish')?.summary)
</script>

<template>
  <UiButton size="sm" @click="open = true">整理建议</UiButton>
  <UiDialog v-model="open" title="整理建议">
    <div class="stack-16">
      <p class="body-sm">让模型查找当前空间里重复或互相冲突的记忆。查看建议不会改动记忆。</p>
      <UiErrorCallout v-if="error !== null" :message="error" />
      <p v-if="disabled" class="body-sm">配置可用 LLM 后，可在 <NuxtLink to="/settings">设置</NuxtLink> 中开启「允许 Dreamer 手动整理」。</p>
      <template v-if="result !== null">
        <p v-if="groups.length === 0" class="body-sm">没有建议改动的记忆。</p>
        <section v-for="group in groups" :key="group.label">
          <h3 class="headline">{{ group.label }} · {{ group.uris.length }}</h3>
          <ul class="suggested-files body-sm">
            <li v-for="uri in group.uris" :key="uri">
              <NuxtLink v-if="group.existing" :to="fileRouteOf(uri)">{{ uri }}</NuxtLink>
              <span v-else>{{ uri }}</span>
            </li>
          </ul>
        </section>
        <p v-if="groups.length > 0 && summary" class="body-sm suggested-files">{{ summary }}</p>
      </template>
      <div class="rowflex">
        <NuxtLink to="/prompts?prompt=consolidation-system">查看整理提示词</NuxtLink>
        <span class="spacer" />
        <UiButton variant="primary" :disabled="loading || scope === ''" @click="preview">
          {{ loading ? '正在检查记忆…' : '生成整理建议' }}
        </UiButton>
      </div>
    </div>
  </UiDialog>
</template>

<style scoped>
.suggested-files {
  overflow-wrap: anywhere;
}

ul.suggested-files {
  padding-inline-start: 1.25rem;
}
</style>
