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
  /** 初始化端点已经关闭：`needsSetup` 已为 false（§12.7 的引导流程）。 */
  | 'BOOTSTRAP_CLOSED'
  /** 初始化只能在服务器本机完成（§12.7 的回环限制）。 */
  | 'NOT_LOOPBACK'
  /** 一次性初始化令牌缺失或不匹配（§12.7 的 Docker 引导路径）。 */
  | 'INVALID_SETUP_TOKEN'
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
  BOOTSTRAP_CLOSED: 403,
  NOT_LOOPBACK: 403,
  INVALID_SETUP_TOKEN: 403,
  RESOURCE_EXHAUSTED: 429,
  PROVIDER_UNAVAILABLE: 503,
  INTERNAL: 500,
});

/**
 * 可重试的错误码（架构文档 §18「并发控制」：超过 busy_timeout 抛 CONFLICT 由任务层重试）。
 * 只有「同样的请求再来一次可能成功」的 code 才在里面——INVALID_ARGUMENT 重试多少次都一样。
 *
 * ## 与 `domain/archive.ts` 的 `isTerminalStepError` 的关系
 *
 * 两个名字都像在回答「要不要重试」，判据却相反。它们是**互补，不是重复**，因为
 * 作用层不同：
 *
 * - 本集合回答「**一次模型调用**失败后，紧接着再发一次会不会成功」——瞬态失败
 *   （限流 429、供应商 5xx、SQLite 写冲突）。消费者是 `services/llm.ts`。
 * - `isTerminalStepError` 回答「**一步提交**重放一次会不会成功」——确定性失败
 *   （URI / 参数 / 身份 / 权限 / API Key 无效，同一份输入再来一次结果一样）。
 *   消费者是 `services/commit/pipeline.ts` 与 `services/task.ts`。
 *
 * 两边都**不在**的 code 会被两个消费者当成「可重试」。这正是 `UNAUTHENTICATED`
 * （API Key 错）曾经白等 `(stepAttempts + 1) × taskAttempts` 次超时的原因：它
 * 既不在本集合（LLM 内部正确地不重试），也不在终态集合（步骤层与任务层误以为
 * 可重试）。
 *
 * **新增错误码时必须同时判断两个集合。** 检查方法：`ComemErrorCode` 的每个成员
 * 都必须在 {@link HTTP_STATUS_BY_CODE} 里有一行，新增 code 会先在 `typecheck`
 * 上红，把你带回这个文件；然后回答两个问题：
 *
 * 1. 它由模型调用抛出吗？会 → 决定是否进本集合；
 * 2. 同样的输入重放一次，结果会不会变？不会 → 必须进 `archive.ts` 的终态集合。
 *
 * 不把 `isTerminalStepError` 写成 `!isRetryable(code)` 的推导：`INTERNAL` 在步骤
 * 级必须重试（`ComemError.from` 把所有未知异常收敛成 `INTERNAL`，写盘失败、连接
 * 断开都走这里），而它不在本集合——推导会把「兜底重试」变成「直接失败」。
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

/**
 * 入参不合法的统一工厂：`code` 固定 `INVALID_ARGUMENT`，机器可读的上下文进 `details`。
 *
 * 只此一份：判定行写两遍以后，同一个参数错误会在不同入口落到不同的 code 或措辞。
 */
export function invalidArgument(message: string, details: Record<string, unknown>): ComemError {
  return new ComemError('INVALID_ARGUMENT', message, details);
}

/** 是否可重试。只认 code，不看 message。 */
export function isRetryable(error: ComemError): boolean {
  return RETRYABLE_CODES.has(error.code);
}

/**
 * 日志与报告里的 `error` 字段：`Error` 取 `message`，其它值按字符串。
 *
 * 不经过 `ComemError.from`：日志要的是原始失败原因，套上「发生未预期的内部错误」
 * 只会让每一行都从同一句废话开始。需要收敛成业务错误码的地方用
 * {@link comemErrorMessage}。
 */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 把任意抛出物收敛成 `ComemError` 后的 `message`（未知异常带「发生未预期的内部错误」前缀）。
 *
 * 导入链路用它而不是 {@link errorMessage}：那里的报告要展示「这条错误算哪个
 * `ComemErrorCode`」，泄漏原始字符串会让调用方按错的 code 分支处理。
 */
export function comemErrorMessage(error: unknown): string {
  return ComemError.from(error).message;
}

/** `error.code`，只认字符串形式（`NodeJS.ErrnoException` 的 `code` 在类型上是 `string`）；拿不到返回 `null`。 */
export function fsErrorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return null;
  }
  const code: unknown = error.code;
  return typeof code === 'string' ? code : null;
}
