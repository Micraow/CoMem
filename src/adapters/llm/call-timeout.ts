/**
 * 单次模型调用的超时与取消
 */

import { ComemError } from '../../domain/errors.js';
import { MILLISECONDS_PER_SECOND } from '../../domain/time.js';

export interface CallTimeoutOptions {
  /** 本次调用的超时上限。缺省只受 `configuredSeconds` 约束。 */
  readonly timeoutMs?: number | undefined;
  /** 调用方的取消信号。 */
  readonly signal?: AbortSignal | undefined;
}

export interface CallTimeout {
  /** 传给底层调用的信号 */
  readonly signal: AbortSignal;
  /** 实际生效的超时, 用于错误上下文 */
  readonly timeoutMs: number;
  /** 超时信号 */
  timedOut(): boolean;
  /** 清除计时器 */
  dispose(): void;
  /** 调用方取消时原样抛出它给出的原因 */
  rethrowCallerAbort(): void;
}

export function startCallTimeout(
  configuredSeconds: number,
  options: CallTimeoutOptions | undefined,
): CallTimeout {
  const configuredMs = configuredSeconds * MILLISECONDS_PER_SECOND;
  const timeoutMs =
    options?.timeoutMs === undefined ? configuredMs : Math.min(configuredMs, options.timeoutMs);

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  timer.unref();

  const callerSignal = options?.signal;
  const signal =
    callerSignal === undefined ? controller.signal : AbortSignal.any([controller.signal, callerSignal]);

  return {
    signal,
    timeoutMs,
    timedOut: () => timedOut,
    dispose: () => {
      clearTimeout(timer);
    },
    rethrowCallerAbort: () => {
      if (callerSignal?.reason instanceof ComemError) {
        throw callerSignal.reason;
      }
    },
  };
}
