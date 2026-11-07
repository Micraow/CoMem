import { describe, expect, it } from 'vitest';

import {
  applyOperation,
  applyOperations,
  suppressConflicts,
} from '../../../src/domain/merge-op.js';
import type {
  BatchOperation,
  MergeOperation,
} from '../../../src/domain/merge-op.js';

function replace(field: string, value: unknown): MergeOperation {
  return { kind: 'replace', field, value };
}

function sum(field: string, delta: number): MergeOperation {
  return { kind: 'sum', field, delta };
}

function immutable(field: string, value: unknown): MergeOperation {
  return { kind: 'immutable', field, value };
}

function patchOp(field: string, search: string, replacement: string): MergeOperation {
  return { kind: 'patch', field, blocks: [{ search, replace: replacement }] };
}

const URI_A = 'comem://user/alice/memories/preferences/code-style';
const URI_B = 'comem://user/alice/memories/profile';

describe('applyOperation', () => {
  it('patch 替换 string 字段', () => {
    const current = { content: 'hello world' };

    expect(
      applyOperation(current, { kind: 'patch', field: 'content', blocks: [{ search: 'world', replace: 'there' }] }),
    ).toEqual({ ok: true, value: { content: 'hello there' } });
    expect(current).toEqual({ content: 'hello world' });
  });

  it('patch 字段不存在时按空字符串处理', () => {
    expect(
      applyOperation({}, { kind: 'patch', field: 'content', blocks: [{ search: '', replace: 'new' }] }),
    ).toEqual({ ok: true, value: { content: 'new' } });
  });

  it('patch 字段不存在且 SEARCH 非空时 not_found', () => {
    expect(
      applyOperation({}, { kind: 'patch', field: 'content', blocks: [{ search: 'old', replace: 'new' }] }),
    ).toEqual({
      ok: false,
      reason: 'patch_not_found',
      field: 'content',
      blockIndex: 0,
      matches: 0,
    });
  });

  it('patch 目标不是 string 时 type_mismatch', () => {
    expect(
      applyOperation({ content: 42 }, { kind: 'patch', field: 'content', blocks: [] }),
    ).toEqual({
      ok: false,
      reason: 'type_mismatch',
      field: 'content',
      expected: 'string',
      actual: 'number',
    });
  });

  it('patch 多处命中时 patch_ambiguous', () => {
    expect(
      applyOperation({ content: 'aaa' }, { kind: 'patch', field: 'content', blocks: [{ search: 'aa', replace: 'b' }] }),
    ).toEqual({
      ok: false,
      reason: 'patch_ambiguous',
      field: 'content',
      blockIndex: 0,
      matches: 2,
    });
  });

  it('replace 支持任意类型', () => {
    for (const value of [1, 'text', true, null, { nested: true }, [1, 2]]) {
      expect(applyOperation({}, replace('content', value))).toEqual({
        ok: true,
        value: { content: value },
      });
    }
  });

  it('sum 对已有 number 字段累加', () => {
    expect(applyOperation({ count: 5 }, sum('count', 3))).toEqual({
      ok: true,
      value: { count: 8 },
    });
  });

  it('sum 对缺失字段按 0 处理', () => {
    expect(applyOperation({}, sum('count', 3))).toEqual({ ok: true, value: { count: 3 } });
  });

  it('sum 支持负数增量', () => {
    expect(applyOperation({ count: 5 }, sum('count', -2))).toEqual({
      ok: true,
      value: { count: 3 },
    });
  });

  it('sum 目标不是 number 时 type_mismatch', () => {
    expect(applyOperation({ count: '5' }, sum('count', 1))).toEqual({
      ok: false,
      reason: 'type_mismatch',
      field: 'count',
      expected: 'number',
      actual: 'string',
    });
  });

  it('immutable 首次写入成功', () => {
    expect(applyOperation({}, immutable('createdAt', '2026-11-08'))).toEqual({
      ok: true,
      value: { createdAt: '2026-11-08' },
    });
  });

  it('immutable 第二次写入失败', () => {
    expect(applyOperation({ createdAt: '2026-11-08' }, immutable('createdAt', '2026-11-09'))).toEqual({
      ok: false,
      reason: 'immutable_violation',
      field: 'createdAt',
    });
  });

  it('immutable 把空字符串视为未写入', () => {
    expect(applyOperation({ createdAt: '' }, immutable('createdAt', '2026-11-09'))).toEqual({
      ok: true,
      value: { createdAt: '2026-11-09' },
    });
  });

  it('immutable 把 null / undefined 视为未写入', () => {
    expect(applyOperation({ createdAt: null }, immutable('createdAt', '2026-11-09'))).toEqual({
      ok: true,
      value: { createdAt: '2026-11-09' },
    });
  });

  it('immutable 把 0 / false / 空数组视为已有值', () => {
    for (const existing of [0, false, []]) {
      expect(applyOperation({ value: existing }, immutable('value', 'next'))).toEqual({
        ok: false,
        reason: 'immutable_violation',
        field: 'value',
      });
    }
  });

  it('不修改传入对象', () => {
    const current = { content: 'old', count: 1 };

    applyOperation(current, replace('content', 'new'));
    applyOperation(current, sum('count', 2));

    expect(current).toEqual({ content: 'old', count: 1 });
  });
});

