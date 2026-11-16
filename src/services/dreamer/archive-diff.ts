import type { MemoryDiff, MemoryDiffEntry } from '../../domain/archive.js';
import { summarizeMemoryDiff } from '../../domain/archive.js';
import { ComemError } from '../../domain/errors.js';
import type { Uri } from '../../domain/uri.js';

import type { MemoryWriteResult } from '../memory.js';

/**
 * `archive_NNN/memory_diff.json` 的读改写端口。
 *
 * 与 `MemoryMergeStepDeps.archive` 同形：两处都只做「读回来、追加、整份写回」，用
 * 同一个形状保证写出的 `MemoryDiff` 只有一种。
 */
export interface DreamerDiffArchive {
  writeMemoryDiff(archiveUri: Uri, diff: MemoryDiff): Promise<void>;
  /** 不存在返回 `null`（正常状态：`memory_merge` 还没跑过）。 */
  readMemoryDiff(archiveUri: Uri): Promise<MemoryDiff | null>;
}

/**
 * 一次经验写入 → 清单条目。
 *
 * 形状与 `MemoryMergeStep` 写出的条目一致：`before` 只在更新时存在，`after` 是刚写下
 * 的整段正文。转换函数返回 `null` 时没有落盘，调用方不应调用它——清单只记真写过的。
 */
export function dreamerDiffEntry(write: MemoryWriteResult): MemoryDiffEntry {
  return {
    uri: write.uri.toString(),
    memoryType: write.memoryType,
    ...(write.before === null ? {} : { before: write.before }),
    after: write.after,
  };
}

/**
 * 把这次归纳写出的记忆追加进归档清单。
 *
 * 空列表不写盘：没有归纳结果时清单保持 `memory_merge` 写下的样子。
 *
 * 清单不存在是装配错误——`dreamer` 排在 `memory_merge` 之后，后者无论有
 * 没有操作都会写这份文件（`memory_merge` 被跳过时这一步也被跳过）。抛出去而不是编
 * 一份只有经验的清单：后者会把抽取结果从报告里悄悄抹掉。
 */
export async function appendDreamerDiff(
  archive: DreamerDiffArchive,
  archiveUri: Uri,
  written: readonly MemoryDiffEntry[],
): Promise<void> {
  if (written.length === 0) {
    return;
  }

  const current = await archive.readMemoryDiff(archiveUri);
  if (current === null) {
    throw new ComemError(
      'INVALID_ARGUMENT',
      `Dreamer 找不到 memory_diff.json：memory_merge 的产物缺失（${archiveUri.toString()}）。`,
      { archive: archiveUri.toString() },
    );
  }

  // 清单里已有同 URI 的条目（重放时上一轮写过的）先剔掉再追加：一个 URI 只出现一次。
  const rewritten = new Set(written.map((entry) => entry.uri));
  const added = written.filter((entry) => entry.before === undefined);
  const updated = written.filter((entry) => entry.before !== undefined);
  const operations = {
    adds: [...current.operations.adds.filter((entry) => !rewritten.has(entry.uri)), ...added],
    updates: [...current.operations.updates.filter((entry) => !rewritten.has(entry.uri)), ...updated],
    deletes: current.operations.deletes,
  };

  await archive.writeMemoryDiff(archiveUri, {
    archiveUri: current.archiveUri,
    extractedAt: current.extractedAt,
    operations,
    skippedOperations: current.skippedOperations,
    summary: summarizeMemoryDiff({ operations, skippedOperations: current.skippedOperations }),
  });
}
