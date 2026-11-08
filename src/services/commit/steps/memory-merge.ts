/**
 * 提交管线第 3 步：补丁合并（架构文档 §11.2、§11.5）。
 *
 * 六条核心链路之一。输入是抽取产出的操作列表，输出是「每个记忆文件写一次」的最终
 * 结果，外加 `archive_NNN/memory_diff.json`。
 *
 * ## 为什么必须合并
 *
 * 一次提交可能产出 20 条操作，其中 5 条指向同一个记忆文件。不合并就是 5 次覆盖写，
 * 最后只剩最后一次。同 URI 的多条 patch **按输出顺序依次应用**——这是 SEARCH/REPLACE
 * 的天然语义：第 2 条的 SEARCH 在第 1 条应用后的正文上匹配。
 *
 * ## 三种冲突（§11.5）
 *
 * | 情况 | 处理 |
 * |---|---|
 * | 同批次既 upsert 又 delete | `suppressConflicts` 保留 upsert，delete 视为误判 |
 * | 同 URI 同时有 replace 和 patch | 按出现顺序应用（`applyOperations`） |
 * | SEARCH 命中多处 | 整条操作进 `skipped`，不做模糊匹配 |
 *
 * ## 失败边界
 *
 * 一个 URI 失败不影响同批次其它 URI：分组循环里逐组捕获？不——`skip` 由
 * `applyOperations` 逐条返回，写盘失败直接抛。写盘失败时 `memory_diff.json` 不写：
 * 它存在就代表「这批操作已经处理过」，先写会让重放跳过真正的写入。
 *
 * **补丁在锁内应用。** 这里不读正文快照：`applyOperations` 作为转换函数交给
 * `upsertMemory`，在 `exact(uri)` 锁内用磁盘上的最新字段执行（§18）。读在锁外时，
 * `task.concurrency: 4` 下同时归档的四个写者各带一份基于旧正文算出的 `content`，
 * 后写者覆盖先写者——`profile` 只有一个 `content` 字段，字段级合并保护不到它。
 * 并发补丁的语义是**串行化**：第 2 个补丁在第一个补丁写回后的正文上匹配。两条
 * 补丁改同一段时，后一条的 SEARCH 可能仍然命中（各取所需），也可能因为正文已被
 * 改掉而落空——落空按 `patch_not_found` 记进 `skippedOperations`，不做模糊匹配，
 * 也不回滚已应用的那条。
 *
 * **`ALREADY_EXISTS` 是唯一不抛的写盘失败。** `addOnly` 类型（`events`）的目标已
 * 存在时，`upsertMemory` 一定拒绝写入（§11.1「覆盖写等于篡改历史」），所以这不是
 * 瞬态失败：重放一次、重排队一次，结果都一样。把它抛出去等于让一条已存在的记录
 * 拖垮整批操作，再白等步骤级重试与任务级重排队，最后还是把归档标成 `failed`。这里
 * 改成记进 `skippedOperations`——归档照常完成，而「这条为什么没生效」留在
 * `memory_diff.json` 里，那是唯一的查证入口。
 *
 * 跳过分两种，`reasonCode` 不同：正文与已有记录**相同**是重放（`already_exists`，
 * 幂等），**不同**是同 URI 的另一条事件（`uri_conflict`，本次内容没有落盘）。
 * 后者的正解是换 `event` 标识，不是覆盖写。
 */

import type {
  MemoryDiff,
  MemoryDiffEntry,
  SkippedMemoryOperation,
} from '../../../domain/archive.js';
import { summarizeMemoryDiff } from '../../../domain/archive.js';
import { ComemError } from '../../../domain/errors.js';
import type { Logger } from '../../../domain/log.js';
import { getMemoryType } from '../../../domain/memory-types/index.js';
import type { MemoryTypeSchema } from '../../../domain/memory-type.js';
import type {
  BatchOperation,
  MergeOperation,
  OperationFailureReason,
} from '../../../domain/merge-op.js';
import { applyOperations, suppressConflicts } from '../../../domain/merge-op.js';
import { Uri } from '../../../domain/uri.js';

import type { MemoryWrite, MemoryWriteResult } from '../../memory.js';

import { CommitStep, type StepContext } from '../pipeline.js';
import { EXTRACT_RESULT_KEY, isMemoryExtractResult } from './memory-extract.js';

/** 跨步骤传递产物的键（`summary_invalidate` 消费）。 */
export const MERGE_RESULT_KEY = 'memory_merge.result';

/** 合并步骤的产物：真正写过的文件与被删掉的文件。 */
export interface MemoryMergeResult {
  readonly written: readonly Uri[];
  readonly deleted: readonly Uri[];
}

