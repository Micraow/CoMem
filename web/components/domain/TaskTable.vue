<script lang="ts">
/**
 * 任务表（架构文档 §10.4 的任务恢复、§14 的 `/tasks`）。
 *
 * `GET /tasks` 返回的是**可认领**的任务：`pending`，或租约过期的 `running`。
 * 这意味着表里每一个 `running` 行都是**孤儿**——没人续租，正常的执行器不会再碰它。
 * 界面必须把这件事说出来（「租约已过期」+「下次启动扫描会回收」），否则运维会把它
 * 读成「正在跑」，然后等一个不会发生的完成。
 *
 * ## 为什么没有重试按钮
 *
 * 重试接口只接受 `failed`，而 `GET /tasks` 只列可认领的任务（`pending` 或租约过期
 * 的 `running`）——`failed` 行永远不会出现在这张表里。按钮挂在一行永远不出现的
 * 数据上就是不可达的死路，所以整列删掉，不补一个「没有失败任务」的假空态。
 *
 * ## 状态为什么不用红黄绿
 *
 * §16.1：不用颜色单独表意。两个状态用强调色的深浅（实心 → 描边）加文字表达，
 * 深浅两套外观都成立，色盲用户也读得出来。
 */

/** `GET /tasks` 的任务行。只声明控制台读到的字段（`payload` / `stepsDone` 不读）。 */
export interface TaskRowPayload {
  readonly id: string
  readonly type: string
  readonly status: string
  readonly attempts: number
  readonly leaseUntil: string | null
  readonly error: string | null
  readonly createdAt: string
  readonly updatedAt: string
}

export interface TaskListPayload {
  readonly tasks: readonly TaskRowPayload[]
  readonly total: number
}

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

/**
 * 相对时间（§16 的要求：相对时间 + `title` 给绝对时间）。
 *
 * 超过 30 天回落到日期：这时候「37 天前」不会比日期更好读，而日期还能直接比对。
 */
export function formatRelativeTime(iso: string): string {
  const time = new Date(iso).getTime()
  if (Number.isNaN(time)) {
    return '—'
  }
  const delta = Date.now() - time
  if (delta < MINUTE_MS) {
    return '刚刚'
  }
  if (delta < HOUR_MS) {
    return `${Math.floor(delta / MINUTE_MS)} 分钟前`
  }
  if (delta < DAY_MS) {
    return `${Math.floor(delta / HOUR_MS)} 小时前`
  }
  if (delta < 30 * DAY_MS) {
    return `${Math.floor(delta / DAY_MS)} 天前`
  }
  return new Date(time).toLocaleDateString('zh-CN')
}

/** 绝对时间，给 `title` 用。 */
export function formatAbsoluteTime(iso: string): string {
  const time = new Date(iso)
  if (Number.isNaN(time.getTime())) {
    return iso
  }
  return time.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
}

/**
 * 租约是否已过期。
 *
 * `leaseUntil` 为 null 的 `running` 行按过期处理：认领一定会写租约，出现这种行说明
 * 数据被改坏了，与 `#oldestPendingAgeSeconds` 的注释同义（§17.5）。
 */
export function isLeaseExpired(task: TaskRowPayload, now: number = Date.now()): boolean {
  if (task.status !== 'running') {
    return false
  }
  if (task.leaseUntil === null) {
    return true
  }
  const lease = new Date(task.leaseUntil).getTime()
  return Number.isNaN(lease) || lease < now
}
</script>

<script setup lang="ts">
import { AlertTriangle, RotateCcw } from 'lucide-vue-next'

const props = withDefaults(
  defineProps<{
    tasks: readonly TaskRowPayload[]
    loading: boolean
    error: string | null
    /** 刚提交的会话产出的任务 ID：高亮并滚到可视区。 */
    highlightId: string | null
  }>(),
  { highlightId: null },
)

const TASK_TYPE_LABEL: Readonly<Record<string, string>> = {
  archive: '归档',
}

const TASK_STATUS_LABEL: Readonly<Record<string, string>> = {
  pending: '排队中',
  running: '运行中',
}

/** 状态徽章的深浅档位；未知名回落到中性底，不发明第三档。 */
const STATUS_DEPTH: Readonly<Record<string, string>> = {
  pending: 'pending',
  running: 'running',
}

const expiredCount = computed(() => props.tasks.filter((task) => isLeaseExpired(task)).length)

