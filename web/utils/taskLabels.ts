/**
 * 任务的类型与状态 → 界面标签（概览页与任务表共用一份）。
 *
 * 两份映射曾经在 `pages/index.vue` 与 `components/domain/TaskTable.vue` 里各写
 * 一遍，改一处标签要记得改另一处。
 *
 * ## 类型
 *
 * `TaskType`（`src/domain/task.ts`）只有一个值 `archive`：归档的抽取、合并、摘要
 * 失效都是归档任务内部的步骤（`CommitPipeline` 的 `stepsDone`），不是独立任务；
 * 重建索引走命令、不入队。`extract` / `merge` / `summary` / `index` 曾经写在两份
 * 映射里，但没有任何生产者，已经删掉——留着它们会让 `/tasks` 的类型列看起来像
 * 还存在别的任务。
 *
 * 未知名原样显示：服务端将来真多出类型时，界面先露出原值，而不是变成空白。
 */
const TASK_TYPE_LABEL: Readonly<Record<string, string>> = {
  archive: '归档',
}

export function taskTypeLabelOf(type: string): string {
  return TASK_TYPE_LABEL[type] ?? type
}

/**
 * ## 状态
 *
 * `/tasks` 只返回可认领的任务（`pending`，或租约过期的 `running`），`done` /
 * `failed` 不会出现在这张表里，因此不声明这两个状态的文案——写了也没有生产者
 * 能让它出现在界面上。未知名原样显示，与类型标签同一处理。
 *
 * 概览页的徽章档位与任务表的深浅档位是**外观**，各自随所在组件保留：两处用不同
 * 控件表达同一状态，把颜色也抽成一份会让两页必须同时改版。
 */
const TASK_STATUS_LABEL: Readonly<Record<string, string>> = {
  pending: '排队中',
  running: '运行中',
}

export function taskStatusLabelOf(status: string): string {
  return TASK_STATUS_LABEL[status] ?? status
}
