/**
 * Hook 的生命周期预算、stdin 读取上限、诊断与退出（架构文档 §15.2、§15.9）。
 *
 * ## 为什么是「每个 hook 一个总预算」
 *
 * `lib/http.mjs` 的 `timeoutMs` 是**单请求**超时。一个 hook 里顺序发两次请求，
 * 最坏耗时就是两倍；`SessionStart` 并发发三次、`PreCompact` 顺序发三次提交，
 * 上限各自相乘。用户在 `UserPromptSubmit` 上等的不是「一次检索」，是「这个端口
 * 上所有请求加起来」。
 *
 * 所以这里给每个事件一个**总 deadline**：从**进程启动**算起（`performance.timeOrigin`），
 * stdin 读取、检索、采集、上报全都从同一个 deadline 里扣。子请求通过
 * `createHttpClient({ deadline })` 共享同一个 `AbortSignal`，超时后剩余工作立刻
 * 放弃。
 *
 * ## 预算值从哪来
 *
 * 三个来源，按优先级：
 *
 * 1. **宿主文档的 hook 超时**（下面各条注明）。宿主的上限只说明「不能超过」，
 *    不能当我们的预算——Claude Code 的 `UserPromptSubmit` 默认给 30 秒，让用户
 *    等 30 秒和挂住没有区别。
 * 2. **这个 hook 在用户感知路径上的位置**：每轮按回车付一次（`UserPromptSubmit`）
 *    与每次工具调用付一次（`PreToolUse` / `PostToolUse`）必须更紧；会话开始
 *    （`SessionStart`）和上下文压缩（`PreCompact`）可以宽一些。
 * 3. **本地实测**：§15.9 的典型值与本机实测（`node servers/*.mjs`，空载）在下面
 *    每条里写明。预算是典型值的 10–100 倍，余量留给服务端抖动，不留给「服务端
 *    挂了还在等」。
 *
 * 这些值**不暴露成配置项**：它们是「用户最多等多久」的取舍，不是部署差异。
 * 要改就改这张表，只有一处。
 *
 * ## 为什么退出前要 `scheduleHardExit`
 *
 * 逻辑上决定「什么都不输出」不等于进程会退出：一个没关的 stdin、一个未清理的
 * 定时器、一条 keep-alive 的 socket 都会把事件循环留住。`scheduleHardExit` 安排
 * 一个**被 `unref()` 的**定时器：事件循环能自然退出时它永远不触发（进程正常退
 * 出）；有残留句柄时它到点触发 `process.exit(0)`。调用方在这之前已经 `await`
 * 过 stdout 的写回调，所以不会截断已完成的输出。
 */

import { ComemHookError } from './http.mjs';

/**
 * `SessionEnd` 的总预算。
 *
 * 1200 = Claude Code 的 1.5s 共享预算减去 300ms，留给进程启动与退出。它比
 * `PreCompact` 短得多不是笔误：宿主写完 `SessionEnd` 就给 1.5 秒，提交一个
 * 本地 CoMem（5–20ms）够用；不够的话游标不前进，下一次 `Stop` / `PreCompact`
 * 会重投（§15.4）。
 */
export const SESSION_END_BUDGET_MS = 1200;

/**
 * 每个 hook 事件的总预算（毫秒），从进程启动算起。
 *
 * 键是**内部事件名**（`lib/events.mjs` 的 snake_case），与上报给服务端的 `event`
 * 字段、`comem_hook_*` 的 `event` 标签同名——一张表同时回答「等多久」与「记到
 * 哪个事件上」。
 *
 * | 事件 | 预算 | 依据 |
 * |---|---|---|
 * | `session_start` | 4000 | 会话开局一次性；三次 GET 并发。宿主上限 600s 不构成约束，按「开局多等 4 秒用户还能接受」定；本机空载实测 57ms |
 * | `user_prompt_submit` | 2000 | **每轮按回车都付**。宿主上限 30s（Claude Code 官方默认）远大于可用值；§15.9 典型 60–180ms，本机实测 54ms → 2s 是典型值的 ~10 倍，超了就退化成「本轮没有记忆」 |
 * | `pre_tool_use` | 1000 | 纯本地判断，不发请求；本机实测 29ms。值是实测的 ~30 倍，因为它出现在**每次工具调用**前 |
 * | `post_tool_use` | 2000 | 两次顺序 POST；§17.2 采集写入 5–20ms → 2s 是 100 倍 |
 * | `stop` | 1000 | 主进程只写载荷 + spawn；`stop.test.mjs` 实测 44ms。1s 是 20 倍 |
 * | `pre_compact` | 30000 | **数据可能丢**，必须等提交完成；与 `commitTimeoutMs`、§17.2 的 `rewriteTimeoutMs` 同一个数。宿主默认 600s |
 * | `session_end` | 1200 | 见 `SESSION_END_BUDGET_MS`：宿主给 `SessionEnd` 只有 1.5 秒共享预算 |
 *
 * `pre_compact` 与 `session_end` 走同一个处理器（`servers/pre-compact.mjs`，都是
 * 「对话要没了，把手上的消息交出去」），但预算是两个数：宿主给它们的超时差 20 倍，
 * 归一预算等于让 `SessionEnd` 被宿主先杀掉、留下半截提交。
 *
 * **不许超过宿主的上限**：任何一项调大到超过宿主给该事件的超时，宿主会在我们
 * 退出前杀掉进程，输出被丢弃——见 `integrations/README.md` 的「每个 hook 的总预算」。
 */
