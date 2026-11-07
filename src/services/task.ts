/**
 * 任务调度（架构文档 §10.4、§18 的 `task` 段）。
 *
 * 这一层是「认领 → 执行 → 心跳 → 终态」的生命周期，以及 `markStepDone` 的幂等
 * 写回。任务行本身在 `adapters/sqlite/task-repository.ts`，状态机的合法转移在
 * `domain/task.ts`。
 *
 * ## 为什么心跳必须 `unref`
 *
 * `setInterval` 会让事件循环一直有活，进程退不出去。心跳是兜底机制，不是业务
 * 逻辑——它存在的前提是「有任务在跑」，任务结束就 `clearInterval`，进程不该为了
 * 一个空转的定时器活着。
 *
 * ## attempts 记什么
 *
 * `attempts` 记「已经跑完的执行次数」，不是「认领次数」（`domain/task.ts` 的
 * `claim` 注释）。所以：认领不递增，这次执行失败时递增。`shouldRetry` 的上限判断
 * 用递增后的值——`maxAttempts = 3` 表示最多执行 3 次，第 3 次失败后置 `failed`。
 *
 * ## 哪些错误不重试
 *
 * `isTerminalStepError`（URI 非法、参数非法、权限不足）重试三次结果一样，直接
 * 置 `failed`（`domain/archive.ts`）。重试它们只会把任务队列拖长。
 */

import { randomUUID } from 'node:crypto';

import type { TaskRepository, TaskRow } from '../adapters/sqlite/task-repository.js';
import type { CommitStepName } from '../domain/archive.js';
import { isTerminalStepError } from '../domain/archive.js';
import { ComemError } from '../domain/errors.js';
import type { Logger } from '../domain/log.js';
import { shouldRetry, type TaskStatus, type TaskType } from '../domain/task.js';

/** §18 的 `task.leaseSeconds` 默认值：60 秒。 */
const DEFAULT_LEASE_SECONDS = 60;

/** §18 的 `task.maxAttempts` 默认值：3 次。 */
const DEFAULT_MAX_ATTEMPTS = 3;

/** §10.4「每 20 秒续租」：心跳间隔。 */
const DEFAULT_HEARTBEAT_SECONDS = 20;

/**
 * `claimable` 一轮最多取回的候选数。经验值，来源未知：任务表通常只有个位数，
 * 取 100 只是给「积压了很多待处理任务」的场景一个上界，避免一次把整表读进内存。
 */
const DEFAULT_CLAIMABLE_LIMIT = 100;

/** 1 秒 = 1000 毫秒；配置里的三个时长都是秒。 */
const MILLISECONDS_PER_SECOND = 1000;

export interface TaskServiceOptions {
  readonly tasks: TaskRepository;
  readonly logger: Logger;
  /** §18 的 task.leaseSeconds，默认 60 */
  readonly leaseSeconds?: number;
  /** §18 的 task.maxAttempts，默认 3 */
  readonly maxAttempts?: number;
  /** 心跳间隔，默认 20 秒（§10.4「每 20 秒续租」） */
  readonly heartbeatSeconds?: number;
}

export interface TaskHandlerContext {
  readonly task: TaskRow;
  /** 标记某个步骤完成（会立刻落盘，重放时跳过） */
  markStepDone(step: CommitStepName): Promise<void>;
}

export type TaskHandler = (context: TaskHandlerContext) => Promise<void>;

export class TaskService {
  readonly #tasks: TaskRepository;
  readonly #logger: Logger;
  readonly #leaseSeconds: number;
  readonly #maxAttempts: number;
  readonly #heartbeatSeconds: number;

  constructor(options: TaskServiceOptions) {
    this.#tasks = options.tasks;
    this.#logger = options.logger;
    this.#leaseSeconds = options.leaseSeconds ?? DEFAULT_LEASE_SECONDS;
    this.#maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.#heartbeatSeconds = options.heartbeatSeconds ?? DEFAULT_HEARTBEAT_SECONDS;
  }