describe('applyOperations', () => {
  it('按顺序应用，后面的操作看到前面的结果', () => {
    expect(
      applyOperations({ content: 'abc' }, [
        patchOp('content', 'ab', 'x'),
        patchOp('content', 'xc', 'y'),
      ]),
    ).toEqual({ value: { content: 'y' }, applied: 2, skipped: [] });
  });

  it('replace 与 patch 按出现顺序应用（replace 在前）', () => {
    expect(
      applyOperations({ content: 'old' }, [replace('content', 'hello'), patchOp('content', 'hello', 'bye')]),
    ).toEqual({ value: { content: 'bye' }, applied: 2, skipped: [] });
  });

  it('replace 与 patch 按出现顺序应用（patch 在前）', () => {
    expect(
      applyOperations({ content: 'hello' }, [patchOp('content', 'hello', 'bye'), replace('content', 'later')]),
    ).toEqual({ value: { content: 'later' }, applied: 2, skipped: [] });
  });

  it('失败的操作被跳过，后续操作继续', () => {
    const failing = sum('content', 1);
    const result = applyOperations({ content: 'text' }, [failing, replace('content', 'ok')]);

    expect(result).toEqual({
      value: { content: 'ok' },
      applied: 1,
      skipped: [{ operation: failing, reason: 'type_mismatch' }],
    });
    expect(result.applied + result.skipped.length).toBe(2);
  });

  it('immutable 第二次写入进入 skipped', () => {
    const first = immutable('createdAt', '2026-11-08');
    const second = immutable('createdAt', '2026-11-09');

    expect(applyOperations({}, [first, second])).toEqual({
      value: { createdAt: '2026-11-08' },
      applied: 1,
      skipped: [{ operation: second, reason: 'immutable_violation' }],
    });
  });

  it('空操作返回当前值的副本', () => {
    const current = { content: 'old' };
    const result = applyOperations(current, []);

    expect(result).toEqual({ value: { content: 'old' }, applied: 0, skipped: [] });
    expect(result.value).not.toBe(current);
  });

  it('不修改传入对象', () => {
    const current = { content: 'old' };

    applyOperations(current, [replace('content', 'new')]);

    expect(current).toEqual({ content: 'old' });
  });
});

describe('suppressConflicts', () => {
  it('同一 URI 的 upsert 与 delete 冲突时保留 upsert', () => {
    const upsert: BatchOperation = { kind: 'upsert', uri: URI_A, operation: replace('content', 1) };
    const remove: BatchOperation = { kind: 'delete', uri: URI_A };

    expect(suppressConflicts([remove, upsert])).toEqual([upsert]);
  });

  it('没有 upsert 的 delete 保留', () => {
    const remove: BatchOperation = { kind: 'delete', uri: URI_A };

    expect(suppressConflicts([remove])).toEqual([remove]);
  });

  it('同一 URI 的多个 upsert 保持顺序，delete 全部丢弃', () => {
    const first: BatchOperation = { kind: 'upsert', uri: URI_A, operation: replace('content', 1) };
    const second: BatchOperation = { kind: 'upsert', uri: URI_A, operation: replace('content', 2) };
    const remove: BatchOperation = { kind: 'delete', uri: URI_A };

    expect(suppressConflicts([first, remove, second, remove])).toEqual([first, second]);
  });

  it('不同 URI 的 delete 不受影响', () => {
    const upsertA: BatchOperation = { kind: 'upsert', uri: URI_A, operation: replace('content', 1) };
    const removeB: BatchOperation = { kind: 'delete', uri: URI_B };

    expect(suppressConflicts([upsertA, removeB])).toEqual([upsertA, removeB]);
  });

  it('同一 URI 同字段的 replace 与 patch 都保留且不重排', () => {
    const replaceOperation: BatchOperation = {
      kind: 'upsert',
      uri: URI_A,
      operation: replace('content', 'x'),
    };
    const patchOperation: BatchOperation = {
      kind: 'upsert',
      uri: URI_A,
      operation: patchOp('content', 'x', 'y'),
    };

    expect(suppressConflicts([replaceOperation, patchOperation])).toEqual([
      replaceOperation,
      patchOperation,
    ]);
  });

  it('不修改传入数组', () => {
    const upsert: BatchOperation = { kind: 'upsert', uri: URI_A, operation: replace('content', 1) };
    const remove: BatchOperation = { kind: 'delete', uri: URI_A };
    const operations = [remove, upsert];

    suppressConflicts(operations);

    expect(operations).toEqual([remove, upsert]);
  });

  it('空批次返回空数组', () => {
    expect(suppressConflicts([])).toEqual([]);
  });
});
