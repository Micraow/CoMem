/**
 * MCP 工具调用的墙上时钟上限（架构文档 §13、§15.9、§19）。
 *
 * ## 为什么需要这一层
 *
 * 工具调用是宿主 agent 的**同步等待**：MCP 客户端发一次 `tools/call`，在结果返回
 * 之前整个 agent 停在那里。供应商超时（`providers.*.timeoutSeconds`）是**单次
 * 外部调用**的预算，不是**一次工具调用**的预算：`search` 会依次/并行走意图分析、
 * 查询嵌入、重排，把三个超时叠起来就是几分钟；配置里 `timeoutSeconds` 又只要求
 * 正数，写 3600 也合法。那些预算解决不了「agent 被挂住」。
 *
 * 这一层是最后一道闸：不论工具走到哪一步、不论配置把供应商超时调成多少，工具在
 * `budgetMs` 到达时一定返回一个结果（错误结果，`isError: true`）。
 *
 * ## 为什么不是「超时就取消」
 *
 * 取消需要每个上游都接受并正确响应 `AbortSignal`。工具层不假设这一点：到点先
 * 返回，不在途调用能不能立刻停下是上游契约的事。检索类工具另有更短的**上游预算**
 * （`services/search.ts` 的 `QUERY_*_TIMEOUT_MS`），它们在到达这一层之前就把
 * 「向量不可用」降级成 FTS 结果并标注——这一层只兜住「连降级都没走完」的情况。
 *
 * ## 上限的来源
 *
 * 30000 毫秒是**推导值**，不是拍出来的：MCP 检索路径的三段上游预算之和是
 * 10000（意图分析）+ 6000（查询嵌入）+ 12000（重排）= 28000 毫秒；留 2000 毫秒
 * 给本地索引、ACL 与序列化。也就是说**正常的最坏情况**由三段预算决定（28000），
 * 这一层只在本地 I/O 也异常时触发。`hook` 的 5 秒是另一套预算（§15.9），不复用。
 */

/** 单次 MCP 工具调用的默认上限。推导见文件头。 */
export const MCP_TOOL_DEADLINE_MS = 30_000;

/**
 * 工具上报的「当前正在等的外部上游」。
 *
 * 只用于超时归因：到达上限时用户要能看到「卡在哪个上游」，而不是一句「工具超时」。
 * 本地 I/O 不细分（索引 / 文件系统 / 锁都在本进程里，排查入口是日志里的 requestId）。
 */
export type ToolUpstream = 'llm' | 'embedding' | 'rerank' | 'index' | 'filesystem';

const UPSTREAM_LABELS: Readonly<Record<ToolUpstream, string>> = Object.freeze({
  llm: 'LLM 生成（意图分析）',
  embedding: '向量嵌入（embedding）',
  rerank: '重排（rerank）',
  index: '检索索引（SQLite / FTS5）',
  filesystem: '文件系统',
});

/** 超时归因：最近一次上报的上游与已经等了多少毫秒。 */
export interface ToolUpstreamSnapshot {
  readonly upstream: ToolUpstream;
  readonly label: string;
  readonly elapsedMs: number;
}

/**
 * 一次工具调用的截止时间。
 *
 * 工具层通过 `McpToolContext.deadline` 拿到它，服务层只看到 `deadlineAt` 与
 * `onUpstream`（`FindOptions`），不依赖接口层类型。
 */
export class ToolDeadline {
  readonly budgetMs: number;
  readonly startedAt: number;
  #upstream: ToolUpstream | null = null;
  #upstreamStartedAt = 0;

  constructor(budgetMs: number, startedAt: number = Date.now()) {
    if (!Number.isFinite(budgetMs) || budgetMs <= 0) {
      throw new RangeError(`MCP 工具上限必须是正的有限数（毫秒），实际 ${String(budgetMs)}。`);
    }
    this.budgetMs = budgetMs;
    this.startedAt = startedAt;
  }

  /** 绝对截止时刻（epoch 毫秒）。服务层按它算剩余预算。 */
  get deadlineAt(): number {
    return this.startedAt + this.budgetMs;
  }

  /** 上报「现在开始等这个上游」。 */
  mark(upstream: ToolUpstream): void {
    this.#upstream = upstream;
    this.#upstreamStartedAt = Date.now();
  }

  /** 最近一次上报的上游；还没上报过时是 `null`。 */
  get lastUpstream(): ToolUpstreamSnapshot | null {
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
 * 到点返回 `onTimeout()`，否则返回 `operation` 的结果。
 *
 * 不用 `AbortController`：这里只保证调用方不再等，不负责取消在途工作（见文件头）。
 * 定时器 `unref()`，进程退出时不被一个 30 秒的计时器拖住。
 *
 * `operation` 在超时之后仍可能 resolve / reject。`Promise.race` 已经给它挂了处理
 * 器，不会产生未处理拒绝；它的返回值被丢弃。
 */
export async function runWithDeadline<T>(
  operation: Promise<T>,
  deadline: ToolDeadline,
  onTimeout: () => T,
): Promise<T> {
  const remainingMs = Math.max(0, deadline.deadlineAt - Date.now());
  let timer: NodeJS.Timeout | undefined;
  const guard = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(onTimeout()), remainingMs);
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
