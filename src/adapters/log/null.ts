/**
 * 丢弃一切日志（架构文档 §4.4 的测试替身之一）。
 *
 * 存在的理由和 `FakeLlmProvider` 一样：测试里断言的是「写了什么」，不是「打印了
 * 什么」。用 `vi.fn()` 手工拼一个 `Logger` 时每个测试都要重复六个方法，改接口
 * 时还要全改一遍。
 *
 * `child` 返回自己：没有 bindings 可合并，派生一个新实例只是浪费分配。
 */

import type { Logger } from '../../domain/log.js';

export class NullLogger implements Logger {
  trace(): void {}

  debug(): void {}

  info(): void {}

  warn(): void {}

  error(): void {}

  child(): Logger {
    return this;
  }
}
