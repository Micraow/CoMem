/**
 * 提交管线骨架（架构文档 §10.1、§10.3、§10.4）。
 *
 * 阶段二（后台任务）是一条固定的四步流水线。Template Method 把「跳过已完成 → 执行
 * → 记录」这段骨架钉死，变化点只有四个 `CommitStep` 实现；新增步骤不改骨架。
 *
 * ## 三条不变量
 *
 * 1. **每步完成立刻落盘 `stepsDone`。** 记忆操作不幂等：重放一次 patch，SEARCH
 *    可能还能匹配，结果是同一段事实被写第二遍。崩在中间时只能靠 `stepsDone` 判断
 *    哪些步骤真的跑完了。
 *
 *    **「跑完」必须包含「产物还在」。** `stepsDone` 是重放判据，重放会跳过它记下
 *    的步骤；如果某一步的产物只存在 `StepContext.state`（进程内存）里，跳过之后
 *    它就不存在了，下游步骤拿到的是「步骤声称完成、产物却缺失」。所以每个步骤的
 *    产物必须落在归档目录里，跳过时由 `CommitStep.rehydrate` 读回来。只记进度不记
 *    产物的实现会让「`memory_extract` 之后的一次瞬态失败」变成永久损坏。
 * 2. **`.done` 最后写。** 它是唯一的完成信号（§10.1）。先写就等于宣称成功，而后面
 *    的步骤可能什么都没做。
 * 3. **单步失败重试 `stepAttempts` 次。** 这里的重试是「同一步再跑一遍」；模型调用
 *    自己的重试（解析失败一次、截断不重试）在 `LlmService` 里，两者不叠加成指数。
 *    终态错误（`isTerminalStepError`）不重试——同样的输入再来一次结果一样
 *    （URI / 参数 / 权限 / API Key 无效）。
 *
 * 超过重试上限的错误原样抛给 `TaskService`，由任务层决定是否把任务置为 `failed`
 * 或者等租约过期后重放（§10.4）。
 *
 * ## 部署缺少能力时跳过步骤，而不是让任务失败
 *
 * `providers.llm.default.type: disabled` 的部署里，`memory_extract` 每次都会撞上
 * `DisabledLlmProvider` 抛出的 `INVALID_ARGUMENT`。那是**终态错误**：第一次就把
 * 任务置 `failed`，归档永远停在 `archive_summary`。但阶段一（归档落盘、建任务、
 * `session` 关联）不依赖模型，缺模型只让阶段二的产物消失——和 `ingest` 的
 * `{ skipped: true, reason: 'llm_disabled' }` 是同一条判据。
 *
 * 所以「不能执行」由装配方**显式登记**（`skippedSteps`），管线在这一步只记
 * `skippedSteps` 与一条 `warn` 日志，然后继续。`services/` 不 import `config/`：
 * 判据在 `bootstrap/container.ts` 里从配置翻译过来。
 */

import type {
  ArchiveMeta,
  CommitStepName,
  CommitStepSkipReason,
} from '../../domain/archive.js';
import { isTerminalStepError } from '../../domain/archive.js';
import { ComemError } from '../../domain/errors.js';
import type { Logger } from '../../domain/log.js';
import type { SessionMessage } from '../../domain/session.js';
import type { Uri } from '../../domain/uri.js';

/**
 * 步骤能用的外部能力。
 *
 * 全部方法都绑定在「这一次提交」的归档上（归档目录、`archive_NNN/.meta.json`、上一个
 * 归档的概览），由装配方按归档创建。管线本身可以复用：`run(archiveUri, scopeUri)`
 * 只负责把地址交给步骤。
 */
export interface StepContextPorts {
  readonly readMessages: () => Promise<readonly SessionMessage[]>;
  readonly readArchiveMeta: () => Promise<ArchiveMeta>;
  readonly writeArchiveMeta: (meta: ArchiveMeta) => Promise<void>;
  /** 上一个归档的 `.overview.md` 正文（§10.5）；第一次提交时为 `null`。 */
  readonly latestArchiveOverview: () => Promise<string | null>;
  /** 写 `archive_NNN/.done`。只有 `run` 在全部步骤成功后调用。 */
  readonly writeDone: () => Promise<void>;
  readonly logger: Logger;
}

export interface StepContext {
  readonly archiveUri: Uri;
  readonly scopeUri: Uri;
  readonly messages: readonly SessionMessage[];
  readonly meta: ArchiveMeta;
  readonly latestArchiveOverview: string | null;
  /** 跨步骤传递的产物，如抽取出的操作列表 */
  readonly state: Map<string, unknown>;
  markStepDone(step: CommitStepName): Promise<void>;
}

