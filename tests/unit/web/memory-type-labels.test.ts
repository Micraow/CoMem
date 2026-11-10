/**
 * 记忆类型文案与领域清单的对拍
 * （`web/utils/memoryTypeLabels.ts` ↔ `src/domain/memory-types/index.ts`）。
 *
 * 控制台是独立包，不能 `import` 领域类型，所以取值在两边各声明了一份。那份重复是
 * 构造成本，不是设计选择：这里把「两份必须一样」变成测试失败，否则它会静默漂移成
 * 「服务端多一个记忆类型、界面显示英文原值」——`ReviewList.vue` 与 `HitList.vue`
 * 改之前就是这个状态：八个内置类型里只有 `experiences` / `rules` 有配色，名字全部
 * 直接打印原值。
 *
 * 断言里写的是**文档里的取值**（硬编码，架构文档 §11.1 的清单），不是从实现里推导
 * 的清单——从实现推导的测试会跟着实现一起漂移。两条方向分开写：任一侧加成员都会红。
 *
 * `memoryType` 在领域层**刻意是开放字符串**（`MemoryDocument.memoryType` 是
 * `string`，自定义类型不进内置表也要能读出来），所以这里同时钉住兜底行为：未知类型
 * 显示原值，不显示「未知」。
 */
import { describe, expect, it } from 'vitest'

import {
  BUILTIN_MEMORY_TYPE_NAMES as DOMAIN_MEMORY_TYPES,
  type MemoryType as DomainMemoryType,
} from '../../../src/domain/memory-types/index.js'
import {
  MEMORY_TYPES,
  memoryTypeLabelOf,
  memoryTypeVariantOf,
  type MemoryType,
} from '../../../web/utils/memoryTypeLabels.js'

describe('记忆类型文案', () => {
  it('清单是文档里的八个，且与领域清单双向一致', () => {
    expect([...MEMORY_TYPES]).toEqual([
      'profile',
      'preferences',
      'entities',
      'events',
      'identity',
      'soul',
      'experiences',
      'rules',
    ])

    const domainTypes = new Set<string>(DOMAIN_MEMORY_TYPES)
    // web 清单 ⊆ 领域清单
    for (const memoryType of MEMORY_TYPES) {
      expect(domainTypes.has(memoryType)).toBe(true)
    }
    // 领域清单 ⊆ web 清单（顺序也一致：两边都以文档的展示顺序为唯一来源）
    for (const memoryType of DOMAIN_MEMORY_TYPES) {
      expect(MEMORY_TYPES).toContain(memoryType)
    }
    expect([...MEMORY_TYPES]).toEqual([...DOMAIN_MEMORY_TYPES])
  })

  it('领域层加一个记忆类型时两张 Record 都会缺键（编译期）', () => {
    const webToDomain: Record<MemoryType, DomainMemoryType> = {
      profile: 'profile',
      preferences: 'preferences',
      entities: 'entities',
      events: 'events',
      identity: 'identity',
      soul: 'soul',
      experiences: 'experiences',
      rules: 'rules',
    }
    const domainToWeb: Record<DomainMemoryType, MemoryType> = {
      profile: 'profile',
      preferences: 'preferences',
      entities: 'entities',
      events: 'events',
      identity: 'identity',
      soul: 'soul',
      experiences: 'experiences',
      rules: 'rules',
    }

    // 运行期再把编译期的覆盖面核对一次：领域层多一个值、这里没补映射就失败。
    expect(Object.keys(webToDomain).sort()).toEqual([...MEMORY_TYPES].sort())
    expect(Object.keys(domainToWeb).sort()).toEqual([...DOMAIN_MEMORY_TYPES].sort())
  })

  it('八个类型都有中文名，顺序即清单顺序', () => {
    expect(MEMORY_TYPES.map(memoryTypeLabelOf)).toEqual([
      '画像',
      '偏好',
      '实体',
      '事件',
      '身份',
      '原则',
      '经验',
      '规则',
    ])
  })

  it('未知类型显示原值，不显示「未知」', () => {
    // 自定义记忆类型是合法数据：没注册进内置表不代表它不存在。
    expect(memoryTypeLabelOf('custom-type')).toBe('custom-type')
    expect(memoryTypeLabelOf('')).toBe('')
    // 配色对未知类型落中性灰，但没有把名字换掉。
    expect(memoryTypeVariantOf('custom-type')).toBe('gray')
  })

  it('徽章配色沿用复核闸门的语义', () => {
    expect(MEMORY_TYPES.map(memoryTypeVariantOf)).toEqual([
      'gray',
      'gray',
      'gray',
      'gray',
      'gray',
      'gray',
      'blue',
      'purple',
    ])
  })
})