export interface MemoryMergeStepDeps {
  readonly memory: {
    upsertMemory(
      scopeUri: Uri,
      schema: MemoryTypeSchema,
      input: MemoryWrite,
    ): Promise<MemoryWriteResult>;
    remove(uri: Uri): Promise<void>;
  };
  /** 写/读 `archive_NNN/memory_diff.json`（保留名，必须按归档目录定位）。 */
  readonly archive: {
    writeMemoryDiff(archiveUri: Uri, diff: MemoryDiff): Promise<void>;
    /** 不存在返回 `null`（正常状态：这一步还没跑过）。 */
    readMemoryDiff(archiveUri: Uri): Promise<MemoryDiff | null>;
  };
  readonly logger: Logger;
}

/** 失败原因的中文说明，只用于 `skippedOperations[].reason`。 */
const FAILURE_LABELS: Readonly<Record<OperationFailureReason, string>> = {
  type_mismatch: '字段类型不匹配',
  patch_not_found: 'SEARCH 没有命中',
  patch_ambiguous: 'SEARCH 命中多处，不做模糊匹配',
  immutable_violation: 'immutable 字段已有值，不允许覆盖',
};

interface UriGroup {
  kind: 'upsert' | 'delete';
  readonly operations: MergeOperation[];
}

/**
 * 按 URI 分组，保持输出顺序。
 *
 * 分组键是 URI 字符串；组内保留字段级操作的相对顺序，组间保留首次出现顺序。顺序是
 * 语义的一部分（第 2 条 patch 依赖第 1 条的结果），不能用 `Map` 之外的排序。
 */
function groupByUri(operations: readonly BatchOperation[]): Map<string, UriGroup> {
  const groups = new Map<string, UriGroup>();

  for (const operation of operations) {
    const existing = groups.get(operation.uri);

    if (operation.kind === 'delete') {
      if (existing === undefined) {
        groups.set(operation.uri, { kind: 'delete', operations: [] });
      }
      continue;
    }

    if (existing === undefined) {
      groups.set(operation.uri, { kind: 'upsert', operations: [operation.operation] });
      continue;
    }
    existing.operations.push(operation.operation);
    if (existing.kind === 'delete') {
      // `suppressConflicts` 已经消掉「同批次 upsert + delete」，走到这里说明契约被
      // 绕过了。按 §11.5 第一种情况保留 upsert。
      existing.kind = 'upsert';
    }
  }

  return groups;
}

/** `state` 里的合并结果；`summary_invalidate` 用它做类型收窄，不用断言。 */
export function isMemoryMergeResult(value: unknown): value is MemoryMergeResult {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  if (!('written' in value) || !('deleted' in value)) {
    return false;
  }
  return Array.isArray(value.written) && Array.isArray(value.deleted);
}

/**
 * `memory_diff.json` → 合并结果（重放时 `summary_invalidate` 的输入）。
 *
 * `written` 是 adds + updates 的 URI——写 `memory_diff.json` 时用的就是
 * `write.uri`，两者同一个值；`deleted` 就是 `deletes`。摘要失效按父目录去重，
 * 集合顺序不影响结果。
 */
function mergeResultFromDiff(diff: MemoryDiff): MemoryMergeResult {
  return {
    written: [...diff.operations.adds, ...diff.operations.updates].map((entry) =>
      Uri.parse(entry.uri),
    ),
    deleted: diff.operations.deletes.map((uri) => Uri.parse(uri)),
  };
}

export class MemoryMergeStep extends CommitStep {
  readonly name = 'memory_merge' as const;

  readonly #memory: MemoryMergeStepDeps['memory'];
  readonly #archive: MemoryMergeStepDeps['archive'];
  readonly #logger: Logger;

  constructor(deps: MemoryMergeStepDeps) {
    super();
    this.#memory = deps.memory;
    this.#archive = deps.archive;
    this.#logger = deps.logger;
  }

