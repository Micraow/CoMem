/**
 * 健康状态 → 界面文案（概览页与监控页共用一份）。
 *
 * ## 取值域是闭集
 *
 * `GET /health` 的 `status` 由 `src/api/health-status.ts` 的 `healthStatus()` 计算，
 * 返回类型是 `HealthStatus = 'ok' | 'degraded'`，函数体只有两个返回值。文件头写明
 * 「健康检查自己失败」不是第三种状态（HTTP 侧返回 500 错误封套，MCP 侧仍能给出其余
 * 字段），早期的 `error` 档已经删掉。所以 `routes/ops.ts` 的 `status` 字段只可能是
 * 这两个值，界面不需要兜底。
 *
 * 两页曾各写一份内联三元（`health.status === 'degraded' ? '降级运行' : '运行正常'`）：
 * 领域层加一档时，两处都静默显示「运行正常」——一个坏掉的部署看起来像好的。
 *
 * 控制台不能 import `src/api`，所以这里的 `as const` 数组是 web 侧的取值来源：
 * 类型从数组派生，映射用 `satisfies Record<状态, 文案>` 穷举。跨项目一致性由
 * `tests/unit/web/health-labels.test.ts` 对拍——那是唯一同时 import 两边的地方。
 *
 * 徽章配色不在这里：概览页只有一枚徽章、监控页的徽章在无数据时整格收起，两处的
 * 颜色语义不同，颜色留在各自的组件里。
 */

/** `HealthStatus`（`src/api/health-status.ts`）。 */
export const HEALTH_STATUSES = ['ok', 'degraded'] as const

export type HealthStatus = (typeof HEALTH_STATUSES)[number]

/** 状态 → 文案。漏一个 `HealthStatus` 即编译失败，多一个键也是。 */
const HEALTH_STATUS_LABEL = {
  ok: '运行正常',
  degraded: '降级运行',
} satisfies Record<HealthStatus, string>

/** 状态 → 界面文案（`HealthPayload.status` 用这里的 `HealthStatus`）。 */
export function healthStatusLabel(status: HealthStatus): string {
  return HEALTH_STATUS_LABEL[status]
}

/**
 * 徽章要用的 `/health` 字段（只取判定需要的，页面绑定用）。
 *
 * `summary.degraded` 是服务端 `config.summary.generator === 'rule'` 的布尔值，
 * **不是**「摘要失败」：规则生成器是没配模型时的正常路径，它产出的每个摘要都会
 * 把目录标成 `degraded`（`RuleSummarizer` 恒返回 `degraded: true`）。所以
 * `degradedDirs > 0` 在规则模式下是正常现象，只有 `summary.degraded === false`
 * （模型生成器）时它才代表模型摘要失败。
 *
 * `rerank` 在响应里始终有；这里写成可选是为了让「只拿到 status」的旧响应与
 * 测试里的小对象也能用同一个判定。
 */
export interface HealthSignals {
  readonly status?: HealthStatus
  readonly summary?: {
    /** 摘要生成器是不是规则生成（服务端字段名如此，语义见上）。 */
    readonly degraded: boolean
    readonly degradedDirs: number
  }
  readonly rerank?: {
    readonly configured: boolean
    readonly degraded: boolean
    readonly failures: number
  }
  readonly memoryExtract?: {
    readonly skipped: boolean
  }
}

/** 徽章配色。中性 = 合法状态，绿色 = 正常，橙色 = 配了但坏了。 */
export type HealthBadgeVariant = 'gray' | 'green' | 'orange'

export interface HealthBadgeView {
  readonly variant: HealthBadgeVariant
  readonly label: string
  /** 未配置模型时给出去配置的入口；其它情况为 null。 */
  readonly action: 'configure-model' | null
}

/**
 * `/health` → 徽章。**「没配」与「配了但坏了」不是一回事。**
 *
 * 判定顺序：
 *
 * 1. 有真实失败（模型摘要失败、重排配置后失败）→ 警示，保留「降级运行」；
 * 2. 没有模型（归档跳过记忆抽取）→ 中性「精简模式」，附「去配置模型」；
 * 3. 配了模型但摘要生成器选的是规则 → 中性「规则摘要模式」，这是配置选择；
 * 4. 其余 → 绿色「运行正常」。
 *
 * 只有 `status` 而没有细节的旧响应仍按 `status` 兜底，避免把降级说成正常。
 */
export function healthBadgeOf(health: HealthSignals): HealthBadgeView {
  const summaryFailed =
    health.summary !== undefined &&
    !health.summary.degraded &&
    health.summary.degradedDirs > 0
  const rerankFailed =
    health.rerank !== undefined &&
    health.rerank.configured &&
    (health.rerank.degraded || health.rerank.failures > 0)

  if (summaryFailed || rerankFailed) {
    return { variant: 'orange', label: HEALTH_STATUS_LABEL.degraded, action: null }
  }
  if (health.memoryExtract?.skipped === true) {
    return {
      variant: 'gray',
      label: '精简模式（未配置模型）',
      action: 'configure-model',
    }
  }
  if (health.summary?.degraded === true) {
    return { variant: 'gray', label: '规则摘要模式', action: null }
  }
  if (health.status === 'degraded') {
    return { variant: 'orange', label: HEALTH_STATUS_LABEL.degraded, action: null }
  }
  return { variant: 'green', label: HEALTH_STATUS_LABEL.ok, action: null }
}

/**
 * 摘要目录数在没有模型时是「规则摘要目录」，不是「降级目录」。
 *
 * 概览页的指标标签与监控页的仪表共用这一个判断：`summary.degraded` 为真表示
 * 生成器是规则模式，此时 `degradedDirs` 是规则摘要的目录数，不是故障数。
 */
export function isRuleSummary(health: Pick<HealthSignals, 'summary'>): boolean {
  return health.summary?.degraded === true
}

/** 模型摘要失败（规则模式下的 `degradedDirs` 不算）。 */
export function hasSummaryFailure(health: Pick<HealthSignals, 'summary'>): boolean {
  return (
    health.summary !== undefined &&
    !health.summary.degraded &&
    health.summary.degradedDirs > 0
  )
}
