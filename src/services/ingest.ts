/**
 * 本机 Agent 对话导入的编排（架构文档 §11.9）。
 *
 * ## 一条会话的流程
 *
 * ```
 * 游标之后读一批 → 建会话（首次）→ 逐条 appendMessages → 写回游标
 *                → 重复直到读完 → commitPhase1（归档 + 建任务）
 * ```
 *
 * **游标只在消息落盘之后前进。** 反过来（先写游标再写消息）时，一次磁盘满或进程
 * 被杀就会永久丢掉那一段——日志还在，但游标越过去了。
 *
 * **每条会话单独提交。** 攒在内存里等到全部会话结束再写，一次失败就全丢；而且
 * 908 个会话的正文不能同时留在堆里。
 *
 * **一条会话失败不影响其它会话。** 单个文件坏掉（格式变化、权限、磁盘）时，其余
 * 会话仍然导入，失败进 `report.errors`。
 *
 * ## 导入之后必须等阶段二
 *
 * `commitPhase1` 只写归档、建任务（阶段一，§10.1）。任务要由 `CommitRunner` 认领
 * 才会跑阶段二：生成摘要、抽取记忆、合并、摘要失效。导入完立刻退出时任务停在
 * `pending`，`find` 一条都搜不到——「导了 908 个会话，find 0 命中」。
 *
 * 所以 `waitForExtraction` **默认 `true`**：导入完一批会话就驱动执行器跑到这一批
 * 的任务结束。关掉它只在「先看报告、稍后跑服务」时有用，报告里的 `extraction` 为
 * `null`。
 *
 * **没有可用 LLM 时降级成「只归档」。** 阶段一不依赖模型：把会话归档进库、建好
 * 任务，本身就有价值（原始对话落盘、可按内容检索）。阶段二每个任务都要调模型，
 * `providers.llm.default.type: disabled` 时注定失败。所以此时**不报错**——「先把
 * 数据导进来、模型以后配」是合法的部署顺序——而是跳过阶段二，并在报告的
 * `extraction` 里写明 `{ skipped: true, reason: 'llm_disabled' }`，同时记一条
 * `warn` 日志。报告与日志必须说出来：跑完 1,076 个会话却不说「记忆没被抽取」，
 * 用户会以为 `find` 能搜到。
 *
 * **为什么要分批。** 908 个会话 × 每会话 1–2 次模型调用是 2–3 小时。等全部导完再
 * 等阶段二，用户几个小时看不到一行进度；而且一次超时就会把整批算失败。按
 * `extractionBatchSize`（默认 20）个会话一批，超时按批算，一批失败不阻塞后面。
 *
 * ## 幂等
 *
 * 同一个 `(harness, nativeSessionId)` 跑第二次：游标已经在末尾，`readMessages`
 * 不前进，`skipped + 1`，不建会话、不写消息、不提交。
 *
 * ## `dryRun` 不写
 *
 * `dryRun` 下不调 `SessionService` 的任何方法，也不调游标仓储的 `upsert`。它仍然
 * 读游标与源日志，所以报告里的「新建 / 跳过」是真实判断。游标仓储在 dry-run 时
 * 可以是只读连接，`services/` 不需要知道这一点。
 *
 * **`dryRun` 也忽略 `waitForExtraction`。** 没有任务可跑；为了「看看抽取效果」去
 * 真的调模型会产生费用且不可逆。报告里的 `extraction` 是 `null`。
 *
 * ## 溯源
 *
 * `SessionMeta` 是冻结契约（`domain/session.ts`），没有 `source` 字段，且
 * `metadata-file.ts` 读回时会丢弃未知字段。所以「这条会话从哪来」记在
 * `ingest_cursor` 行的 `(harness, nativeSessionId, locator → session_uri)` 上，
 * 而不是伪造一个读不回来的 `.meta.json` 字段。
 */

import { randomUUID } from 'node:crypto';

import type { IngestCursorRepository } from '../adapters/sqlite/ingest-cursor-repository.js';
import { ComemError } from '../domain/errors.js';
import type {
  IngestCursor,
  IngestHarness,
  SessionRef,
} from '../domain/ingest.js';
import type { Logger } from '../domain/log.js';
import { Uri } from '../domain/uri.js';
import type { LogSource } from '../ingest/source.js';

