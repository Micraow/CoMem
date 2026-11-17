/**
 * 任务的类型与状态 → 界面标签（概览页与任务表共用一份）。
 *
 * 两份映射曾经在 `pages/index.vue` 与 `components/domain/TaskTable.vue` 里各写
 * 一遍，改一处标签要记得改另一处。
 *
 * ## 为什么取值也在这里声明一份
 *
 * `web/` 是独立包（不在根 pnpm workspace 里，`web/tsconfig.json` 只覆盖 `web/`），
 * 控制台不能 import `src/domain/task.ts`。所以这里的 `as const` 数组是 web 侧的
 * 取值来源：类型从数组派生，映射用 `satisfies Record<类型, 文案>` 穷举。加一个
 * 成员时漏写文案即编译失败；多写一个不存在的键也是。
 *
 * 跨项目的一致性由 `tests/unit/web/task-labels.test.ts` 对拍——那是唯一同时 import
 * 两边的地方。
 */

/** `TaskType`（`src/domain/task.ts`）。 */
export const TASK_TYPES = ['archive'] as const

export type TaskType = (typeof TASK_TYPES)[number]

/** 默认任务队列只含可认领状态；recent 视图包含全部状态。 */
export const CLAIMABLE_TASK_STATUSES = ['pending', 'running'] as const
export const TASK_STATUSES = ['pending', 'running', 'done', 'failed'] as const
export type TaskStatus = (typeof TASK_STATUSES)[number]

/** 类型 → 标签。漏一个 `TaskType` 即编译失败，多一个键也是。 */
const TASK_TYPE_LABEL = {
  archive: '归档',
} satisfies Record<TaskType, string>

export function taskTypeLabelOf(type: TaskType): string {
  return TASK_TYPE_LABEL[type]
}

/** 状态 → 标签。漏一个 `TaskStatus` 即编译失败，多一个键也是。 */
const TASK_STATUS_LABEL = {
  pending: '排队中',
  running: '运行中',
  done: '已完成',
  failed: '失败',
} satisfies Record<TaskStatus, string>

export function taskStatusLabelOf(status: TaskStatus): string {
  return TASK_STATUS_LABEL[status]
}
