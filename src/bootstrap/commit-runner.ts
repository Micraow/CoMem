/**
 * 阶段二执行器（架构文档 §10.1、§10.3、§10.4）。
 *
 * ## 为什么需要它
 *
 * `POST /sessions/{id}/commit` 只做阶段一的同步部分：落归档目录、写
 * `messages.jsonl`、写 `phase1.status = ready`、建任务。阶段二的五个步骤
 * （归档摘要 → 记忆抽取 → 补丁合并 → 摘要失效 → 经验归纳）**没有任何执行入口**。
 *
 * 没有这个循环的后果不是「慢」而是「永远不跑」：任务停在 `pending`，
 * `memories/pending` 永远为空，`.done` 永远不写。单元测试**看不出来**——
 * 它们直接构造 `CommitPipeline` 并同步 `await run()`，绕过了「谁在什么时候调它」。
 *
 * ## 轮询而不是消息队列
 *
 * 进度靠 `task` 表的租约推进（§10.4）：`claimable` 查出「pending 或租约过期的
 * running」，`TaskService.run` 用 `tryClaim` 原子认领。多进程部署时两个实例不会
 * 同时跑同一个任务——抢占由 `UPDATE ... WHERE` 的行锁保证，不需要额外的协调服务。
 *
 * 轮询的代价是**平均延迟半秒**（间隔的一半）。归档本来就是后台动作（§17.2 把它
 * 归进「不阻塞用户」那一列），这点延迟换一个不需要额外中间件的部署形态是划算的。
 *
 * ## 为什么并发上限来自配置
 *
 * 每个任务会调模型（抽取、摘要）。并发太高会把供应商的速率限制打满，而失败重试
 * 只会让它更糟。`config.task.concurrency` 默认 2——两个任务在跑就够了，再多也
 * 只是把同一批 token 预算切成更小的片。
 *
 * ## 为什么定时器不 `unref`
 *
 * 反直觉，但必须这样：`unref` 之后，如果 HTTP 服务也在等（比如没有任何连接），
 * 进程会在启动后立刻退出。执行器是「服务在跑」的证据之一。停止靠 `stop()`——
 * `main.ts` 的退出信号里调它，先停轮询再关数据库，否则在途任务会撞上已关闭的连接。
 */

import type { TaskRow } from '../adapters/sqlite/task-repository.js';
import type { ArchiveTaskPayload, CommitStepName } from '../domain/archive.js';
import type { Logger } from '../domain/log.js';
import { MILLISECONDS_PER_SECOND } from '../domain/time.js';
import { Uri } from '../domain/uri.js';

import type { CommitPipeline } from '../services/commit/pipeline.js';
import type { TaskService } from '../services/task.js';

/** 轮询间隔：1 秒。经验值，来源未知——架构文档没给。 */
const DEFAULT_INTERVAL_SECONDS = 1;

/**
 * 兜底并发：4。与 `config.task.concurrency` 的默认值一致。
 *
 * 生产路径走 `container.ts` 传入的 `config.task.concurrency`，这个常量只在构造
 * 时没给 `concurrency` 的测试里生效。两处必须同值，否则测试跑出的并发行为与
 * 生产不同——2026-11 之前这里是 2 而配置默认是 4，注释还写着「来源同默认值」，
 * 属于典型的「文档与代码各说各话」。
 */
const DEFAULT_CONCURRENCY = 4;

/**
 * 会话目录名（`services/session.ts` 的私有常量，同一个布局）。
 *
 * `payload.sessionUri` 是 `{scope}/sessions/{id}`（`SessionService.create` 造的），
 * 去掉最后两段就是归档所在的**作用域根**——记忆写在它下面，不是写在会话目录下。
 */
const SESSIONS_DIRECTORY_NAME = 'sessions';