import type { SessionService } from './session.js';

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
  readonly sessions?: Pick<SessionService, 'create' | 'addMessage' | 'commitPhase1'>;
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

interface MutableReport {
  harness: IngestHarness;
  discovered: number;
  skipped: number;
  imported: number;
  appended: number;
  messages: number;
  failed: number;
  errors: IngestError[];
}

interface MutableExtraction {
  tasksCompleted: number;
  tasksFailed: number;
  /** 全部批次写入的记忆 URI → 类型；用来算「抽取条数」的去重总数。 */
  readonly memories: Map<string, string>;
  readonly pendingReview: Set<string>;
  durationMs: number;
  readonly batches: IngestExtractionBatchReport[];
}

/**
 * 每批等多少个会话的阶段二。
 *
 * 20 的来源是 W25 任务约定：一批 20 个会话 × 每会话 1–2 次模型调用 ≈ 20–40 次
 * 调用，按 5 秒/次约 100–200 秒。用户在终端里按「批」看到进度，而不是等 908 个
 * 会话全部导完才出第一行；批量再小会让执行器每几个任务空转一次，且批次日志过多。
 *
 * 测试与批量脚本可以覆盖，生产从 `ingest.extractionBatchSize` 传。
 */
const DEFAULT_EXTRACTION_BATCH_SIZE = 20;

/**
 * 每批阶段二的最长等待：30 分钟。
 *
 * 来源是「908 个会话 × 1–2 次模型调用 × 5 秒/次 ≈ 2–3 小时」的总量，换算到一批
 * 20 个会话约 3–7 分钟。30 分钟留了 4–10 倍余量覆盖供应商尾延迟与单步重试；更
 * 短会把「供应商慢一点」误判成超时，更长会让一次卡住的导入拖住终端。
 *
 * 超时按**批**算，不是按总量：总耗时可以是「批数 × 30 分钟」。
 */
const DEFAULT_EXTRACTION_TIMEOUT_MS = 30 * 60 * 1000;

function errorMessage(error: unknown): string {
  return ComemError.from(error).message;
}

/** 错误里带的源文件路径；发现阶段的失败（如整份 Qwen 导出损坏）要靠它定位。 */
function locatorOf(error: unknown): string | null {
  if (!(error instanceof ComemError)) {
    return null;
  }
  const locator = error.details?.['locator'];
  return typeof locator === 'string' ? locator : null;
}

/** 源时间戳不是合法 ISO 时用导入时刻兜底：`SessionMessage.createdAt` 必须是 ISO。 */
function normalizeTimestamp(value: string | null): string {
  if (value !== null && !Number.isNaN(Date.parse(value))) {
    return value;
  }
  return new Date().toISOString();
}

function isBefore(value: string | null, since: string): boolean {
  if (value === null) {
    return false;
  }
  const startedAt = Date.parse(value);
  if (Number.isNaN(startedAt)) {
    return false;
  }
  return startedAt < Date.parse(since);
}

export class IngestService {
  readonly #sources: readonly LogSource[];
  readonly #scopeUri: Uri;
  readonly #principals: readonly string[];
  readonly #logger: Logger;
  readonly #batchSize: number;
  readonly #sessions: IngestServiceOptions['sessions'];
  readonly #cursors: IngestServiceOptions['cursors'];
  readonly #extraction: IngestServiceOptions['extraction'];
  readonly #extractionSkip: IngestExtractionSkipReason | undefined;
  readonly #extractionBatchSize: number;
  readonly #extractionTimeoutMs: number;

