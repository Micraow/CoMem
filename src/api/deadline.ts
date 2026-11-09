/**
 * 接口层一次调用的墙上时钟上限（架构文档 §13.3、§14）。
 *
 * ## 为什么需要这一层
 *
 * 两个入口都是**同步等待**：MCP 的 `tools/call` 在结果返回前把整个宿主 agent 停住；
 * HTTP 的 `POST /api/v1/search/*` 让调用方连着连接等。供应商超时
 * （`providers.*.timeoutSeconds`）是**单次外部调用**的预算，不是**一次接口调用**
 * 的预算：`search` 会依次/并行走意图分析、查询嵌入、重排，把三个超时叠起来就是
 * 几分钟；配置里 `timeoutSeconds` 又只要求正数，写 3600 也合法。那些预算解决不了
 * 「调用方被挂住」。
 *
 * 这一层是最后一道闸：不论调用走到哪一步、不论配置把供应商超时调成多少，在
 * `budgetMs` 到达时一定给出结论。**返回形态由各入口自己映射**，所以这个模块只
 * 定义「到点」这件事：
 *
 * | 入口 | 到点后的返回 |
 * |---|---|
 * | MCP 工具（`api/mcp/registry.ts`） | `isError: true`，文本以 `TOOL_DEADLINE_EXCEEDED: ` 开头 |
 * | HTTP 检索路由（`api/http/routes/search.ts`） | `PROVIDER_UNAVAILABLE`（503）的错误封套 |
 *
 * 两侧都不返回空结果：空结果会被读成「记忆里没有」，而实际是上游没响应。
 *
 * ## 为什么不是「超时就取消」
 *
 * 取消需要每个上游都接受并正确响应 `AbortSignal`。这一层不假设这一点：到点先
 * 返回，不在途调用能不能立刻停下是上游契约的事。检索类调用另有更短的**上游预算**
 * （`services/search.ts` 的 `REWRITE_TIMEOUT_MS` / `QUERY_EMBED_TIMEOUT_MS` /
 * `QUERY_RERANK_TIMEOUT_MS`），它们由调用方通过 `FindOptions.deadlineAt` 传下去，
 * 在到达这一层之前就把「向量不可用」降级成 FTS 结果并标注——这一层只兜住
 * 「连降级都没走完」的情况。
 *
 * ## 上限的来源
 *
 * 30000 毫秒是**推导值**，不是拍出来的：检索路径的三段上游预算之和是
 * 10000（意图分析）+ 6000（查询嵌入）+ 12000（重排）= 28000 毫秒；留 2000 毫秒
 * 给本地索引、ACL 与序列化。也就是说**正常的最坏情况**由三段预算决定（28000），
 * 这一层只在本地 I/O 也异常时触发。`hook` 的 5 秒是另一套预算（§15.9），不复用。
 *
 * ## 为什么放在 `api/` 而不是 `api/mcp/`
 *
 * 它同时服务 `api/mcp`（工具注册表）与 `api/http`（检索路由）。两个入口是同一层
 * 的兄弟，让 HTTP 去 import `api/mcp/deadline.ts` 等于给两个入口建立了一条只为
 * 共用一个常数而存在的依赖边；放在 `api/` 下，两边都只依赖「接口层的调用预算」
 * 这一个概念（§4 的分层里 `api/` 是同一层）。
 */

/**
 * 一次接口调用的默认上限（毫秒）。
 *
 * MCP 的 16 个工具与 HTTP 的检索端点**共用这一个值**：同一个能力两个入口不能有
 * 两种行为。推导见文件头。
 */
export const API_CALL_DEADLINE_MS = 30_000;

/**
 * 调用上报的「当前正在等的外部上游」。
 *
 * 只用于超时归因：到达上限时用户要能看到「卡在哪个上游」，而不是一句「调用超时」。
 * 本地 I/O 不细分（索引 / 文件系统 / 锁都在本进程里，排查入口是日志里的 requestId）。
 */
