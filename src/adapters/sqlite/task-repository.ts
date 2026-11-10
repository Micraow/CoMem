/**
 * 任务仓储（架构文档 §8.1 的 `task` 表、§10.4 的任务恢复）。
 *
 * 任务表是**运行时状态**：高并发写、需要原子性，所以放 SQLite 而不是文件（§7 的
 * 判据表）。这一层只做行与值的转换，状态转移规则在 `domain/task.ts`、心跳与重试
 * 在 `services/task.ts`。
 *
 * 三个不变量：
 *
 * 1. **认领是一条 UPDATE**。`tryClaim` 不能「先 SELECT 再 UPDATE」——两个 worker 会
 *    同时读到 `pending`，然后都写 `running`。条件放在 `WHERE` 里，SQLite 的单写者
 *    语义保证只有一条能改到行。
 * 2. **时间只用 ISO 8601 字符串**。与 `node` 表一致；ISO 8601 的字典序等于时间序，
 *    所以租约比较可以直接用 SQL 的字符串比较，不需要 `julianday()` 之类的转换。
 * 3. **所有写操作走 `withWriteTransaction`**（§18「并发控制」）。多个 UPDATE 的复合
 *    操作（`recoverExpired`）必须整体成功或整体回滚。
 *
 * `payload` 与 `steps_done` 落盘是 JSON 文本。解析失败抛 `INTERNAL`：能写进这两列
 * 的只有本模块的调用方，解析失败说明数据库被改坏了，是程序缺陷不是用户输入问题。
 */

import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';

import { ComemError } from '../../domain/errors.js';
import type { Logger } from '../../domain/log.js';
import {
  isClaimableTaskStatus,
  isTaskStatus,
  isTaskType,
  type ClaimableTaskStatus,
  type TaskStatus,
  type TaskType,
} from '../../domain/task.js';

import { withWriteTransaction } from './database.js';
import { placeholders } from './node-repository.js';

/** `task` 表的一行（架构文档 §8.1）。 */
export interface TaskRow {
  readonly id: string;
  readonly type: TaskType;
  readonly status: TaskStatus;
  /** 解析后的 JSON；`payload` 列存的是序列化结果 */
  readonly payload: unknown;
  readonly stepsDone: readonly string[];
  readonly attempts: number;
  readonly leaseUntil: string | null;
  readonly error: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * `claimable()` 返回的行：`status` 已收缩到可认领集合。
 *
 * SQL 的 `WHERE` 只留下 `pending` 与「租约过期的 `running`」，所以返回类型如实写成
 * `ClaimableTaskStatus`——`/tasks` 的消费方不需要为 `done` / `failed` 写分支。
 */
export interface ClaimableTaskRow extends Omit<TaskRow, 'status'> {
  readonly status: ClaimableTaskStatus;
}

export interface TaskRepositoryDeps {
  readonly db: DatabaseSync;
  readonly logger: Logger;
}

/** 列顺序与 `TaskRow` 字段顺序一致，映射函数只依赖这个常量。 */
const TASK_COLUMN_NAMES = [
  'id',
  'type',
  'status',
  'payload',
  'steps_done',
  'attempts',
  'lease_until',
  'error',
  'created_at',
  'updated_at',
] as const;

const TASK_COLUMNS = TASK_COLUMN_NAMES.join(', ');

/** 1 秒 = 1000 毫秒；租约时长按秒配置（§18 的 `task.leaseSeconds`）。 */
const MILLISECONDS_PER_SECOND = 1000;

/**
 * 「租约已过期」：`running` 行的租约时间早于给定时刻。
 *
 * `lease_until IS NULL` 也按过期算：认领一定会写租约，出现这种行说明数据被改坏了，
 * 让它能被捞回来而不是永远卡在 `running`。
 *
 * 谓词带一个 `?`（当前时刻）。`recoverExpired` 的回收扫描与 `countExpiredLeases` 的
 * 孤儿计数共用这一份——两处各写一份时，健康度报出的孤儿数会与实际能被回收的集合
 * 分叉，运维看到的数字就不再是「下次启动扫描会捞回多少」。
 *
 * **只覆盖 `running`**：回收租约不碰 `pending`，把它并进来会改变「回收」的行为。
 */
const LEASE_EXPIRED_SQL = '(lease_until IS NULL OR lease_until < ?)';

/**
 * 「可认领」：`pending` 随时可领，`running` 只在租约过期后可领（§10.4）。
 *
 * `tryClaim` 的 `WHERE` 与 `claimable()` 的候选集共用这一份，两处对「什么任务能跑」
 * 给出同一个答案。带一个 `?`（当前时刻），与 `LEASE_EXPIRED_SQL` 同一个占位符。
 */
const CLAIMABLE_SQL = `(status = 'pending' OR (status = 'running' AND ${LEASE_EXPIRED_SQL}))`;

function text(value: SQLOutputValue | undefined): string {
  return String(value);
}

function nullableText(value: SQLOutputValue | undefined): string | null {
  return value === null || value === undefined ? null : String(value);
}

function integer(value: SQLOutputValue | undefined): number {
  return Number(value);
}

function parseJsonColumn(raw: string, column: string, taskId: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new ComemError('INTERNAL', `任务行的 ${column} 不是合法 JSON：${taskId}`, {
      taskId,
      column,
    });
  }
}