  constructor(options: IngestServiceOptions) {
    if (!Number.isInteger(options.batchSize) || options.batchSize <= 0) {
      throw new ComemError('INVALID_ARGUMENT', `ingest.batchSize 必须是正整数：${options.batchSize}`, {
        batchSize: options.batchSize,
      });
    }
    const extractionBatchSize = options.extractionBatchSize ?? DEFAULT_EXTRACTION_BATCH_SIZE;
    if (!Number.isInteger(extractionBatchSize) || extractionBatchSize <= 0) {
      throw new ComemError(
        'INVALID_ARGUMENT',
        `ingest.extractionBatchSize 必须是正整数：${extractionBatchSize}`,
        { extractionBatchSize },
      );
    }
    const extractionTimeoutMs = options.extractionTimeoutMs ?? DEFAULT_EXTRACTION_TIMEOUT_MS;
    if (!Number.isInteger(extractionTimeoutMs) || extractionTimeoutMs < 0) {
      throw new ComemError(
        'INVALID_ARGUMENT',
        `ingest.extractionTimeoutMs 必须是非负整数：${extractionTimeoutMs}`,
        { extractionTimeoutMs },
      );
    }
    this.#sources = options.sources;
    this.#scopeUri = options.scopeUri;
    this.#principals = options.principals;
    this.#logger = options.logger;
    this.#batchSize = options.batchSize;
    this.#sessions = options.sessions;
    this.#cursors = options.cursors;
    this.#extraction = options.extraction;
    this.#extractionSkip = options.extractionSkip;
    this.#extractionBatchSize = extractionBatchSize;
    this.#extractionTimeoutMs = extractionTimeoutMs;
  }

