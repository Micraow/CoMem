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
  return {
    statusCode: httpStatusOf('INTERNAL'),
    body: fail(new ComemError('INTERNAL', INTERNAL_MESSAGE)),
  };
}
