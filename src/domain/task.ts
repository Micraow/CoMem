/**
 * 任务状态机（架构文档 §8.1 的 `task` 表、§10.4 的任务恢复）。
 *
 * 任务表是运行时状态，放 SQLite：高并发写、需要原子性。状态转移与租约判定都在
 * `adapters/sqlite/task-repository.ts` 的 SQL 里原子完成；这一层只定义任务形状与
 * 「还值不值得重试」。
 */

/**
 * 任务状态。
 *
 * 数组是唯一来源，类型从它派生：`/tasks` 的 `status` 查询参数校验、`task` 表列
 * 的取值都从它取。旧写法在路由里手抄一份 `readonly string[]`，加一个状态时既没有
 * 编译错误、也没有运行期错误——查询参数继续拒绝它。
 */
export const TASK_STATUSES = ['pending', 'running', 'done', 'failed'] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

/**
 * `/tasks` 只会返回**可认领**的任务（§10.4）：`pending`，或租约过期的 `running`。
 *
 * 单独声明这个子集而不是让消费方用 `TaskStatus` 加 `??` 兜底：`done` / `failed`
 * 在这个接口里不会出现，为它们写文案是给「不会发生的状态」写代码；而用兜底又会把
 * 「真的出现了意外状态」变成空白。子集的每个成员都必须仍是 `TaskStatus`
 * （`satisfies`），删掉一个状态时这里跟着编译失败。
 */
export const CLAIMABLE_TASK_STATUSES = [
  'pending',
  'running',
] as const satisfies readonly TaskStatus[];

export type ClaimableTaskStatus = (typeof CLAIMABLE_TASK_STATUSES)[number];

/** 任务状态守卫。`task` 表的 `status` 列读出来是字符串。 */
export function isTaskStatus(value: string): value is TaskStatus {
  return TASK_STATUSES.some((status) => status === value);
}

/** 类型守卫。`task` 表的 `type` 列读出来是字符串（`task-repository.ts` 用它）。 */
export function isTaskType(value: string): value is TaskType {
  return TASK_TYPES.some((type) => type === value);
}

/** 可认领状态守卫（`claimable()` 的 SQL 与这个集合是同一个判据）。 */
export function isClaimableTaskStatus(value: string): value is ClaimableTaskStatus {
  return CLAIMABLE_TASK_STATUSES.some((status) => status === value);
}

/**
 * 后台任务类型。数组是唯一来源，类型从它派生。
 *
 * 只有 `archive` 一个值：它是 `session.ts` 的两阶段提交（§10.1）落队列时创建的
 * 任务，也是全仓唯一的创建点。`extract` / `merge` / `summary` / `index` 曾经写
 * 在这里，但没有任何生产者——归档的抽取、合并、摘要失效都是**归档任务的步骤**
 * （`CommitPipeline` 的 `stepsDone`），不是独立任务；临时重建索引走
 * `commands/reindex.ts`，也不入队。
 *
 * 加类型之前先确认有真实的创建点：没有生产者的类型值会让 `/tasks` 的类型列和
 * 「按类型分支」看起来像还存在别的任务。
 */
export const TASK_TYPES = ['archive'] as const;

export type TaskType = (typeof TASK_TYPES)[number];

export interface Task {
  readonly id: string;
  readonly type: TaskType;
  readonly status: TaskStatus;
  /** 任务参数，形状由 `type` 决定；领域层不解析它 */
  readonly payload: unknown;
  /** 已完成的步骤名，重放时跳过（架构文档 §10.1） */
  readonly stepsDone: readonly string[];
  /**
   * 已开始的执行次数：认领成功时由 SQL 原子 +1（`tryClaim`），执行成功、失败、
   * 回到队列、被回收都不再改。上限是 `maxAttempts`（允许的最大执行次数）。
   */
  readonly attempts: number;
  /** 租约到期时间，ISO 8601；只有 `running` 有意义 */
  readonly leaseUntil: string | null;
  readonly error: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * 是否还值得重试（架构文档 §10.4：上限 3 次，超限置 `failed`）。
 *
 * `attempts` 是「已开始的执行次数」，调用方传进来的值必须已经包含刚跑完的这一次
 * （认领时加的）。所以第 `maxAttempts` 次失败时 `attempts === maxAttempts`，返回假
 * ——不再放行第 `maxAttempts + 1` 次执行。
 *
 * `done` 永不重试；其余状态只要没到上限就还能再跑一次。
 */
export function shouldRetry(task: Task, maxAttempts: number): boolean {
  return task.status !== 'done' && task.attempts < maxAttempts;
}
