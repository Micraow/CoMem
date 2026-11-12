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
 *
 * ## 两个请求分开加载
 *
 * `GET /tasks` 是**系统管理员专属**（`auth.adminUserIds` 默认空 → 普通用户 403），
 * `GET /health` 对所有人可见。两者共用一个 `Promise.all` 加一个 `catch` 时，一次
 * 403 会把健康徽标和三张指标卡一起置空：部署者按文档起来，打开首页看到的是一片
 * 空白，没有任何错误说明。现在两个请求各带自己的加载态与错误，任务卡在 403 时
 * 直接说明需要管理员权限。
 */
import { AlertTriangle, CheckCircle2, Plug, RefreshCw, ShieldAlert } from 'lucide-vue-next'

import {
  errorMessageOf,
  isForbidden,
  useApi,
  type HealthPayload,
  type TaskPayload,
} from '~/composables/useApi'
import { isFreshInstall } from '~/utils/connectGuide'
import { formatMonthDayTime } from '~/utils/format'
import { healthStatusLabel } from '~/utils/healthLabels'
import {
  taskStatusLabelOf,
  taskTypeLabelOf,
  type ClaimableTaskStatus,
} from '~/utils/taskLabels'

useHead({ title: '概览 · CoMem 控制台' })

/** 任务表只陈列最前面的一屏。 */
const TASK_PREVIEW_LIMIT = 8

const api = useApi()

const health = useState<HealthPayload | null>('comem-health', () => null)
const tasks = useState<readonly TaskPayload[] | null>('comem-tasks', () => null)

const loadingHealth = ref(false)
const loadingTasks = ref(false)
const healthError = ref<string | null>(null)
const tasksError = ref<string | null>(null)
/** 任务列表要系统管理员；这个状态与「取失败了」分开表达。 */
const tasksForbidden = ref(false)

/**
 * 状态的文案在 `taskLabels.ts`（与任务表共用一份）。这里只留徽章的档位，那是这一页
 * 的外观选择，不是标签。
 */
type BadgeVariant = 'blue' | 'green' | 'red' | 'orange' | 'purple' | 'teal' | 'gray' | 'outline'

const TASK_STATUS_VARIANT = {
  pending: 'gray',
  running: 'blue',
} satisfies Record<ClaimableTaskStatus, BadgeVariant>

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

async function loadHealth(): Promise<void> {
  loadingHealth.value = true
  healthError.value = null
  try {
    health.value = await api.get<HealthPayload>('/health')
  } catch (caught) {
    healthError.value = errorMessageOf(caught)
    health.value = null
  } finally {
    loadingHealth.value = false
  }
}

async function loadTasks(): Promise<void> {
  loadingTasks.value = true
  tasksError.value = null
  tasksForbidden.value = false
  try {
    const payload = await api.get<{ tasks: readonly TaskPayload[]; total: number }>('/tasks', {
      limit: TASK_PREVIEW_LIMIT,
    })
    tasks.value = payload.tasks
  } catch (caught) {
    tasks.value = null
    // `PERMISSION_DENIED` 映射到 403（`src/domain/errors.ts`）。这不是故障，是
    // 「当前账号不是系统管理员」，重试不会改变结果，所以不显示成错误。判定与取文案
    // 走同一个 `isForbidden`，403 只说一次。
    if (isForbidden(caught)) {
      tasksForbidden.value = true
    } else {
      tasksError.value = errorMessageOf(caught)
    }
  } finally {
    loadingTasks.value = false
  }
}

async function load(): Promise<void> {
  await Promise.all([loadHealth(), loadTasks()])
}

onMounted(load)

/**
 * 新装的数据根没有索引、没有排队任务、任务列表也是空的——这不是「队列是空的」，
 * 是「还没有 Agent 接上来」。引导只在三项都成立时出现，已有数据的部署保持原空态。
 */
const needsOnboarding = computed(() =>
  isFreshInstall(health.value, tasks.value === null ? null : tasks.value.length),
)
</script>

<template>
  <div class="content">
    <div class="page">
      <DomainPageHeader title="概览">
        <template #actions>
          <UiBadge v-if="health !== null" :variant="health.status === 'degraded' ? 'orange' : 'green'">
            {{ healthStatusLabel(health.status) }}
          </UiBadge>
          <UiButton
            variant="secondary"
            size="sm"
            :disabled="loadingHealth || loadingTasks"
            @click="load"
          >
            <RefreshCw :size="14" :stroke-width="1.5" />
            刷新
          </UiButton>
        </template>
      </DomainPageHeader>

      <UiCallout v-if="healthError !== null" class="mb-24">
        <template #icon><AlertTriangle :size="15" :stroke-width="1.4" /></template>
        <div>{{ healthError }}</div>
      </UiCallout>

      <div class="stats mb-24">
        <div v-for="stat in stats" :key="stat.key" class="stat rise">
          <UiSkeleton v-if="health === null && healthError === null" width="56px" height="26px" />
          <span v-else class="stat__v" :class="stat.tone">{{ stat.value }}</span>
          <span class="stat__k">{{ stat.label }}</span>
        </div>
      </div>

      <UiCard title="待处理任务" panel>
        <template #actions>
          <span class="caption">最早创建优先，只含可认领的任务</span>
        </template>

        <UiEmpty v-if="tasksForbidden" v-slot="{ size }" title="需要管理员权限">
          <ShieldAlert :size="size" :stroke-width="1.4" />
        </UiEmpty>

        <UiEmpty v-else-if="tasksError !== null" v-slot="{ size }" title="任务列表没有取到" :text="tasksError">
          <AlertTriangle :size="size" :stroke-width="1.4" />
        </UiEmpty>

        <div v-else-if="tasks === null" class="stack-12" aria-busy="true">
          <UiSkeleton v-for="index in 5" :key="index" :width="`${64 - index * 6}%`" height="14px" />
        </div>

        <template v-else-if="tasks.length === 0">
          <UiEmpty
            v-if="needsOnboarding"
            title="还没有数据"
            text="接入 Agent 后，这里会显示索引与任务。"
          >
            <template #default="{ size }">
              <Plug :size="size" :stroke-width="1.4" />
            </template>
            <template #extra>
              <NuxtLink to="/connect" class="btn btn--primary btn--sm connect-cta">
                接入 Agent
              </NuxtLink>
            </template>
          </UiEmpty>
          <UiEmpty v-else v-slot="{ size }" title="队列是空的">
            <CheckCircle2 :size="size" :stroke-width="1.4" />
          </UiEmpty>
        </template>

        <UiTable v-else caption="待处理任务">
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
              <td>{{ taskTypeLabelOf(task.type) }}</td>
              <td>
                <UiBadge :variant="TASK_STATUS_VARIANT[task.status]">
                  {{ taskStatusLabelOf(task.status) }}
                </UiBadge>
              </td>
              <td class="num">{{ task.attempts }}</td>
              <td class="mono">{{ formatMonthDayTime(task.updatedAt) }}</td>
            </tr>
          </tbody>
        </UiTable>
      </UiCard>
    </div>
  </div>
</template>

<style scoped>
/* 空态里的入口是链接，不是按钮：锚点默认带下划线，改成按钮外观后要显式去掉。 */
.connect-cta {
  text-decoration: none;
}
</style>
