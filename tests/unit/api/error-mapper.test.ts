import { describe, expect, it } from 'vitest';

import { toErrorEnvelope, httpStatusOf } from '../../../src/api/http/error-mapper.js';
import { fail, ok } from '../../../src/api/http/envelope.js';
import { ComemError, type ComemErrorCode } from '../../../src/domain/errors.js';

/** §19 的表格：code → HTTP 状态。十个错误码一个不少。 */
const STATUS_BY_CODE: readonly (readonly [ComemErrorCode, number])[] = [
  ['INVALID_URI', 400],
  ['INVALID_ARGUMENT', 400],
  ['NOT_FOUND', 404],
  ['UNAUTHENTICATED', 401],
  ['PERMISSION_DENIED', 403],
  ['ALREADY_EXISTS', 409],
  ['CONFLICT', 409],
  ['RESOURCE_EXHAUSTED', 429],
  ['PROVIDER_UNAVAILABLE', 503],
  ['INTERNAL', 500],
];

describe('httpStatusOf', () => {
  it('十个错误码逐个映射（§19）', () => {
    for (const [code, status] of STATUS_BY_CODE) {
      expect(httpStatusOf(code)).toBe(status);
    }
    expect(STATUS_BY_CODE).toHaveLength(10);
  });
});

describe('toErrorEnvelope', () => {
  it('ComemError 走 §19 的状态码与可读消息', () => {
    for (const [code, status] of STATUS_BY_CODE) {
      const mapped = toErrorEnvelope(new ComemError(code, '给用户看的中文句子。'));

      expect(mapped.statusCode).toBe(status);
      expect(mapped.body).toEqual({
        status: 'error',
        error: { code, message: '给用户看的中文句子。' },
      });
    }
  });

  it('details 原样透传', () => {
    const mapped = toErrorEnvelope(
      new ComemError('INVALID_URI', 'URI 不合法。', {
        requestId: 'req_abc',
        uri: 'comem://user/alice/../etc',
      }),
    );

    expect(mapped.body.error.details).toEqual({
      requestId: 'req_abc',
      uri: 'comem://user/alice/../etc',
    });
  });

  it('非 ComemError 一律当 INTERNAL，不透出原始消息', () => {
    const original = new Error('ENOENT: /home/alice/secret.sql SELECT * FROM users');

    const mapped = toErrorEnvelope(original);

    expect(mapped.statusCode).toBe(500);
    expect(mapped.body.status).toBe('error');
    expect(mapped.body.error.code).toBe('INTERNAL');
    expect(mapped.body.error.message).toBe('发生未预期的内部错误。');
    expect(JSON.stringify(mapped.body)).not.toContain('secret.sql');
    expect(JSON.stringify(mapped.body)).not.toContain('ENOENT');
  });

  it('字符串、null、普通对象同样收敛成 INTERNAL', () => {
    for (const thrown of ['数据库炸了', null, undefined, 42, { message: '对象' }]) {
      const mapped = toErrorEnvelope(thrown);
      expect(mapped.statusCode).toBe(500);
      expect(mapped.body.error).toEqual({ code: 'INTERNAL', message: '发生未预期的内部错误。' });
    }
  });

  it('响应体里没有堆栈（§19 不抛只有开发者能读的堆栈）', () => {
    const original = new Error('内部细节');
    const mapped = toErrorEnvelope(original);
    const serialized = JSON.stringify(mapped.body);

    expect(mapped.body.error).not.toHaveProperty('stack');
    expect(serialized).not.toContain(original.stack ?? '');
    expect(serialized).not.toMatch(/at\s+\S+\s+\(.*:\d+:\d+\)/);
  });
});

describe('envelope', () => {
  it('ok 包住任意结果', () => {
    expect(ok({ memories: [] })).toEqual({ status: 'ok', result: { memories: [] } });
    expect(ok(null)).toEqual({ status: 'ok', result: null });
  });

  it('fail 不写 details 键（没有细节就是没有）', () => {
    const envelope = fail(new ComemError('NOT_FOUND', '节点不存在。'));

    expect(envelope).toEqual({
      status: 'error',
      error: { code: 'NOT_FOUND', message: '节点不存在。' },
    });
    expect(envelope.error).not.toHaveProperty('details');
  });
});