  async run(options: IngestOptions = {}): Promise<IngestReport> {
    const dryRun = options.dryRun ?? false;
    const waitForExtraction = options.waitForExtraction ?? true;
    const extractionTimeoutMs = options.extractionTimeoutMs ?? this.#extractionTimeoutMs;
    // 「本该跑阶段二」的三个条件：不是 dry-run、用户要等、超时不为 0。
    const extractionRequested = !dryRun && waitForExtraction && extractionTimeoutMs > 0;
    // 没有可用模型时跳过阶段二，而不是让每个会话各失败一次。阶段一（归档）不依赖
    // 模型，先导进来本身就是价值；但报告必须说明记忆没被抽取。
    const skipReason = extractionRequested ? this.#extractionSkip : undefined;
    if (!dryRun) {
      this.#requireWriter();
      if (this.#cursors === undefined) {
        throw new ComemError(
          'INVALID_ARGUMENT',
          '导入需要游标仓储；`dryRun` 之外必须注入 IngestCursorRepository。',
        );
      }
      if (
        extractionRequested &&
        skipReason === undefined &&
        this.#extraction === undefined
      ) {
        throw new ComemError(
          'INVALID_ARGUMENT',
          '导入默认等待阶段二；要跳过抽取请显式传 waitForExtraction: false。',
          { field: 'extraction' },
        );
      }
    }

    const extraction =
      extractionRequested && skipReason === undefined ? createExtraction() : null;
    if (skipReason !== undefined) {
      this.#logger.warn('阶段二被跳过：providers.llm.default.type 是 disabled', {
        reason: skipReason,
      });
    }

    const since = this.#parseSince(options.since);
    const batchSize = this.#parseBatchSize(options.limitPerSession);
    const sources = this.#selectSources(options.harnesses);
    const reports: IngestHarnessReport[] = [];

    for (const source of sources) {
      const report: MutableReport = {
        harness: source.harness,
        discovered: 0,
        skipped: 0,
        imported: 0,
        appended: 0,
        messages: 0,
        failed: 0,
        errors: [],
      };
      // 这一批「本次导入创建的任务」。阶段二按批跑：攒够 extractionBatchSize 个
      // 会话就等一批，避免 908 个会话全部导完才出进度。
      const batchTaskIds: string[] = [];

      try {
        for await (const ref of source.discoverSessions()) {
          report.discovered += 1;
          if (since !== null && isBefore(ref.startedAt, since)) {
            report.skipped += 1;
            continue;
          }
          try {
            const taskId = await this.#ingestSessionAsync(source, ref, report, dryRun, batchSize);
            if (taskId !== null) {
              batchTaskIds.push(taskId);
              if (extraction !== null && batchTaskIds.length >= this.#extractionBatchSize) {
                await this.#drainExtraction(
                  source.harness,
                  batchTaskIds.splice(0).length,
                  extraction,
                  extractionTimeoutMs,
                );
              }
            }
          } catch (error) {
            report.failed += 1;
            report.errors.push({ locator: ref.locator, message: errorMessage(error) });
            this.#logger.error('导入会话失败', {
              harness: source.harness,
              locator: ref.locator,
              nativeSessionId: ref.nativeSessionId,
              reason: errorMessage(error),
            });
          }
        }
      } catch (error) {
        // 发现阶段失败（Qwen 整份导出不是合法 JSON）：整份文件不可用，明确记进
        // 报告，不静默返回 0 个会话。
        report.failed += 1;
        report.errors.push({
          locator: locatorOf(error) ?? `<${source.harness}>`,
          message: errorMessage(error),
        });
        this.#logger.error('导入源发现失败', {
          harness: source.harness,
          reason: errorMessage(error),
        });
      }

      // 适配器按文件跳过的损坏导出。它们不中断来源，但必须出现在报告里——
      // 「跳过了哪些文件」是用户判断「导入是不是完整」的唯一线索。
      for (const fileError of source.fileErrors ?? []) {
        report.failed += 1;
        report.errors.push(fileError);
      }

      // 这一批的最后几个会话（不足 extractionBatchSize 的余数）。放在 catch 之后：
      // 发现阶段失败时，失败之前已经建好的任务也要跑完，不能留在 pending。
      if (extraction !== null && batchTaskIds.length > 0) {
        await this.#drainExtraction(
          source.harness,
          batchTaskIds.splice(0).length,
          extraction,
          extractionTimeoutMs,
        );
      }

      reports.push(report);
      this.#logger.info('导入源完成', {
        harness: report.harness,
        discovered: report.discovered,
        skipped: report.skipped,
        imported: report.imported,
        appended: report.appended,
        messages: report.messages,
        failed: report.failed,
        extractionBatches: extraction?.batches.length ?? 0,
      });
    }

    return {
      harnesses: reports,
      extraction:
        extraction !== null
          ? freezeExtraction(extraction)
          : skipReason === undefined
            ? null
            : { skipped: true, reason: skipReason },
    };
  }

  /**
   * 跑一批阶段二。执行器认领的是全局队列，`sessions` 只用于报告展示「这一批对应
   * 本次导入的多少个会话」。
   *
   * 执行器失败（不是任务失败）只记进报告，不抛出：一批跑失败不该让整次导入变成
   * 异常——用户已经导进来的会话还在磁盘上，报告必须能说明「哪一批没跑完」。
   *
   * 队列为空（`tasksAttempted === 0`）时不产生空批次：正常导入的收尾批已经由上一
   * 轮跑完，这里再记一条「0 个任务」只会让报告变长。
   */
  async #drainExtraction(
    harness: IngestHarness,
    sessions: number,
    extraction: MutableExtraction,
    timeoutMs: number,
  ): Promise<void> {
    const index = extraction.batches.length + 1;
    const startedAt = Date.now();
    let batch: IngestExtractionBatch;
    try {
      batch = await this.#requireExtraction().run({ timeoutMs });
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      extraction.durationMs += durationMs;
      extraction.batches.push({
        index,
        harness,
        sessions,
        tasksCompleted: 0,
        tasksFailed: 0,
        memoriesExtracted: 0,
        memoriesPendingReview: 0,
        durationMs,
        timedOut: false,
        error: errorMessage(error),
      });
      this.#logger.error('阶段二执行失败', {
        harness,
        batch: index,
        sessions,
        reason: errorMessage(error),
      });
      return;
    }

    if (batch.tasksAttempted === 0) {
      // 队列空：不产生空批次。计时也不累加——那是「等了一下」而不是「跑了一批」。
      return;
    }

    const durationMs = Date.now() - startedAt;
    extraction.tasksCompleted += batch.tasksCompleted;
    extraction.tasksFailed += batch.tasksFailed;
    extraction.durationMs += durationMs;
    for (const [uri, memoryType] of batch.memories) {
      extraction.memories.set(uri, memoryType);
    }
    for (const uri of batch.pendingReview) {
      extraction.pendingReview.add(uri);
    }

    extraction.batches.push({
      index,
      harness,
      sessions,
      tasksCompleted: batch.tasksCompleted,
      tasksFailed: batch.tasksFailed,
      memoriesExtracted: batch.memories.size,
      memoriesPendingReview: batch.pendingReview.length,
      durationMs,
      timedOut: batch.timedOut,
      error: null,
    });

    this.#logger.info('阶段二完成', {
      harness,
      batch: index,
      sessions,
      tasksCompleted: batch.tasksCompleted,
      tasksFailed: batch.tasksFailed,
      memoriesExtracted: batch.memories.size,
      memoriesPendingReview: batch.pendingReview.length,
      durationMs,
      timedOut: batch.timedOut,
    });
  }

  async #ingestSessionAsync(
    source: LogSource,
    ref: SessionRef,
    report: MutableReport,
    dryRun: boolean,
    batchSize: number,
  ): Promise<string | null> {
    const existing = this.#cursors?.get(source.harness, ref.nativeSessionId) ?? null;
    if (existing !== null && existing.cursorKind !== source.cursorKind) {
      throw new ComemError('INTERNAL', `游标类型与源不匹配：${ref.locator}`, {
        locator: ref.locator,
        expected: source.cursorKind,
        actual: existing.cursorKind,
      });
    }

    let cursor: IngestCursor | null =
      existing === null ? null : { kind: existing.cursorKind, value: existing.cursorValue };
    let sessionUri: Uri | null =
      existing === null ? null : parseUri(existing.sessionUri, ref.locator);
    let created = false;
    let written = 0;

    while (true) {
      const result = await source.readMessages(ref, cursor, batchSize);
      const advanced =
        cursor === null ? result.cursor.value !== '' : result.cursor.value !== cursor.value;
      if (!advanced) {
        break;
      }

      if (result.messages.length > 0) {
        if (!dryRun) {
          sessionUri = await this.#ensureSession(sessionUri, () => {
            created = true;
          });
          const sessions = this.#requireWriter();
          for (const message of result.messages) {
            await sessions.addMessage(sessionUri, {
              id: randomUUID(),
              role: message.role,
              parts: [{ kind: 'text', text: message.text }],
              createdAt: normalizeTimestamp(message.createdAt),
            });
          }
          written += result.messages.length;
          this.#writeCursor(source, ref, sessionUri, result.cursor, existing, written);
        } else {
          written += result.messages.length;
          if (sessionUri === null) {
            created = true;
          }
        }
      } else if (!dryRun && sessionUri !== null) {
        // 只消费到空行 / 坏行：游标也要前进，否则下一次从同一位置开始，永远读不到
        // 后面的内容。
        this.#writeCursor(source, ref, sessionUri, result.cursor, existing, written);
      }

      cursor = result.cursor;

      // dry-run 只需要回答「这个会话有没有新消息」，不需要把整个文件读完。
      // 真跑时循环到游标不再前进为止。
      if (dryRun) {
        break;
      }
    }

    if (written === 0) {
      report.skipped += 1;
      this.#logger.debug('会话没有新消息，跳过', {
        harness: source.harness,
        nativeSessionId: ref.nativeSessionId,
        locator: ref.locator,
      });
      return null;
    }

    if (!dryRun) {
      if (sessionUri !== null) {
        // 一条会话导入完立刻提交：阶段一只落归档、建任务，记忆要等阶段二。
        const commit = await this.#requireWriter().commitPhase1(sessionUri);
        report.messages += written;
        if (created) {
          report.imported += 1;
        } else {
          report.appended += written;
        }
        this.#logger.info(created ? '会话已导入' : '会话已追加', {
          harness: source.harness,
          nativeSessionId: ref.nativeSessionId,
          locator: ref.locator,
          messages: written,
          taskId: commit.taskId,
        });
        return commit.taskId;
      }
      return null;
    }

    report.messages += written;
    if (created) {
      report.imported += 1;
    } else {
      report.appended += written;
    }
    this.#logger.info(created ? '会话已导入' : '会话已追加', {
      harness: source.harness,
      nativeSessionId: ref.nativeSessionId,
      locator: ref.locator,
      messages: written,
      dryRun: true,
    });
    return null;
  }

  async #ensureSession(
    current: Uri | null,
    onCreated: () => void,
  ): Promise<Uri> {
    if (current !== null) {
      return current;
    }
    const sessions = this.#requireWriter();
    const created = await sessions.create(this.#scopeUri, this.#principals);
    onCreated();
    return created;
  }

  #writeCursor(
    source: LogSource,
    ref: SessionRef,
    sessionUri: Uri,
    cursor: IngestCursor,
    existing: { readonly messageCount: number } | null,
    written: number,
  ): void {
    const cursors = this.#cursors;
    if (cursors === undefined) {
      throw new ComemError(
        'INTERNAL',
        '导入游标仓储未注入，无法在非 dry-run 下前进游标。',
        { harness: source.harness, nativeSessionId: ref.nativeSessionId },
      );
    }
    cursors.upsert({
      harness: source.harness,
      nativeSessionId: ref.nativeSessionId,
      sessionUri: sessionUri.toString(),
      cursorKind: cursor.kind,
      cursorValue: cursor.value,
      messageCount: (existing?.messageCount ?? 0) + written,
      updatedAt: new Date().toISOString(),
    });
  }

  #requireWriter(): NonNullable<IngestServiceOptions['sessions']> {
    if (this.#sessions === undefined) {
      throw new ComemError(
        'INVALID_ARGUMENT',
        '导入需要会话服务；`dryRun` 之外必须注入 SessionService。',
      );
    }
    return this.#sessions;
  }

  #requireExtraction(): ExtractionRunner {
    if (this.#extraction === undefined) {
      throw new ComemError(
        'INVALID_ARGUMENT',
        '导入需要阶段二执行器；`waitForExtraction` 为 true 时必须注入 ExtractionRunner。',
      );
    }
    return this.#extraction;
  }

  #selectSources(harnesses: readonly IngestHarness[] | undefined): readonly LogSource[] {
    if (harnesses === undefined) {
      return this.#sources;
    }
    const known = new Set(this.#sources.map((source) => source.harness));
    for (const harness of harnesses) {
      if (!known.has(harness)) {
        throw new ComemError('INVALID_ARGUMENT', `未知的导入来源：${harness}`, { harness });
      }
    }
    const selected = new Set(harnesses);
    return this.#sources.filter((source) => selected.has(source.harness));
  }

  #parseBatchSize(limitPerSession: number | undefined): number {
    if (limitPerSession === undefined) {
      return this.#batchSize;
    }
    if (!Number.isInteger(limitPerSession) || limitPerSession <= 0) {
      throw new ComemError(
        'INVALID_ARGUMENT',
        `limitPerSession 必须是正整数：${limitPerSession}`,
        { limitPerSession },
      );
    }
    return limitPerSession;
  }

  #parseSince(since: string | undefined): string | null {
    if (since === undefined || since === '') {
      return null;
    }
    if (Number.isNaN(Date.parse(since))) {
      throw new ComemError('INVALID_ARGUMENT', `--since 不是合法时间：${since}`, { since });
    }
    return since;
  }
}

function createExtraction(): MutableExtraction {
  return {
    tasksCompleted: 0,
    tasksFailed: 0,
    memories: new Map(),
    pendingReview: new Set(),
    durationMs: 0,
    batches: [],
  };
}

function freezeExtraction(extraction: MutableExtraction): IngestExtractionReport {
  return {
    skipped: false,
    tasksCompleted: extraction.tasksCompleted,
    tasksFailed: extraction.tasksFailed,
    memoriesExtracted: extraction.memories.size,
    memoriesPendingReview: extraction.pendingReview.size,
    durationMs: extraction.durationMs,
    batches: extraction.batches,
  };
}

function parseUri(value: string, locator: string): Uri {
  try {
    return Uri.parse(value);
  } catch (error) {
    throw new ComemError('INTERNAL', `游标里的会话 URI 不合法：${locator}`, {
      locator,
      uri: value,
      reason: errorMessage(error),
    });
  }
}
