/**
 * 调度器本体：定时器句柄、轮次状态、`start` / `stop` / `tick`。
 *
 * 一轮里做什么（扫会话、自动提交、过期、四个维护动作）在 `round.ts` 及其下游模块，
 * 这里只负责「什么时候开一轮」和「什么时候等它收尾」。
 *
 * ## 为什么定时器 `unref`
 *
 * 与 `CommitRunner` 的取舍相反（那边故意不 `unref`，理由见那个文件头）：调度器是
 * **周期性维护**，不是「服务在跑」的证据。真正让进程活着的是 HTTP 服务；测试与
 * 一次性脚本（`pnpm test`、`tsx` 跑的小工具）不该为了一个每 30 秒空转一圈的定时器
 * 卡住不退出。
 */

import type { Logger } from '../../domain/log.js';

import type { SchedulerOptions, SchedulerTickResult } from './contracts.js';
import { DEFAULT_INTERVAL_MS } from './constants.js';
import { errorMessage } from '../../domain/errors.js';
import { runRound, SKIPPED_RESULT } from './round.js';

export class Scheduler {
  readonly #options: SchedulerOptions;
  readonly #logger: Logger;
  readonly #now: () => Date;
  readonly #intervalMs: number;

  #timer: NodeJS.Timeout | null = null;
  /** 在途的一轮；`stop()` 要等它收尾（见下方注释）。 */
  #inFlight: Promise<SchedulerTickResult> | null = null;
  /** 停止之后定时器可能已经触发过：`tick()` 用这个标记不再开新的一轮。 */
  #stopped = false;

  constructor(options: SchedulerOptions) {
    this.#options = options;
    this.#logger = options.logger;
    this.#now = options.now ?? (() => new Date());
    this.#intervalMs = Math.max(1, options.intervalMs ?? DEFAULT_INTERVAL_MS);
  }

  /** 定时器是否在跑。`stop()` 之后是 `false`；重复 `start()` 不会起第二个。 */
  get started(): boolean {
    return this.#timer !== null;
  }

  /** 开始轮询。幂等：重复调用不会起第二个定时器。 */
  start(): void {
    if (this.#timer !== null) {
      return;
    }
    this.#stopped = false;
    this.#timer = setInterval(() => {
      // `tick()` 内部兜底所有异常（见 `tick()` 里 `runRound` 的 `.catch`），这里
      // 不会产生未处理的 rejection。
      void this.tick();
    }, this.#intervalMs);
    // 不阻止进程退出（见文件头「为什么定时器 unref」）。
    this.#timer.unref();
  }

  /**
   * 停止轮询，并**等在途的一轮跑完**再返回。
   *
   * 在途的一轮不打断：一次自动提交可能停在「归档消息已写、live 还没重写」的
   * `preparing` 状态（§10.1），下次重放能补完，但这一次的产物就是半成品。等它跑完，
   * 代价是退出慢几百毫秒。`AbortController` 在这里没有用武之地——**没有一步是可以
   * 安全中断的**，中断只会把「等一下」换成「下次补」。
   */
  async stop(): Promise<void> {
    this.#stopped = true;
    const wasRunning = this.#timer !== null || this.#inFlight !== null;
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    const inFlight = this.#inFlight;
    if (inFlight !== null) {
      this.#logger.info('等待在途的调度轮次收尾。', {});
      await inFlight;
    }
    // 从来没启动过（配置全关）时不说「已停止」：那会让启动日志里的
    // 「调度器未启动」看起来自相矛盾。
    if (wasRunning) {
      this.#logger.info('调度器已停止。', {});
    }
  }

  /**
   * 跑一轮（生产由 `start()` 的定时器调；测试直接 `await tick()` 拿确定点）。
   *
   * **不抛错**：轮询失败只记日志，下一轮还会再试——数据库被锁、某个会话的
   * `.meta.json` 被改坏，这些都是自愈的；抛出去会让定时器停在一个没人接的
   * rejection 上。
   */
  async tick(): Promise<SchedulerTickResult> {
    if (this.#stopped || this.#inFlight !== null) {
      // 上一轮还没跑完。不是错误：一次提交要写归档、建任务，30 秒仍可能重叠。
      return SKIPPED_RESULT;
    }

    const running = runRound(this.#options, this.#now).catch((error: unknown) => {
      this.#logger.error('调度轮次失败，下一轮重试。', { error: errorMessage(error) });
      return SKIPPED_RESULT;
    });
    this.#inFlight = running;
    try {
      return await running;
    } finally {
      this.#inFlight = null;
    }
  }
}
