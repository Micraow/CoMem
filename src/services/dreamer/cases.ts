import type { ConsolidationOperation } from '../../domain/consolidation.js';
import type { LlmPrompt } from '../../domain/llm.js';
import { Uri } from '../../domain/uri.js';

import { pageContent } from '../commit/steps/memory-extract.js';
import type { MemoryRecord } from '../memory.js';

/**
 * 把本次任务相关的具体案例附加到经验归纳上下文。
 *
 * cases 提供事实边界与具体结果；经验模型只据此抽象同类做法，不能把单次参数或
 * 具体解题步骤复制成普遍经验。
 */
export function withCaseContext(
  prompt: LlmPrompt,
  cases: readonly MemoryRecord[],
): LlmPrompt {
  if (cases.length === 0) return prompt;
  const entries = cases.map((record) => [
    `### ${record.uri.toString()}`,
    `来源：${JSON.stringify(record.sources)}`,
    pageContent(record),
  ].join('\n'));
  return {
    ...prompt,
    messages: [
      ...prompt.messages,
      {
        role: 'user',
        content: [
          '## 相关具体案例',
          '下面是已保存的具体任务、尝试与结果，只作为提炼依据。单次参数、题解步骤和失败分支由 cases 保存；只有能覆盖同类适用条件时才归纳到 experiences。',
          ...entries,
        ].join('\n\n'),
      },
    ],
  };
}

/** 当前归档刚写入的案例与检索预取案例按 URI 去重，并逐条求读权限。 */
export async function relatedCasesForArchive(
  currentCases: readonly MemoryRecord[],
  prefetched: readonly MemoryRecord[],
  currentArchive: Uri,
  canUse: (uri: Uri) => Promise<boolean>,
): Promise<readonly MemoryRecord[]> {
  const records = new Map<string, MemoryRecord>();
  for (const record of currentCases) {
    if (record.sources.includes(currentArchive.toString())) {
      records.set(record.uri.toString(), record);
    }
  }
  for (const record of prefetched) records.set(record.uri.toString(), record);
  return (
    await Promise.all(
      [...records.values()].map(
        async (record) => await canUse(record.uri) ? [record] : [],
      ),
    )
  ).flat();
}

/**
 * cases 描述的是具体尝试与结果，模型更新或删除前必须看到正文。
 *
 * 其他类型的读前检查仍按整理提示词执行；这里把最容易丢失复现条件的 cases
 * 做成确定性守卫。add 不需要先读；update / delete 的目标必须在本轮 reads 中。
 */
export function unreadCaseMutations(
  scope: Uri,
  operations: readonly ConsolidationOperation[],
  reads: ReadonlyMap<string, string>,
): readonly string[] {
  const caseDirectory = scope.child('memories', 'cases');
  return operations.flatMap((operation) => {
    if (operation.kind === 'add') return [];
    const uri = Uri.tryParse(operation.uri);
    if (uri === null || !caseDirectory.isAncestorOf(uri) || reads.has(uri.toString())) {
      return [];
    }
    return [uri.toString()];
  });
}
