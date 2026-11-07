/**
 * 领域层错误模型（架构文档 §19）。
 *
 * `code` 是稳定枚举，调用方按 code 分支；`message` 是给用户看的中文完整句子，
 * 不放英文堆栈、不放内部标识符。需要机器可读的上下文时放进 `details`。
 */

export type ComemErrorCode =
  | 'INVALID_URI'
  | 'INVALID_ARGUMENT'
  | 'NOT_FOUND'
  | 'UNAUTHENTICATED'
  | 'PERMISSION_DENIED'
  | 'ALREADY_EXISTS'
  | 'CONFLICT'
  | 'RESOURCE_EXHAUSTED'
  | 'PROVIDER_UNAVAILABLE'
  | 'INTERNAL';

/**
 * 错误码 → HTTP 状态，与架构文档 §19 的表格一一对应。
 * 接口层的错误映射只查这张表，不写 if 链。
 */
export const HTTP_STATUS_BY_CODE: Readonly<Record<ComemErrorCode, number>> = Object.freeze({
  INVALID_URI: 400,
  INVALID_ARGUMENT: 400,
  NOT_FOUND: 404,
  UNAUTHENTICATED: 401,
  PERMISSION_DENIED: 403,
  ALREADY_EXISTS: 409,
  CONFLICT: 409,
  RESOURCE_EXHAUSTED: 429,
  PROVIDER_UNAVAILABLE: 503,
  INTERNAL: 500,
});

/**
 * 可重试的错误码（架构文档 §18「并发控制」：超过 busy_timeout 抛 CONFLICT 由任务层重试）。
 * 只有「同样的请求再来一次可能成功」的 code 才在里面——INVALID_ARGUMENT 重试多少次都一样。
 */
const RETRYABLE_CODES: ReadonlySet<ComemErrorCode> = new Set<ComemErrorCode>([
  'CONFLICT',
  'PROVIDER_UNAVAILABLE',
  'RESOURCE_EXHAUSTED',
]);

export class ComemError extends Error {
  readonly code: ComemErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: ComemErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'ComemError';
    this.code = code;
    if (details !== undefined) {
      this.details = details;
    }
  }

  /**
   * 把任意抛出物收敛成 ComemError。已经是 ComemError 的原样返回，
   * 其余（Error、字符串、其它）包成 INTERNAL——不把未知异常泄漏成业务错误码，
   * 否则调用方会按 NOT_FOUND 之类的分支去处理一个真正的程序缺陷。
   */
  static from(unknown: unknown): ComemError {
    if (unknown instanceof ComemError) {
      return unknown;
    }
    if (unknown instanceof Error) {
      return new ComemError('INTERNAL', `发生未预期的内部错误：${unknown.message}`, {
        cause: unknown.name,
      });
    }
    if (typeof unknown === 'string') {
      return new ComemError('INTERNAL', `发生未预期的内部错误：${unknown}`);
    }
    return new ComemError('INTERNAL', '发生未预期的内部错误。');
  }
}

/** 是否可重试。只认 code，不看 message。 */
export function isRetryable(error: ComemError): boolean {
  return RETRYABLE_CODES.has(error.code);
}