  async run(context: StepContext): Promise<void> {
    const extracted = context.state.get(EXTRACT_RESULT_KEY);
    if (!isMemoryExtractResult(extracted)) {
      // 正常恢复路径是 `MemoryExtractStep.rehydrate`：它把盘上的
      // `memory_operations.json` 读回 `state`，所以能走到这里说明这一步排在
      // `memory_extract` 之前（步骤顺序被改过），或者抽取步骤被登记成跳过却仍有
      // 合并步骤要执行。两者都是装配错误，重试也没用。
      throw new ComemError('INVALID_ARGUMENT', '记忆合并步骤缺少抽取结果，提交管线顺序有误。', {
        archive: context.archiveUri.toString(),
      });
    }

    const groups = groupByUri(suppressConflicts(extracted.operations));

    const adds: MemoryDiffEntry[] = [];
    const updates: MemoryDiffEntry[] = [];
    const deletes: string[] = [];
    const skipped: SkippedMemoryOperation[] = [...extracted.skipped];
    const written: Uri[] = [];
    const removed: Uri[] = [];

    for (const [uriString, group] of groups) {
      const memoryType = extracted.memoryTypes.get(uriString) ?? 'unknown';
      const uri = Uri.parse(uriString);

      if (group.kind === 'delete') {
        await this.#memory.remove(uri);
        deletes.push(uriString);
        removed.push(uri);
        continue;
      }

      const schema = getMemoryType(memoryType);
      if (schema === undefined) {
        skipped.push({
          memoryType,
          reasonCode: 'unknown_memory_type',
          reason: `记忆类型 ${memoryType} 不存在，跳过 ${uriString}。`,
        });
        continue;
      }

      // 每个 URI 只写一次（§11.5）。补丁在 `upsertMemory` 的 `exact(uri)` 锁内
      // 应用：`current` 是磁盘上的最新字段，不是这里提前读到的快照。读在锁外时，
      // 两个并发归档各带一份基于旧正文算出的 `content`，后写者会覆盖先写者
      // （`profile` 只有一个 `content` 字段，字段级合并保护不到它）。
      let write: MemoryWriteResult;
      try {
        write = await this.#memory.upsertMemory(context.scopeUri, schema, {
          uri,
          update: (current) => {
            const result = applyOperations({ ...current }, group.operations);
            for (const failure of result.skipped) {
              skipped.push({
                memoryType,
                reasonCode: failure.reason,
                reason: `字段 ${failure.operation.field}：${FAILURE_LABELS[failure.reason]}。`,
              });
            }
            // 全部字段操作都失败：不落盘。写盘只会把正文原样覆盖一遍（还会白改
            // 一次 updated_at、把已复核的记忆打回 pending）。
            return result.applied === 0 ? null : result.value;
          },
        });
      } catch (error) {
        const failure = ComemError.from(error);
        if (failure.code !== 'ALREADY_EXISTS') {
          // 其它写盘失败是真正的故障：`memory_diff.json` 不写，重放才有意义。
          throw error;
        }

        // `addOnly` 类型的目标已存在。两个内容都在锁内读到：相同是重放
        // （幂等），不同是同 URI 的另一条事件（本次内容没有落盘）。
        const sameEvent =
          failure.details?.['existingContent'] === failure.details?.['nextContent'];
        const reasonCode = sameEvent ? 'already_exists' : 'uri_conflict';
        skipped.push({
          memoryType,
          reasonCode,
          reason: sameEvent
            ? `该 URI 已存在同一条事件，未重复写入：${uriString}（${memoryType} 类型只允许新增）。`
            : `该 URI 已存在内容不同的事件，本次内容未写入：${uriString}。事件不可修改，请换一个 event 标识再提交。`,
        });
        // 降级必须可见：归档会走完，用户不会收到任何错误。
        this.#logger.warn('记忆写入被跳过：目标已存在，记忆类型只允许新增', {
          archive: context.archiveUri.toString(),
          uri: uriString,
          memoryType,
          reasonCode,
        });
        continue;
      }
      if (!write.written) {
        continue;
      }
      const entry: MemoryDiffEntry = {
        uri: write.uri.toString(),
        memoryType,
        ...(write.before === null ? {} : { before: write.before }),
        after: write.after,
      };
      if (write.created) {
        adds.push(entry);
      } else {
        updates.push(entry);
      }
      written.push(write.uri);
    }

    const operations = { adds, updates, deletes };
    const diff: MemoryDiff = {
      archiveUri: context.archiveUri.toString(),
      extractedAt: new Date().toISOString(),
      operations,
      skippedOperations: skipped,
      summary: summarizeMemoryDiff({ operations, skippedOperations: skipped }),
    };

    // 写盘全部成功之后才写 `memory_diff.json`：它一旦存在就代表这批操作处理过，
    // 先写会让重放跳过真正的写入。
    await this.#archive.writeMemoryDiff(context.archiveUri, diff);
    context.state.set(MERGE_RESULT_KEY, { written, deleted: removed } satisfies MemoryMergeResult);

    this.#logger.info('记忆合并完成', {
      archive: context.archiveUri.toString(),
      ...diff.summary,
    });
  }

  /**
   * 重放：从 `memory_diff.json` 恢复「真正写过 / 删过哪些文件」。
   *
   * 这一步的产物（`written` / `deleted`）只存在 `state` 里。不恢复的话，重放时
   * `summary_invalidate` 读到空集合，记一条 debug 日志就返回：目录摘要永远不重算，
   * 而归档照样完成——**静默降级比失败更难发现**。
   */
  override async rehydrate(context: StepContext): Promise<void> {
    const diff = await this.#archive.readMemoryDiff(context.archiveUri);
    if (diff === null) {
      throw new ComemError(
        'INVALID_ARGUMENT',
        `归档元数据声称 memory_merge 已完成，但 memory_diff.json 不存在：${context.archiveUri.toString()}`,
        { archive: context.archiveUri.toString() },
      );
    }
    const merged = mergeResultFromDiff(diff);
    context.state.set(MERGE_RESULT_KEY, merged);
    this.#logger.debug('已从归档目录恢复合并结果', {
      archive: context.archiveUri.toString(),
      written: merged.written.length,
      deleted: merged.deleted.length,
    });
  }
}
