/**
 * 可观测性服务的公开契约：只读数据库端口、Hook 上报、归因报告、请求记录。
 *
 * 总体设计见 `../observability.ts` 的文件头。这里只放跨文件共用的类型与默认值，
 * 实现分散在同目录的 `timing.ts` / `metrics.ts` / `health.ts` 等模块。
 */

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

export const DEFAULT_REQUEST_LOG_POLICY: RequestLogPolicy = Object.freeze({
  enabled: true,
  sampleRate: 1,
});
