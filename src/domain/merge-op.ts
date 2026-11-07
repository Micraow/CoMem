/**
 * 记忆字段的合并操作（架构文档 §11.2、§11.5）。
 *
 * 一次提交产出的操作是「URI + 字段 + 策略」：`patch` 走 SEARCH/REPLACE 块，
 * `replace` 整体替换，`sum` 数值累加，`immutable` 只允许首次写入。
 *
 * 三类冲突的归属在这里切清楚：
 *
 * - **upsert / delete 同 URI**：由 `suppressConflicts` 处理。同一批次里既 upsert
 *   又 delete 同一个 URI 时保留 upsert，delete 视为误判（§11.5）。批次操作带 URI，
 *   upsert 内部再携带字段级操作。
 * - **replace + patch 同 URI 同字段**：`suppressConflicts` 不重排、不去重，两条都
 *   保留；`applyOperations` 按它们在输出里的出现顺序依次应用（§11.5）。
 * - **SEARCH 命中多处**：由 `applyOperations` 处理。整条操作失败并记入
 *   `skippedOperations`，不做模糊匹配（§11.5）。
 */

import { applyPatch } from './patch.js';
import type { PatchBlock } from './patch.js';

/**
 * 字段级合并策略（§11.2）。
 *
 * 定义放在这里而不是 `memory-type.ts`：四个名字就是四种操作，跟 `MergeOperation`
 * 的判别标签是同一个集合，放一起才不会漂。`memory-type.ts` 只做 `import type`。
 */
export type MergeStrategy = 'patch' | 'replace' | 'sum' | 'immutable';

export type MergeOperation =
  | { readonly kind: 'patch'; readonly field: string; readonly blocks: readonly PatchBlock[] }
  | { readonly kind: 'replace'; readonly field: string; readonly value: unknown }
  | { readonly kind: 'sum'; readonly field: string; readonly delta: number }
  | { readonly kind: 'immutable'; readonly field: string; readonly value: unknown };

export type OperationFailureReason =
  | 'type_mismatch'
  | 'patch_not_found'
  | 'patch_ambiguous'
  | 'immutable_violation';

/**
 * 单条操作失败的结构化原因。`reason` 是判别字段；其余字段只在对应分支存在。
 *
 * - `type_mismatch`：`patch` 目标不是 string，或 `sum` 目标不是 number。
 * - `patch_not_found` / `patch_ambiguous`：SEARCH 零命中 / 多处命中，带块下标与命中数。
 * - `immutable_violation`：字段已有值，`immutable` 不允许覆盖。
 */
export type OperationFailure =
  | {
      readonly ok: false;
      readonly reason: 'type_mismatch';
      readonly field: string;
      readonly expected: 'string' | 'number';
      readonly actual: string;
    }
  | {
      readonly ok: false;
      readonly reason: 'patch_not_found' | 'patch_ambiguous';
      readonly field: string;
      readonly blockIndex: number;
      readonly matches: number;
    }
  | {
      readonly ok: false;
      readonly reason: 'immutable_violation';
      readonly field: string;
    };

export type OperationResult =
  | { readonly ok: true; readonly value: Record<string, unknown> }
  | OperationFailure;

export interface SkippedOperation {
  readonly operation: MergeOperation;
  readonly reason: OperationFailureReason;
}

export interface BatchResult {
  readonly value: Record<string, unknown>;
  readonly applied: number;
  readonly skipped: readonly SkippedOperation[];
}

/**
 * 提交批次里的一条操作。
 *
 * `uri` 是记忆文件地址；`upsert` 携带该文件上的字段级操作，`delete` 表示删除整个
 * 文件（没有字段级操作）。冲突抑制按 URI 判断 upsert/delete，按 `(uri, field)` 保留
 * replace/patch 的先后。
 */
export type BatchOperation =
  | {
      readonly kind: 'upsert';
      readonly uri: string;
      readonly operation: MergeOperation;
    }
  | {
      readonly kind: 'delete';
      readonly uri: string;
    };

/**
 * 字段是否「空」。
 *
 * 只把 `undefined`、`null`、空字符串视为未写入；`0`、`false`、空数组都是已有值，
 * 再写 `immutable` 字段就算违规。否则「第一次写入 0，第二次写 1」会被误判成首次
 * 写入，静默覆盖掉真实值。
 */
