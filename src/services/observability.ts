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
 * ## 2. 阶段之和不超过总耗时（§20 的验收点）
 *
 * `#attribute()` 把阶段累加值与测量总耗时对比：**差额（`unattributedMs`）是正常的**，
 * 它覆盖身份解析、路由、请求体解析、响应编码这些没有被计时的部分。只有阶段之和
 * **超过**总耗时（`ATTRIBUTION_TOLERANCE_MS` 之外）才记 `warn`——那说明同一段被记了
 * 两次，或者这些阶段不是这次请求的。**不抛错**：观测代码不该让请求失败（§19「错误
 * 必须可解释」的反面——它也不该制造错误）。
 *
 * ## 2.1 四个阶段里哪些在服务端测得到（§17.2 的实现注记）
 *
 * `phase(name, fn)` 是唯一的记录入口，边界由调用方给定：
 *
 * | 阶段 | 服务端边界 | 备注 |
 * |---|---|---|
 * | `processStart` | 无 | hook 进程启动，只有 hook 自己知道（`performance.timeOrigin`） |
 * | `recall` | `/search/find`、`/search/search` 的服务调用 | `mode=context` 的组装与渲染在 `SearchService.context` 内部，随它一起计时 |
 * | `serialize` | 无 | 注入块的格式化在 hook 里（`formatRecallBlock`） |
 * | `capture` | `POST /sessions/{id}/messages` 的落盘 | hook 侧「写 worker 载荷 + spawn」不在这里 |
 *
 * 所以 `request_log.phases` 里通常只有 `recall` 或 `capture` 之一，`processStart` /
 * `serialize` 不会凭空出现。整轮的四阶段由 hook 上报到 `/telemetry/hook`，进
 * `/metrics` 的 gauge（`recordHookOverhead`）。
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
 * 超了记 `warn` 并返回已统计数。画像格式自查（`profileFormatHealth`）同样要读文件
 * 正文，上界 `PROFILE_CHECK_LIMIT`，超了 `truncated: true` 并记 `warn`。
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
import type { TaskRepository } from '../adapters/sqlite/task-repository.js';
import type { Logger } from '../domain/log.js';
import { validateProfileBody } from '../domain/profile-format.js';
import { Uri } from '../domain/uri.js';

import type { LlmService } from './llm.js';

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
 *
 * 导出是给一致性测试用的（`tests/integration/sqlite/node-self-row-consistency.test.ts`）：
 * 两份谓词必须对同一批 `kind × level` 行判定相同，否则 `health()` / `/metrics` 的
 * 节点数会把目录的 L1 概览行算进去。导出常量不改变运行期语义。
 */
export const NODE_SELF_ROW = "NOT (kind = 'directory' AND level = 'L1')";

/**
 * 这个阶段名是不是后台阶段。
 *
 * 写成 `.some()` 而不是 `ASYNC_PHASES.includes(name)`：元组式数组的 `includes`
 * 要求入参就是联合类型，调用方得先断言——那等于在唯一一处判定上关掉类型检查。
 */
function isAsyncPhase(name: string): boolean {
  return ASYNC_PHASES.some((phase) => phase === name);
}

/** §17.2 的四个阻塞阶段。名字与 `phase()` 的调用参数一致。 */
const BLOCKING_PHASES: readonly string[] = ['processStart', 'recall', 'serialize', 'capture'];

/**
 * §17.2 表格里的后台阶段：归档、抽取、合并、摘要、经验归纳。不计入阻塞开销。
 *
 * 数组是唯一来源，类型从它派生：`CommitPipeline` 的 `STEP_PHASE`
 * （`Record<CommitStepName, AsyncPhase>`）用它当值域。两边各写一份字面量时，给
 * 提交管线加一步会多出一个阶段名，而 `#asyncPhases` 的求和与 `/metrics` 的输出
 * 继续只认这五个——新步骤的耗时静默消失。
 */