function parseStepsDone(raw: string, taskId: string): readonly string[] {
  const parsed = parseJsonColumn(raw, 'steps_done', taskId);
  if (!Array.isArray(parsed) || !parsed.every((step) => typeof step === 'string')) {
    throw new ComemError('INTERNAL', `任务行的 steps_done 不是字符串数组：${taskId}`, { taskId });
  }
  return parsed;
}

/**
 * 数据库里的 `status` → 领域状态。
 *
 * 旧写法是 `text(row['status']) as TaskStatus`：一个被改坏的值会带着假的类型一路
 * 走到 `/tasks` 与重试判定里。写入路径只接受领域类型，所以走到这里的非法值说明
 * 表被改坏了，按 `INTERNAL` 报出去。
 */
function requireTaskStatus(value: string): TaskStatus {
  if (!isTaskStatus(value)) {
    throw new ComemError('INTERNAL', `任务状态不合法：${value}`, { status: value });
  }
  return value;
}

/**
 * `type` 列的解析。
 *
 * 旧写法是 `text(row['type']) as TaskType`：`as` 让「表里有个类型不在联合里」这件事
 * 不可见，那个值会被当成 `archive` 一路走到 `CommitRunner`。写入路径只接受
 * `TaskType`，所以非法值说明表被改坏了。
 */
function requireTaskType(value: string): TaskType {
  if (!isTaskType(value)) {
    throw new ComemError('INTERNAL', `任务类型不合法：${value}`, { type: value });
  }
  return value;
}

/**
 * 数据库行 → `TaskRow`。
 *
 * `status` 走校验（见上），`type` 仍用 `as` 收窄：两者都只由写入路径赋值，但
 * `status` 还要被 `/tasks` 的响应类型当成子集来用，多走一次校验才拿得到那个子集。
 */
function toTaskRow(row: Record<string, SQLOutputValue>): TaskRow {
  const id = text(row['id']);
  return {
    id,
    type: requireTaskType(text(row['type'])),
    status: requireTaskStatus(text(row['status'])),
    payload: parseJsonColumn(text(row['payload']), 'payload', id),
    stepsDone: parseStepsDone(text(row['steps_done']), id),
    attempts: integer(row['attempts']),
    leaseUntil: nullableText(row['lease_until']),
    error: nullableText(row['error']),
    createdAt: text(row['created_at']),
    updatedAt: text(row['updated_at']),
  };
}

/**
 * 数据库行 → `ClaimableTaskRow`。
 *
 * `WHERE` 只留下 `pending` 与租约过期的 `running`，所以这里的状态已经是子集；
 * 还是过一遍守卫：`CLAIMABLE_TASK_STATUSES` 与那段 SQL 是两个独立写下的判据，
 * 改其中一个忘了另一个时，这里报 `INTERNAL` 而不是把一个 `done` 任务交给调用方。
 */
function toClaimableTaskRow(row: Record<string, SQLOutputValue>): ClaimableTaskRow {
  const task = toTaskRow(row);
  if (!isClaimableTaskStatus(task.status)) {
    throw new ComemError('INTERNAL', `可认领任务的状态不合法：${task.id}`, {
      taskId: task.id,
      status: task.status,
    });
  }
  return { ...task, status: task.status };
}

function leaseUntilOf(now: Date, leaseSeconds: number): string {
  return new Date(now.getTime() + leaseSeconds * MILLISECONDS_PER_SECOND).toISOString();
}

export class TaskRepository {
  readonly #db: DatabaseSync;
  readonly #logger: Logger;