export abstract class CommitStep {
  abstract readonly name: CommitStepName;
  abstract run(context: StepContext): Promise<void>;

  /**
   * 从归档目录把「只存在内存里」的产物读回 `context.state`。
   *
   * 管线在**跳过**已完成的步骤时调用它。跳过意味着「不重算」，但下游步骤仍要看到
   * 这一步的产物；产物一旦只存在 `StepContext.state` 里，重放时它就不存在了。
   * 默认什么都不做：产物本来就在盘上的步骤（`archive_summary`）没有可恢复的东西，
   * 而 `summary_invalidate` 的「产物」是摘要的脏计数，重跑反而会重复累加。
   *
   * 抛错表示归档自相矛盾（`stepsDone` 声称跑过，但盘上没有产物）。那是装配或数据
   * 损坏，按终态错误处理，不要重试。
   */
  async rehydrate(context: StepContext): Promise<void> {
    // 产物在盘上的步骤没有可恢复的东西。
    void context;
  }
}

/**
 * 后台阶段计时入口（§17.2）。
 *
 * 形状就是 `ObservabilityService.phase` 的方法签名：`CommitPipeline` 不 import
 * 那个服务，装配方传进来即可。省略时原样执行 `fn`（单测直接 `new CommitPipeline`
 * 不需要为了计时造一个可观测服务）。
 */
export type CommitPhase = <T>(name: string, fn: () => Promise<T>) => Promise<T>;

export interface CommitPipelineOptions {
  readonly steps: readonly CommitStep[];
  readonly ports: StepContextPorts;
  readonly logger: Logger;
  /**
   * 给四个后台步骤计时。生产装配传 `observability.phase`；省略时不记。
   *
   * 后台阶段不在 HTTP 请求里，`ObservabilityService.phase` 会把它们记进进程级
   * `#asyncPhases`（见该方法注释），因此这里不需要请求作用域。
   */
  readonly phase?: CommitPhase;
  /** 单步失败重试次数，默认 1（§11.4「解析失败只重试一次」） */
  readonly stepAttempts?: number;
  /**
   * 因部署缺少能力而**不能执行**的步骤 → 原因。
   *
   * 由装配方从配置推出（`services/` 不 import `config/`）。跳过的步骤仍写进
   * `stepsDone`——否则每次任务重放都会再判一次「没有模型」，而且任务行无法看出
   * 「四步都走过了」；原因另记在 `skippedSteps` 里。
   */
  readonly skippedSteps?: ReadonlyMap<CommitStepName, CommitStepSkipReason>;
}

/**
 * 默认重试次数。
 *
 * 来源：架构文档 §11.4「解析失败只重试一次」。一次重试 = 总共两次尝试；再多就只是
 * 把一个确定的失败拖成几秒后的失败，并在监控里留下几条假故障。
 */
const DEFAULT_STEP_ATTEMPTS = 1;

/** 跳过原因的人类可读说明，只用于日志。 */
const SKIP_REASON_LABELS: Readonly<Record<CommitStepSkipReason, string>> = {
  llm_disabled: 'providers.llm.default.type 是 disabled',
};

/**
 * 四个管线步骤 → §17.2 的后台阶段名。
 *
 * 一一对应：`archive_summary` 是归档阶段（生成 `archive_NNN/` 的摘要），
 * `summary_invalidate` 是摘要阶段（标记目录摘要失效）。阶段一（写归档目录）是请求
 * 内的同步工作，不在这里——把它算进「后台耗时」会把用户等过的时间重复计一次。
 *
 * 用 `Record<CommitStepName, string>` 而不是普通对象：新增步骤时类型检查会强制
 * 给出阶段名，避免新步骤静默不计时。
 */
const STEP_PHASE: Readonly<Record<CommitStepName, string>> = {
  archive_summary: 'archive',
  memory_extract: 'extract',
  memory_merge: 'merge',
  summary_invalidate: 'summary',
};

/** 没有装配计时器时原样执行。 */
const IDENTITY_PHASE: CommitPhase = <T>(_name: string, fn: () => Promise<T>): Promise<T> => fn();

export class CommitPipeline {
  readonly #steps: readonly CommitStep[];
  readonly #ports: StepContextPorts;
  readonly #logger: Logger;
  readonly #stepAttempts: number;
  readonly #skippedSteps: ReadonlyMap<CommitStepName, CommitStepSkipReason>;
  readonly #phase: CommitPhase;

