/**
 * 可观测性应用服务（架构文档 §17 全节）。
 *
 * 四个问题要能回答：**系统现在在干什么、刚才那次为什么慢、那次失败错在哪、用 CoMem
 * 让每个请求多花了多少时间。** 最后一个是核心——记忆系统的价值必须能证明大于它的
 * 成本（§17 开头）。
 *
 * ## 1. 延迟归因：阻塞与异步分开（§17.2）
 *
 * | 阶段 | 阻塞用户？ |
 * |---|---|
 * | `processStart`（`node hook.mjs` 的进程启动） | 是 |
 * | `recall`（`find` / `search`） | 是 |
 * | `serialize`（注入序列化） | 是 |
 * | `capture`（`Stop` 时的消息落盘） | 是 |
 * | `archive` / `extract` / `merge` / `summary` | 否（后台） |
 *
 * 单轮阻塞开销是前四个之和，典型 60–180ms；后台部分不算进去——用户没等它（§17.2）。
 * 分开统计是必须的：把进程启动藏在「检索 20ms」后面会误导人。
 *
 * ## 2. 四阶段相加等于总耗时（§20 的验收点）
 *
 * `attribute()` 把阶段累加值与测量总耗时对比，超过 `ATTRIBUTION_TOLERANCE_MS` 记
 * `warn`。**不抛错**：观测代码不该让请求失败（§19「错误必须可解释」的反面——它
 * 也不该制造错误）。
 *
 * ## 3. 低基数标签（§17.1、§18 的 `includeAccountLabel` 注释）
 *
 * `/metrics` 的 `event` 只认 §15.2 的七个生命周期点，未知事件归成 `other`。
 * **`sessionId` 不进标签**：每次会话一个值，抓取一次就把指标库撑爆。它只进日志与
 * `request_log`。
 *
 * ## 4. 健康度是诊断端点，不是全库扫描（§17.5）
 *
 * `degradedSummaries` 要读每个目录的 `.abstract.md`，目录数上界 `DEGRADED_DIRECTORY_LIMIT`；
 * 超了记 `warn` 并返回已统计数。
 *
 * ## 5. 为什么这里能直接写 SQL
 *
 * `services/` 不能 import `node:sqlite`（§4.2），而健康度与 `/metrics` 的计数是
 * 「一条 SELECT 就够」的只读聚合。为它们各建一个仓储只会把同一张表的读路径拆散，
 * 所以和 `SummaryService` 的 `SummaryDatabase` 一样，声明最小结构端口
 * `ObservabilityDatabase`，实例由 `bootstrap/` 注入 `DatabaseSync`。写入路径仍然
 * 走 `RequestLogRepository`——写要事务与列映射，读不要。
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

import type { MetadataFileStore } from '../adapters/fs/metadata-file.js';
import type {
  RequestLogRepository,
  RequestLogRow,
} from '../adapters/sqlite/request-log-repository.js';
import type { Logger } from '../domain/log.js';
import { Uri } from '../domain/uri.js';

import type { LlmCallStats, LlmService } from './llm.js';

/**
 * 只读聚合查询的最小结构端口。
 *
 * `DatabaseSync` 结构上满足它；测试可以传内存库，不需要为健康度再造一层仓储。
 * 只声明 `get`：健康度与指标都是单行聚合，没有列表需求。
 */
export interface ObservabilityDatabase {
  prepare(sql: string): {
    get(...params: unknown[]): Record<string, unknown> | undefined;
    all(...params: unknown[]): Record<string, unknown>[];
  };
}

/**
 * 「节点自身那一行」的谓词，与 `adapters/sqlite/node-repository.ts` 的
 * `nodeSelfRowSql()` 是同一个不变量：目录的 L1 概览行是附加检索行，不是独立节点。
 *
 * 不复用那个函数：`services/` 只能 `import type` 引用适配层（§4.2），而这个文件
 * 本来就直接对 `node` 表写 SQL（读端口是 `ObservabilityDatabase`）。两处的含义由
 * `0004_node_level_rows.sql` 与 `SummaryService.#persistSummary` 共同约束。
 */
const NODE_SELF_ROW = "NOT (kind = 'directory' AND level = 'L1')";

/** §17.2 的四个阻塞阶段。名字与 `phase()` 的调用参数一致。 */
const BLOCKING_PHASES: readonly string[] = ['processStart', 'recall', 'serialize', 'capture'];

