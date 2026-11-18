<script setup lang="ts">
import { fileRouteOf } from '~/utils/fileRoute'
import { errorMessageOf, useApi } from '~/composables/useApi'

interface ArchiveActivity {
  readonly uri: string
  readonly status: 'pending' | 'running' | 'done' | 'failed' | null
  readonly nextStep: string | null
  readonly skippedSteps: readonly { step: string; reason: string }[]
  readonly changes: { added: number; updated: number; deleted: number; skipped: number | null } | null
}

interface Activity {
  readonly items: readonly ArchiveActivity[]
  readonly acknowledged: number
}

const props = defineProps<{ sessionId: string; scope: string }>()
const api = useApi()
const activity = ref<Activity | null>(null)
const error = ref<string | null>(null)
const loading = ref(false)
let requestVersion = 0

const STEP: Readonly<Record<string, string>> = {
  archive_summary: '归档摘要', memory_extract: '记忆抽取', memory_merge: '写入记忆',
  summary_invalidate: '刷新摘要', dreamer: '记忆整理',
}

function statusOf(item: ArchiveActivity): string {
  const step = item.nextStep === null ? null : STEP[item.nextStep]
  if (item.status === 'failed') return step ? `${step}失败` : '归档处理失败'
  if (item.status === 'pending') return '等待处理'
  if (item.status === 'running') return step ? `正在${step}` : '处理中'
  if (item.status === 'done') return '处理完成'
  return '任务状态不可用'
}

function changesOf(item: ArchiveActivity): string {
  if (item.changes === null) return '还没有写入结果'
  const { added, updated, deleted, skipped } = item.changes
  const changes = [added > 0 ? `新增 ${added}` : '', updated > 0 ? `更新 ${updated}` : '', deleted > 0 ? `删除 ${deleted}` : ''].filter(Boolean)
  return [changes.join(' · ') || '没有记忆变更', skipped ? `跳过 ${skipped}` : ''].filter(Boolean).join(' · ')
}

async function refresh() {
  const version = ++requestVersion
  loading.value = true
  error.value = null
  try {
    const result = await api.get<Activity>(`/sessions/${encodeURIComponent(props.sessionId)}/activity`, { scopeUri: props.scope })
    if (version === requestVersion) activity.value = result
  } catch (caught) {
    if (version === requestVersion) error.value = errorMessageOf(caught)
  } finally {
    if (version === requestVersion) loading.value = false
  }
}

watch(() => [props.sessionId, props.scope], () => { activity.value = null; void refresh() }, { immediate: true })
onBeforeUnmount(() => { requestVersion += 1 })
</script>

<template>
  <section class="session-activity" aria-label="会话记忆结果">
    <header>
      <span v-if="activity !== null">{{ activity.acknowledged ? `近期宿主确认接收 ${activity.acknowledged} 条上下文` : '近期未查到宿主回执' }}</span>
      <UiButton size="sm" variant="secondary" :disabled="loading" @click="refresh">刷新结果</UiButton>
    </header>
    <UiErrorCallout v-if="error" :message="error" />
    <p v-else-if="activity === null" role="status">正在读取会话结果…</p>
    <p v-else-if="activity.items.length === 0">这个会话还没有归档。</p>
    <ul v-else>
      <li v-for="item in activity.items" :key="item.uri">
        <NuxtLink :to="fileRouteOf(item.uri)">{{ item.uri.split('/').at(-1) }}</NuxtLink>
        <span>{{ statusOf(item) }}</span>
        <span>{{ changesOf(item) }}</span>
        <span v-if="item.skippedSteps.length > 0">未运行：{{ item.skippedSteps.map(({ step }) => STEP[step] ?? step).join('、') }}</span>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.session-activity { padding: 16px 18px; border-top: 1px solid var(--border); }
header, li { display: flex; align-items: center; flex-wrap: wrap; gap: 10px 18px; }
header { justify-content: space-between; font-weight: 600; }
ul { margin: 10px 0 0; padding: 0; list-style: none; }
li { padding: 7px 0; color: var(--text-secondary); }
li a { font-family: var(--font-mono); }
</style>