export const HOOK_BUDGETS_MS = Object.freeze({
  session_start: 4000,
  user_prompt_submit: 2000,
  pre_tool_use: 1000,
  post_tool_use: 2000,
  stop: 1000,
  pre_compact: 30000,
  session_end: SESSION_END_BUDGET_MS,
});

/**
 * 读 stdin 的上限。
 *
 * 宿主在拉起子进程后**立刻**写 stdin 并关闭（Claude Code / Codex 的 command hook
 * 都是这个行为；本机实测写入在 1ms 内完成）。800ms 是这个观测值的几百倍，同时
 * 小于最短的事件预算（1000ms），保证「stdin 卡住」不会把任何 hook 拖过它的总预算。
 *
 * 超时按「没有事件」处理：宿主没写载荷，比拿半个 JSON 去猜更安全。
 */
export const STDIN_READ_CAP_MS = 800;

/**
 * `process.exit(0)` 之前的宽限期。
 *
 * 只在**有残留句柄**时生效（定时器被 unref）。250ms 足够本地管道把一行 stderr /
 * stdout 写完；它同时也是「预算 + 余量」里的余量之一。
 */
const FORCED_EXIT_GRACE_MS = 250;

/** 进程启动时刻（epoch ms）。`performance.timeOrigin` 就是它。 */
export function processStartEpochMs() {
  const origin = globalThis.performance?.timeOrigin;
  return typeof origin === 'number' && Number.isFinite(origin) ? origin : Date.now();
}

/**
 * 取一个事件的预算。
 *
 * 只查内部事件名这一个键：`pre_compact` 与 `session_end` 是两个键（宿主给它们的
 * 超时差 20 倍），不再需要从原始载荷名反推。
 *
 * @param {{ event: string }} event
 */
export function budgetForEvent(event) {
  const budget = HOOK_BUDGETS_MS[event.event];
  // 适配器会拒绝未知事件，走到这里说明事件表与新代码不同步。退回最长的那个预算
  // 不会把用户等的时间放大到无限：它仍然有上限。
  return typeof budget === 'number' ? budget : HOOK_BUDGETS_MS.pre_compact;
}

/**
 * 建一个从**进程启动**算起的总 deadline。
 *
 * `AbortSignal.timeout` 内部定时器被 Node unref（实测 `node -e "AbortSignal.timeout(60000)"`
 * 21ms 退出），所以它自己不会把进程留在事件循环里。
 *
 * @param {number} budgetMs
 */
export function createDeadline(budgetMs) {
  const expiresAt = processStartEpochMs() + budgetMs;
  // `AbortSignal.timeout` 只接受整数毫秒；`timeOrigin` 带小数。
  const remaining = Math.max(0, Math.round(expiresAt - Date.now()));
  return {
    budgetMs,
    expiresAt,
    /** 子请求把这个 signal 与自己的单请求超时合并（`AbortSignal.any`）。 */
    signal: AbortSignal.timeout(remaining),
    remainingMs() {
      return Math.max(0, expiresAt - Date.now());
    },
    expired() {
      return Date.now() >= expiresAt;
    },
  };
}

/**
 * 写一行诊断到 stderr。**永不抛错**，也永不跨行：宿主把 stderr 按行展示，多行
 * 会把一条诊断拆成几条。
 *
 * 为什么不用 stdout：那是注入协议的通道，混进一行 warn 会被宿主当成上下文
 * （`mcp-proxy.mjs` 的文件头有同一个约束）。
 *
 * 返回的 Promise 在写回调后 resolve，调用方可以 `await` 它再退出。
 *
 * @param {string} message
 */
export function diagnose(message) {
  const line = `${String(message).replace(/\s*\n\s*/g, ' ')}\n`;
  try {
    return new Promise((resolve) => {
      process.stderr.write(line, () => resolve(undefined));
    });
  } catch {
    return Promise.resolve(undefined);
  }
}