/** §17.2 表格里的后台阶段：归档、抽取、合并、摘要。不计入阻塞开销。 */
const ASYNC_PHASES: readonly string[] = ['archive', 'extract', 'merge', 'summary'];

/**
 * `attribute()` 的容差：0.5ms。
 *
 * §20 的验收点只写「四阶段相加等于总耗时」。半毫秒是浮点计时（`performance.now()`
 * 的微秒分辨率 + 各阶段边界）的误差上界，经验值，来源未知。取半毫秒而不是 0：
 * 归因报告是给人看的，差 0.1ms 报一条 warn 只会让人忽略这条日志。
 */
const ATTRIBUTION_TOLERANCE_MS = 0.5;

/**
 * `degradedSummaries` 最多检查的目录数：1000。
 *
 * 经验值，来源未知：§17.5 只要求分析型统计，没给上界。每个目录要读两个摘要文件，
 * 1000 个目录约 2000 次读；健康检查是诊断端点，不该因为库大就把请求拖成秒级。
 */
const DEGRADED_DIRECTORY_LIMIT = 1000;

/** 1 秒 = 1000 毫秒。`durationMs` 换成 Prometheus 的秒。 */
const MILLISECONDS_PER_SECOND = 1000;

/**
 * §15.2 的七个 Hook 生命周期点。`event` 标签只允许这几个值加 `other`。
 *
 * 白名单而不是「原样透传」：Hook 是装进宿主的独立进程，它的上报内容是外部输入，
 * 一个拼错的事件名会在指标库里造出一个新时间序列，而且永远不会有第二个样本。
 */
const HOOK_EVENTS: readonly string[] = [
  'session_start',
  'user_prompt_submit',
  'pre_tool_use',
  'post_tool_use',
  'stop',
  'pre_compact',
  'session_end',
];

/** 未知事件归到这里（§17.1 的低基数要求）。 */
const OTHER_EVENT = 'other';

/**
 * 没有身份的请求在 `account` 标签里的取值。
 *
 * 不省略标签：同一个指标族的样本标签集必须一致，漏掉 account 会让 Prometheus
 * 抓取整段失败。
 */
const ANONYMOUS_ACCOUNT = 'anonymous';

/** §17.2 的报告：hook 在退出前 `POST /api/v1/telemetry/hook` 带上它。 */
export interface HookOverheadReport {
  readonly event: string;
  readonly sessionId: string | null;
  readonly phases: {
    readonly processStartMs: number;
    readonly recallMs: number;
    readonly serializeMs: number;
    readonly captureMs: number;
  };
}

/**
 * 报告字段 → 指标 `phase` 标签名。
 *
 * 报告用 camelCase（TypeScript 字段），指标用 snake_case（§17.2 的
 * `phase = process_start | recall | serialize | capture`）。映射只写这一份。
 */
const BLOCKING_PHASE_LABELS = [
  ['processStartMs', 'process_start'],
  ['recallMs', 'recall'],
  ['serializeMs', 'serialize'],
  ['captureMs', 'capture'],
] as const;

export interface LatencyAttribution {
  readonly requestId: string;
  readonly totalMs: number;
  /** 四阶段相加必须等于它（容差 0.5ms，浮点） */
  readonly accountedMs: number;
  readonly phases: Readonly<Record<string, number>>;
  /** §17.2 的阻塞合计 */
  readonly blockingMs: number;
  /** 后台部分，不计入阻塞 */
  readonly asyncMs: number;
}

export interface MemoryHealth {
  readonly pendingReview: number;
  readonly staleSummaries: number;
  readonly degradedSummaries: number;
  readonly orphanTasks: number;
  readonly indexNodes: number;
  readonly oldestPendingAgeSeconds: number | null;
}

/** `recordRequest` 的入参：一次已完成的 HTTP 请求（§17.6）。 */
export interface RequestLogEntry {
  readonly requestId: string;
  readonly method: string;
  readonly path: string;
  readonly statusCode: number;
  readonly durationMs: number;
  readonly errorCode: string | null;
  readonly subject: string | null;
}

/**
 * §17.6 的采样策略。
 *
 * 默认全量；`sampleRate < 1` 时只按比例记录**成功**请求，错误请求永远全量
 * （§17.6：「错误请求永远全量记录」——采样把错误采掉就等于没有错误数据）。
 */
