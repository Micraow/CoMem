/**
 * 归档元数据与记忆差异（架构文档 §6.6、§10.1）。
 *
 * 这两个形状是**提交管线的契约**：阶段一（同步落盘）写它们，阶段二（后台任务）
 * 读它们并把进度写回去。放在领域层是因为两侧都要用，而它们本身是纯数据。
 */

import type { ComemErrorCode } from './errors.js';
import type { BatchOperation } from './merge-op.js';

/**
 * 归档阶段的状态（§10.1 的 `phase1.status`）。
 *
 * `ready` 表示消息已经完整落到 `archive_NNN/messages.jsonl` 且 sha256 已校验；
 * `preparing` 是阶段一进行中的中间态，崩溃后由 `#findInterruptedArchive` 补完。
 *
 * 没有 `failed`：归档失败表达在任务状态上（`task.status = 'failed'`），归档元数据
 * 停在失败那一步之前的 `stepsDone`，阶段二不检查这里的值。
 */
export type ArchivePhaseStatus = 'preparing' | 'ready';

/**
 * 阶段状态的合法取值。
 *
 * 类型是来源，这张表是运行期清单：往 `ArchivePhaseStatus` 加成员时这里编译失败，
 * 而 `isArchivePhaseStatus` 只查这张表。旧写法在适配层手抄
 * `value === 'preparing' || value === 'ready'`，加成员时那段比较不会报错——
 * 表现为一个合法的 `phase1.status` 被当成「元数据损坏」。
 */
const ARCHIVE_PHASE_STATUSES: Readonly<Record<ArchivePhaseStatus, true>> = {
  preparing: true,
  ready: true,
};

/** 阶段状态守卫（`.meta.json` 是不可信输入，见 `MetadataFileStore`）。 */
export function isArchivePhaseStatus(value: unknown): value is ArchivePhaseStatus {
  return typeof value === 'string' && Object.hasOwn(ARCHIVE_PHASE_STATUSES, value);
}

export interface ArchivePhase1 {
  readonly status: ArchivePhaseStatus;
  /** `messages.jsonl` 的 sha256，阶段二读回来先校验 */
  readonly messagesSha256: string;
  /** 被归档（从 live 里移除）的消息 ID */
  readonly archivedMessageIds: readonly string[];
  /** 保留在 live 里的消息 ID（`keepRecentCount`） */
  readonly retainedMessageIds: readonly string[];
}

/**
 * 提交步骤名，**按执行顺序**。
 *
 * 写成字面量联合而不是 `string`：`stepsDone` 是重放判据，一个拼写错误会让某一步
 * 被静默重放（记忆操作不幂等，重放会造出重复记忆）。
 *
 * 数组是唯一来源，类型从它派生：步骤顺序在此定义（`CommitPipeline` 按它装配），
 * `stepsDone` 的人读顺序也来自它。加一步时 `STEP_PHASE`（阶段名）与装配处的
 * `Record<CommitStepName, CommitStep>` 会同时编译失败，逼你补齐实现与计时归档。
 */
export const COMMIT_STEP_NAMES = [
  'archive_summary',
  'memory_extract',
  'memory_merge',
  'summary_invalidate',
  /**
   * 经验归纳（§10.1 阶段二的第 5 步）。排在最后：它只消费归档目录与记忆文件，不依赖前四步的
   * `state`，而新增一步不能改变既有步骤的重放判据。
   */
  'experience_distill',
] as const;

export type CommitStepName = (typeof COMMIT_STEP_NAMES)[number];

/** 步骤名守卫。`stepsDone` 从 `.meta.json` 读回，属于不可信输入。 */
export function isCommitStepName(value: unknown): value is CommitStepName {
  return typeof value === 'string' && COMMIT_STEP_NAMES.some((step) => step === value);
}

/**
 * 步骤被跳过的原因。
 *
 * 目前只有一种：`providers.llm.default.type` 是 `disabled`。与 `memory_diff.json`
 * 的 `skippedOperations[].reasonCode` 不是一回事——那是**操作**级的跳过（某条补丁
 * 没匹配上），这里是**步骤**级的跳过（这一步在本次部署里不可能执行，也不该阻塞
 * 归档完成）。
 */
export type CommitStepSkipReason = 'llm_disabled';

/** 没有执行、但归档仍然完成的步骤。 */
export interface SkippedCommitStep {
  readonly step: CommitStepName;
  readonly reason: CommitStepSkipReason;
}

