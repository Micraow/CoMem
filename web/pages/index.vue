<script setup lang="ts">
/**
 * 概览（架构文档 §16 的第一页）。
 *
 * 四个指标 + 待处理任务。指标全部来自 `GET /health`，任务卡来自 `GET /tasks`。
 * `/metrics` 是 Prometheus 文本，不套信封，且它的计数与 `/health` 重叠，
 * 在浏览器里再解析一份只会得到两套口径。
 *
 * 待复核数直接读 `health.memory.pendingReview`：`GET /memories/pending` 不排序、
 * 先截断 100 条，拿它的返回条数当总数只会得到一个偏小的值。
 *
 * 「最近请求」没有对应端点：`request_log` 只落 SQLite，没有 HTTP 读出口。
 * 这里退一步展示任务队列——它是同一批后台工作里唯一可读的部分。
 */
import { AlertTriangle, CheckCircle2, Inbox, RefreshCw } from 'lucide-vue-next'

import {
  errorMessageOf,
  useApi,
  type HealthPayload,
  type TaskPayload,
} from '~/composables/useApi'

useHead({ title: '概览 · CoMem 控制台' })

/** 任务表只陈列最前面的一屏。 */
const TASK_PREVIEW_LIMIT = 8

const api = useApi()

const health = useState<HealthPayload | null>('comem-health', () => null)
const tasks = useState<readonly TaskPayload[] | null>('comem-tasks', () => null)
const loading = ref(false)
const error = ref<string | null>(null)

const TASK_TYPE_LABEL: Readonly<Record<string, string>> = {
  archive: '归档',
  extract: '抽取',
  merge: '合并',
  summary: '摘要',
  index: '索引',
}

/**
 * `/tasks` 只返回可认领的任务（`pending` 或租约过期的 `running`），
 * `done` / `failed` 不会出现在这里，因此不声明这两个状态的文案。
 */
const TASK_STATUS_LABEL: Readonly<Record<string, string>> = {
  pending: '排队中',
  running: '运行中',
}

type BadgeVariant = 'blue' | 'green' | 'red' | 'orange' | 'purple' | 'teal' | 'gray' | 'outline'

const TASK_STATUS_VARIANT: Readonly<Record<string, BadgeVariant>> = {
  pending: 'gray',
  running: 'blue',
}

const stats = computed<readonly { key: string; label: string; value: string; tone?: string }[]>(
  () => [
    {
      key: 'nodes',
      label: '索引节点数',
      value: health.value === null ? '—' : String(health.value.index.totalNodes),
    },
    {
      key: 'queue',
      label: '待处理任务',
      value: health.value === null ? '—' : String(health.value.queue.pending),
      tone: (health.value?.queue.pending ?? 0) > 0 ? 'is-orange' : undefined,
    },
    {
      key: 'review',
      label: '待复核记忆',
      value: health.value === null ? '—' : String(health.value.memory.pendingReview),
      tone: (health.value?.memory.pendingReview ?? 0) > 0 ? 'is-orange' : undefined,
    },
    {
      key: 'degraded',
      label: '摘要降级目录数',
      value: health.value === null ? '—' : String(health.value.summary.degradedDirs),
      tone: (health.value?.summary.degradedDirs ?? 0) > 0 ? 'is-red' : undefined,
    },
  ],
)

function formatDateTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return value
  }
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

async function load(): Promise<void> {
  loading.value = true
  error.value = null
  try {
    const [healthPayload, taskPayload] = await Promise.all([
      api.get<HealthPayload>('/health'),
      api.get<{ tasks: readonly TaskPayload[]; total: number }>('/tasks', {
        limit: TASK_PREVIEW_LIMIT,
      }),
    ])
    health.value = healthPayload
    tasks.value = taskPayload.tasks
  } catch (caught) {
    error.value = errorMessageOf(caught)
    health.value = null
    tasks.value = null
  } finally {
    loading.value = false
  }
}

onMounted(load)
</script>

<template>
  <div class="content">
    <div class="page">
      <DomainPageHeader title="概览">
        <template #actions>
          <UiBadge v-if="health !== null" :variant="health.status === 'degraded' ? 'orange' : 'green'">
            {{ health.status === 'degraded' ? '降级运行' : '运行正常' }}
          </UiBadge>
          <UiButton variant="secondary" size="sm" :disabled="loading" @click="load">
            <RefreshCw :size="14" :stroke-width="1.5" />
            刷新
          </UiButton>
        </template>
      </DomainPageHeader>

      <div v-if="error !== null" class="callout callout--danger mb-24">
        <AlertTriangle :size="15" :stroke-width="1.4" />
        <div>{{ error }}</div>
      </div>

      <div class="stats mb-24">
        <div v-for="stat in stats" :key="stat.key" class="stat rise">
          <UiSkeleton v-if="loading && health === null" width="56px" height="26px" />
          <span v-else class="stat__v" :class="stat.tone">{{ stat.value }}</span>
          <span class="stat__k">{{ stat.label }}</span>
        </div>
      </div>

      <UiCard title="待处理任务" panel>
        <template #actions>
          <span class="caption">最早创建优先，只含可认领的任务</span>
        </template>

        <div v-if="loading && tasks === null" class="stack-12">
          <UiSkeleton v-for="index in 5" :key="index" :width="`${64 - index * 6}%`" height="14px" />
        </div>

        <div v-else-if="tasks !== null && tasks.length === 0" class="empty">
          <span class="empty__icon">
            <CheckCircle2 :size="20" :stroke-width="1.4" />
          </span>
          <span class="empty__title">队列是空的</span>
        </div>

        <UiTable v-else-if="tasks !== null" caption="待处理任务">
          <thead>
            <tr>
              <th>任务</th>
              <th>类型</th>
              <th>状态</th>
              <th class="num">尝试</th>
              <th>更新时间</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="task in tasks" :key="task.id">
              <td class="mono strong">{{ task.id }}</td>
              <td>{{ TASK_TYPE_LABEL[task.type] ?? task.type }}</td>
              <td>
                <UiBadge :variant="TASK_STATUS_VARIANT[task.status] ?? 'gray'">
                  {{ TASK_STATUS_LABEL[task.status] ?? task.status }}
                </UiBadge>
              </td>
              <td class="num">{{ task.attempts }}</td>
              <td class="mono">{{ formatDateTime(task.updatedAt) }}</td>
            </tr>
          </tbody>
        </UiTable>

        <div v-else class="empty">
          <span class="empty__icon">
            <Inbox :size="20" :stroke-width="1.4" />
          </span>
          <span class="empty__title">还没有任务</span>
        </div>
      </UiCard>
    </div>
  </div>
</template>
