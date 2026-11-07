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
 * 2. **`.done` 最后写。** 它是唯一的完成信号（§10.1）。先写就等于宣称成功，而后面
 *    的步骤可能什么都没做。
 * 3. **单步失败重试 `stepAttempts` 次。** 这里的重试是「同一步再跑一遍」；模型调用
 *    自己的重试（解析失败一次、截断不重试）在 `LlmService` 里，两者不叠加成指数。
 *    终态错误（`isTerminalStepError`）不重试——同样的输入再来一次结果一样。
 *
 * 超过重试上限的错误原样抛给 `TaskService`，由任务层决定是否把任务置为 `failed`
 * 或者等租约过期后重放（§10.4）。
 */

import type { ArchiveMeta, CommitStepName } from '../../domain/archive.js';
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
}

export interface CommitPipelineOptions {
  readonly steps: readonly CommitStep[];
  readonly ports: StepContextPorts;
  readonly logger: Logger;
  /** 单步失败重试次数，默认 1（§11.4「解析失败只重试一次」） */
  readonly stepAttempts?: number;
}

/**
 * 默认重试次数。
 *
 * 来源：架构文档 §11.4「解析失败只重试一次」。一次重试 = 总共两次尝试；再多就只是
 * 把一个确定的失败拖成几秒后的失败，并在监控里留下几条假故障。
 */
const DEFAULT_STEP_ATTEMPTS = 1;

export class CommitPipeline {
  readonly #steps: readonly CommitStep[];
  readonly #ports: StepContextPorts;
  readonly #logger: Logger;
  readonly #stepAttempts: number;

  constructor(options: CommitPipelineOptions) {
    this.#steps = options.steps;
    this.#ports = options.ports;
    this.#logger = options.logger;
    this.#stepAttempts = Math.max(0, options.stepAttempts ?? DEFAULT_STEP_ATTEMPTS);
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

    for (const step of this.#steps) {
      if (meta.stepsDone.includes(step.name)) {
        this.#logger.debug('提交步骤已完成，跳过', {
          archive: archiveUri.toString(),
          step: step.name,
        });
        continue;
      }

      const context: StepContext = {
        archiveUri,
        scopeUri,
        messages,
        meta,
        latestArchiveOverview,
        state,
        markStepDone,
      };
      await this.#runWithRetry(step, context);
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