/** `archive_NNN/.meta.json` 的形状（§6.6）。 */
export interface ArchiveMeta {
  readonly archiveId: string;
  readonly phase1: ArchivePhase1;
  /** 已完成的步骤，按完成顺序 */
  readonly stepsDone: readonly CommitStepName[];
  /**
   * 没有执行、但归档仍然完成的步骤，按跳过顺序。
   *
   * **与 `stepsDone` 分开是必要的。** `stepsDone` 是重放判据（「跑过没有」），跳过
   * 的步骤也要写进去——否则每次任务重放都会再判一次「没有模型」。但「归档完成了，
   * 只是没抽取记忆」这个事实只有这里说得清：只看 `stepsDone` 的话，一份跳过抽取的
   * 归档和一份真的没抽出任何操作的归档长得一模一样。
   */
  readonly skippedSteps: readonly SkippedCommitStep[];
  readonly taskId: string | null;
}

/**
 * 归档任务的 payload（`task.type = 'archive'`）。
 *
 * 与 `ArchiveMeta` 同源：阶段一建任务时写它，阶段二认领任务后按 `archiveUri`
 * 读回 `ArchiveMeta`。URI 落 JSON 用字符串——`Uri` 是值对象，序列化形态是
 * 适配层的事，任务表只存文本。
 */
export interface ArchiveTaskPayload {
  readonly sessionUri: string;
  readonly archiveUri: string;
  readonly archiveId: string;
}

/**
 * 一条记忆操作的结果（§6.6 的 `memory_diff.json`）。
 *
 * `before` 只在更新时存在；新增时为空。删除操作只记 URI——内容已经没了，记下来
 * 也没有回滚价值。
 */
export interface MemoryDiffEntry {
  readonly uri: string;
  readonly memoryType: string;
  readonly before?: string;
  readonly after: string;
}

/** 被跳过的操作及原因。**不能静默丢弃**：模型要学会少产出无效操作。 */
export interface SkippedMemoryOperation {
  readonly memoryType: string;
  /** 稳定的机器可读原因，如 `invalid_ranges` / `patch_not_found` / `patch_ambiguous` */
  readonly reasonCode: string;
  /** 给用户看的完整句子 */
  readonly reason: string;
}

/** `archive_NNN/memory_diff.json` 的形状（§6.6）。 */
export interface MemoryDiff {
  readonly archiveUri: string;
  /** ISO 8601 */
  readonly extractedAt: string;
  readonly operations: {
    readonly adds: readonly MemoryDiffEntry[];
    readonly updates: readonly MemoryDiffEntry[];
    /** 只记 URI */
    readonly deletes: readonly string[];
  };
  readonly skippedOperations: readonly SkippedMemoryOperation[];
  readonly summary: {
    readonly totalAdds: number;
    readonly totalUpdates: number;
    readonly totalDeletes: number;
    readonly totalSkipped: number;
  };
}

/**
 * `archive_NNN/memory_operations.json` 的形状（§6.6、§10.4）。
 *
 * `memory_extract` 的产物。抽取结果原先只存在 `StepContext.state` 里，而
 * `stepsDone` 已经声称这一步跑完了——`memory_merge` 之后任何一次瞬态失败（供应商
 * 503、租约过期、进程重启）都会让重放跳过抽取步骤、从空 `state` 里读不到产物，
 * 把一份本来能完成的归档永久标成 `failed`。**`stepsDone` 的契约是「可恢复」，
 * 它必须同时意味着「产物还在」。**
 *
 * `memoryTypes` 落盘用二元组数组：JSON 没有 `Map`，用对象则是拿 URI 当键，会撞上
 * `__proto__` 这类原型链属性。
 */
export interface MemoryOperationsFile {
  readonly archiveUri: string;
  /** ISO 8601 */
  readonly extractedAt: string;
  readonly operations: readonly BatchOperation[];
  readonly skipped: readonly SkippedMemoryOperation[];
  /** `[uri, memoryType]`，还原成 `Map` 是消费方的事 */
  readonly memoryTypes: readonly (readonly [string, string])[];
}

/**
 * 盘上的 `memory_operations.json` 是否可消费。
 *
 * 只校验**下游真正读取的字段**：`operations` / `skipped` / `memoryTypes` 的形状。
 * 深校验 `BatchOperation` 等于把 `memory-extract.ts` 的 zod schema 抄一遍，而写入
 * 侧已经用那份 schema 校验过；这里防的是磁盘被手改、版本升级留下旧结构。
 */
