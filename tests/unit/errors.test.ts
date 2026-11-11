import { describe, expect, it } from 'vitest';

import { isTerminalStepError } from '../../src/domain/archive.js';
import {
  ComemError,
  HTTP_STATUS_BY_CODE,
  isRetryable,
  type ComemErrorCode,
} from '../../src/domain/errors.js';

/** 架构文档 §19 的表格。测试直接抄表，防止实现和文档漂移。 */
const EXPECTED_HTTP_STATUS: Readonly<Record<ComemErrorCode, number>> = {
  INVALID_URI: 400,
  INVALID_ARGUMENT: 400,
  NOT_FOUND: 404,
  UNAUTHENTICATED: 401,
  PERMISSION_DENIED: 403,
  ALREADY_EXISTS: 409,
  CONFLICT: 409,
  BOOTSTRAP_CLOSED: 403,
  NOT_LOOPBACK: 403,
  INVALID_SETUP_TOKEN: 403,
  RESOURCE_EXHAUSTED: 429,
  PROVIDER_UNAVAILABLE: 503,
  INTERNAL: 500,
};

const ALL_CODES = Object.keys(EXPECTED_HTTP_STATUS) as ComemErrorCode[];

describe('ComemError', () => {
  it('保留 code、message 与 details，并且是 Error 实例', () => {
    const error = new ComemError('NOT_FOUND', '找不到这个节点。', { uri: 'comem://user/alice/x' });

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(ComemError);
    expect(error.name).toBe('ComemError');
    expect(error.code).toBe('NOT_FOUND');
    expect(error.message).toBe('找不到这个节点。');
    expect(error.details).toEqual({ uri: 'comem://user/alice/x' });
  });

  it('不传 details 时保持 undefined', () => {
    expect(new ComemError('INTERNAL', '发生未预期的内部错误。').details).toBeUndefined();
  });

  describe('from()', () => {
    it('ComemError 原样返回', () => {
      const original = new ComemError('PERMISSION_DENIED', '你没有这个节点的权限。');

      expect(ComemError.from(original)).toBe(original);
    });

    it('Error 包成 INTERNAL，并保留原始 message', () => {
      const wrapped = ComemError.from(new TypeError('undefined is not a function'));

      expect(wrapped).toBeInstanceOf(ComemError);
      expect(wrapped.code).toBe('INTERNAL');
      expect(wrapped.message).toContain('undefined is not a function');
      expect(wrapped.details).toEqual({ cause: 'TypeError' });
    });

    it('字符串包成 INTERNAL，并保留原字符串', () => {
      const wrapped = ComemError.from('磁盘写满了');

      expect(wrapped.code).toBe('INTERNAL');
      expect(wrapped.message).toContain('磁盘写满了');
      expect(wrapped.details).toBeUndefined();
    });

    it('其余抛出物（含 null、对象、数字）包成 INTERNAL', () => {
      for (const thrown of [null, undefined, 42, { reason: 'boom' }]) {
        const wrapped = ComemError.from(thrown);
        expect(wrapped.code).toBe('INTERNAL');
        expect(wrapped.message).toBe('发生未预期的内部错误。');
      }
    });
  });
});

describe('HTTP_STATUS_BY_CODE', () => {
  it('覆盖全部错误码，且状态与 §19 表格一致', () => {
    expect(Object.keys(HTTP_STATUS_BY_CODE).sort()).toEqual([...ALL_CODES].sort());
    expect(HTTP_STATUS_BY_CODE).toEqual(EXPECTED_HTTP_STATUS);
  });

  it('只读', () => {
    expect(Object.isFrozen(HTTP_STATUS_BY_CODE)).toBe(true);
  });
});

describe('isRetryable', () => {
  it('CONFLICT、PROVIDER_UNAVAILABLE、RESOURCE_EXHAUSTED 可重试', () => {
    for (const code of ['CONFLICT', 'PROVIDER_UNAVAILABLE', 'RESOURCE_EXHAUSTED'] as const) {
      expect(isRetryable(new ComemError(code, '稍后重试。'))).toBe(true);
    }
  });

  it('其余错误码不可重试', () => {
    const retryable = new Set<ComemErrorCode>(['CONFLICT', 'PROVIDER_UNAVAILABLE', 'RESOURCE_EXHAUSTED']);
    for (const code of ALL_CODES) {
      if (!retryable.has(code)) {
        expect(isRetryable(new ComemError(code, '不可重试。'))).toBe(false);
      }
    }
  });
});

describe('isTerminalStepError', () => {
  it.each(['INVALID_URI', 'INVALID_ARGUMENT', 'PERMISSION_DENIED', 'UNAUTHENTICATED'] as const)(
    '%s 是确定性失败：步骤层与任务层不重试',
    (code) => {
      expect(isTerminalStepError(code)).toBe(true);
    },
  );

  it.each(['CONFLICT', 'RESOURCE_EXHAUSTED', 'PROVIDER_UNAVAILABLE', 'INTERNAL'] as const)(
    '%s 重放可能成功：步骤层与任务层重试',
    (code) => {
      expect(isTerminalStepError(code)).toBe(false);
    },
  );
});
