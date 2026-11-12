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
 *
 * ## 权限不足不是故障
 *
 * `GET /tasks` 只有系统管理员能读（`auth.adminUserIds` 为空时普通用户 403）。
 * 403 的服务端原文里写着配置项名，照抄到界面只会让用户去搜文档（§11）；这里
 * 显示「需要管理员权限」，与概览页一致。重试不会改变结果，所以不显示成错误。
 * 其它错误仍然显示服务端消息——那是排查用的诊断信息。
 */

/**
 * 任务行的形状定义在 `web/composables/useApi.ts`（`TaskPayload`）：概览页与本组件
 * 读的是同一个 `GET /tasks`，两份声明会漂移。`TaskRowPayload` 保留为别名，因为
 * 「会话与任务」页从这个组件导入它。
 */
import type { TaskPayload } from '~/composables/useApi'
import { formatDateTimeWithSeconds, formatRelativeTime } from '~/utils/format'

export type TaskRowPayload = TaskPayload

export interface TaskListPayload {
  readonly tasks: readonly TaskRowPayload[]
  readonly total: number
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

import { taskStatusLabelOf, taskTypeLabelOf } from '~/utils/taskLabels'

const props = withDefaults(
  defineProps<{
    tasks: readonly TaskRowPayload[]
    loading: boolean
    error: string | null
    /** 当前账号不是系统管理员：与「取失败了」分开表达。 */
    forbidden: boolean
    /** 刚提交的会话产出的任务 ID：高亮并滚到可视区。 */
    highlightId: string | null
  }>(),
  { forbidden: false, highlightId: null },
)

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
</script>

<template>
  <div class="stack-16">
    <UiErrorCallout v-if="props.error !== null" :message="props.error" />

    <UiCallout v-if="expiredCount > 0" tone="warn">
      <template #icon><AlertTriangle :size="15" :stroke-width="1.4" /></template>
      <div>
        <b>{{ expiredCount }} 个任务的租约已过期。</b>
        执行器不再续租，下次启动会重置为排队中并增加一次重试。
      </div>
    </UiCallout>

    <UiCard
      v-if="props.forbidden || props.error === null || props.tasks.length > 0"
      title="任务"
      panel
      flush
    >
      <template #actions>
        <span class="caption">按创建时间升序，只含可认领的任务</span>
      </template>

      <UiEmpty v-if="props.forbidden" forbidden />

      <div v-else-if="props.loading && props.tasks.length === 0" class="task-skeleton">
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
            <td>{{ taskTypeLabelOf(task.type) }}</td>
            <td>
              <UiBadge :variant="task.status === 'running' ? 'solid' : 'outline-faint'">
                {{ taskStatusLabelOf(task.status) }}
              </UiBadge>
            </td>
            <td>
              <time class="mono" :title="formatDateTimeWithSeconds(task.createdAt)">
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
                :title="formatDateTimeWithSeconds(task.leaseUntil)"
              >
                {{ formatRelativeTime(task.leaseUntil) }}
              </time>
              <span v-else class="faint">—</span>
            </td>
            <td class="num">{{ task.attempts }}</td>
          </tr>
        </tbody>
      </UiTable>

      <UiEmpty v-else v-slot="{ size }" title="队列是空的">
        <RotateCcw :size="size" :stroke-width="1.4" />
      </UiEmpty>
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

.lease-expired {
  font-size: 13px;
  color: var(--accent-ink);
}

tr.is-highlight {
  background: var(--accent-tint-2);
  box-shadow: inset 2px 0 0 var(--accent);
}
</style>