  constructor(options: CommitPipelineOptions) {
    this.#steps = options.steps;
    this.#ports = options.ports;
    this.#logger = options.logger;
    this.#stepAttempts = Math.max(0, options.stepAttempts ?? DEFAULT_STEP_ATTEMPTS);
    this.#skippedSteps = options.skippedSteps ?? new Map();
    this.#phase = options.phase ?? IDENTITY_PHASE;
  }

  async run(archiveUri: Uri, scopeUri: Uri): Promise<void> {
    const [messages, initialMeta, latestArchiveOverview] = await Promise.all([
      this.#ports.readMessages(),
      this.#ports.readArchiveMeta(),
      this.#ports.latestArchiveOverview(),
    ]);

    let meta = initialMeta;
    const state = new Map<string, unknown>();

    const markStepDone = async (step: CommitStepName): Promise<void> => {
      if (meta.stepsDone.includes(step)) {
        return;
      }
      meta = { ...meta, stepsDone: [...meta.stepsDone, step] };
      await this.#ports.writeArchiveMeta(meta);
    };

    /**
     * 跳过一步：既写 `stepsDone`（重放判据），也写 `skippedSteps`（为什么没做）。
     *
     * 两次写入合成一次：分开写会让「已经完成」和「被跳过」之间出现一个崩溃窗口，
     * 而重放时那一步会被当成「该执行」。
     */
    const markStepSkipped = async (
      step: CommitStepName,
      reason: CommitStepSkipReason,
    ): Promise<void> => {
      if (meta.skippedSteps.some((skipped) => skipped.step === step)) {
        return;
      }
      meta = {
        ...meta,
        stepsDone: meta.stepsDone.includes(step) ? meta.stepsDone : [...meta.stepsDone, step],
        skippedSteps: [...meta.skippedSteps, { step, reason }],
      };
      await this.#ports.writeArchiveMeta(meta);
    };

    for (const step of this.#steps) {
      const context: StepContext = {
        archiveUri,
        scopeUri,
        messages,
        meta,
        latestArchiveOverview,
        state,
        markStepDone,
      };

      if (meta.stepsDone.includes(step.name)) {
        // 跳过 = 不重算，但下游步骤仍要看到这一步的产物（文件头的第 1 条不变量）。
        // 被跳过的步骤（`skippedSteps`）从未执行过，没有产物可恢复；对它们调用
        // `rehydrate` 会让「没有可用模型」的部署在任务重放时误报「产物不存在」。
        if (!meta.skippedSteps.some((skipped) => skipped.step === step.name)) {
          await step.rehydrate(context);
        }
        this.#logger.debug('提交步骤已完成，跳过', {
          archive: archiveUri.toString(),
          step: step.name,
        });
        continue;
      }

      const skipReason = this.#skippedSteps.get(step.name);
      if (skipReason !== undefined) {
        await markStepSkipped(step.name, skipReason);
        // 降级必须可见：归档会走到 `.done`，用户不会收到任何错误。
        this.#logger.warn(`${step.name} 被跳过：${SKIP_REASON_LABELS[skipReason]}`, {
          archive: archiveUri.toString(),
          step: step.name,
          reason: skipReason,
        });
        continue;
      }

      // 包住整段真实工作（含重试）：这一段就是 §17.2 表格里的后台阶段。
      await this.#phase(STEP_PHASE[step.name], () => this.#runWithRetry(step, context));
      await markStepDone(step.name);
    }

    // §10.1：`.done` 是唯一的完成信号，必须最后写。
    await this.#ports.writeDone();
    this.#logger.info('提交管线完成', {
      archive: archiveUri.toString(),
      steps: this.#steps.length,
    });
  }

  async #runWithRetry(step: CommitStep, context: StepContext): Promise<void> {
    const maxAttempts = this.#stepAttempts + 1;

    for (let attempt = 1; ; attempt += 1) {
      try {
        await step.run(context);
        return;
      } catch (error) {
        const failure = ComemError.from(error);
        const canRetry = attempt < maxAttempts && !isTerminalStepError(failure.code);
        this.#logger.error('提交步骤失败', {
          archive: context.archiveUri.toString(),
          step: step.name,
          attempt,
          maxAttempts,
          code: failure.code,
          message: failure.message,
          willRetry: canRetry,
        });
        if (!canRetry) {
          // 抛原始异常：包装成 ComemError 会丢掉非 ComemError 的调用栈，而
          // `TaskService` 只关心「它失败了」。
          throw error;
        }
      }
    }
  }
}
