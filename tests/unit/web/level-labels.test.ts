/**
 * 披露层级文案与领域清单的对拍（`web/utils/levelLabels.ts` ↔ `src/domain/level.ts`）。
 *
 * 控制台是独立包，不能 `import` 领域类型，所以取值在两边各声明了一份。那份重复是
 * 构造成本，不是设计选择：这里把「两份必须一样」变成测试失败，否则它会静默漂移成
 * 「服务端多一个层级、界面显示 `undefined`」。
 *
 * 断言里写的是**文档里的取值**（硬编码），不是从实现里推导的清单——从实现推导的
 * 测试会跟着实现一起漂移。两条方向分开写：任一侧加成员都会红。
 */
import { describe, expect, it } from 'vitest'

import { LEVELS as DOMAIN_LEVELS, type Level as DomainLevel } from '../../../src/domain/level.js'
import {
  LEVELS,
  LEVEL_OF_TAB,
  LEVEL_REASON,
  LEVEL_TABS,
  LEVEL_TAB_LABEL,
  LEVEL_TAB_NOTE,
  type Level,
  type LevelTab,
} from '../../../web/utils/levelLabels.js'

describe('披露层级文案', () => {
  it('层级清单是文档里的三层，且与 src/domain/level.ts 的 LEVELS 双向一致', () => {
    expect([...LEVELS]).toEqual(['L0', 'L1', 'L2'])

    const domainLevels = new Set<string>(DOMAIN_LEVELS)
    // web 清单 ⊆ 领域清单
    for (const level of LEVELS) {
      expect(domainLevels.has(level)).toBe(true)
    }
    // 领域清单 ⊆ web 清单
    for (const level of DOMAIN_LEVELS) {
      expect(LEVELS).toContain(level)
    }
  })

  it('领域层加一层时两张 Record 都会缺键（编译期）', () => {
    const webToDomain: Record<Level, DomainLevel> = { L0: 'L0', L1: 'L1', L2: 'L2' }
    const domainToWeb: Record<DomainLevel, Level> = { L0: 'L0', L1: 'L1', L2: 'L2' }

    expect(Object.keys(webToDomain)).toEqual(['L0', 'L1', 'L2'])
    expect(Object.keys(domainToWeb)).toEqual(['L0', 'L1', 'L2'])
  })

  it('文件树的三个页签与领域层级一一对应', () => {
    const tabToLevel: Record<LevelTab, Level> = { l0: 'L0', l1: 'L1', l2: 'L2' }
    const levelToTab: Record<Level, LevelTab> = { L0: 'l0', L1: 'l1', L2: 'l2' }

    expect(Object.keys(tabToLevel)).toEqual(['l0', 'l1', 'l2'])
    expect(Object.keys(levelToTab)).toEqual(['L0', 'L1', 'L2'])
    expect([...LEVEL_TABS]).toEqual(['l0', 'l1', 'l2'])
    expect(LEVEL_TABS.map((tab) => LEVEL_OF_TAB[tab])).toEqual(['L0', 'L1', 'L2'])
  })

  it('文案与清单一一对应（顺序即清单顺序）', () => {
    expect(LEVELS.map((level) => LEVEL_REASON[level])).toEqual(['摘要命中', '概览命中', '原文命中'])
    expect(LEVEL_TABS.map((tab) => LEVEL_TAB_LABEL[tab])).toEqual(['摘要', '概览', '原文'])
    expect(LEVEL_TABS.map((tab) => LEVEL_TAB_NOTE[tab])).toEqual([
      '一句话摘要，256 字符以内。',
      '目录级上下文，4000 字符以内。',
      '完整正文；目录列出直接子项。',
    ])
  })
})