  /** 建任务。`id` 用 `crypto.randomUUID()` 生成。 */
  create(type: TaskType, payload: unknown): TaskRow {
    const now = new Date().toISOString();
    const task: TaskRow = {
      id: randomUUID(),
      type,
      status: 'pending',
      payload,
      stepsDone: [],
      attempts: 0,
      leaseUntil: null,
      error: null,
      createdAt: now,
      updatedAt: now,
    };
    this.#tasks.insert(task);
    this.#logger.info('任务已创建', { taskId: task.id, type });
    return task;
  }

  /**
   * 认领 + 执行 + 心跳 + 终态。
   *
   * 返回 `false` 有两种含义：认领失败（别人在处理），或执行失败（已按
   * `shouldRetry` 决定回队列还是置 `failed`）。调用方不需要区分——两者都表示
   * 「这次没有跑成功」。
   */
  async run(id: string, handler: TaskHandler): Promise<boolean> {
    if (!this.#tasks.tryClaim(id, new Date(), this.#leaseSeconds)) {
      this.#logger.debug('任务正在被处理，跳过认领。', { taskId: id });
      return false;
    }

    const claimed = this.#tasks.get(id);
    if (claimed === null) {
      // 认领成功却读不到行：UPDATE 与 SELECT 之间行被删了。按并发冲突处理，
      // 让调用方重试；编一个假任务继续执行会写出一个不存在的 taskId 的步骤。
      throw new ComemError('CONFLICT', `任务在认领后消失：${id}`, { taskId: id });
    }

    // 步骤集合在内存里累积，每次标记整体写回：同一个 step 调两次只有一条记录。
    const stepsDone = new Set<string>(claimed.stepsDone);
    const context: TaskHandlerContext = {
      task: claimed,
      markStepDone: async (step) => {
        if (stepsDone.has(step)) {
          return;
        }
        stepsDone.add(step);
        this.#tasks.updateStepsDone(id, [...stepsDone]);
      },
    };

    const timer = setInterval(() => {
      this.#tasks.renewLease(id, new Date(), this.#leaseSeconds);
    }, this.#heartbeatSeconds * MILLISECONDS_PER_SECOND);
    // 不 unref 进程退不出去（见文件头）。
    timer.unref();

    try {
      await handler(context);
      this.#tasks.finish(id, 'done', null, new Date());
      this.#logger.info('任务完成', { taskId: id, type: claimed.type });
      return true;
    } catch (error) {
      return this.#handleFailure(id, claimed, error);
    } finally {
      // 无论成功、失败还是抛出，定时器都必须清掉。
      clearInterval(timer);
    }
  }

  /** 启动扫描：回收僵尸任务。返回重置的数量。幂等，可以每 30 秒跑一次。 */
  recover(): number {
    const recovered = this.#tasks.recoverExpired(new Date());
    return recovered.length;
  }

  /** 待处理任务（`pending` 或租约过期的 `running`），按创建时间升序。 */
  claimable(limit: number = DEFAULT_CLAIMABLE_LIMIT): readonly TaskRow[] {
    return this.#tasks.claimable(new Date(), limit);
  }

  /** 某类型某状态的计数（`health` 工具用）。 */
  countByStatus(status: TaskStatus): number {
    return this.#tasks.countByStatus(status);
  }

  /**
   * 失败处理：错误先进 `error` 字段与 `error.log`（§10.4），再决定重试还是终态。
   *
   * 终态错误（URI / 参数 / 权限）不重试；其余按 `shouldRetry` 判断。回到 `pending`
   * 时 `attempts` 由仓储递增，下次 `tryClaim` 会再领到它。
   */
  #handleFailure(id: string, claimed: TaskRow, error: unknown): false {
    const failure = ComemError.from(error);
    this.#logger.error('任务执行失败。', {
      taskId: id,
      type: claimed.type,
      code: failure.code,
      error: failure.message,
    });

    const latest = this.#tasks.get(id) ?? claimed;
    // 这次执行已经跑完，`attempts` 先加一，再用它判断还有没有下一次。
    const attempted: TaskRow = { ...latest, attempts: latest.attempts + 1 };
    if (isTerminalStepError(failure.code) || !shouldRetry(attempted, this.#maxAttempts)) {
      this.#tasks.finish(id, 'failed', failure.message, new Date());
      return false;
    }
    this.#tasks.requeue(id, new Date());
    return false;
  }
}