watch(
  () => props.highlightId,
  async (taskId) => {
    if (taskId === null) {
      return
    }
    await nextTick()
    document
      .querySelector<HTMLElement>('[data-highlight="true"]')
      ?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  },
  { immediate: true },
)

function typeLabelOf(type: string): string {
  return TASK_TYPE_LABEL[type] ?? type
}

function statusLabelOf(status: string): string {
  return TASK_STATUS_LABEL[status] ?? status
}

function depthOf(status: string): string {
  return STATUS_DEPTH[status] ?? 'pending'
}
</script>

<template>
  <div class="stack-16">
    <div v-if="props.error !== null" class="callout callout--danger">
      <AlertTriangle :size="15" :stroke-width="1.4" />
      <div>{{ props.error }}</div>
    </div>

    <div v-if="expiredCount > 0" class="callout callout--warn">
      <AlertTriangle :size="15" :stroke-width="1.4" />
      <div>
        <b>{{ expiredCount }} 个任务的租约已过期。</b>
        执行器不再续租，下次启动会重置为排队中并增加一次重试。
      </div>
    </div>

    <UiCard v-if="props.error === null || props.tasks.length > 0" title="任务" panel flush>
      <template #actions>
        <span class="caption">按创建时间升序，只含可认领的任务</span>
      </template>

      <div v-if="props.loading && props.tasks.length === 0" class="task-skeleton">
        <UiSkeleton v-for="index in 5" :key="index" :width="`${78 - index * 5}%`" height="14px" />
      </div>

      <UiTable v-else-if="props.tasks.length > 0" caption="任务列表">
        <thead>
          <tr>
            <th>任务</th>
            <th>类型</th>
            <th>状态</th>
            <th>创建时间</th>
            <th>租约到期</th>
            <th class="num">重试次数</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="task in props.tasks"
            :key="task.id"
            :data-highlight="task.id === props.highlightId ? 'true' : undefined"
            :class="{ 'is-highlight': task.id === props.highlightId }"
          >
            <td class="mono strong">
              {{ task.id }}
              <span v-if="task.error !== null" class="task-error" :title="task.error">有错误记录</span>
            </td>
            <td>{{ typeLabelOf(task.type) }}</td>
            <td>
              <span class="depth" :data-depth="depthOf(task.status)">
                {{ statusLabelOf(task.status) }}
              </span>
            </td>
            <td>
              <time class="mono" :title="formatAbsoluteTime(task.createdAt)">
                {{ formatRelativeTime(task.createdAt) }}
              </time>
            </td>
            <td>
              <span v-if="isLeaseExpired(task)" class="lease-expired">
                已过期 · 下次启动扫描会回收
              </span>
              <time
                v-else-if="task.leaseUntil !== null"
                class="mono"
                :title="formatAbsoluteTime(task.leaseUntil)"
              >
                {{ formatRelativeTime(task.leaseUntil) }}
              </time>
              <span v-else class="faint">—</span>
            </td>
            <td class="num">{{ task.attempts }}</td>
          </tr>
        </tbody>
      </UiTable>

      <div v-else class="empty">
        <span class="empty__icon">
          <RotateCcw :size="20" :stroke-width="1.4" />
        </span>
        <span class="empty__title">队列是空的</span>
      </div>
    </UiCard>
  </div>
</template>

<style scoped>
.task-skeleton {
  display: grid;
  gap: 12px;
  padding: 22px 20px;
}

.task-error {
  display: inline-block;
  margin-left: 8px;
  padding: 0 6px;
  border-radius: 5px;
  background: var(--fill-2);
  font-family: var(--font);
  font-size: 12px;
  line-height: 18px;
  color: var(--label-3);
  vertical-align: 1px;
}

/* 状态：强调色的四档深浅，不是红黄绿（§16.1）。 */
.depth {
  display: inline-flex;
  align-items: center;
  height: 24px;
  padding: 0 10px;
  border-radius: var(--r-pill);
  font-size: 13px;
  font-weight: 590;
  letter-spacing: 0;
  white-space: nowrap;
}

.depth[data-depth="pending"] {
  background: transparent;
  box-shadow: inset 0 0 0 0.5px var(--hairline-strong);
  color: var(--label-3);
}

.depth[data-depth="running"] {
  background: var(--accent);
  color: #fff;
}

.lease-expired {
  font-size: 13px;
  color: var(--accent-ink);
}

tr.is-highlight {
  background: var(--accent-tint-2);
  box-shadow: inset 2px 0 0 var(--accent);
}
</style>
