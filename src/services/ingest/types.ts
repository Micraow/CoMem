/**
 * 导入编排的对外契约（架构文档 §11.9）：选项、报告与两个端口。
 *
 * 这些形状由 `services/ingest.ts` 原样 re-export；`commands/ingest.ts` 与测试只认那
 * 一个入口。放在这里是为了让编排、会话落地、阶段二各自只 import 需要的类型。
 */

import type { IngestCursorRepository } from '../../adapters/sqlite/ingest-cursor-repository.js';
import type { IngestHarness } from '../../domain/ingest.js';
import type { Logger } from '../../domain/log.js';
import type { Uri } from '../../domain/uri.js';
import type { LogSource } from '../../ingest/source.js';
import type { SessionService } from '../session.js';

export interface IngestOptions {
  readonly harnesses?: readonly IngestHarness[];
  readonly dryRun?: boolean;
  /**
   * 每个会话一次读多少条。
   *
   * 默认 100，来源是 W24 任务约定（与 MCP 单次批量写入的量级一致，§10.6 的验收
   * 场景就是 100 个文件）。100 条消息的内存占用可忽略，又足够摊薄「每条消息一次
   * 游标写」的代价。
   */
  readonly limitPerSession?: number;
  /** ISO 时间，只导这个时间之后的会话（`startedAt` 为 null 的会话仍然导入）。 */
  readonly since?: string;
  /**
   * 导入后等阶段二跑完。
   *
   * **默认 `true`**。用户要的是「导进来就能搜到」，不是「导进来一堆 pending 任务」。
   * 关掉它只在批量导入、想先看报告时有用——报告里的 `extraction` 为 `null`，会话
   * 仍然是 `pending` 任务，`find` 搜不到内容。
   */
  readonly waitForExtraction?: boolean;
  /**
   * 每批阶段二的最长等待，毫秒。`0` = 不等（等价于 `waitForExtraction: false`）。
   *
   * 默认 `DEFAULT_EXTRACTION_TIMEOUT_MS`（30 分钟）。超时按**批**算，不是按总量
   * 算：908 个会话的总量是几小时，但一批 20 个会话通常 3–7 分钟。
   */
  readonly extractionTimeoutMs?: number;
}

export interface IngestError {
  readonly locator: string;
  readonly message: string;
}

export interface IngestHarnessReport {
  readonly harness: IngestHarness;
  readonly discovered: number;
  /** 游标已到末尾（或 `since` 之前）的会话数 */
  readonly skipped: number;
  /** 新建的会话数 */
  readonly imported: number;
  /** 追加到已有会话的消息数 */
  readonly appended: number;
  /**
   * 写入的消息总数（含新建会话里的消息）。
   *
   * 报告接口里 `imported` 只数会话，`appended` 只数已有会话；CLI 要打印「共 N 条
   * 消息」时这两个数都不够，所以多一个总数，不改变前两者的语义。
   */
  readonly messages: number;
  readonly failed: number;
  readonly errors: readonly IngestError[];
}

/**
 * 阶段二一批跑完的结果。
 *
 * 由装配方（`commands/ingest.ts`）实现：它知道 `CommitRunner`、任务表与
 * `memory_diff.json` 的磁盘位置；`services/` 只负责「什么时候等、等多久」。
 */
export interface IngestExtractionBatch {
  /** 本轮认领了多少个任务（含历史积压）。 */
  readonly tasksAttempted: number;
  readonly tasksCompleted: number;
  readonly tasksFailed: number;
  /**
   * 本批写入的记忆：URI → 记忆类型。同一个 URI 只出现一次（一次合并写一次）。
   */
  readonly memories: ReadonlyMap<string, string>;
  /**
   * 本批写入的记忆中需要复核的 URI（记忆类型在 `memory.reviewRequired` 里）。
   *
   * 这些记忆的 `status = 'pending'`，**不会出现在检索结果里**，必须单独报给用户
   * ——否则「导进来 100 条，30 条待复核」看起来像 100 条都能搜到。
   */
  readonly pendingReview: readonly string[];
  /** 达到超时上限，队列里还有任务没跑。 */
  readonly timedOut: boolean;
}

/**
 * 阶段二执行端口（§10.1、§10.4）。
 *
 * `IngestService` 不能直接依赖 `CommitRunner`：后者在 `bootstrap/`，而
 * `services/` 只能看到领域与应用层。装配方把「跑任务直到队列空」包成这个端口。
 */
export interface ExtractionRunner {
  /**
   * 跑任务直到队列空或超时。
   *
   * **执行器是全局的 FIFO 队列，不区分来源。** 本次导入创建的任务排在同一队列里；
   * 历史积压会被先认领（报告里的完成数照实统计）。这是有意为之：任务表没有
   * `source` 列，按来源过滤执行器等于再造一份「这次该跑哪些」的状态。
   */
  run(options: { readonly timeoutMs: number }): Promise<IngestExtractionBatch>;
}

