/**
 * 错误 → HTTP 状态与响应体（架构文档 §19）。
 *
 * 映射只查 `domain/errors.ts` 的 `HTTP_STATUS_BY_CODE` 表，不写 if 链：错误码与
 * 状态码的对应关系是冻结契约，两处各写一份就会漂移。
 *
 * **不透出原始错误消息。** 非 `ComemError` 一律当 `INTERNAL`，消息是固定的中文
 * 句子。原始 `Error.message` 里可能有绝对路径、SQL 片段、连接串——那些对攻击者
 * 是免费的侦察信息，对用户没有帮助。需要定位时用 `requestId` 去 `error.log` 查
 * （§17.7）：「错误必须可解释」指的是日志，不是响应体。
 *
 * 注意这里**不用** `ComemError.from()`：它会把 `unknown.message` 拼进消息里，
 * 正是本文件要挡掉的那种泄漏。
 *
 * ## Fastify 的解析错误是唯一的例外
 *
 * `content-type: application/json` 而 body 为空时，Fastify 在进路由之前就抛
 * `FST_ERR_CTP_EMPTY_JSON_BODY`（400）。这条错误**不是**未知异常：它是调用方
 * 少发了一个 `{}`，消息里也没有任何服务端内部信息。把它归进 `INTERNAL`（500）
 * 等于告诉调用方「服务端坏了」，而正确的处置（补一个空对象）与「服务端坏了」
 * 完全不同——Hook 侧当初就必须显式发 `{}` 才能提交。
 *
 * 其余 4xx 同族（JSON 语法错、媒体类型不支持、body 超过 `bodyLimit`）一并归到
 * `INVALID_ARGUMENT`：§19 的十个码里没有 413 / 415，而它们都是「请求本身不能被
 * 接受」。精确的 413 只在日志里（`error.log` 记原始 `message`），响应体只回稳定码。
 */

import type { ComemErrorCode } from '../../domain/errors.js';
import { ComemError, HTTP_STATUS_BY_CODE } from '../../domain/errors.js';

import type { ErrorEnvelope } from './envelope.js';
import { fail } from './envelope.js';

/**
 * 未知错误的固定消息。
 *
 * 非 `ComemError` 的抛出物不携带「给用户看」的语义：它可能是 `TypeError`、
 * 网络错误、或者一段字符串。透传它等于把内部实现当接口。
 */
const INTERNAL_MESSAGE = '发生未预期的内部错误。';

/** Fastify 客户端错误的固定消息。说的是「改请求」，不是「服务端坏了」。 */
const CLIENT_REQUEST_MESSAGE = '请求体无法解析：请检查 content-type 与请求体格式。';

/**
 * Fastify 内部错误码的前缀。
 *
 * 全部 `FST_ERR_*`（含 `FST_ERR_CTP_*` 解析族与 `FST_ERR_VALIDATION_*`）都带这
 * 个前缀。仅凭前缀不够——Fastify 也有 5xx 的 `FST_ERR_*`（插件加载、路由注册），
 * 那些必须留在 `INTERNAL`——所以还要看 `statusCode` 是不是 4xx。
 */
const FASTIFY_ERROR_PREFIX = 'FST_ERR_';

/** 从 `unknown` 里取字符串字段，不做类型断言。 */
function stringField(value: unknown, key: string): string | null {
  if (typeof value !== 'object' || value === null || !(key in value)) {
    return null;
  }
  const field: unknown = (value as Record<string, unknown>)[key];
  return typeof field === 'string' ? field : null;
}

function numberField(value: unknown, key: string): number | null {
  if (typeof value !== 'object' || value === null || !(key in value)) {
    return null;
  }
  const field: unknown = (value as Record<string, unknown>)[key];
  return typeof field === 'number' && Number.isFinite(field) ? field : null;
}

/**
 * 是不是 Fastify 抛出的客户端错误。是则返回它的错误码（写进 `details` 便于定位）。
 *
 * 判据见 `FASTIFY_ERROR_PREFIX` 的注释：前缀 + 4xx 两条同时成立。
 */
function fastifyClientErrorCode(error: unknown): string | null {
  const code = stringField(error, 'code');
  if (code === null || !code.startsWith(FASTIFY_ERROR_PREFIX)) {
    return null;
  }
  const statusCode = numberField(error, 'statusCode');
  if (statusCode === null || statusCode < 400 || statusCode >= 500) {
    return null;
  }
  return code;
}

export function httpStatusOf(code: ComemErrorCode): number {
  return HTTP_STATUS_BY_CODE[code];
}

export interface MappedError {
  readonly statusCode: number;
  readonly body: ErrorEnvelope;
}

export function toErrorEnvelope(error: unknown): MappedError {
  if (error instanceof ComemError) {
    return { statusCode: httpStatusOf(error.code), body: fail(error) };
  }

  const fastifyCode = fastifyClientErrorCode(error);
  if (fastifyCode !== null) {
    return {
      statusCode: httpStatusOf('INVALID_ARGUMENT'),
      // `fastifyCode` 是协议层的常量名（`FST_ERR_CTP_EMPTY_JSON_BODY`），不含
      // 路径、SQL 或连接串，可以原样给调用方——它是「怎么改请求」的唯一定位信息。
      body: fail(new ComemError('INVALID_ARGUMENT', CLIENT_REQUEST_MESSAGE, { fastifyCode })),
    };
  }

  return {
    statusCode: httpStatusOf('INTERNAL'),
    body: fail(new ComemError('INTERNAL', INTERNAL_MESSAGE)),
  };
}