export interface RequestLogPolicy {
  readonly enabled: boolean;
  readonly sampleRate: number;
}

const DEFAULT_REQUEST_LOG_POLICY: RequestLogPolicy = Object.freeze({
  enabled: true,
  sampleRate: 1,
});

export interface ObservabilityServiceDeps {
  /** `request_log` 的写入路径（§17.6） */
  readonly requestLog: RequestLogRepository;
  /** 健康度与 `/metrics` 的只读聚合（§17.5、§17.9）；`DatabaseSync` 结构上满足它 */
  readonly db: ObservabilityDatabase;
  /** 读目录的 `.abstract.md`，判定降级摘要（§17.5） */
  readonly metadata: Pick<MetadataFileStore, 'readSummary'>;
  /** §17.4 的模型用量；`LlmService.stats` 是累加器 */
  readonly llm: Pick<LlmService, 'stats'>;
  readonly logger: Logger;
  /**
   * 是否记录 Hook 阻塞开销（`telemetry.hookOverhead.enabled`）。
   *
   * 关闭时 `recordHookOverhead` 直接返回，`comem_hook_overhead_seconds` 不出现在
   * `/metrics` 里。默认 `true`——它是控制台「监控」页的主要数据源，关掉就没有数据。
   */
  readonly hookOverheadEnabled?: boolean;
  /** 时钟；默认 `() => new Date()` */
  readonly now?: () => Date;
  /** §17.6 的采样；默认全量 */
  readonly requestLogPolicy?: RequestLogPolicy;
  /**
   * 是否在 `/metrics` 里按账号拆分请求耗时（`telemetry.metrics.includeAccountLabel`）。
   *
   * 默认 `false`：单账号部署没必要，开了会放大标签基数。打开后
   * `comem_http_request_duration_seconds` 的样本带 `account` 标签。
   */
  readonly includeAccountLabel?: boolean;
}

function normalizeEvent(event: string): string {
  return HOOK_EVENTS.includes(event) ? event : OTHER_EVENT;
}

/** 把一组阶段名的耗时加起来；缺的阶段按 0 算。 */
function sumOf(phases: Readonly<Record<string, number>>, names: readonly string[]): number {
  let total = 0;
  for (const name of names) {
    total += phases[name] ?? 0;
  }
  return total;
}

/** Prometheus 文本里的数值。非有限值（NaN / ±Infinity）写 0，否则抓取会整段失败。 */
function metricValue(value: number): string {
  return Number.isFinite(value) ? String(value) : '0';
}