/** 报告里的一批阶段二。 */
export interface IngestExtractionBatchReport {
  /** 全局批次序号，从 1 开始。 */
  readonly index: number;
  readonly harness: IngestHarness;
  /** 这一批包含多少个本次导入的会话。 */
  readonly sessions: number;
  readonly tasksCompleted: number;
  readonly tasksFailed: number;
  readonly memoriesExtracted: number;
  readonly memoriesPendingReview: number;
  readonly durationMs: number;
  /** 超时：队列里还有任务，等下一轮（或服务端执行器）继续。 */
  readonly timedOut: boolean;
  /** 执行器本身失败（不是任务失败）；`null` 表示这一批正常跑完。 */
  readonly error: string | null;
}

/**
 * 阶段二被跳过的原因。
 *
 * 目前只有一种：`providers.llm.default.type` 是 `disabled`。留着联合类型的形状，
 * 是为了让报告自己说明「为什么没抽取」——`extraction: null` 已经表示「没等」
 * （`--no-wait` / dry-run / 超时为 0），不能再多一个含义。
 */
export type IngestExtractionSkipReason = 'llm_disabled';

export interface IngestExtractionReport {
  /** 恒为 `false`。与 {@link IngestExtractionSkippedReport} 区分用。 */
  readonly skipped: false;
  readonly tasksCompleted: number;
  readonly tasksFailed: number;
  /** 抽取并写入的记忆条数（按 URI 去重；同一份记忆更新两次只算一条）。 */
  readonly memoriesExtracted: number;
  /** 其中需要复核、暂不参与检索的记忆条数。 */
  readonly memoriesPendingReview: number;
  readonly durationMs: number;
  readonly batches: readonly IngestExtractionBatchReport[];
}

/** 阶段二没有发生：会话已归档、任务已建，记忆没被抽取。 */
export interface IngestExtractionSkippedReport {
  readonly skipped: true;
  readonly reason: IngestExtractionSkipReason;
}

export interface IngestReport {
  readonly harnesses: readonly IngestHarnessReport[];
  /**
   * 阶段二的结果。
   *
   * `null` 表示**没等**（`waitForExtraction: false`、`dryRun` 或
   * `extractionTimeoutMs: 0`）；`{ skipped: true }` 表示**等了但没有可用模型**，
   * 阶段二没有发生。
   */
  readonly extraction: IngestExtractionReport | IngestExtractionSkippedReport | null;
}

export interface IngestServiceOptions {
  readonly sources: readonly LogSource[];
  readonly scopeUri: Uri;
  /** 导入以绑定主体的身份写会话；展开后的主体集合（含 `user:*`）。 */
  readonly principals: readonly string[];
  readonly logger: Logger;
  readonly batchSize: number;
  /**
   * 会话写入端口。`dryRun` 时可以不传——传了也不会被调用。
   *
   * 用 `Pick` 而不是整个 `SessionService`：导入只做三件事，构造它的其它依赖
   * （锁、任务、权限）与这里无关。
   */
  readonly sessions?: Pick<
    SessionService,
    'create' | 'addMessage' | 'commitPhase1' | 'load' | 'listArchives' | 'readArchiveMeta'
  >;
  /**
   * 游标端口。`dryRun` 时可以传只读连接；不传就当作「没有任何游标」。
   */
  readonly cursors?: Pick<IngestCursorRepository, 'get' | 'upsert'>;
  /**
   * 阶段二执行端口。`waitForExtraction` 为 `true` 且非 dry-run 时必须注入——
   * 否则导入会静默停在「任务已建、记忆没抽」的假完成状态。
   */
  readonly extraction?: ExtractionRunner;
  /**
   * 阶段二跑不了的原因；不传表示能跑。
   *
   * 装配方从 `providers.llm.default.type === 'disabled'` 推出。给了它却仍注入
   * `extraction` 时以它为准——**执行器存在不等于模型存在**，容器总会建好执行器。
   */
  readonly extractionSkip?: IngestExtractionSkipReason;
  /**
   * 每批等多少个会话的阶段二。
   *
   * 默认 `DEFAULT_EXTRACTION_BATCH_SIZE`（20）。来源见该常量的注释。
   */
  readonly extractionBatchSize?: number;
  /**
   * 每批阶段二的最长等待，毫秒。
   *
   * 默认 `DEFAULT_EXTRACTION_TIMEOUT_MS`（30 分钟）。来源见该常量的注释。
   */
  readonly extractionTimeoutMs?: number;
}