const ASYNC_PHASES = ['archive', 'extract', 'merge', 'summary', 'distill'] as const;

export type AsyncPhase = (typeof ASYNC_PHASES)[number];

/**
 * `#attribute()` 的容差：0.5ms。
 *
 * 它只用来判断「阶段之和是否**超过**总耗时」——超过说明同一段被 `phase()` 套了两层，
 * 不是未归因间隙。半毫秒是浮点计时（`performance.now()` 的微秒分辨率 + 阶段边界）
 * 的误差上界，经验值，来源未知。取半毫秒而不是 0：归因报告是给人看的，差 0.1ms
 * 报一条 warn 只会让人忽略这条日志。
 */
const ATTRIBUTION_TOLERANCE_MS = 0.5;

/**
 * `degradedSummaries` 最多检查的目录数：1000。
 *
 * 经验值，来源未知：§17.5 只要求分析型统计，没给上界。每个目录要读两个摘要文件，
 * 1000 个目录约 2000 次读；健康检查是诊断端点，不该因为库大就把请求拖成秒级。
 */
const DEGRADED_DIRECTORY_LIMIT = 1000;

/**
 * 一次健康检查最多校验的画像份数：200。
 *
 * 画像一个 scope 只有一份，每份一次读，所以 200 份约等于 200 次文件读取。
 * 来源：经验值，没有实测。§17.5 把健康检查定为诊断端点（500ms 级），200 次
 * 本地读在这个预算内；画像更多的部署应该用专门的巡检脚本，而不是让 `/health`
 * 把磁盘读穿。达到上限时返回值 `truncated: true` 并记一条
 * `warn`，**不静默截断**。
 */
const PROFILE_CHECK_LIMIT = 200;

/** 1 秒 = 1000 毫秒。`durationMs` 换成 Prometheus 的秒。 */
const MILLISECONDS_PER_SECOND = 1000;

/**
 * 会在 `/metrics` 里出现的 Hook 事件：§15.2 的七个生命周期点减去 `pre_tool_use`。
 * `event` 标签只允许这几个值加 `other`。
 *
 * 白名单而不是「原样透传」：Hook 是装进宿主的独立进程，它的上报内容是外部输入，
 * 一个拼错的事件名会在指标库里造出一个新时间序列，而且永远不会有第二个样本。
 *
 * **`pre_tool_use` 不在这里。** `PreToolUse` 的处理器只做本地字符串判断、刻意不发
 * HTTP（`integrations/servers/pre-tool-use.mjs` 的文件头），它不承担开销上报——给每次
 * 工具调用加一次网络往返不值得。留在白名单里会让控制台多一个永远不会有点的行，
 * 而空行会被读成「这个事件没发生」，不是「这个事件没被采集」。它的耗时排查走宿主
 * 自己的日志。这条约定由 hook 侧的 `events.json`（`reportsOverhead: false`）与
 * `integrations/tests/event-names.test.mjs` 共同守住。
 *
 * 名字是 **snake_case**。上报方（`integrations/lib/events.json`）必须发这组名字，
 * 它同时被控制台的行键（`web/pages/monitor.vue`）与 hook 的预算表
 * （`integrations/lib/lifecycle.mjs`）使用。两边的一致性由
 * `tests/integration/services/observability.test.ts` 断言：加事件时同时改这一张表
 * 与 `integrations/lib/events.json`，不要在两个方向上各加一套映射。
 */
const HOOK_EVENTS: readonly string[] = [
  'session_start',
  'user_prompt_submit',
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
  /** 外部测量的总耗时；没传时取阶段累加值（此时报告只回答「各阶段各花了多少」）。 */
  readonly totalMs: number;
  /** 记到的阶段之和。**不超过** `totalMs`，差额是未归因间隙。 */
  readonly accountedMs: number;
  /** `totalMs - accountedMs`：没有被计时的部分，正常为正数，不会是负数 */
  readonly unattributedMs: number;
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
  /** 画像格式契约的自查结果（§11.1） */
  readonly profileFormat: ProfileFormatHealth;
}