export function isMemoryOperationsFile(value: unknown): value is MemoryOperationsFile {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (typeof record['archiveUri'] !== 'string' || typeof record['extractedAt'] !== 'string') {
    return false;
  }
  if (!Array.isArray(record['operations']) || !Array.isArray(record['skipped'])) {
    return false;
  }
  const memoryTypes = record['memoryTypes'];
  if (!Array.isArray(memoryTypes)) {
    return false;
  }
  return memoryTypes.every(
    (entry) =>
      Array.isArray(entry) &&
      entry.length === 2 &&
      typeof entry[0] === 'string' &&
      typeof entry[1] === 'string',
  );
}

/**
 * 盘上的 `memory_diff.json` 是否可消费。
 *
 * 重放用它推出「真正写过 / 删过哪些文件」（`MemoryMergeStep.rehydrate`）。只校验
 * 消费方读取的字段（`operations.{adds,updates}[].uri` 与 `operations.deletes[]`），
 * 其余字段原样保留。
 */
export function isMemoryDiff(value: unknown): value is MemoryDiff {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const operations = (value as Record<string, unknown>)['operations'];
  if (typeof operations !== 'object' || operations === null || Array.isArray(operations)) {
    return false;
  }
  const record = operations as Record<string, unknown>;
  return (
    isDiffEntryList(record['adds']) &&
    isDiffEntryList(record['updates']) &&
    Array.isArray(record['deletes']) &&
    record['deletes'].every((uri) => typeof uri === 'string')
  );
}

function isDiffEntryList(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        typeof entry === 'object' &&
        entry !== null &&
        typeof (entry as Record<string, unknown>)['uri'] === 'string',
    )
  );
}

/** 统计一段记忆差异。空差异返回全 0，不返回 `undefined`。 */
export function summarizeMemoryDiff(
  diff: Pick<MemoryDiff, 'operations' | 'skippedOperations'>,
): MemoryDiff['summary'] {
  return {
    totalAdds: diff.operations.adds.length,
    totalUpdates: diff.operations.updates.length,
    totalDeletes: diff.operations.deletes.length,
    totalSkipped: diff.skippedOperations.length,
  };
}

/**
 * 步骤失败时用的错误码判断：这些错误重放没意义，直接把归档标失败。
 *
 * **终态错误不能靠重试绕过。** 部署缺少某项能力（目前只有「没有可用 LLM」）时，
 * 正确的做法是在装配期把对应步骤登记进 `CommitPipelineOptions.skippedSteps`，
 * 让它根本不执行——`INVALID_ARGUMENT` 第一次就会把任务置 `failed`，归档永远停在
 * 上一步。
 *
 * ## 与 `domain/errors.ts` 的 `RETRYABLE_CODES` 的关系
 *
 * 两者**互补，不是重复**：本函数回答「同一步重放一次会不会成功」，`RETRYABLE_CODES`
 * 回答「一次模型调用再发一次会不会成功」。确定性失败（URI 非法、参数非法、身份 /
 * 权限、API Key 无效）进本函数；瞬态失败（限流 429、供应商 5xx、SQLite 写冲突）
 * 留给步骤层与任务层重试。
 *
 * **两边都不在的 code 会被当成可重试。** 这就是 `UNAUTHENTICATED` 曾经白重试的
 * 原因：一把错的 API Key 在模型调用层正确地不重试，到了步骤层却被当成瞬态失败，
 * 等满 `(stepAttempts + 1) × taskAttempts` 次超时（默认 2 × 3 = 6 次，每次上限
 * 120 秒，见 `config.example.yaml` 的 `providers.llm.default.timeoutSeconds`）。
 *
 * 新增错误码时两个集合都要判断，检查方法见 `errors.ts` 的 `RETRYABLE_CODES` 注释。
 * 不写成 `!isRetryable(code)` 推导：`INTERNAL` 在步骤级必须重试（未知异常兜底），
 * 却不在 `RETRYABLE_CODES` 里。
 */
export function isTerminalStepError(code: ComemErrorCode): boolean {
  return (
    code === 'INVALID_URI' ||
    code === 'INVALID_ARGUMENT' ||
    code === 'PERMISSION_DENIED' ||
    code === 'UNAUTHENTICATED' || code === 'BOOTSTRAP_CLOSED' || code === 'NOT_LOOPBACK' || code === 'INVALID_SETUP_TOKEN'
  );
}
