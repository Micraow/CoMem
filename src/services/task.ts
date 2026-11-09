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
 * `attempts` 记「**已经开始的执行次数**」，`maxAttempts` 是**允许的最大执行次数**。
 * 加一只有一处：`tryClaim` 的 SQL，与 `running` 的状态转移在同一条 UPDATE 里原子
 * 完成（`adapters/sqlite/task-repository.ts`），`WHERE` 没命中的认领不会计数。
 *
 * 应用层不补这次加一：
 *
 * - 并发认领时两个 worker 会各自读到同一个旧值再各自加一，两次执行只记一次；
 * - 失败路径加一（上一版的做法）要求这里先把「加过之后是多少」预演一遍再判断
 *   `shouldRetry`，同一规则写了两份，两份必须时刻对齐。上一版删掉这里的补偿就会
 *   跑 4 次：第 3 次失败时数据库里的 `attempts` 还是 2（递增发生在判断之后），
 *   于是又放行了第 4 次。
 *
 * 认领之后的 `attempts` 就是「含这次执行」的次数，所以 `shouldRetry` 直接看它：
 * 第 N 次认领后 `attempts = N`，`N < maxAttempts` 才回队列，第 `maxAttempts` 次
 * 失败后置 `failed`。成功、失败、回队列都不再改这个计数——回收扫描也不改，
 * 一次认领只算一次。
 *
 * ## 哪些错误不重试
 *
 * `isTerminalStepError`（URI 非法、参数非法、权限不足、未认证）重试三次结果一样，
 * 直接置 `failed`（`domain/archive.ts`）。重试它们只会把任务队列拖长——API Key
 * 错的时候每次都要等满 LLM 超时，一条坏配置能拖出几分钟。
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
   * 时 `attempts` 不变：这次执行的开始已经在认领时记过，下次 `tryClaim` 会再领到它
   * 并记下一次开始。
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
    // `latest.attempts` 已经包含这次执行（认领时 SQL 加的），直接用它判断还有没有
    // 下一次；这里再补一次就是同一个计数加两遍。
    if (isTerminalStepError(failure.code) || !shouldRetry(latest, this.#maxAttempts)) {
      this.#tasks.finish(id, 'failed', failure.message, new Date());
      return false;
    }
    this.#tasks.requeue(id, new Date());
    return false;
  }
}
