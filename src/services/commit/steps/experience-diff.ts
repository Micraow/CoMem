/**
 * 经验归纳的归档清单写入（架构文档 §6.6 的 `memory_diff.json`、§11.6 复核闸门）。
 *
 * 经验归纳的产物不只是磁盘上的记忆文件：每写一条经验，都要把「这次归档产出了哪些
 * 记忆」追加进 `archive_NNN/memory_diff.json`。这份清单是报告统计待复核条数、删除
 * 会话前做安全检查的唯一出口（`commands/ingest.ts` 的 `ExtractionRunnerImpl`、
 * `bootstrap/scheduler/session-expiry.ts`）。只写文件不写清单时，一条 `pending`
 * 的经验在报告里是 0 条、在删除检查里也不存在——**用户以为什么都没抽出来，文件却躺
 * 在 `memories/experiences/` 里**。
 *
 * ## 读取后追加，不覆盖
 *
 * 清单由 `memory_merge` 先写（抽取与合并的结果）。整份覆盖会让报告少算抽取结果、
 * 让删除检查看不见那些记忆；按 URI 去重后追加，清单始终是「这条归档写过的全部记忆」。
 *
 * 清单记录的是**归档**写过的记忆，不是**某一步**写过的记忆：消费方要回答的问题都是
 * 前者（报告统计、摘要失效、删除前检查）。重放时 `memory_merge` 从同一份清单恢复
 * 写入集合，因此它看到的是整条流水线写过的记忆——比只含合并结果更接近它的用途。
 * 代价是经验目录的摘要会多失效一次：新写入的经验同样让目录摘要落后，重算一次不影响
 * 结果。
 *
 * ## 布局为什么单独一个文件
 *
 * `experience_distill.ts` 已经贴着 250 行的形状上限。清单的读改写与归纳本身是两件
 * 事（一个只碰归档产物、一个只碰记忆文件与模型），拆开后两边都能独立读。
 */

import type { MemoryDiff, MemoryDiffEntry } from '../../../domain/archive.js';
import { summarizeMemoryDiff } from '../../../domain/archive.js';
import { ComemError } from '../../../domain/errors.js';
import type { Uri } from '../../../domain/uri.js';

import type { MemoryWriteResult } from '../../memory.js';

/**
 * `archive_NNN/memory_diff.json` 的读改写端口。
 *
 * 与 `MemoryMergeStepDeps.archive` 同形：两处都只做「读回来、追加、整份写回」，用
 * 同一个形状保证写出的 `MemoryDiff` 只有一种。
 */
export interface ExperienceDiffArchive {
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
export function experienceDiffEntry(write: MemoryWriteResult): MemoryDiffEntry {
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
 * 清单不存在是装配错误——`experience_distill` 排在 `memory_merge` 之后，后者无论有
 * 没有操作都会写这份文件（`memory_merge` 被跳过时这一步也被跳过）。抛出去而不是编
 * 一份只有经验的清单：后者会把抽取结果从报告里悄悄抹掉。
 */
export async function appendExperienceDiff(
  archive: ExperienceDiffArchive,
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
      `经验归纳找不到 memory_diff.json：memory_merge 的产物缺失（${archiveUri.toString()}）。`,
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
