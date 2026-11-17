/**
 * 记忆合并的 URI 分组。
 *
 * 分组键是 URI 字符串；组内保留字段级操作的相对顺序，组间保留首次出现顺序。
 * 顺序是语义的一部分：第 2 条 patch 依赖第 1 条 patch 的结果。
 */

import type { BatchOperation, MergeOperation } from '../../../domain/merge-op.js';

interface UriGroup {
  kind: 'upsert' | 'delete';
  readonly operations: MergeOperation[];
}

export function groupByUri(operations: readonly BatchOperation[]): Map<string, UriGroup> {
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
      // `suppressConflicts` 已经消掉 upsert + delete；按 §11.5 仍保留 upsert。
      existing.kind = 'upsert';
    }
  }

  return groups;
}