export type CallUpstream = 'llm' | 'embedding' | 'rerank' | 'index' | 'filesystem';

const UPSTREAM_LABELS: Readonly<Record<CallUpstream, string>> = Object.freeze({
  llm: 'LLM 生成（意图分析）',
  embedding: '向量嵌入（embedding）',
  rerank: '重排（rerank）',
  index: '检索索引（SQLite / FTS5）',
  filesystem: '文件系统',
});

/** 超时归因：最近一次上报的上游与已经等了多少毫秒。 */
export interface UpstreamSnapshot {
  readonly upstream: CallUpstream;
  readonly label: string;
  readonly elapsedMs: number;
}

/**
 * 一次接口调用的截止时间。
 *
 * 调用方（`ToolRegistry` 的 `bindDeadline`、HTTP 检索路由）创建它，工具与服务层
 * 只看到 `deadlineAt` 与 `onUpstream`（`FindOptions`），不依赖接口层类型。
 */
export class CallDeadline {
  readonly budgetMs: number;
  readonly startedAt: number;
  #upstream: CallUpstream | null = null;
  #upstreamStartedAt = 0;

  constructor(budgetMs: number, startedAt: number = Date.now()) {
    if (!Number.isFinite(budgetMs) || budgetMs <= 0) {
      throw new RangeError(`接口调用上限必须是正的有限数（毫秒），实际 ${String(budgetMs)}。`);
    }
    this.budgetMs = budgetMs;
    this.startedAt = startedAt;
  }

  /** 绝对截止时刻（epoch 毫秒）。服务层按它算剩余预算。 */
  get deadlineAt(): number {
    return this.startedAt + this.budgetMs;
  }

  /** 上报「现在开始等这个上游」。 */
  mark(upstream: CallUpstream): void {
    this.#upstream = upstream;
    this.#upstreamStartedAt = Date.now();
  }

  /** 最近一次上报的上游；还没上报过时是 `null`。 */
  get lastUpstream(): UpstreamSnapshot | null {
    if (this.#upstream === null) {
      return null;
    }
    return {
      upstream: this.#upstream,
      label: UPSTREAM_LABELS[this.#upstream],
      elapsedMs: Math.max(0, Date.now() - this.#upstreamStartedAt),
    };
  }
}

/**
 * `runWithDeadline` 的结论。
 *
 * 用判别联合而不是「到点返回一个同类型的哨兵值」：MCP 的哨兵是错误结果
 * （`McpToolResult`），HTTP 的哨兵必须变成一次抛出（状态码 + 封套）。哨兵值由
 * 各入口在同一个类型里编，另一侧就会漏判。
 */
export type DeadlineOutcome<T> =
  | { readonly kind: 'completed'; readonly value: T }
  | { readonly kind: 'timed_out' };

/**
 * 到点返回 `timed_out`，否则返回 `completed`。
 *
 * 不用 `AbortController`：这里只保证调用方不再等，不负责取消在途工作（见文件头）。
 * 定时器 `unref()`，进程退出时不被一个 30 秒的计时器拖住。
 *
 * `operation` 在超时之后仍可能 resolve / reject。`Promise.race` 已经给它挂了处理
 * 器，不会产生未处理拒绝；它的返回值被丢弃。
 */
export async function runWithDeadline<T>(
  operation: Promise<T>,
  deadline: CallDeadline,
): Promise<DeadlineOutcome<T>> {
  const remainingMs = Math.max(0, deadline.deadlineAt - Date.now());
  let timer: NodeJS.Timeout | undefined;
  const guard = new Promise<DeadlineOutcome<T>>((resolve) => {
    timer = setTimeout(() => resolve({ kind: 'timed_out' }), remainingMs);
    timer.unref();
  });
  try {
    return await Promise.race([
      operation.then((value): DeadlineOutcome<T> => ({ kind: 'completed', value })),
      guard,
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}
