/**
 * 请求级埋点：阶段计时、作用域与归因（§17.2、§20 的验收点）。
 *
 * 这里只有「阶段账」本身。写 `request_log` 与指标累加在 `request-record.ts` /
 * `metrics.ts`；总体设计见 `../observability.ts` 的文件头。
 *
 * **用 `AsyncLocalStorage` 而不是实例字段。** 实例字段会让并发请求共用同一个 Map：
 * A 的 `recall` 记到 B 的账上，`recordRequest` 还会把 A 没写完的阶段清掉。归因
 * 报告是「这一轮 CoMem 花了多少」的唯一证据，混了就没有意义。
 */

import { AsyncLocalStorage } from 'node:async_hooks';

import type { Logger } from '../../domain/log.js';

import type { LatencyAttribution } from './contracts.js';

/**
 * 这个阶段名是不是后台阶段。
 *
 * 写成 `.some()` 而不是 `ASYNC_PHASES.includes(name)`：元组式数组的 `includes`
 * 要求入参就是联合类型，调用方得先断言——那等于在唯一一处判定上关掉类型检查。
 */
function isAsyncPhase(name: string): boolean {
  return ASYNC_PHASES.some((phase) => phase === name);
}

/** §17.2 的四个阻塞阶段。名字与 `timePhase()` 的调用参数一致。 */
const BLOCKING_PHASES: readonly string[] = ['processStart', 'recall', 'serialize', 'capture'];

/**
 * §17.2 表格里的后台阶段：归档、抽取、合并、摘要、经验归纳。不计入阻塞开销。
 *
 * 数组是唯一来源，类型从它派生：`CommitPipeline` 的 `STEP_PHASE`
 * （`Record<CommitStepName, AsyncPhase>`）用它当值域。两边各写一份字面量时，给
 * 提交管线加一步会多出一个阶段名，而 `asyncMs` 的求和与 `/metrics` 的输出
 * 继续只认这五个——新步骤的耗时静默消失。
 */
const ASYNC_PHASES = ['archive', 'extract', 'merge', 'summary', 'distill'] as const;

export type AsyncPhase = (typeof ASYNC_PHASES)[number];

/**
 * `attributeRequest()` 的容差：0.5ms。
 *
 * 它只用来判断「阶段之和是否**超过**总耗时」——超过说明同一段被 `timePhase()` 套了
 * 两层，不是未归因间隙。半毫秒是浮点计时（`performance.now()` 的微秒分辨率 + 阶段
 * 边界）的误差上界，经验值，来源未知。取半毫秒而不是 0：归因报告是给人看的，差
 * 0.1ms 报一条 warn 只会让人忽略这条日志。
 */
const ATTRIBUTION_TOLERANCE_MS = 0.5;

/** 把一组阶段名的耗时加起来；缺的阶段按 0 算。 */
function sumOf(phases: Readonly<Record<string, number>>, names: readonly string[]): number {
  let total = 0;
  for (const name of names) {
    total += phases[name] ?? 0;
  }
  return total;
}

/** 一次请求作用域里的阶段账，加上进程级的后台阶段快照。 */
export interface TimingState {
  /**
   * 当前请求的阶段耗时。调用方必须用 `runInRequestScope()` 包住一次请求——HTTP
   * 中间件与 hook 上报各包一次。不在 scope 里调 `timePhase()` 时阶段被丢弃
   * （记一次 warn），不会污染别人的账。
   */
  readonly scope: AsyncLocalStorage<Map<string, number>>;
  /**
   * 后台阶段的**进程级**最近一次耗时。
   *
   * 阻塞阶段是请求作用域的（`scope`），后台阶段不是——归档/抽取/合并/摘要在任务
   * 里跑，不挂在某个 HTTP 请求下。混进 `scope` 会让 hook 上报读到一个空的 Map
   * （上报请求里没有后台阶段），指标恒为 0。
   */
  readonly asyncPhases: Map<string, number>;
  readonly logger: Logger;
}

export function createTimingState(logger: Logger): TimingState {
  return {
    scope: new AsyncLocalStorage<Map<string, number>>(),
    asyncPhases: new Map<string, number>(),
    logger,
  };
}

