/**
 * 负责：检索类入口的条数上限解析，以及外部调用（意图分析 / 查询嵌入 / 重排）的时间预算收窄。
 * 不负责：检索本身，以及各上游怎么用自己的预算。
 */

import { ComemError } from '../../domain/errors.js';

/**
 * 检索类入口的默认条数（架构文档 §8.4、§13.2）。
 *
 * 10：`find` / `search` / `grep` 的返回直接进模型上下文，10 条摘要约 1–2k token，
 * 再多会挤占工作上下文。`services/` 不能 import `api/`（§4.2），所以值定义在这里，
 * 服务层的 `resolveLimit` 与 MCP / HTTP 直接 import 这一处——各写一份会让「同一个
 * 能力」按调用方式返回不同规模。
 */
export const DEFAULT_SEARCH_LIMIT = 10;

/** 1 毫秒 = 1e6 纳秒。 */
const NANOSECONDS_PER_MILLISECOND = 1_000_000;

export function elapsedMs(startedAt: bigint): number {
  return Number(process.hrtime.bigint() - startedAt) / NANOSECONDS_PER_MILLISECOND;
}

export function resolveLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return DEFAULT_SEARCH_LIMIT;
  }
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new ComemError('INVALID_ARGUMENT', 'limit 必须是正整数。', { limit });
  }
  return limit;
}

/**
 * 上游预算之外留给工具层的余量（毫秒）。
 *
 * 上游预算与工具总上限同时到点的话，谁先返回取决于定时器顺序——降级路径可能
 * 输给「工具级失败」，把一次本可以返回 FTS 结果的检索变成错误。所以每个上游
 * 预算都从剩余时间里扣掉这份余量；余量再按剩余预算的 1/5 封顶，避免测试里
 * 几百毫秒的预算被一个固定值吃光。
 */
const DEADLINE_RESERVE_MS = 1_000;

/**
 * 剩余预算（毫秒）：`cap` 与「离总截止还有多久」取较小者。
 *
 * `deadlineAt` 省略时返回 `null`——调用方据此走原来的「只有供应商超时」路径，
 * HTTP / Hook 的行为不变。
 */
export function remainingBudget(deadlineAt: number | undefined, cap: number): number | null {
  const remaining = deadlineRemainingMs(deadlineAt);
  if (remaining === null) {
    return null;
  }
  const reserve = Math.min(DEADLINE_RESERVE_MS, Math.floor(remaining / 5));
  // 已经过期时给 1ms 而不是 0：`setTimeout(0)` 与「立刻降级」在语义上都是马上，
  // 但 1ms 让错误信息里能写一个正整数预算，读日志时不会出现「0 毫秒超时」。
  return Math.max(1, Math.min(cap, remaining - reserve));
}

/** 离总截止还有多久（毫秒）；没有总预算时是 `null`。 */
export function deadlineRemainingMs(deadlineAt: number | undefined): number | null {
  if (deadlineAt === undefined) {
    return null;
  }
  return Math.max(1, deadlineAt - Date.now());
}

/**
 * 给一个外部调用套上预算。到点用 `onTimeout()` 的错误结束，不取消在途请求
 * （供应商返回后会被丢弃）。
 *
 * 只用于已经确定有预算的路径；`null` 预算的调用不经过它。
 */
export async function withBudget<T>(
  operation: Promise<T>,
  budgetMs: number,
  onTimeout: () => Error,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(onTimeout()), budgetMs);
    timer.unref();
  });
  try {
    return await Promise.race([operation, guard]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/** 超时错误：`details.timeout` 让 `rerankFailureReason` 能把它记成 `timeout`。 */
export function budgetExceeded(upstream: string, budgetMs: number): ComemError {
  return new ComemError(
    'PROVIDER_UNAVAILABLE',
    `${upstream}超过 ${budgetMs} 毫秒没有返回，已中止等待。`,
    { timeout: true, timeoutMs: budgetMs },
  );
}
