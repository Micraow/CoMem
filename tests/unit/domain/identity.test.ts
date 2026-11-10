import { describe, expect, it } from 'vitest';

import { RESERVED_NAMES } from '../../../src/adapters/fs/path.js';
import { ComemError } from '../../../src/domain/errors.js';
import {
  assertValidGroupId,
  assertValidUserId,
  buildIdentity,
  GROUP_ID_PATTERN,
  isReservedIdentifier,
  USER_ID_PATTERN,
} from '../../../src/domain/identity.js';
import { VERSION_DIRECTORY } from '../../../src/domain/node.js';
import { RESERVED_SEGMENT_NAMES, Uri } from '../../../src/domain/uri.js';

function expectInvalidArgument(run: () => unknown): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ComemError);
    expect((error as ComemError).code).toBe('INVALID_ARGUMENT');
    return;
  }
  throw new Error('期望抛出 ComemError');
}

describe('assertValidUserId', () => {
  it('接受小写字母开头的 ID 并原样返回', () => {
    for (const id of ['alice', 'a', 'alice-1_2.3', 'u2']) {
      expect(assertValidUserId(id)).toBe(id);
    }
  });

  it('拒绝大写开头与任何大写字母', () => {
    // 小写是硬约束：URI 大小写敏感，`Alice` 与 `alice` 会变成两个权限根。
    for (const id of ['Alice', 'aliceSmith', 'ALICE']) {
      expectInvalidArgument(() => assertValidUserId(id));
    }
  });

  it('拒绝空白、冒号与其它非法字符', () => {
    for (const id of ['alice smith', 'user:alice', '', ' ', 'alice/smith', '-alice', 'alice@example.com']) {
      expectInvalidArgument(() => assertValidUserId(id));
    }
  });

  it('拒绝数据根下的内部目录名', () => {
    for (const id of ['_meta', 'attachments', '.', '..']) {
      expectInvalidArgument(() => assertValidUserId(id));
    }
  });

  it('与 adapters/fs/path.ts 的 RESERVED_NAMES 保持一致', () => {
    // 两处清单必须同时拒绝同一个名字（domain 不能 import adapters，靠断言兜底）。
    for (const name of RESERVED_NAMES) {
      expect(isReservedIdentifier(name)).toBe(true);
      expectInvalidArgument(() => assertValidUserId(name));
    }
  });

  it('比段保留名多一个 .history：URI 段放行，用户标识拒绝', () => {
    // 三份清单的关系是「同一份段保留名 + 一个差集」，不是三份同义清单：
    // `.history` 必须是合法 URI 段（系统写版本快照要用 `Uri#child`），
    // 但不能由用户选（会拼出落点在版本目录里的「合法」记忆）。
    expect(RESERVED_SEGMENT_NAMES.has(VERSION_DIRECTORY)).toBe(false);
    for (const name of RESERVED_SEGMENT_NAMES) {
      expect(RESERVED_NAMES.has(name)).toBe(true);
    }
    expect(isReservedIdentifier(VERSION_DIRECTORY)).toBe(true);
    expectInvalidArgument(() => assertValidUserId(VERSION_DIRECTORY));
    expect(
      Uri.tryParse('comem://user/alice/memories/rules/.history/xxx.md'),
    ).not.toBeNull();
  });

  it('64 个字符通过，65 个字符拒绝', () => {
    expect(USER_ID_PATTERN.test('a'.repeat(64))).toBe(true);
    expect(assertValidUserId('a'.repeat(64))).toBe('a'.repeat(64));
    expectInvalidArgument(() => assertValidUserId('a'.repeat(65)));
  });
});

describe('assertValidGroupId', () => {
  it('与用户 ID 同规则', () => {
    expect(assertValidGroupId('eng-1')).toBe('eng-1');
    expect(GROUP_ID_PATTERN.test('eng-1')).toBe(true);
    for (const id of ['Eng', 'eng team', '_meta', 'a'.repeat(65)]) {
      expectInvalidArgument(() => assertValidGroupId(id));
    }
  });
});

describe('buildIdentity', () => {
  it('没有组时只有 user principal', () => {
    expect(buildIdentity('alice', [])).toEqual({ userId: 'alice', principals: ['user:alice'] });
  });

  it('去重并排序，输入顺序不影响输出', () => {
    const identity = buildIdentity('alice', ['ops', 'eng', 'eng']);
    expect(identity).toEqual({
      userId: 'alice',
      principals: ['group:eng', 'group:ops', 'user:alice'],
    });
    // 同一份成员关系重复展开必须得到同一个数组（可重放）。
    expect(buildIdentity('alice', ['eng', 'ops']).principals).toEqual(identity.principals);
  });
});