export interface CommitRunnerOptions {
  readonly tasks: Pick<TaskService, 'claimable' | 'run'>;
  /**
   * 按归档现造一条管线。每个任务一份，**不复用**。
   *
   * `CommitPipelineOptions.ports` 在构造期固定，而五个端口方法绑定归档目录（读这个
   * 归档的 `messages.jsonl`、写它的 `.meta.json`、找它的上一个归档）。单例管线只能
   * 绑死一个归档，第二个任务就会把部分步骤记到别人的 `.meta.json` 里。
   *
   * 只收 `archiveUri`：作用域根是 `run()` 的入参（由任务载荷的 `sessionUri` 推出），
   * 构造期用不到它。
   */
  /**
   * 按归档现造一条管线。
   *
   * 第二个参数是「步骤集合变了」的回调——`task.steps_done` 与 `.meta.json` 各记
   * 一份：后者是重放的依据，前者让「卡在第几步」能直接 SQL 查出来（见
   * `archive-ports.ts` 的 `onStepsChanged`）。
   */
  readonly createPipeline: (
    archiveUri: Uri,
    onStepsChanged: (steps: readonly CommitStepName[]) => void,
  ) => CommitPipeline;
  readonly logger: Logger;
  /** 轮询间隔（秒），默认 1。 */
  readonly intervalSeconds?: number;
  /** 同时执行的任务数上限，默认 2。 */
  readonly concurrency?: number;
}

export class CommitRunner {
  readonly #tasks: CommitRunnerOptions['tasks'];
  readonly #createPipeline: CommitRunnerOptions['createPipeline'];
  readonly #logger: Logger;
  readonly #intervalMs: number;
  readonly #concurrency: number;

  #timer: NodeJS.Timeout | null = null;
  /** 当前这一轮正在跑的任务；`stop()` 要等它们收尾。 */
  readonly #inFlight = new Set<Promise<unknown>>();
  /** 防止上一轮没跑完时重入：并发上限是「同时执行」，不是「每秒启动」。 */
  #ticking = false;

  constructor(options: CommitRunnerOptions) {
    this.#tasks = options.tasks;
    this.#createPipeline = options.createPipeline;
    this.#logger = options.logger;
    this.#intervalMs = Math.max(1, options.intervalSeconds ?? DEFAULT_INTERVAL_SECONDS) * MILLISECONDS_PER_SECOND;
    this.#concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);
  }

  /** 开始轮询。幂等：重复调用不会起第二个定时器。 */
  start(): void {
    if (this.#timer !== null) {
      return;
    }
    this.#timer = setInterval(() => {
      void this.#tick();
    }, this.#intervalMs);
    this.#logger.info('提交执行器已启动。', {
      intervalSeconds: this.#intervalMs / MILLISECONDS_PER_SECOND,
      concurrency: this.#concurrency,
    });
  }

  /**
   * 停止轮询并等待在途任务收尾。
   *
   * 在途任务**不打断**：一个跑到一半的补丁合并被打断，留下的是「部分步骤已标完成、
   * 却没有 `.done`」的归档。它下次会被重新认领并跳过已完成的步骤，但这次的数据
   * 就是半成品。等它跑完，代价是退出慢几百毫秒。
   */
  async stop(): Promise<void> {
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    if (this.#inFlight.size > 0) {
      this.#logger.info('等待在途提交任务收尾。', { count: this.#inFlight.size });
      await Promise.allSettled([...this.#inFlight]);
    }
    this.#logger.info('提交执行器已停止。');
  }

  /** 跑一轮：认领可执行任务并并行执行。测试用 `await tick()` 拿确定点。 */
  async tick(): Promise<void> {
    await this.#tick();
  }

  async #tick(): Promise<void> {
    if (this.#ticking) {
      // 上一轮还没跑完。不是错误：任务本来就要跑几秒，间隔 1 秒必然重叠。
      return;
    }
    this.#ticking = true;
    try {
      const claimable = this.#tasks.claimable(this.#concurrency);
      if (claimable.length === 0) {
        return;
      }
      await Promise.all(claimable.map((task) => this.#runOne(task)));
    } catch (error) {
      // 轮询本身失败不能让进程退出：下一轮还会再试。数据库被锁、任务表被改，
      // 这些都会自愈；崩掉就再也不会重试。
      this.#logger.error('提交执行器轮询失败，下一轮重试。', {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.#ticking = false;
    }
  }

  async #runOne(task: TaskRow): Promise<void> {
    // 任务类型只有 `archive`：这一段之后的所有代码都在按归档载荷解释 `payload`。
    //
    // 写成穷举的 switch 而不是直接往下走：`domain/task.ts` 的 `TASK_TYPES` 加一个
    // 类型时这里编译失败，逼你给它写处理器。缺处理器不会报错——新类型会被当成
    // 归档载荷解析，然后在某个 `payload.xxx` 上静默失败。
    switch (task.type) {
      case 'archive':
        break;
      default: {
        const exhaustive: never = task.type;
        await this.#failTask(task, `未知的任务类型：${String(exhaustive)}。`);
        return;
      }
    }

    const payload = readArchivePayload(task.payload);
    if (payload === null) {
      // 载荷坏了不能当成功：标 failed 让它进死信，否则它会永远被 `claimable`
      // 查出来、永远失败在一个没人看的循环里。
      await this.#failTask(task, '任务载荷缺少 sessionUri / archiveUri / archiveId，无法执行。');
      return;
    }

    // 载荷里的 URI 是上一次进程写进去的文本：解析失败要标失败，不能让它变成
    // `#tick` 里的异常——那会被当成「轮询失败」，任务留在 `running` 等租约过期，
    // 然后每一轮都撞在同一个坏 URI 上。
    const archiveUri = Uri.tryParse(payload.archiveUri);
    const scopeUri = sessionScopeOf(payload.sessionUri);
    if (archiveUri === null || scopeUri === null) {
      await this.#failTask(
        task,
        `任务载荷里的 URI 不合法：sessionUri=${payload.sessionUri}，archiveUri=${payload.archiveUri}。`,
      );
      return;
    }

    const promise = this.#tasks
      .run(task.id, async (context) => {
        // 每个任务现造一条管线：端口绑定归档目录，跨任务复用会写错归档。
        const pipeline = this.#createPipeline(archiveUri, (steps) => {
          // 管线每完成一步就回写任务行：`markStepDone` 内部去重，重复写同一步是
          // 一次幂等的 UPDATE。
          for (const step of steps) {
            void context.markStepDone(step);
          }
        });
        await pipeline.run(archiveUri, scopeUri);
      })
      .catch((error: unknown) => {
        // `TaskService.run` 自己会捕获并写失败状态；走到这里是它崩了（认领后行消失
        // 之类）。记下来，不要静默。
        this.#logger.error('提交任务执行异常。', {
          taskId: task.id,
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        this.#inFlight.delete(promise);
      });

    this.#inFlight.add(promise);
    await promise;
  }

  async #failTask(task: TaskRow, reason: string): Promise<void> {
    this.#logger.error('提交任务无法执行。', { taskId: task.id, reason });
    // `TaskService.run` 的失败路径会写 error；没有 handler 可跑时只能直接标。
    // 这里复用它：跑一个立刻抛错的 handler，走同一条失败记账路径。
    await this.#tasks.run(task.id, async () => {
      throw new Error(reason);
    });
  }
}

