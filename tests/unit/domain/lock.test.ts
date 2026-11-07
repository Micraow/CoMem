import { describe, expect, it } from 'vitest';

import {
  acquireDecision,
  conflicts,
  createLockRecord,
  DEFAULT_LOCK_OPTIONS,
  isExpired,
  shouldRenew,
} from '../../../src/domain/lock.js';
import type { LockMode, LockRecord } from '../../../src/domain/lock.js';
import { Uri } from '../../../src/domain/uri.js';

const NOW = new Date('2026-11-08T00:00:00.000Z');
const A = 'comem://user/alice/a';
const A_B = `${A}/b`;
const B = 'comem://user/alice/b';

function makeRecord(mode: LockMode, path: string, now: Date = NOW): LockRecord {
  return createLockRecord('owner-1', mode, Uri.parse(path), now, DEFAULT_LOCK_OPTIONS);
}

interface LockCase {
  readonly label: string;
  readonly mode: LockMode;
  readonly path: string;
}

const CASES: readonly LockCase[] = [
  { label: 'EXACT(a)', mode: 'exact', path: A },
  { label: 'TREE(a)', mode: 'tree', path: A },
  { label: 'EXACT(a/b)', mode: 'exact', path: A_B },
  { label: 'TREE(a/b)', mode: 'tree', path: A_B },
  { label: 'EXACT(b)', mode: 'exact', path: B },
];

/**
 * 架构文档 §10.6 的表格，逐格照抄。
 * 行是已有锁，列是请求锁；`true` 表示冲突。
 */
const EXPECTED: readonly (readonly boolean[])[] = [
  // EXACT(a)  TREE(a)  EXACT(a/b)  TREE(a/b)  EXACT(b)
  [true, true, false, true, false],
  [true, true, true, true, false],
  [false, true, true, true, false],
  [true, true, true, true, false],
  [false, false, false, false, true],
];

describe('DEFAULT_LOCK_OPTIONS', () => {
  it('默认 30 秒租约、10 秒续租（§10.6）', () => {
    expect(DEFAULT_LOCK_OPTIONS).toEqual({ leaseSeconds: 30, renewSeconds: 10 });
  });
});

describe('createLockRecord', () => {
  it('expiresAt 是 now + 租约，renewedAt 是 now，uri 是规范化字符串', () => {
    const record = createLockRecord(
      'owner-1',
      'tree',
      Uri.parse('comem://user/alice/a/'),
      NOW,
      { leaseSeconds: 30, renewSeconds: 10 },
    );

    expect(record).toEqual({
      owner: 'owner-1',
      mode: 'tree',
      uri: A,
      expiresAt: '2026-11-08T00:00:30.000Z',
      renewedAt: '2026-11-08T00:00:00.000Z',
    });
  });
});

describe('conflicts 的 5×5 矩阵', () => {
  for (const [rowIndex, row] of CASES.entries()) {
    for (const [columnIndex, column] of CASES.entries()) {
      const expected = EXPECTED[rowIndex]?.[columnIndex];
      it(`已有 ${row.label} / 请求 ${column.label} → ${expected === true ? '冲突' : '不冲突'}`, () => {
        const left = makeRecord(row.mode, row.path);
        const right = makeRecord(column.mode, column.path);

        expect(conflicts(left, right)).toBe(expected);
        // 矩阵对称：谁先拿不影响互斥判定。
        expect(conflicts(right, left)).toBe(expected);
      });
    }
  }

  it('祖先判断用段边界，不用字符串前缀', () => {
    const tree = makeRecord('tree', 'comem://user/alice/foo');
    const longer = makeRecord('exact', 'comem://user/alice/foobar');

    expect(conflicts(tree, longer)).toBe(false);
  });

  it('不同根的相同路径不冲突', () => {
    const alice = makeRecord('tree', 'comem://user/alice/a');
    const bob = makeRecord('exact', 'comem://user/bob/a');

    expect(conflicts(alice, bob)).toBe(false);
  });

  it('无法解析的 uri 按冲突处理', () => {
    const broken: LockRecord = {
      owner: 'owner-1',
      mode: 'exact',
      uri: 'not-a-uri',
      expiresAt: NOW.toISOString(),
      renewedAt: NOW.toISOString(),
    };

    expect(conflicts(broken, makeRecord('exact', A))).toBe(true);
    expect(conflicts(makeRecord('exact', A), broken)).toBe(true);
  });
});

describe('isExpired', () => {
  const record = makeRecord('exact', A);

  it('到期前未过期', () => {
    expect(isExpired(record, new Date('2026-11-08T00:00:29.999Z'))).toBe(false);
  });

  it('到期时刻即过期', () => {
    expect(isExpired(record, new Date('2026-11-08T00:00:30.000Z'))).toBe(true);
  });

  it('到期后过期', () => {
    expect(isExpired(record, new Date('2026-11-08T00:01:00.000Z'))).toBe(true);
  });
});

describe('acquireDecision', () => {
  const record = makeRecord('exact', A);

  it('没有现有锁 → acquire', () => {
    expect(acquireDecision(undefined, NOW)).toBe('acquire');
  });

  it('现有锁已过期 → steal', () => {
    expect(acquireDecision(record, new Date('2026-11-08T00:00:30.000Z'))).toBe('steal');
  });

  it('现有锁还在租期内 → wait', () => {
    expect(acquireDecision(record, new Date('2026-11-08T00:00:29.999Z'))).toBe('wait');
  });
});

describe('shouldRenew', () => {
  const options = { leaseSeconds: 30, renewSeconds: 10 };
  const record = makeRecord('exact', A);

  it('剩余 20 秒 > 续租窗口 10 秒 → 不续租', () => {
    expect(shouldRenew(record, new Date('2026-11-08T00:00:10.000Z'), options)).toBe(false);
  });

  it('剩余恰好 10 秒 → 续租', () => {
    expect(shouldRenew(record, new Date('2026-11-08T00:00:20.000Z'), options)).toBe(true);
  });

  it('剩余 9 秒 → 续租', () => {
    expect(shouldRenew(record, new Date('2026-11-08T00:00:21.000Z'), options)).toBe(true);
  });

  it('已过期 → 仍然应该续租', () => {
    expect(shouldRenew(record, new Date('2026-11-08T00:01:00.000Z'), options)).toBe(true);
  });
});
