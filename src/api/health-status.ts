/**
 * `/health` 与 MCP `health` 的状态判定（架构文档 §17.9）。
 *
 * 两个入口以前各写一份：HTTP 的枚举是 `{ok, degraded}`，MCP 多一个 `error`
 * （索引计数抛异常时），而且 HTTP 计入降级摘要数、MCP 不计。同一个部署下用两种
 * 方式健康检查会得到不同结论，排障时先得判断「是服务变了还是入口不同」。
 *
 * 判定只保留两个状态：
 *
 * - `degraded`：某一环节「配了但没生效」，或降级路径正在使用，结果质量会下降；
 * - `ok`：其余。
 *
 * 「健康检查自己失败」不是第三种状态：HTTP 拿不到 `ObservabilityService.health()`
 * 时返回 500 错误封套，MCP 索引计数失败时仍能给出其余字段。把后者记成 `error`
 * 会让「服务坏了」与「一项统计失败」在监控里变成同一件事，也会改动 HTTP 已有的
 * `status` 契约。
 */

export type HealthStatus = 'ok' | 'degraded';

export interface HealthSignals {
  /** 摘要生成器配成 `rule`：模型不可用时的降级路径。 */
  readonly ruleGenerator: boolean;
  /** 最近一次重排调用失败（已退回融合分）。 */
  readonly rerankDegraded: boolean;
  /**
   * 磁盘上标记为降级的目录摘要数。
   *
   * 两个入口都从 `ObservabilityService.health()` 取同一个数（MCP 的 `health` 工具
   * 与 HTTP `/health`），不在任一侧重算：同一个部署的健康结论必须一样。
   */
  readonly degradedSummaries?: number;
  /** 索引计数失败：这一项统计不到，不等于服务不可用。 */
  readonly indexUnavailable?: boolean;
}

export function healthStatus(signals: HealthSignals): HealthStatus {
  const degraded =
    signals.ruleGenerator ||
    signals.rerankDegraded ||
    (signals.degradedSummaries ?? 0) > 0 ||
    signals.indexUnavailable === true;
  return degraded ? 'degraded' : 'ok';
}