function isUnset(value: unknown): boolean {
  return value === undefined || value === null || value === '';
}

/**
 * 应用一条字段级操作，返回新对象。
 *
 * `current` 不会被修改。`patch` 只作用于 string 字段，字段缺失时按空字符串处理；
 * `sum` 只作用于 number 字段，字段缺失时按 0 处理；`immutable` 已有值时失败。
 */
export function applyOperation(
  current: Record<string, unknown>,
  operation: MergeOperation,
): OperationResult {
  switch (operation.kind) {
    case 'patch': {
      const existing = current[operation.field];
      if (existing !== undefined && typeof existing !== 'string') {
        return {
          ok: false,
          reason: 'type_mismatch',
          field: operation.field,
          expected: 'string',
          actual: typeof existing,
        };
      }

      const result = applyPatch(existing ?? '', operation.blocks);
      if (!result.ok) {
        return {
          ok: false,
          reason: result.reason === 'not_found' ? 'patch_not_found' : 'patch_ambiguous',
          field: operation.field,
          blockIndex: result.blockIndex,
          matches: result.matches,
        };
      }

      return { ok: true, value: { ...current, [operation.field]: result.content } };
    }

    case 'replace':
      return { ok: true, value: { ...current, [operation.field]: operation.value } };

    case 'sum': {
      const existing = current[operation.field];
      const base = existing === undefined ? 0 : existing;
      if (typeof base !== 'number') {
        return {
          ok: false,
          reason: 'type_mismatch',
          field: operation.field,
          expected: 'number',
          actual: typeof base,
        };
      }
      // `NaN` / `Infinity` 的类型也是 number，但它们一旦写进记忆就再也读不出来
      // （JSON 序列化成 null），所以按类型不匹配拒绝。
      if (!Number.isFinite(base) || !Number.isFinite(operation.delta)) {
        return {
          ok: false,
          reason: 'type_mismatch',
          field: operation.field,
          expected: 'number',
          actual: String(base + operation.delta),
        };
      }

      return { ok: true, value: { ...current, [operation.field]: base + operation.delta } };
    }

    case 'immutable': {
      const existing = current[operation.field];
      if (!isUnset(existing)) {
        return { ok: false, reason: 'immutable_violation', field: operation.field };
      }

      return { ok: true, value: { ...current, [operation.field]: operation.value } };
    }
  }
}

/**
 * 按顺序应用一批字段级操作。
 *
 * 失败的操作被跳过（记入 `skipped`），后续操作继续在最后一次成功的值上应用。
 * 因此 `applied + skipped.length === operations.length`，且 `value` 不含失败操作的
 * 部分结果。
 */
export function applyOperations(
  current: Record<string, unknown>,
  operations: readonly MergeOperation[],
): BatchResult {
  let value: Record<string, unknown> = { ...current };
  let applied = 0;
  const skipped: SkippedOperation[] = [];

  for (const operation of operations) {
    const result = applyOperation(value, operation);
    if (result.ok) {
      value = result.value;
      applied += 1;
      continue;
    }

    skipped.push({ operation, reason: result.reason });
  }

  return { value, applied, skipped };
}

/**
 * 抑制文件级冲突（§11.5 第一种情况）。
 *
 * 同一 URI 既有 upsert 又有 delete 时保留 upsert，丢弃该 URI 的 delete——delete
 * 视为模型误判。其余操作保持原顺序，不重排：同 URI 的 replace 与 patch 谁先谁后
 * 由输出顺序决定，交给 `applyOperations` 顺序应用。
 *
 * SEARCH 多命中不在这里处理：那是字段级操作的应用结果，属于 `applyOperations`。
 */
export function suppressConflicts(operations: readonly BatchOperation[]): BatchOperation[] {
  const upsertedUris = new Set(
    operations
      .filter((operation) => operation.kind === 'upsert')
      .map((operation) => operation.uri),
  );

  return operations.filter(
    (operation) => operation.kind !== 'delete' || !upsertedUris.has(operation.uri),
  );
}