/**
 * 画像格式契约的自查结果（§11.1）。
 *
 * 画像一个 scope 只有一份，代价是「一份文件一次读」，所以可以按 scope 逐个校验。
 * 与 `pendingReview` 等索引统计不同，它读的是**文件正文**：索引里的
 * `memory_type` 只说明这是一条画像，说明不了它是否符合格式契约。
 */
export interface ProfileFormatHealth {
  /** 成功读取并校验的画像份数（索引有节点但文件读不到的不算） */
  readonly checked: number;
  /** 至少有一条违规的画像份数（不是违规条数） */
  readonly invalid: number;
  /** 违规条数合计（一份画像可以有多条） */
  readonly violations: number;
  /**
   * 是否因为上限只检查了一部分。为 `true` 时 `checked` / `invalid` /
   * `violations` 都是**下界**，不能当成全库结论。
   */
  readonly truncated: boolean;
}

/**
 * 画像正文读取（§11.1 的格式自查）。
 *
 * `services/` 不能读盘（§4.2），由 bootstrap 用 `MemoryService.read` 注入。
 */
export interface ProfileBodyReader {
  /** 返回画像正文；索引里有节点但文件不在时返回 `null`（跳过，不计入 `checked`）。 */
  readContent(uri: Uri): Promise<string | null>;
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
  /**
   * 孤儿任务计数（§17.5 的 `orphanTasks`）。
   *
   * 用仓储的方法而不是在这里再写一条 `WHERE`：「租约过期」这个谓词只有一份
   * （`task-repository.ts` 的 `LEASE_EXPIRED_SQL`），健康度报的数字必须等于
   * `recoverExpired` 下次启动能捞回的集合。
   */
  readonly tasks: Pick<TaskRepository, 'countExpiredLeases'>;
  /** §17.4 的模型用量；`LlmService.stats` 是累加器 */
  readonly llm: Pick<LlmService, 'stats'>;
  /**
   * 画像正文读取。必须有：缺了它 `health()` 返回的 `memory.profileFormat` 会永远
   * 报 0 违规，「服务端校验画像」就变成假实现。
   */
  readonly profileBodies: ProfileBodyReader;
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
  readonly #profileBodies: ProfileBodyReader;
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
  /** 孤儿任务计数的端口（`TaskRepository`）。 */
  readonly #tasks: Pick<TaskRepository, 'countExpiredLeases'>;
  /** `telemetry.metrics.includeAccountLabel`。关掉时只输出全局汇总。 */
  readonly #includeAccountLabel: boolean;
  /** `telemetry.hookOverhead.enabled`。关掉时 `recordHookOverhead` 直接丢弃。 */
  readonly #hookOverheadEnabled: boolean;

  constructor(deps: ObservabilityServiceDeps) {
    this.#requestLog = deps.requestLog;
    this.#db = deps.db;
    this.#metadata = deps.metadata;
    this.#tasks = deps.tasks;
    this.#llm = deps.llm;
    this.#profileBodies = deps.profileBodies;
    this.#logger = deps.logger;
    this.#now = deps.now ?? (() => new Date());
    this.#policy = deps.requestLogPolicy ?? DEFAULT_REQUEST_LOG_POLICY;
    this.#includeAccountLabel = deps.includeAccountLabel ?? false;
    this.#hookOverheadEnabled = deps.hookOverheadEnabled ?? true;
  }