/**
 * 一行 `warn` 诊断（JSON），用于「降级但仍要继续」的路径。
 *
 * 格式与 `mcp-proxy.mjs` 的 `log()` 一致，便于统一采集。`data` 里不要放 prompt
 * 正文、工具输出或凭据。
 *
 * @param {string} component
 * @param {string} message
 * @param {Record<string, unknown>} [data]
 */
export function warnToStderr(component, message, data) {
  try {
    process.stderr.write(
      `${JSON.stringify({ level: 'warn', component, message, ...data })}\n`,
    );
  } catch {
    // 写不了 stderr 就只能放弃诊断。
  }
}

/**
 * 安排一次「兜底退出」。定时器被 unref：事件循环能自然退出时它不触发；有残留
 * 句柄（未关的 stdin、keep-alive socket、未清理的定时器）时它到点以退出码 0 结束。
 *
 * 调用前必须已经把输出写完（`runHook` 会 `await` 写回调）。
 *
 * @param {number} [delayMs]
 */
export function scheduleHardExit(delayMs = FORCED_EXIT_GRACE_MS) {
  const timer = setTimeout(() => process.exit(0), Math.max(0, delayMs));
  timer.unref();
  return timer;
}

/**
 * 在总预算用尽处再架一道硬上限：即使 handler 违背约定（永不 resolve、忽略
 * `AbortSignal`、在 FIFO 上 `readFile` 挂住），进程也会在「预算 + 宽限期」退出。
 *
 * 这是「进程永远会退出」的最后一道保险，不是主路径：正常路径在 handler 返回后
 * 就调 `scheduleHardExit` 了。到那时 handler 还没返回，说明也不会有 stdout 要写。
 *
 * @param {ReturnType<typeof createDeadline>} deadline
 */
export function armHardDeadline(deadline) {
  return scheduleHardExit(deadline.remainingMs() + FORCED_EXIT_GRACE_MS);
}

/**
 * 读 stdin 文本，最多等 `limitMs`。
 *
 * 宿主不关 stdin 时 `for await` 永远不返回，进程也不会退出——这是「hook 挂住」
 * 最直接的一种。超时后销毁 stdin 句柄（否则它继续把事件循环留住）并抛
 * `HOOK_STDIN_TIMEOUT`，由 `runHook` 收敛成「没有事件」。
 *
 * @param {number} [limitMs]
 * @returns {Promise<string>}
 */
export async function readStdinText(limitMs = STDIN_READ_CAP_MS) {
  const chunks = [];
  const reading = (async () => {
    for await (const chunk of process.stdin) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    }
  })();

  let timer;
  const timedOut = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      try {
        process.stdin.destroy();
      } catch {
        // 已经关了：没什么可销毁的。
      }
      reject(
        new ComemHookError(`等宿主写 stdin 超时（${limitMs}ms），按「没有事件」处理。`, {
          code: 'HOOK_STDIN_TIMEOUT',
        }),
      );
    }, limitMs);
    timer.unref();
  });

  try {
    await Promise.race([reading, timedOut]);
  } finally {
    clearTimeout(timer);
    // 超时后 reading 仍然挂在 stdin 上；吞掉它之后的拒绝，避免变成未处理的拒绝。
    reading.catch(() => {});
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * 兜住「还没进 `runHook` 就失败」的路径。
 *
 * `resolveHost()` / `loadConfig()` 在 `runHook` 之前跑：宿主名拼错、配置文件
 * 解析失败、`--host` 被改坏，都会让顶层 await 抛错，Node 以**退出码 1** 结束。
 * 宿主把非 0 退出码当失败；Claude Code 配了 `onFailure: "block"` 时它还会**阻断**
 * 这次调用（官方文档「Block the action when a hook fails」）。hook 是旁路，任何
 * 内部错误都不该 deny，所以这里统一：诊断一行 → 退出码 0。
 *
 * @template T
 * @param {string} component 诊断里的组件名
 * @param {() => Promise<T>} task
 * @returns {Promise<T | undefined>}
 */
export async function runMain(component, task) {
  installFatalGuards(component);
  try {
    return await task();
  } catch (error) {
    await diagnose(`co-mem ${component}: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  } finally {
    scheduleHardExit();
  }
}

/**
 * 进程级兜底：未捕获异常与未处理的 Promise 拒绝也走「诊断 + 退出码 0」。
 *
 * 没有这一层时，Node 默认打印堆栈并以退出码 1 结束。
 *
 * @param {string} component
 */
export function installFatalGuards(component) {
  const report = (label, error) => {
    diagnose(`co-mem ${component}: ${label}：${error instanceof Error ? error.message : String(error)}`);
    scheduleHardExit();
  };
  process.on('uncaughtException', (error) => report('未捕获异常', error));
  process.on('unhandledRejection', (error) => report('未处理的 Promise 拒绝', error));
}