/**
 * 从任务载荷里读出归档定位信息。
 *
 * `payload` 是 `unknown`（数据库里的 JSON 列），**逐个字段校验**而不是断言：
 * 载荷是上一次进程写进去的，字段改名、手改数据库、版本升级都会让形状对不上，
 * 而 `as ArchiveTaskPayload` 会让这些错误变成运行期的 `undefined`。
 */
function readArchivePayload(payload: unknown): ArchiveTaskPayload | null {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return null;
  }
  const record = payload as Record<string, unknown>;
  const sessionUri = record['sessionUri'];
  const archiveUri = record['archiveUri'];
  const archiveId = record['archiveId'];
  if (
    typeof sessionUri !== 'string' ||
    typeof archiveUri !== 'string' ||
    typeof archiveId !== 'string'
  ) {
    return null;
  }
  return { sessionUri, archiveUri, archiveId };
}

/**
 * 会话 URI 的作用域根：`{scope}/sessions/{id}` 去掉最后两段。
 *
 * 记忆 URI 由 `renderMemoryUri(scopeUri, ...)` 拼出来（`comem://user/alice/memories/...`），
 * 传会话 URI 会写到 `sessions/sess_xxx/memories/` 下——一份谁都找不到的记忆。项目
 * 会话的作用域是 `comem://user/alice/projects/foo`，所以不能退化成「scope + rootId」。
 *
 * 形状对不上返回 `null`：这是载荷写坏了，不是用户的输入错误。
 */
function sessionScopeOf(sessionUri: string): Uri | null {
  const parsed = Uri.tryParse(sessionUri);
  if (parsed === null) {
    return null;
  }
  const sessionsDirectory = parsed.parent();
  if (sessionsDirectory === null || sessionsDirectory.name !== SESSIONS_DIRECTORY_NAME) {
    return null;
  }
  return sessionsDirectory.parent();
}
