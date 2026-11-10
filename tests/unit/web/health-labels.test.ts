/**
 * 健康状态文案与领域取值域的对拍
 * （`web/utils/healthLabels.ts` ↔ `src/api/health-status.ts`）。
 *
 * 取值域是闭集，证据在 `healthStatus()` 的函数体：它由几个布尔信号或起来，只有
 * `degraded` / `ok` 两个返回值；文件头也写明「健康检查自己失败」不是第三种状态。
 * 所以这里能同时钉住两侧的运行期行为——逐个输入信号，确认领域层只会给出清单里
 * 的两个值；类型层的 `Record` 双向绑定负责「加一档而界面没跟」。
 *
 * 断言里的取值是**文档里的**（硬编码）：`/health` 两档，文案「运行正常 / 降级运行」。
 */
import { describe, expect, it } from 'vitest'

import { healthStatus, type HealthStatus as DomainHealthStatus } from '../../../src/api/health-status.js'
import {
  HEALTH_STATUSES,
  healthStatusLabel,
  type HealthStatus,
} from '../../../web/utils/healthLabels.js'

describe('健康状态文案', () => {
  it('状态清单是文档里的两档，且与领域类型双向一致', () => {
    const documented: readonly DomainHealthStatus[] = ['ok', 'degraded']

    expect([...HEALTH_STATUSES]).toEqual([...documented])
    expect(HEALTH_STATUSES.map(healthStatusLabel)).toEqual(['运行正常', '降级运行'])
  })

  it('领域层加一档时双向 Record 都会缺键（编译期）', () => {
    const webToDomain: Record<HealthStatus, DomainHealthStatus> = {
      ok: 'ok',
      degraded: 'degraded',
    }
    const domainToWeb: Record<DomainHealthStatus, HealthStatus> = {
      ok: 'ok',
      degraded: 'degraded',
    }

    expect(Object.keys(webToDomain)).toEqual([...HEALTH_STATUSES])
    expect(Object.keys(domainToWeb)).toEqual([...HEALTH_STATUSES])
  })

  it('判定只会产出清单里的值：健康时 ok、有降级信号时 degraded', () => {
    expect(healthStatus({ ruleGenerator: false, rerankDegraded: false })).toBe('ok')
    expect(healthStatus({ ruleGenerator: true, rerankDegraded: false })).toBe('degraded')
    expect(healthStatus({ ruleGenerator: false, rerankDegraded: true })).toBe('degraded')
    expect(healthStatus({ ruleGenerator: false, rerankDegraded: false, indexUnavailable: true })).toBe(
      'degraded',
    )
    expect(
      healthStatus({ ruleGenerator: false, rerankDegraded: false, degradedSummaries: 1 }),
    ).toBe('degraded')
  })
})
