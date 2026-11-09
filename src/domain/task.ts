/**
 * 任务状态机（架构文档 §8.1 的 `task` 表、§10.4 的任务恢复）。
 *
 * 任务表是运行时状态，放 SQLite：高并发写、需要原子性。状态转移与租约判定都在
 * `adapters/sqlite/task-repository.ts` 的 SQL 里原子完成；这一层只定义任务形状与
 * 「还值不值得重试」。
 */

export type TaskStatus = 'pending' | 'running' | 'done' | 'failed';

/** 只列真实存在的后台任务；加类型之前先确认有消费者。 */
export type TaskType = 'archive' | 'extract' | 'merge' | 'summary' | 'index';

export interface Task {
  readonly id: string;
  readonly type: TaskType;
  readonly status: TaskStatus;
  /** 任务参数，形状由 `type` 决定；领域层不解析它 */
  readonly payload: unknown;
  /** 已完成的步骤名，重放时跳过（架构文档 §10.1） */
  readonly stepsDone: readonly string[];
  /** 已被认领的次数；由恢复扫描在重置僵尸任务时递增 */
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
 * `done` 永不重试；其余状态只要没到上限就还能再跑一次。
 */
export function shouldRetry(task: Task, maxAttempts: number): boolean {
  return task.status !== 'done' && task.attempts < maxAttempts;
}