  constructor(deps: TaskRepositoryDeps) {
    this.#db = deps.db;
    this.#logger = deps.logger;
  }

  insert(task: TaskRow): void {
    withWriteTransaction(this.#db, () => {
      this.#db
        .prepare(
          `INSERT INTO task (${TASK_COLUMNS}) VALUES (${placeholders(TASK_COLUMN_NAMES.length)})`,
        )
        .run(
          task.id,
          task.type,
          task.status,
          JSON.stringify(task.payload),
          JSON.stringify(task.stepsDone),
          task.attempts,
          task.leaseUntil,
          task.error,
          task.createdAt,
          task.updatedAt,
        );
    });
    this.#logger.debug('任务已写入', { taskId: task.id, type: task.type, status: task.status });
  }

  get(id: string): TaskRow | null {
    const row = this.#db.prepare(`SELECT ${TASK_COLUMNS} FROM task WHERE id = ?`).get(id);
    return row === undefined ? null : toTaskRow(row);
  }

  /**
   * 认领（架构文档 §10.4）。
   *
   * 一条 UPDATE，条件写进 `WHERE`：`pending` 随时可领，`running` 只在租约过期后
   * 可领。`lease_until IS NULL` 的 `running` 行按已过期处理：认领一定会写租约，
   * 出现这种行说明数据被改坏了，让它能被捞回来而不是永远卡在 `running`。
   *
   * **认领成功即 `attempts += 1`，并与状态转移写在同一条 SQL 里。** 语义是
   * 「`attempts` = 已开始的执行次数」：一次认领就是一次执行的开始，执行成功与否、
   * 进程是否中途被杀，都不再改这个计数。`WHERE` 命中的那次 UPDATE 才递增，
   * 所以在应用层做这件事不安全——两个 worker 会读到同一个旧值再各自加一（丢一次
   * 计数），或者认领已经落盘、加一却没落盘（计数落后于真实执行次数，`maxAttempts`
   * 因此多放行一次）。
   */
  tryClaim(id: string, now: Date, leaseSeconds: number): boolean {
    const nowIso = now.toISOString();
    const changes = withWriteTransaction(this.#db, () =>
      this.#db
        .prepare(
          `UPDATE task
              SET status = 'running', attempts = attempts + 1, lease_until = ?, updated_at = ?
            WHERE id = ? AND ${CLAIMABLE_SQL}`,
        )
        .run(leaseUntilOf(now, leaseSeconds), nowIso, id, nowIso).changes,
    );
    return Number(changes) > 0;
  }

  /** 心跳续租（§10.4「每 20 秒续租」）。只续 `running`：终态任务的租约必须为空。 */
  renewLease(id: string, now: Date, leaseSeconds: number): void {
    withWriteTransaction(this.#db, () => {
      this.#db
        .prepare(
          `UPDATE task SET lease_until = ?, updated_at = ? WHERE id = ? AND status = 'running'`,
        )
        .run(leaseUntilOf(now, leaseSeconds), now.toISOString(), id);
    });
  }

  /**
   * 写回 `steps_done`（§10.1 的重放判据）。
   *
   * 去重由调用方负责（`TaskService` 用 `Set` 汇总后整体写回）：这一层拿不到「步骤
   * 完成的先后关系」，重复去重会让两条不同路径各写一份规则。
   */
  updateStepsDone(id: string, stepsDone: readonly string[]): void {
    withWriteTransaction(this.#db, () => {
      this.#db
        .prepare('UPDATE task SET steps_done = ?, updated_at = ? WHERE id = ?')
        .run(JSON.stringify(stepsDone), new Date().toISOString(), id);
    });
    this.#logger.debug('任务步骤写回', { taskId: id, steps: stepsDone.length });
  }

  /**
   * 失败但还值得重试：回到 `pending`，**不动 `attempts`**。
   *
   * 这次执行的开始已经在 `tryClaim` 里记过（一次认领 = 一次执行的开始），这里再加
   * 一次会把「一次失败」记成两次，可重试次数凭空减半。`domain/task.ts` 的转移表里
   * `running → pending` 是合法转移；这里用一条 UPDATE 完成，不经过内存里的
   * `transition`——那会多一次读。
   *
   * 保留 `error`：它是「上一次失败的原因」，重试成功后由 `finish('done')` 清空。
   * 清掉的话，一个反复失败的任务在队列里看不到任何线索。
   */
  requeue(id: string, now: Date): void {
    withWriteTransaction(this.#db, () => {
      this.#db
        .prepare(
          `UPDATE task
              SET status = 'pending', lease_until = NULL, updated_at = ?
            WHERE id = ?`,
        )
        .run(now.toISOString(), id);
    });
    this.#logger.debug('任务回到队列', { taskId: id });
  }

  /**
   * 终态（§10.4）。**不动 `attempts`**：这次执行的开始已经在 `tryClaim` 里记过。
   *
   * 成功与失败都不改计数——成功的那次同样是一次「已开始的执行」。在这里给失败补加
   * 一次，等于让 `attempts` 时而记开始、时而记失败，两条回收路径（认领 / 启动扫描）
   * 对「一次认领算不算一次尝试」给出两个答案。
   */
  finish(id: string, status: 'done' | 'failed', error: string | null, now: Date): void {
    withWriteTransaction(this.#db, () => {
      this.#db
        .prepare(
          `UPDATE task
              SET status = ?, lease_until = NULL, error = ?, updated_at = ?
            WHERE id = ?`,
        )
        .run(status, error, now.toISOString(), id);
    });
    this.#logger.info('任务进入终态', { taskId: id, status, error });
  }

  /**
   * 启动扫描（§10.4）：租约过期的 `running` → `pending`，**不动 `attempts`**。
   *
   * 僵尸任务的那次认领已经算过一次执行开始（`tryClaim`）。回收只是把行放回队列，
   * 不是一次新的执行，所以不计数。否则同一个任务会因为「被回收」而多消耗一次重试：
   * 直接抢过期租约（`tryClaim`）与经本方法重置是同一个状态的两条回收路径，它们必须
   * 对「一次认领算不算一次尝试」给同一个答案。
   *
   * 先 SELECT 再批量 UPDATE，整体一个事务：SELECT 到的行在事务内不会被别的写者
   * 改掉（`BEGIN IMMEDIATE` 先拿写锁），所以不存在「读到了、写的时候已经变了」。
   * 返回被重置的 id 列表，调用方用它打日志。
   */
  recoverExpired(now: Date): readonly string[] {
    const nowIso = now.toISOString();
    const recovered = withWriteTransaction(this.#db, () => {
      const rows = this.#db
        .prepare(
          `SELECT id FROM task
            WHERE status = 'running' AND ${LEASE_EXPIRED_SQL}
            ORDER BY created_at ASC`,
        )
        .all(nowIso);
      const ids = rows.map((row) => text(row['id']));
      if (ids.length === 0) {
        return ids;
      }
      const statement = this.#db.prepare(
        `UPDATE task
            SET status = 'pending', lease_until = NULL, updated_at = ?
          WHERE id = ?`,
      );
      for (const id of ids) {
        statement.run(nowIso, id);
      }
      return ids;
    });
    if (recovered.length > 0) {
      this.#logger.warn('回收租约过期的任务。', { taskIds: recovered, count: recovered.length });
    }
    return recovered;
  }

  /**
   * 待处理任务（§10.4）：`pending`，或租约过期的 `running`，按 `created_at` 升序。
   *
   * 升序是 FIFO：先建的任务先跑，归档序号与提交顺序才不会交叉。
   */
  claimable(now: Date, limit: number): readonly ClaimableTaskRow[] {
    return this.#db
      .prepare(
        `SELECT ${TASK_COLUMNS} FROM task
          WHERE ${CLAIMABLE_SQL}
          ORDER BY created_at ASC
          LIMIT ?`,
      )
      .all(now.toISOString(), limit)
      .map(toClaimableTaskRow);
  }

  /**
   * 租约过期的 `running` 任务数（§17.5 的孤儿任务）。
   *
   * 与 `recoverExpired` 同一个谓词（`LEASE_EXPIRED_SQL`）：健康度报的就是「下次启动
   * 扫描能捞回多少」。只读聚合放在仓储上而不是让 `services/observability.ts` 自己写
   * SQL：谓词只有一份，两处不会各改一半。
   */
  countExpiredLeases(now: Date): number {
    const row = this.#db
      .prepare(
        `SELECT COUNT(*) AS total FROM task
          WHERE status = 'running' AND ${LEASE_EXPIRED_SQL}`,
      )
      .get(now.toISOString());
    return Number(row?.['total'] ?? 0);
  }

  countByStatus(status: TaskStatus): number {
    const row = this.#db.prepare('SELECT COUNT(*) AS total FROM task WHERE status = ?').get(status);
    return Number(row?.['total'] ?? 0);
  }
}
