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

import type { MemoryRecord, MemoryWriteResult } from '../../memory.js';

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
    read(uri: Uri): Promise<MemoryRecord | null>;
    upsertMemory(
      scopeUri: Uri,
      schema: MemoryTypeSchema,
      values: Readonly<Record<string, unknown>>,
    ): Promise<MemoryWriteResult>;
    remove(uri: Uri): Promise<void>;
  };
  /** 写 `archive_NNN/memory_diff.json`（保留名，必须按归档目录定位）。 */
  readonly archive: {
    writeMemoryDiff(archiveUri: Uri, diff: MemoryDiff): Promise<void>;
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
      // 缺产物是装配错误（步骤顺序被改过），不是模型的问题，重试也没用。
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

      const existing = await this.#memory.read(uri);
      const result = applyOperations({ ...(existing?.fields ?? {}) }, group.operations);
      for (const failure of result.skipped) {
        skipped.push({
          memoryType,
          reasonCode: failure.reason,
          reason: `字段 ${failure.operation.field}：${FAILURE_LABELS[failure.reason]}。`,
        });
      }
      if (result.applied === 0) {
        // 全部字段操作都失败：写盘只会把正文原样覆盖一遍（还会白改一次 updated_at）。
        continue;
      }

      // 每个 URI 只写一次（§11.5）。
      const write = await this.#memory.upsertMemory(context.scopeUri, schema, result.value);
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
}