/**
 * 在一个请求作用域里执行。`fn` 内部调用的 `timePhase()` 只归因到这次请求。
 *
 * 作用域随 `fn` 的 Promise 链传播，`await` 不丢上下文。
 */
export function runInRequestScope<T>(state: TimingState, fn: () => Promise<T>): Promise<T> {
  return state.scope.run(new Map<string, number>(), fn);
}

/**
 * 给一个阶段计时（§17.2）。**这是唯一的阶段记录入口**：边界由调用方用 `fn` 包出来，
 * 文件名与行号就是「这个阶段从哪开始、到哪结束」的答案。
 *
 * 同名阶段多次调用**累加**（`recall` 在一次请求里可能跑几轮；累加保住「这一段总共
 * 花了多少」，覆盖会只留下最后一轮）。
 *
 * 只在 `runInRequestScope()` 里有效。作用域外调用时同步阶段被丢弃并记一次 `warn`
 * ——静默丢弃会让「为什么 phases 是 NULL」变成需要读源码才能回答的问题。后台阶段
 * 是例外：它们记进进程级 `asyncPhases`（不挂在某个请求下），不需要作用域。
 *
 * 用 `performance.now()` 而不是 `Date.now()`：后者是墙上时钟，系统时间被校准时
 * 可能倒退，耗时会变成负数。
 */
export async function timePhase<T>(
  state: TimingState,
  name: string,
  fn: () => Promise<T>,
): Promise<T> {
  const startedAt = performance.now();
  try {
    return await fn();
  } finally {
    // `finally` 保证失败路径也记到耗时：慢请求和慢失败对归因同样重要。
    const elapsed = performance.now() - startedAt;
    // 后台阶段记进程级最近值：它不属于某个请求（见 `TimingState.asyncPhases` 的注释）。
    if (isAsyncPhase(name)) {
      state.asyncPhases.set(name, elapsed);
    }
    const scope = state.scope.getStore();
    if (scope === undefined) {
      if (!isAsyncPhase(name)) {
        state.logger.warn('阶段计时不在请求作用域里，已丢弃。', { phase: name });
      }
    } else {
      scope.set(name, (scope.get(name) ?? 0) + elapsed);
    }
  }
}

/**
 * 生成归因报告（§17.2）。
 *
 * `measuredTotalMs` 是外部的请求总耗时（middleware / hook 自己量的）。不传时总耗时
 * 取阶段累加值——此时两者恒等，报告只回答「各阶段各花了多少」。传了才回答
 * 「这个请求有多少是没被计时的」（`unattributedMs`）。
 *
 * **间隙不是错误。** 只有显式调用 `timePhase()` 的边界会计时，身份解析、路由、
 * 请求体解析、响应编码都不计时（见文件头 2.1 的表格）。所以这里只在阶段之和
 * **超过**总耗时才记 `warn`——那是重复计时，不是间隙。
 */
export function attributeRequest(
  state: TimingState,
  requestId: string,
  measuredTotalMs?: number,
): LatencyAttribution {
  const phases: Record<string, number> = {};
  let accountedMs = 0;
  for (const [name, elapsed] of state.scope.getStore() ?? new Map<string, number>()) {
    phases[name] = elapsed;
    accountedMs += elapsed;
  }

  const totalMs = measuredTotalMs ?? accountedMs;
  const blockingMs = sumOf(phases, BLOCKING_PHASES);
  const asyncMs = sumOf(phases, ASYNC_PHASES);
  // 时钟不会让阶段比请求本身还长，除非同一段被记了两次；`Math.max` 保护下游，
  // 「间隙」这个词本身不表达负数。
  const unattributedMs = Math.max(0, totalMs - accountedMs);

  if (accountedMs > totalMs + ATTRIBUTION_TOLERANCE_MS) {
    // §20 的验收点：阶段之和必须落在总耗时之内。超了说明有阶段被套了两层，或者
    // 读到的是另一个请求的账。不抛错：观测代码不该让请求失败。
    state.logger.warn('阶段耗时之和超过请求总耗时，归因出现重复计时。', {
      requestId,
      totalMs,
      accountedMs,
      phases,
    });
  }

  return { requestId, totalMs, accountedMs, unattributedMs, phases, blockingMs, asyncMs };
}
