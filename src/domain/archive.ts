/**
 * 归档元数据与记忆差异（架构文档 §6.6、§10.1）。
 *
 * 这两个形状是**提交管线的契约**：阶段一（同步落盘）写它们，阶段二（后台任务）
 * 读它们并把进度写回去。放在领域层是因为两侧都要用，而它们本身是纯数据。
 */

import type { ComemErrorCode } from './errors.js';

/**
 * 归档的完成状态（§10.1 的 `phase1.status`）。
 *
 * `ready` 表示消息已经完整落到 `archive_NNN/messages.jsonl` 且 sha256 已校验。
 * 阶段二只在这个状态下开始。
 */
export type ArchivePhaseStatus = 'preparing' | 'ready' | 'failed';

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
 * 提交步骤名。
 *
 * 写成字面量联合而不是 `string`：`stepsDone` 是重放判据，一个拼写错误会让某一步
 * 被静默重放（记忆操作不幂等，重放会造出重复记忆）。
 */
export type CommitStepName =
  | 'archive_summary'
  | 'memory_extract'
  | 'memory_merge'
  | 'summary_invalidate';

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
 */
export function isTerminalStepError(code: ComemErrorCode): boolean {
  return code === 'INVALID_URI' || code === 'INVALID_ARGUMENT' || code === 'PERMISSION_DENIED';
}