  /**
   * 给一个阶段计时（§17.2）。**这是唯一的阶段记录入口**：边界由调用方用 `fn` 包出来，
   * 文件名与行号就是「这个阶段从哪开始、到哪结束」的答案。
   *
   * 同名阶段多次调用**累加**（`recall` 在一次请求里可能跑几轮；累加保住「这一段总共
   * 花了多少」，覆盖会只留下最后一轮）。
   *
   * 只在 `withRequestScope()` 里有效。作用域外调用时同步阶段被丢弃并记一次 `warn`
   * ——静默丢弃会让「为什么 phases 是 NULL」变成需要读源码才能回答的问题。后台阶段
   * 是例外：它们记进进程级 `#asyncPhases`（不挂在某个请求下），不需要作用域。
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
      if (isAsyncPhase(name)) {
        this.#asyncPhases.set(name, elapsed);
      }
      const scope = this.#scope.getStore();
      if (scope === undefined) {
        if (!isAsyncPhase(name)) {
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
   * 取阶段累加值——此时两者恒等，报告只回答「各阶段各花了多少」。传了才回答
   * 「这个请求有多少是没被计时的」（`unattributedMs`）。
   *
   * **间隙不是错误。** 只有显式调用 `phase()` 的边界会计时，身份解析、路由、请求体
   * 解析、响应编码都不计时（见文件头 2.1 的表格）。所以这里只在阶段之和**超过**总耗时
   * 时记 `warn`——那是重复计时，不是间隙。
   */
  #attribute(requestId: string, measuredTotalMs?: number): LatencyAttribution {
    const phases: Record<string, number> = {};
    let accountedMs = 0;
    for (const [name, elapsed] of this.#scope.getStore() ?? new Map<string, number>()) {
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
      this.#logger.warn('阶段耗时之和超过请求总耗时，归因出现重复计时。', {
        requestId,
        totalMs,
        accountedMs,
        phases,
      });
    }

    return { requestId, totalMs, accountedMs, unattributedMs, phases, blockingMs, asyncMs };
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
    // 里另一个正在跑的请求的阶段。归因顺手在这里跑一次：`#attribute()` 的超额检查
    // 只有在真实请求上才有意义，悬空的方法永远发现不了重复计时。空 Map 写 NULL
    // （§17.6：没有计时时为 NULL）。
    const attribution = this.#attribute(entry.requestId, entry.durationMs);
    const phases = Object.keys(attribution.phases).length === 0 ? null : attribution.phases;

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
    // 后台耗时与阻塞分开（§17.2），也不挂到这次上报上：后台阶段的最近一次值由
    // `#asyncPhases` 自己维护，`/metrics` 直接按 `phase` 渲染。以前这里把同一份
    // 进程级快照复制进「刚上报的那个事件」，于是每个事件的 async 值都一样——那是
    // 给同一个值贴了不同的标签，不是维度。

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
    // 租约过期的 running 任务就是孤儿：没人续租，正常的执行器不会再碰它。谓词与
    // `TaskRepository.recoverExpired` 是同一份（`LEASE_EXPIRED_SQL`），所以这里报的
    // 数字就是下次启动扫描能捞回的任务数。
    const orphanTasks = this.#tasks.countExpiredLeases(now);
    const indexNodes = this.#count(`SELECT COUNT(*) AS total FROM node WHERE ${NODE_SELF_ROW}`);
    const oldestPendingAgeSeconds = this.#oldestPendingAgeSeconds(now);
    const degradedSummaries = await this.#countDegradedSummaries();
    const profileFormat = await this.profileFormatHealth();

    const health: MemoryHealth = {
      pendingReview,
      staleSummaries,
      degradedSummaries,
      orphanTasks,
      indexNodes,
      oldestPendingAgeSeconds,
      profileFormat,
    };
    this.#logger.debug('记忆健康度统计完成。', { ...health });
    return health;
  }

  /**
   * 画像格式契约自查（§11.1）。只由 `health()` 调用。
   *
   * 索引里 `memory_type = 'profile'` 的节点就是全部画像（画像单文件类型，一个
   * scope 一份）。逐个读正文跑 `validateProfileBody`，只统计、不修改文件。
   *
   * 不对外公开：`health()` 的 `memory.profileFormat` 是唯一出口。曾经有过一个
   * 分析端点只为避开 `health()` 的目录摘要读盘而单独调它，那个端点已删——没有
   * 第二个调用方就不留公开面（`pnpm check:reachability` 的口径：导出符号必须在
   * 入口可达的生产代码里被值引用）。
   */
  private async profileFormatHealth(): Promise<ProfileFormatHealth> {
    // 多取一行判断是否还有更多，避免再跑一次 COUNT。
    const rows = this.#db
      .prepare(
        `SELECT uri FROM node
          WHERE memory_type = 'profile'
          ORDER BY uri
          LIMIT ?`,
      )
      .all(PROFILE_CHECK_LIMIT + 1);

    const truncated = rows.length > PROFILE_CHECK_LIMIT;
    if (truncated) {
      this.#logger.warn('画像格式检查达到上限，只检查了一部分画像。', {
        limit: PROFILE_CHECK_LIMIT,
      });
    }

    let checked = 0;
    let invalid = 0;
    let violations = 0;
    for (const row of rows.slice(0, PROFILE_CHECK_LIMIT)) {
      const raw = row['uri'];
      if (typeof raw !== 'string') {
        continue;
      }
      const uri = Uri.tryParse(raw);
      if (uri === null) {
        continue;
      }
      // 单份画像读失败不能把整个健康检查打成 500：跳过并记一条 warn。
      let body: string | null;
      try {
        body = await this.#profileBodies.readContent(uri);
      } catch (error) {
        this.#logger.warn('读取画像正文失败，跳过格式检查。', {
          uri: raw,
          error: errorMessage(error),
        });
        continue;
      }
      if (body === null) {
        continue;
      }
      checked += 1;
      const found = validateProfileBody(body);
      if (found.length > 0) {
        invalid += 1;
        violations += found.length;
      }
    }

    return { checked, invalid, violations, truncated };
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
      '# HELP comem_hook_async_seconds 后台处理耗时，不阻塞用户（每个后台阶段最近一次）',
      '# TYPE comem_hook_async_seconds gauge',
    );
    // 按 `phase` 而不是 `event`：`#asyncPhases` 是进程级的「每个阶段最近一次」，
    // 同一份数据不属于任何一次 hook 上报。阶段之间是真维度（归档/抽取/合并/摘要
    // 是四个不同的操作，各有各的耗时），事件之间不是。
    for (const [phase, elapsedMs] of this.#asyncPhases) {
      lines.push(
        `comem_hook_async_seconds{phase="${phase}"} ${metricValue(
          elapsedMs / MILLISECONDS_PER_SECOND,
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
    );

    // 成本只在真算得出来的时候才有样本。`costUsd` 为 `null` 表示「没配
    // `providers.llm.default.pricing`，成本不可计算」；配了单价它就是 0 起步的累加
    // 值（`LlmService.emptyStats`）。写成 `?? 0` 会让「没配单价」与「确实花了 0
    // 美元」在 `/metrics` 上长得一模一样——控制台的「模型成本累计」就永远是
    // `$0.0000`，看起来像一份正常数据。
    // Prometheus 里「序列不存在」本身就是「未知」，不需要 `-1` 之类的哨兵值。
    if (stats.costUsd !== null) {
      lines.push(
        '# HELP comem_llm_cost_usd_total 模型成本累计，美元（§18 的 pricing 换算）',
        '# TYPE comem_llm_cost_usd_total counter',
        `comem_llm_cost_usd_total ${metricValue(stats.costUsd)}`,
      );
    }

    // 再给一个 0/1，抓取端不用猜「成本序列为什么不见了」。
    lines.push(
      '# HELP comem_llm_pricing_configured 是否配置了模型单价（0 = 未配置，成本不可计算）',
      '# TYPE comem_llm_pricing_configured gauge',
      `comem_llm_pricing_configured ${stats.costUsd === null ? 0 : 1}`,
    );

    return `${lines.join('\n')}\n`;
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
