/**
 * HTTP 响应信封（架构文档 §14、§19）。
 *
 * 成功与失败的外层形状固定：`{status: 'ok', result}` / `{status: 'error', error}`。
 * 控制台与集成方按 `status` 分支，不需要猜错误码藏在哪一层。
 *
 * `details` 原样透传（`unknown`）：它是机器可读的上下文（`requestId`、`uri`、
 * `fields`），形状由各 `ComemError` 的构造方决定。这里不裁剪也不校验——信封的
 * 职责是搬运，编造细节属于错误构造方。
 *
 * **`error` 里没有堆栈**（§19「不抛只有开发者能读的堆栈」）：堆栈进 stderr，
 * 响应体只留可读的 `code` / `message` / `details`。
 */

import type { ComemError } from '../../domain/errors.js';

export interface OkEnvelope<T> {
  readonly status: 'ok';
  readonly result: T;
}

export interface ErrorEnvelope {
  readonly status: 'error';
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly details?: unknown;
  };
}

export function ok<T>(result: T): OkEnvelope<T> {
  return { status: 'ok', result };
}

export function fail(error: ComemError): ErrorEnvelope {
  return {
    status: 'error',
    error: {
      code: error.code,
      message: error.message,
      // 不写 `details: undefined`：JSON 序列化后两者一样，但内存里多一个键会让
      // 「有 details」的判断（`'details' in error`）与序列化结果不一致。
      ...(error.details === undefined ? {} : { details: error.details }),
    },
  };
}
