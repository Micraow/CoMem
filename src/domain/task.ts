/**
 * 任务状态机（架构文档 §8.1 的 `task` 表、§10.4 的任务恢复）。
 *
 * 任务表是运行时状态，放 SQLite：高并发写、需要原子性。这里只实现状态转移与租约
 * 判定，持久化在 `adapters/sqlite/task-repository.ts`。
 */

import { ComemError } from './errors.js';

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
 * 合法转移表（架构文档 §10.4）。
 *
 * - `pending → running`：被 worker 认领；
 * - `running → done | failed | pending`：正常结束、失败、租约过期回到队列；
 * - `failed → pending`：人工或调度器重试；
 * - `done` 是终态：没有出边，重试一个已完成的任务会重复应用记忆操作。
 */
const ALLOWED_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = Object.freeze({
  pending: ['running'],
  running: ['done', 'failed', 'pending'],
  done: [],
  failed: ['pending'],
});

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

/**
 * 转移状态；非法转移抛 `CONFLICT`。
 *
 * 离开 `running` 时清空租约：租约只在运行期间有意义，留着会让 `isLeaseExpired`
 * 对已完成的任务返回真。
 */
export function transition(task: Task, to: TaskStatus, now: Date): Task {
  if (!canTransition(task.status, to)) {
    throw new ComemError('CONFLICT', `任务不能从 ${task.status} 转移到 ${to}。`, {
      taskId: task.id,
      from: task.status,
      to,
    });
  }
  return {
    ...task,
    status: to,
    leaseUntil: to === 'running' ? task.leaseUntil : null,
    updatedAt: now.toISOString(),
  };
}

/**
 * 租约是否过期（架构文档 §10.4 的认领条件）。
 *
 * `running` 但没有租约视为已过期：认领一定会写租约，出现这种行说明数据被改坏了，
 * 按过期处理让恢复扫描能把它捞回来，而不是永远卡在 `running`。
 * 非 `running` 的任务没有租约概念，返回 `false`。
 */
export function isLeaseExpired(task: Task, now: Date): boolean {
  if (task.status !== 'running') {
    return false;
  }
  if (task.leaseUntil === null) {
    return true;
  }
  return parseTimestamp(task.leaseUntil, task.id) <= now.getTime();
}

/**
 * 解析 ISO 8601 时间戳。坏数据必须显式报错：`Date.parse` 返回 `NaN` 会让
 * 「租约还没过期」与「租约已经过期」同时为假，任务就永远卡在 `running`。
 */
function parseTimestamp(value: string, taskId: string): number {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    throw new ComemError('INVALID_ARGUMENT', '任务时间戳不是合法的 ISO 8601 时间。', {
      taskId,
      value,
    });
  }
  return timestamp;
}

/**
 * 认领任务：只有 `pending` 或租约过期的 `running` 能领。
 *
 * 认领本身不递增 `attempts`——§10.4 让恢复扫描在把僵尸任务重置为 `pending` 时
 * 递增，如果认领也加，一次失败的重试会被计两次，`maxAttempts` 就不准了。
 */
export function claim(task: Task, now: Date, leaseSeconds: number): Task {
  if (!Number.isFinite(leaseSeconds) || leaseSeconds <= 0) {
    throw new ComemError('INVALID_ARGUMENT', '租约时长必须是正数秒。', {
      taskId: task.id,
      leaseSeconds,
    });
  }
  const claimable =
    task.status === 'pending' || (task.status === 'running' && isLeaseExpired(task, now));
  if (!claimable) {
    throw new ComemError('CONFLICT', '任务正在被处理，租约尚未过期。', {
      taskId: task.id,
      status: task.status,
      leaseUntil: task.leaseUntil,
    });
  }
  return {
    ...task,
    status: 'running',
    leaseUntil: new Date(now.getTime() + leaseSeconds * 1000).toISOString(),
    updatedAt: now.toISOString(),
  };
}

/** 这一步是否已经完成；重放时据此跳过（架构文档 §10.1）。 */
export function isStepDone(task: Task, step: string): boolean {
  return task.stepsDone.includes(step);
}

/**
 * 记录一步完成。
 *
 * 幂等：同一步重复标记返回同一个对象，不产生重复项。`updatedAt` 不改——这个函数
 * 拿不到时钟，持久化层写库时统一打时间戳。
 */
export function markStepDone(task: Task, step: string): Task {
  if (isStepDone(task, step)) {
    return task;
  }
  return { ...task, stepsDone: [...task.stepsDone, step] };
}

/**
 * 是否还值得重试（架构文档 §10.4：上限 3 次，超限置 `failed`）。
 *
 * `done` 永不重试；其余状态只要没到上限就还能再跑一次。
 */
export function shouldRetry(task: Task, maxAttempts: number): boolean {
  return task.status !== 'done' && task.attempts < maxAttempts;
}
