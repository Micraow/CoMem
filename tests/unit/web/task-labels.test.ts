/**
 * 控制台标签映射与领域类型的对拍（`web/utils/taskLabels.ts` ↔ `src/domain/task.ts`）。
 *
 * 控制台是独立包（`web/` 不在根 pnpm workspace 里），不能 `import` 领域类型，所以
 * 取值在两边各声明了一份。那份重复是构造成本，不是设计选择：这里把「两份必须一样」
 * 变成测试失败，否则它会静默漂移成「服务端多一个状态、界面显示英文原值」。
 *
 * 断言里写的是**文档里的取值**（硬编码），不是从实现里推导的清单——从实现推导的
 * 测试会跟着实现一起漂移。
 */
import { describe, expect, it } from 'vitest'

import {
  CLAIMABLE_TASK_STATUSES as DOMAIN_CLAIMABLE_STATUSES,
  TASK_STATUSES as DOMAIN_STATUSES,
  TASK_TYPES as DOMAIN_TASK_TYPES,
} from '../../../src/domain/task.js'
import {
  CLAIMABLE_TASK_STATUSES,
  TASK_TYPES,
  taskStatusLabelOf,
  taskTypeLabelOf,
} from '../../../web/utils/taskLabels.js'

describe('任务标签映射', () => {
  it('类型清单与 src/domain/task.ts 一致', () => {
    expect([...TASK_TYPES]).toEqual(['archive'])
    expect([...TASK_TYPES]).toEqual([...DOMAIN_TASK_TYPES])
  })

  it('可认领状态清单与 src/domain/task.ts 一致', () => {
    // `/tasks` 只返回可认领的任务：`pending`，或租约过期的 `running`。
    expect([...CLAIMABLE_TASK_STATUSES]).toEqual(['pending', 'running'])
    expect([...CLAIMABLE_TASK_STATUSES]).toEqual([...DOMAIN_CLAIMABLE_STATUSES])
  })

  it('可认领状态是 TaskStatus 的子集，且不含终态', () => {
    for (const status of CLAIMABLE_TASK_STATUSES) {
      expect(DOMAIN_STATUSES).toContain(status)
    }
    // 这两个状态不会出现在 `/tasks` 的响应里，所以标签表不为它们写文案。
    expect(CLAIMABLE_TASK_STATUSES).not.toContain('done')
    expect(CLAIMABLE_TASK_STATUSES).not.toContain('failed')
  })

  it('每个取值都有非空中文标签', () => {
    for (const type of TASK_TYPES) {
      expect(taskTypeLabelOf(type)).not.toBe('')
      expect(taskTypeLabelOf(type)).not.toBe(type)
    }
    for (const status of CLAIMABLE_TASK_STATUSES) {
      expect(taskStatusLabelOf(status)).not.toBe('')
      expect(taskStatusLabelOf(status)).not.toBe(status)
    }
  })
})
