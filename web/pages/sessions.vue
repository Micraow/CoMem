<script setup lang="ts">
/**
 * 会话与任务（架构文档 §16 的第六页、§10 的提交管线、§10.4 的任务恢复）。
 *
 * 两个 tab 共用一份页面：会话是**输入**（消息攒够后提交），任务是提交后的**后台
 * 工作**（归档 → 抽取 → 合并 → 摘要）。提交成功就把用户送到任务 tab 并高亮新行
 * ——这是「提交之后发生了什么」唯一自然的回答方式，比弹一个 toast 更完整。
 *
 * ## 轮询只在需要时开
 *
 * `running` 的任务每 3 秒刷新一次；没有 `running` 任务时停表。无条件轮询全部任务
 * 会让一个空控制台每秒打一次后端，而 99% 的响应完全相同。停表的判定挂在
 * 「当前有 running 任务」与「任务 tab 可见」两个条件上：切回会话 tab 就不需要
 * 任务的新鲜度，回来时会立刻拉一次。
 *
 * ## 为什么错误分两层
 *
 * 列表加载失败（`sessionsError` / `tasksError`）说明这一屏没有数据；提交失败
 * 说明**刚才那个动作**没生效，列表本身还是好的。混成一个错误会让用户以为整页坏了。
 */
import { AlertTriangle, RefreshCw } from 'lucide-vue-next'
import { useIntervalFn } from '@vueuse/core'

import type { SessionListPayload, SessionSummaryPayload } from '~/components/domain/SessionList.vue'
import type { TaskListPayload, TaskRowPayload } from '~/components/domain/TaskTable.vue'
import { ApiClientError, errorMessageOf, useApi } from '~/composables/useApi'

useHead({ title: '会话与任务 · CoMem 控制台' })

/** 轮询间隔：3 秒。任务状态迁移的粒度是秒级，更密没有收益，更疏用户会以为卡住。 */
const POLL_INTERVAL_MS = 3_000

const TABS = [
  { value: 'sessions', label: '会话' },
  { value: 'tasks', label: '任务' },
] as const

const api = useApi()
const scopeRoot = useScopeRoot()

const tab = ref<'sessions' | 'tasks'>('sessions')

const sessions = ref<readonly SessionSummaryPayload[]>([])
const tasks = ref<readonly TaskRowPayload[]>([])

const loadingSessions = ref(false)
const loadingTasks = ref(false)

const sessionsError = ref<string | null>(null)
const tasksError = ref<string | null>(null)
/** 任务列表要系统管理员；这个状态与「取失败了」分开表达（与概览页一致）。 */
const tasksForbidden = ref(false)
/** 提交这类单次动作的错误，与列表加载错误分开。 */
const actionError = ref<string | null>(null)

const committing = ref<readonly string[]>([])
const committedTaskIds = ref<Readonly<Record<string, string>>>({})
const highlightTaskId = ref<string | null>(null)

async function loadSessions(): Promise<void> {
  loadingSessions.value = true
  sessionsError.value = null
  try {
    const payload = await api.get<SessionListPayload>('/sessions', {
      scopeUri: scopeRoot.value,
    })
    sessions.value = payload.sessions
  } catch (caught) {
    sessionsError.value = errorMessageOf(caught)
    sessions.value = []
  } finally {
    loadingSessions.value = false
  }
}

/** `silent` 用于轮询：不把骨架屏闪回来，避免每次刷新都跳一下。 */
async function loadTasks(silent = false): Promise<void> {
  if (!silent) {
    loadingTasks.value = true
  }
  try {
    const payload = await api.get<TaskListPayload>('/tasks')
    tasks.value = payload.tasks
    tasksError.value = null
    tasksForbidden.value = false
  } catch (caught) {
    // `PERMISSION_DENIED` 映射到 403（`src/domain/errors.ts`）。这不是故障，是
    // 「当前账号不是系统管理员」，服务端消息里的配置项名不进界面（§11）。
    if (caught instanceof ApiClientError && caught.statusCode === 403) {
      tasksForbidden.value = true
      tasksError.value = null
      tasks.value = []
    } else {
      tasksError.value = errorMessageOf(caught)
      tasksForbidden.value = false
      if (!silent) {
        tasks.value = []
      }
    }
  } finally {
    loadingTasks.value = false
  }
}

async function commitSession(sessionId: string): Promise<void> {
  if (committing.value.includes(sessionId)) {
    return
  }
  committing.value = [...committing.value, sessionId]
  actionError.value = null

  try {
    const result = await api.post<{ taskId: string }>(
      `/sessions/${encodeURIComponent(sessionId)}/commit`,
      { scopeUri: scopeRoot.value },
    )
    committedTaskIds.value = { ...committedTaskIds.value, [sessionId]: result.taskId }
    highlightTaskId.value = result.taskId
    tab.value = 'tasks'
    // 提交会改变会话的未提交计数：两份数据都重新取，避免切回去看到旧数字。
    await Promise.all([loadSessions(), loadTasks()])
  } catch (caught) {
    actionError.value = errorMessageOf(caught)
  } finally {
    committing.value = committing.value.filter((id) => id !== sessionId)
  }
}

const hasRunningTask = computed(() => tasks.value.some((task) => task.status === 'running'))

const { pause: stopPolling, resume: startPolling } = useIntervalFn(
  () => {
    void loadTasks(true)
  },
  POLL_INTERVAL_MS,
  { immediate: false },
)

watch(
  [hasRunningTask, tab],
  ([running, current]) => {
    if (running && current === 'tasks') {
      startPolling()
    } else {
      stopPolling()
    }
  },
  { immediate: true },
)

watch(tab, (current) => {
  if (current === 'tasks') {
    void loadTasks()
  } else {
    void loadSessions()
  }
})

async function refresh(): Promise<void> {
  actionError.value = null
  await Promise.all([loadSessions(), loadTasks()])
}

onMounted(() => {
  void refresh()
})

// 会话按作用域隔离；任务队列是全局的，不需要重取。
watch(scopeRoot, () => {
  committedTaskIds.value = {}
  void loadSessions()
})
</script>

<template>
  <div class="content">
    <div class="page">
      <DomainPageHeader title="会话与任务">
        <template #actions>
          <UiButton
            variant="secondary"
            size="sm"
            :disabled="loadingSessions || loadingTasks"
            @click="refresh"
          >
            <RefreshCw :size="14" :stroke-width="1.5" />
            刷新
          </UiButton>
        </template>
      </DomainPageHeader>

      <UiTabs v-model="tab" :items="TABS" aria-label="会话与任务" />

      <div v-if="actionError !== null" class="callout callout--danger mt-16">
        <AlertTriangle :size="15" :stroke-width="1.4" />
        <div>{{ actionError }}</div>
      </div>

      <div class="mt-16">
        <DomainSessionList
          v-if="tab === 'sessions'"
          :sessions="sessions"
          :loading="loadingSessions"
          :error="sessionsError"
          :committing="committing"
          :committed-task-ids="committedTaskIds"
          @commit="commitSession"
        />

        <DomainTaskTable
          v-else
          :tasks="tasks"
          :loading="loadingTasks"
          :error="tasksError"
          :forbidden="tasksForbidden"
          :highlight-id="highlightTaskId"
        />
      </div>
    </div>
  </div>
</template>
