/**
 * 模型每一轮的输出：结构校验、归一化与意图摘要（架构文档 §11.8「循环」）。
 */

import { z } from 'zod';

import type { ConsolidationOperation } from '../../domain/consolidation.js';

/**
 * 模型每一轮的输出。
 *
 * `content` 用 `nullish` 而不是 `nullable`：`delete` 忘记写 `content: null` 是最
 * 常见的形状错误，为它让整轮解析失败、再重试一次毫无收益——归一化成 `null` 之后
 * `validateOperations` 会给出「content 不能为空」这种能定位的消息。
 */
export const consolidationOutputSchema = z.object({
  action: z.enum(['read', 'finish']),
  uris: z.array(z.string()).optional(),
  operations: z
    .array(
      z.object({
        kind: z.enum(['add', 'update', 'delete']),
        uri: z.string(),
        content: z.string().nullish(),
        reason: z.string(),
      }),
    )
    .optional(),
});

type ConsolidationOutput = z.infer<typeof consolidationOutputSchema>;

/** `operations` 缺省时是空列表（模型认为不需要改）。 */
export function normalizeOperations(output: ConsolidationOutput): readonly ConsolidationOperation[] {
  return (output.operations ?? []).map((operation) => ({
    kind: operation.kind,
    uri: operation.uri,
    content: operation.content ?? null,
    reason: operation.reason,
  }));
}

/** 一轮 `finish` 的意图摘要：计数 + 每条操作的理由。 */
export function describeOperations(operations: readonly ConsolidationOperation[]): string {
  if (operations.length === 0) {
    return '没有需要改的操作。';
  }

  const counts = new Map<ConsolidationOperation['kind'], number>();
  for (const operation of operations) {
    counts.set(operation.kind, (counts.get(operation.kind) ?? 0) + 1);
  }
  const summary = (['add', 'update', 'delete'] as const)
    .map((kind) => `${kind} ${counts.get(kind) ?? 0} 条`)
    .join('、');
  const reasons = operations
    .map((operation) => `${operation.kind} ${operation.uri}（${operation.reason}）`)
    .join('；');
  return `${summary}：${reasons}`;
}
