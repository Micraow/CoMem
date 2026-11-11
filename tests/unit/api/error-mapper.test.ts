import { describe, expect, it } from 'vitest';

import { toErrorEnvelope, httpStatusOf } from '../../../src/api/http/error-mapper.js';
import { fail, ok } from '../../../src/api/http/envelope.js';
import { ComemError, type ComemErrorCode } from '../../../src/domain/errors.js';

/** §19 的表格：code → HTTP 状态。全部错误码一个不少。 */
const STATUS_BY_CODE: readonly (readonly [ComemErrorCode, number])[] = [
  ['INVALID_URI', 400],
  ['INVALID_ARGUMENT', 400],
  ['NOT_FOUND', 404],
  ['UNAUTHENTICATED', 401],
  ['PERMISSION_DENIED', 403],
  ['ALREADY_EXISTS', 409],
  ['CONFLICT', 409],
  ['BOOTSTRAP_CLOSED', 403],
  ['NOT_LOOPBACK', 403],
  ['INVALID_SETUP_TOKEN', 403],
  ['RESOURCE_EXHAUSTED', 429],
  ['PROVIDER_UNAVAILABLE', 503],
  ['INTERNAL', 500],
];

describe('httpStatusOf', () => {
  it('全部错误码逐个映射（§19）', () => {
    for (const [code, status] of STATUS_BY_CODE) {
      expect(httpStatusOf(code)).toBe(status);
    }
    expect(STATUS_BY_CODE).toHaveLength(13);
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

/**
 * 构造 Fastify 在进路由之前抛出的客户端错误。
 *
 * 真实的抛出物是 `createError(CODE, message, statusCode)` 的产物：一个带 `code` 与
 * `statusCode` 的 `Error`。这里只复刻这两个字段——映射只读它们。
 */
function fastifyClientError(code: string, statusCode: number, message: string): Error {
  return Object.assign(new Error(message), { code, statusCode });
}

describe('toErrorEnvelope 的 Fastify 客户端错误', () => {
  it('空 JSON body → 400 INVALID_ARGUMENT，不是 500', () => {
    // 缺陷现场：`POST /sessions/{id}/commit` 带 `content-type: application/json`
    // 且 body 为空时，Fastify 抛这条。归成 500 等于告诉调用方「服务端坏了」，
    // 而正确处置是「补一个」。
    const mapped = toErrorEnvelope(
      fastifyClientError(
        'FST_ERR_CTP_EMPTY_JSON_BODY',
        400,
        "Body cannot be empty when content-type is set to 'application/json'",
      ),
    );

    expect(mapped.statusCode).toBe(400);
    expect(mapped.body.error.code).toBe('INVALID_ARGUMENT');
    expect(mapped.body.error.details).toEqual({ fastifyCode: 'FST_ERR_CTP_EMPTY_JSON_BODY' });
    expect(mapped.body.error.message).toBe('请求体无法解析：请检查 content-type 与请求体格式。');
  });

  it('JSON 语法错、媒体类型不支持、body 过大同样归 INVALID_ARGUMENT', () => {
    const codes: readonly (readonly [string, number])[] = [
      ['FST_ERR_CTP_INVALID_JSON_BODY', 400],
      ['FST_ERR_CTP_INVALID_MEDIA_TYPE', 415],
      ['FST_ERR_CTP_BODY_TOO_LARGE', 413],
      ['FST_ERR_CTP_INVALID_CONTENT_LENGTH', 400],
    ];

    for (const [code, statusCode] of codes) {
      const mapped = toErrorEnvelope(fastifyClientError(code, statusCode, 'detail'));

      expect(mapped.statusCode).toBe(400);
      expect(mapped.body.error.code).toBe('INVALID_ARGUMENT');
    }
  });

  it('FST_ERR_* 的 5xx 仍然是 INTERNAL（插件加载失败不是调用方的问题）', () => {
    const mapped = toErrorEnvelope(
      fastifyClientError('FST_ERR_PLUGIN_VERSION_MISMATCH', 500, 'plugin mismatch'),
    );

    expect(mapped.statusCode).toBe(500);
    expect(mapped.body.error.code).toBe('INTERNAL');
  });

  it('4xx 但没有 FST_ERR_ 前缀仍然是 INTERNAL（只认 Fastify 自己的错误码）', () => {
    for (const error of [
      fastifyClientError('SOME_CLIENT_ERROR', 400, 'detail'),
      fastifyClientError('FST_ERR_CTP_EMPTY_JSON_BODY', 200, 'detail'),
      Object.assign(new Error('no code'), { statusCode: 400 }),
    ]) {
      const mapped = toErrorEnvelope(error);

      expect(mapped.statusCode).toBe(500);
      expect(mapped.body.error.code).toBe('INTERNAL');
    }
  });

  it('不透出 Fastify 的原始消息', () => {
    const original = fastifyClientError(
      'FST_ERR_CTP_EMPTY_JSON_BODY',
      400,
      '/home/alice/secret.sql SELECT * FROM users',
    );

    const serialized = JSON.stringify(toErrorEnvelope(original).body);

    expect(serialized).not.toContain('secret.sql');
    expect(serialized).not.toContain('SELECT');
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