/** 标签值转义（Prometheus 文本格式）：反斜杠、换行、双引号。 */
function escapeLabel(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('\n', '\\n').replaceAll('"', '\\"');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class ObservabilityService {
  readonly #requestLog: RequestLogRepository;
  readonly #db: ObservabilityDatabase;
  readonly #metadata: Pick<MetadataFileStore, 'readSummary'>;
  readonly #llm: Pick<LlmService, 'stats'>;
  readonly #logger: Logger;
  readonly #now: () => Date;
  readonly #policy: RequestLogPolicy;

  /**
   * 当前请求的阶段耗时。
   *
   * **用 `AsyncLocalStorage` 而不是实例字段。** 实例字段会让并发请求共用同一个 Map：
   * A 的 `recall` 记到 B 的账上，`recordRequest` 还会把 A 没写完的阶段清掉。归因
   * 报告是「这一轮 CoMem 花了多少」的唯一证据，混了就没有意义。
   *
   * 调用方必须用 `withRequestScope()` 包住一次请求——HTTP 中间件与 hook 上报各包
   * 一次。不在 scope 里调 `phase()` 时阶段被丢弃（记一次 warn），不会污染别人的账。
   */
  readonly #scope = new AsyncLocalStorage<Map<string, number>>();

  /**
   * 在一个请求作用域里执行。`fn` 内部调用的 `phase()` 只归因到这次请求。
   *
   * 作用域随 `fn` 的 Promise 链传播，`await` 不丢上下文。
   */
  withRequestScope<T>(fn: () => Promise<T>): Promise<T> {
    return this.#scope.run(new Map<string, number>(), fn);
  }

  /** 每个事件最近一次的四阶段耗时（`comem_hook_overhead_seconds`）。 */
  readonly #hookPhases = new Map<string, Map<string, number>>();
  /** 每个事件最近一次的单轮阻塞合计（`comem_hook_overhead_total_seconds`）。 */
  readonly #hookTotals = new Map<string, number>();
  /** 每个事件最近一次的后台耗时（`comem_hook_async_seconds`）。 */
  readonly #hookAsync = new Map<string, number>();
  /**
   * 后台阶段的**进程级**最近一次耗时。
   *
   * 阻塞阶段是请求作用域的（`#scope`），后台阶段不是——归档/抽取/合并/摘要在任务
   * 里跑，不挂在某个 HTTP 请求下。混进 `#scope` 会让 hook 上报读到一个空的 Map
   * （上报请求里没有后台阶段），指标恒为 0。
   */
  readonly #asyncPhases = new Map<string, number>();

  /** §17.3 的 `comem_http_request_duration_seconds` 的 summary 累加器。 */
  #requestDurationSumSeconds = 0;
  #requestDurationCount = 0;
  /** `telemetry.metrics.includeAccountLabel` 打开时按账号分组的请求耗时。 */
  readonly #accountDurations = new Map<string, { sumSeconds: number; count: number }>();
  /** `telemetry.metrics.includeAccountLabel`。关掉时只输出全局汇总。 */
  readonly #includeAccountLabel: boolean;
  /** `telemetry.hookOverhead.enabled`。关掉时 `recordHookOverhead` 直接丢弃。 */
  readonly #hookOverheadEnabled: boolean;

  constructor(deps: ObservabilityServiceDeps) {
    this.#requestLog = deps.requestLog;
    this.#db = deps.db;
    this.#metadata = deps.metadata;
    this.#llm = deps.llm;
    this.#logger = deps.logger;
    this.#now = deps.now ?? (() => new Date());
    this.#policy = deps.requestLogPolicy ?? DEFAULT_REQUEST_LOG_POLICY;
    this.#includeAccountLabel = deps.includeAccountLabel ?? false;
    this.#hookOverheadEnabled = deps.hookOverheadEnabled ?? true;
  }

  /**
   * 给一个阶段计时。同名阶段多次调用会累加（`recall` 在一次请求里可能跑两轮）。
   *
   * 用 `performance.now()` 而不是 `Date.now()`：后者是墙上时钟，系统时间被校准时
   * 可能倒退，耗时会变成负数。
   */
  async phase<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const startedAt = performance.now();
    try {
      return await fn();
    } finally {
      // `finally` 保证失败路径也记到耗时：慢请求和慢失败对归因同样重要。
      const elapsed = performance.now() - startedAt;
      // 后台阶段记进程级最近值：它不属于某个请求（见 `#asyncPhases` 的注释）。
      if (ASYNC_PHASES.includes(name)) {
        this.#asyncPhases.set(name, elapsed);
      }
      const scope = this.#scope.getStore();
      if (scope === undefined) {
        if (!ASYNC_PHASES.includes(name)) {
          this.#logger.warn('阶段计时不在请求作用域里，已丢弃。', { phase: name });
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
   * 取阶段累加值——此时两者恒等，报告只回答「各阶段各花了多少」。传了才做 §20 的
   * 「相加等于总耗时」检查。
   */
  attribute(requestId: string, measuredTotalMs?: number): LatencyAttribution {
    const phases: Record<string, number> = {};
    let accountedMs = 0;
    for (const [name, elapsed] of this.#scope.getStore() ?? new Map<string, number>()) {
      phases[name] = elapsed;
      accountedMs += elapsed;
    }

    const totalMs = measuredTotalMs ?? accountedMs;
    const blockingMs = sumOf(phases, BLOCKING_PHASES);
    const asyncMs = sumOf(phases, ASYNC_PHASES);

    const divergence = Math.abs(totalMs - accountedMs);
    if (divergence > ATTRIBUTION_TOLERANCE_MS) {
      // §20 的验收点不成立说明有阶段没被计时。不抛错：观测代码不该让请求失败。
      this.#logger.warn('延迟归因与总耗时不一致，有阶段没有被计时。', {
        requestId,
        totalMs,
        accountedMs,
        divergenceMs: divergence,
        phases,
      });
    }

    return { requestId, totalMs, accountedMs, phases, blockingMs, asyncMs };
  }

  /** 记录一次请求：写 `request_log`（§17.6）+ 结构化日志（§17.8）。 */
  async recordRequest(entry: RequestLogEntry): Promise<void> {
    // 指标先记：采样只影响请求记录表，不影响「系统刚才多慢」。
    const durationSeconds = entry.durationMs / MILLISECONDS_PER_SECOND;
    this.#requestDurationSumSeconds += durationSeconds;
    this.#requestDurationCount += 1;
    if (this.#includeAccountLabel) {
      const account = entry.subject ?? ANONYMOUS_ACCOUNT;
      const current = this.#accountDurations.get(account) ?? { sumSeconds: 0, count: 0 };
      current.sumSeconds += durationSeconds;
      current.count += 1;
      this.#accountDurations.set(account, current);
    }

    // 作用域随请求结束一起被丢弃，不需要（也不能）在这里清空——清空会抹掉同进程
    // 里另一个正在跑的请求的阶段。
    const phases = this.#snapshotPhases();

    if (!this.#policy.enabled) {
      return;
    }
    // 错误请求永远全量（§17.6）：采样把错误采掉就等于没有错误数据。
    const failed = entry.statusCode >= 400 || entry.errorCode !== null;
    if (!failed && Math.random() >= this.#policy.sampleRate) {
      return;
    }

    const row: RequestLogRow = {
      id: randomUUID(),
      requestId: entry.requestId,
      method: entry.method,
      path: entry.path,
      statusCode: entry.statusCode,
      durationMs: entry.durationMs,
      phases,
      errorCode: entry.errorCode,
      subject: entry.subject,
      createdAt: this.#now().toISOString(),
    };
    this.#requestLog.insert(row);
    this.#logRequest(row);
  }

  /**
   * Hook 开销上报（§17.2 的「报告路径」）。
   *
   * 只保留**每个事件最近一次**：`comem_hook_overhead_seconds` 是 gauge，控制台要
   * 展示的是「本轮 CoMem 开销 142ms」这样的当前值。历史分布由 `request_log` 与
   * Prometheus 的抓取间隔共同回答，服务端不再存一份直方图。
   */
  async recordHookOverhead(report: HookOverheadReport): Promise<void> {
    // 关掉时直接丢弃，不进 Map：Hook 每个事件每轮都上报，禁用它是为了省内存与 CPU，
    // 记下来再过滤等于没关。
    if (!this.#hookOverheadEnabled) {
      return;
    }
    const event = normalizeEvent(report.event);
    const phaseValues = new Map<string, number>();
    let totalMs = 0;
    for (const [field, label] of BLOCKING_PHASE_LABELS) {
      const elapsed = report.phases[field];
      phaseValues.set(label, elapsed);
      totalMs += elapsed;
    }

    this.#hookPhases.set(event, phaseValues);
    this.#hookTotals.set(event, totalMs);
    // 后台耗时与阻塞分开（§17.2）：它来自后台任务对 `phase()` 的调用，不是这份报告。
    this.#hookAsync.set(event, sumOf(Object.fromEntries(this.#asyncPhases), ASYNC_PHASES));

    this.#logger.info('Hook 开销上报完成。', {
      event: report.event,
      sessionId: report.sessionId,
      totalMs,
      phases: Object.fromEntries(phaseValues),
    });
  }

  /** §17.5 记忆健康度。字段口径见各查询的注释。 */
  async health(): Promise<MemoryHealth> {
    const now = this.#now();
    const pendingReview = this.#count(
      `SELECT COUNT(*) AS total FROM node WHERE status = ? AND ${NODE_SELF_ROW}`,
      'pending',
    );
    const staleSummaries = this.#count(
      `SELECT COUNT(*) AS total FROM node
        WHERE kind = 'directory' AND summary_pending > 0`,
    );
    // 租约过期的 running 任务就是孤儿：没人续租，正常的执行器不会再碰它。
    // 与 `TaskRepository.recoverExpired` 同义：`lease_until IS NULL` 的 running 行
    // 也按过期处理（认领一定会写租约，出现这种行说明数据被改坏了）。
    const orphanTasks = this.#count(
      `SELECT COUNT(*) AS total FROM task
        WHERE status = 'running' AND (lease_until IS NULL OR lease_until < ?)`,
      now.toISOString(),
    );
    const indexNodes = this.#count(`SELECT COUNT(*) AS total FROM node WHERE ${NODE_SELF_ROW}`);
    const oldestPendingAgeSeconds = this.#oldestPendingAgeSeconds(now);
    const degradedSummaries = await this.#countDegradedSummaries();

    const health: MemoryHealth = {
      pendingReview,
      staleSummaries,
      degradedSummaries,
      orphanTasks,
      indexNodes,
      oldestPendingAgeSeconds,
    };
    this.#logger.debug('记忆健康度统计完成。', { ...health });
    return health;
  }

  /** §17.4 模型用量与成本。返回 `LlmService` 的累加器快照。 */
  modelUsage(): { readonly stats: LlmCallStats } {
    return { stats: this.#llm.stats };
  }

  /**
   * `comem_http_request_duration_seconds` 的样本。
   *
   * `includeAccountLabel` 为 `true` 时按账号分组；关闭时输出全局汇总（与接线前
   * 逐字一致）。**两种形态不能混着输出**：同一个指标族的标签集必须一致，否则
   * Prometheus 抓取整段失败。
   */
  #requestDurationLines(): string[] {
    if (!this.#includeAccountLabel) {
      return [
        `comem_http_request_duration_seconds_sum ${metricValue(this.#requestDurationSumSeconds)}`,
        `comem_http_request_duration_seconds_count ${metricValue(this.#requestDurationCount)}`,
      ];
    }

    const lines: string[] = [];
    for (const [account, duration] of this.#accountDurations) {
      const label = `account="${escapeLabel(account)}"`;
      lines.push(
        `comem_http_request_duration_seconds_sum{${label}} ${metricValue(duration.sumSeconds)}`,
        `comem_http_request_duration_seconds_count{${label}} ${metricValue(duration.count)}`,
      );
    }
    return lines;
  }

  /**
   * Prometheus 文本（§17.1 的低基数端点）。
   *
   * v1 的 `comem_http_request_duration_seconds` 用 summary 形态（只报 `_sum` /
   * `_count`）：直方图的桶边界要按真实分布调，而 v1 没有长期运行的 Prometheus 来
   * 回答「桶该切在哪」（§17.11 不部署 Prometheus）。summary 的 `_sum` / `_count`
   * 已经能算平均耗时与 TPS，够验收。
   */
  renderMetrics(): string {
    const stats = this.#llm.stats;
    const lines: string[] = [
      '# HELP comem_http_request_duration_seconds HTTP 请求完整耗时',
      '# TYPE comem_http_request_duration_seconds summary',
      ...this.#requestDurationLines(),
    ];

    lines.push(
      '# HELP comem_hook_overhead_seconds Hook 阻塞开销的单阶段耗时（取每个事件最近一次）',
      '# TYPE comem_hook_overhead_seconds gauge',
    );
    for (const [event, phases] of this.#hookPhases) {
      for (const [phase, elapsedMs] of phases) {
        lines.push(
          `comem_hook_overhead_seconds{event="${event}",phase="${phase}"} ${metricValue(
            elapsedMs / MILLISECONDS_PER_SECOND,
          )}`,
        );
      }
    }

    lines.push(
      '# HELP comem_hook_overhead_total_seconds Hook 单轮阻塞开销合计（进程启动 + 检索 + 序列化 + 采集）',
      '# TYPE comem_hook_overhead_total_seconds gauge',
    );
    for (const [event, totalMs] of this.#hookTotals) {
      lines.push(
        `comem_hook_overhead_total_seconds{event="${event}"} ${metricValue(
          totalMs / MILLISECONDS_PER_SECOND,
        )}`,
      );
    }

    lines.push(
      '# HELP comem_hook_async_seconds 后台处理耗时，不阻塞用户',
      '# TYPE comem_hook_async_seconds gauge',
    );
    for (const [event, asyncMs] of this.#hookAsync) {
      lines.push(
        `comem_hook_async_seconds{event="${event}"} ${metricValue(
          asyncMs / MILLISECONDS_PER_SECOND,
        )}`,
      );
    }

    lines.push(
      '# HELP comem_index_nodes 索引节点数',
      '# TYPE comem_index_nodes gauge',
      `comem_index_nodes ${metricValue(
        this.#count(`SELECT COUNT(*) AS total FROM node WHERE ${NODE_SELF_ROW}`),
      )}`,
      '# HELP comem_pending_review 待复核的记忆条数',
      '# TYPE comem_pending_review gauge',
      `comem_pending_review ${metricValue(
        this.#count(
          `SELECT COUNT(*) AS total FROM node WHERE status = ? AND ${NODE_SELF_ROW}`,
          'pending',
        ),
      )}`,
      '# HELP comem_llm_tokens_total 模型 token 累计',
      '# TYPE comem_llm_tokens_total counter',
      `comem_llm_tokens_total{kind="prompt"} ${metricValue(stats.promptTokens)}`,
      `comem_llm_tokens_total{kind="completion"} ${metricValue(stats.completionTokens)}`,
      '# HELP comem_llm_cost_usd_total 模型成本累计，美元（§18 的 pricing 换算）',
      '# TYPE comem_llm_cost_usd_total counter',
      `comem_llm_cost_usd_total ${metricValue(stats.costUsd ?? 0)}`,
    );

    return `${lines.join('\n')}\n`;
  }

  #snapshotPhases(): Record<string, number> | null {
    const scope = this.#scope.getStore();
    if (scope === undefined || scope.size === 0) {
      return null;
    }
    return Object.fromEntries(scope);
  }

  #logRequest(row: RequestLogRow): void {
    const fields = {
      requestId: row.requestId,
      method: row.method,
      path: row.path,
      statusCode: row.statusCode,
      durationMs: row.durationMs,
      errorCode: row.errorCode,
      subject: row.subject,
    };
    if (row.statusCode >= 500) {
      this.#logger.error('HTTP 请求失败。', fields);
      return;
    }
    if (row.statusCode >= 400) {
      this.#logger.warn('HTTP 请求被拒绝。', fields);
      return;
    }
    this.#logger.info('HTTP 请求完成。', fields);
  }

  /** 单行聚合查询。列名固定 `total`，与 `node-repository` / `task-repository` 一致。 */
  #count(sql: string, ...params: readonly unknown[]): number {
    const row = this.#db.prepare(sql).get(...params);
    const total = row?.['total'];
    return typeof total === 'number' ? total : 0;
  }

  /** 最老的 pending 记忆距今秒数（§17.5）；没有则 `null`（「没有」不是 0 秒）。 */
  #oldestPendingAgeSeconds(now: Date): number | null {
    const row = this.#db
      .prepare(
        `SELECT updated_at FROM node
          WHERE status = 'pending' AND ${NODE_SELF_ROW}
          ORDER BY updated_at ASC
          LIMIT 1`,
      )
      .get();
    const updatedAt = row?.['updated_at'];
    if (typeof updatedAt !== 'string') {
      return null;
    }
    const timestamp = Date.parse(updatedAt);
    if (Number.isNaN(timestamp)) {
      return null;
    }
    // 时钟回拨时差值为负，按 0 秒报——「未来更新的记忆」不是更老。
    return Math.max(0, Math.floor((now.getTime() - timestamp) / MILLISECONDS_PER_SECOND));
  }

  /**
   * 降级摘要的目录数（§17.5）。
   *
   * `degraded` 在 `.abstract.md` 的 frontmatter 里（§6.7），只能逐个目录读。上界
   * `DEGRADED_DIRECTORY_LIMIT`：超了说明库已经大到该用专门的巡检，而不是让健康
   * 检查把磁盘读穿。单个目录读失败只跳过（记 `warn`），否则一个坏文件会让整个
   * 健康检查 500。
   */
  async #countDegradedSummaries(): Promise<number> {
    // 多取一行：用来判断「是否还有更多目录」而不必再跑一次 COUNT。
    const rows = this.#db
      .prepare(
        `SELECT uri FROM node
          WHERE kind = 'directory' AND ${NODE_SELF_ROW}
          ORDER BY uri
          LIMIT ?`,
      )
      .all(DEGRADED_DIRECTORY_LIMIT + 1);

    if (rows.length > DEGRADED_DIRECTORY_LIMIT) {
      this.#logger.warn('目录摘要降级统计达到上限，只统计了一部分目录。', {
        limit: DEGRADED_DIRECTORY_LIMIT,
      });
    }

    let degraded = 0;
    for (const row of rows.slice(0, DEGRADED_DIRECTORY_LIMIT)) {
      const raw = row['uri'];
      if (typeof raw !== 'string') {
        continue;
      }
      try {
        const summary = await this.#metadata.readSummary(Uri.parse(raw));
        if (summary.generation?.degraded === true) {
          degraded += 1;
        }
      } catch (error) {
        this.#logger.warn('读取目录摘要失败，跳过降级统计。', {
          uri: raw,
          error: errorMessage(error),
        });
      }
    }
    return degraded;
  }
}
