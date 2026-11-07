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
import type { TaskStatus, TaskType } from '../../domain/task.js';

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
 * 数据库行 → `TaskRow`。
 *
 * `type` / `status` 用 `as` 收窄：写入路径只接受领域类型，表里出现的值一定是枚举
 * 成员；这里再写一遍校验只会给两个字段各加一个不可能走到的分支。
 */
function toTaskRow(row: Record<string, SQLOutputValue>): TaskRow {
  const id = text(row['id']);
  return {
    id,
    type: text(row['type']) as TaskType,
    status: text(row['status']) as TaskStatus,
    payload: parseJsonColumn(text(row['payload']), 'payload', id),
    stepsDone: parseStepsDone(text(row['steps_done']), id),
    attempts: integer(row['attempts']),
    leaseUntil: nullableText(row['lease_until']),
    error: nullableText(row['error']),
    createdAt: text(row['created_at']),
    updatedAt: text(row['updated_at']),
  };
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
   * 可领。`lease_until IS NULL` 的 `running` 行按已过期处理——与
   * `domain/task.ts` 的 `isLeaseExpired` 一致：认领一定会写租约，出现这种行说明
   * 数据被改坏了，让它能被捞回来而不是永远卡在 `running`。
   *
   * 认领不递增 `attempts`：递增在「这次执行结束」时（失败回队列、或恢复扫描重置
   * 僵尸任务），一次失败只算一次（`domain/task.ts` 的 `claim` 注释）。
   */
  tryClaim(id: string, now: Date, leaseSeconds: number): boolean {
    const nowIso = now.toISOString();
    const changes = withWriteTransaction(this.#db, () =>
      this.#db
        .prepare(
          `UPDATE task
              SET status = 'running', lease_until = ?, updated_at = ?
            WHERE id = ?
              AND (
                status = 'pending'
                OR (status = 'running' AND (lease_until IS NULL OR lease_until < ?))
              )`,
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
   * 失败但还值得重试：回到 `pending`，`attempts += 1`。
   *
   * `domain/task.ts` 的转移表里 `running → pending` 是合法转移；这里用一条 UPDATE
   * 完成，不经过内存里的 `transition`——那会多一次读。
   *
   * 保留 `error`：它是「上一次失败的原因」，重试成功后由 `finish('done')` 清空。
   * 清掉的话，一个反复失败的任务在队列里看不到任何线索。
   */
  requeue(id: string, now: Date): void {
    withWriteTransaction(this.#db, () => {
      this.#db
        .prepare(
          `UPDATE task
              SET status = 'pending', lease_until = NULL, attempts = attempts + 1, updated_at = ?
            WHERE id = ?`,
        )
        .run(now.toISOString(), id);
    });
    this.#logger.debug('任务回到队列', { taskId: id });
  }

  /**
   * 终态（§10.4）。`done` 不递增 `attempts`；`failed` 递增——`attempts` 记的是
   * 「已经跑完的执行次数」，失败的这一次也要算进去，否则 `shouldRetry` 永远为真。
   */
  finish(id: string, status: 'done' | 'failed', error: string | null, now: Date): void {
    const attemptsDelta = status === 'failed' ? 1 : 0;
    withWriteTransaction(this.#db, () => {
      this.#db
        .prepare(
          `UPDATE task
              SET status = ?, lease_until = NULL, error = ?, attempts = attempts + ?, updated_at = ?
            WHERE id = ?`,
        )
        .run(status, error, attemptsDelta, now.toISOString(), id);
    });
    this.#logger.info('任务进入终态', { taskId: id, status, error });
  }

  /**
   * 启动扫描（§10.4）：租约过期的 `running` → `pending`，`attempts += 1`。
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
            WHERE status = 'running' AND (lease_until IS NULL OR lease_until < ?)
            ORDER BY created_at ASC`,
        )
        .all(nowIso);
      const ids = rows.map((row) => text(row['id']));
      if (ids.length === 0) {
        return ids;
      }
      const statement = this.#db.prepare(
        `UPDATE task
            SET status = 'pending', lease_until = NULL, attempts = attempts + 1, updated_at = ?
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
  claimable(now: Date, limit: number): readonly TaskRow[] {
    return this.#db
      .prepare(
        `SELECT ${TASK_COLUMNS} FROM task
          WHERE status = 'pending'
             OR (status = 'running' AND (lease_until IS NULL OR lease_until < ?))
          ORDER BY created_at ASC
          LIMIT ?`,
      )
      .all(now.toISOString(), limit)
      .map(toTaskRow);
  }

  countByStatus(status: TaskStatus): number {
    const row = this.#db.prepare('SELECT COUNT(*) AS total FROM task WHERE status = ?').get(status);
    return Number(row?.['total'] ?? 0);
  }
}
