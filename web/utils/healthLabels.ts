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
