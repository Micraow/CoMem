/**
 * 检索意图、上下文类型文案与领域清单的对拍
 * （`web/utils/searchLabels.ts` ↔ `src/domain/retrieval.ts` / `src/domain/node.ts`）。
 *
 * 控制台是独立包，不能 `import` 领域类型，所以取值在两边各声明了一份。那份重复是
 * 构造成本，不是设计选择：这里把「两份必须一样」变成测试失败，否则它会静默漂移成
 * 「服务端多一个意图、界面显示 `undefined`」。
 *
 * 断言里写的是**文档里的取值**（硬编码），不是从实现里推导的清单——从实现推导的
 * 测试会跟着实现一起漂移。两条方向分开写：任一侧加成员都会红。
 */
import { describe, expect, it } from 'vitest'

import {
  CONTEXT_TYPES as DOMAIN_CONTEXT_TYPES,
  type ContextType as DomainContextType,
} from '../../../src/domain/node.js'
import { TYPED_QUERY_INTENTS as DOMAIN_INTENTS } from '../../../src/domain/retrieval.js'
import {
  CONTEXT_TYPES,
  CONTEXT_LABEL,
  TYPED_QUERY_INTENTS,
  typedQueryIntentLabel,
  type ContextType,
} from '../../../web/utils/searchLabels.js'

describe('检索意图文案', () => {
  it('意图清单是文档里的六个，且与 TYPED_QUERY_INTENTS 双向一致', () => {
    expect([...TYPED_QUERY_INTENTS]).toEqual([
      'preference',
      'fact',
      'decision',
      'event',
      'procedure',
      'other',
    ])

    const domainIntents = new Set<string>(DOMAIN_INTENTS)
    for (const intent of TYPED_QUERY_INTENTS) {
      expect(domainIntents.has(intent)).toBe(true)
    }
    for (const intent of DOMAIN_INTENTS) {
      expect(TYPED_QUERY_INTENTS).toContain(intent)
    }
  })

  it('每个意图都有非空中文文案', () => {
    for (const intent of TYPED_QUERY_INTENTS) {
      expect(typedQueryIntentLabel(intent)).not.toBe('')
      expect(typedQueryIntentLabel(intent)).not.toBe(intent)
    }
  })

  it('文案与清单一一对应（顺序即清单顺序）', () => {
    expect(TYPED_QUERY_INTENTS.map(typedQueryIntentLabel)).toEqual([
      '偏好',
      '事实',
      '决定',
      '事件',
      '流程',
      '其他',
    ])
  })
})

describe('上下文类型文案', () => {
  it('类型清单是文档里的四个，且与 src/domain/node.ts 的 CONTEXT_TYPES 双向一致', () => {
    expect([...CONTEXT_TYPES]).toEqual(['memory', 'resource', 'skill', 'session'])

    const domainTypes = new Set<string>(DOMAIN_CONTEXT_TYPES)
    // web 清单 ⊆ 领域清单
    for (const contextType of CONTEXT_TYPES) {
      expect(domainTypes.has(contextType)).toBe(true)
    }
    // 领域清单 ⊆ web 清单
    for (const contextType of DOMAIN_CONTEXT_TYPES) {
      expect(CONTEXT_TYPES).toContain(contextType)
    }
  })

  it('领域层加一类上下文时两张 Record 都会缺键（编译期）', () => {
    const webToDomain: Record<ContextType, DomainContextType> = {
      memory: 'memory',
      resource: 'resource',
      skill: 'skill',
      session: 'session',
    }
    const domainToWeb: Record<DomainContextType, ContextType> = {
      memory: 'memory',
      resource: 'resource',
      skill: 'skill',
      session: 'session',
    }

    expect(Object.keys(webToDomain)).toEqual(['memory', 'resource', 'skill', 'session'])
    expect(Object.keys(domainToWeb)).toEqual(['memory', 'resource', 'skill', 'session'])
  })

  it('每个上下文类型都有中文文案，且不等于原值', () => {
    expect(CONTEXT_TYPES.map((contextType) => CONTEXT_LABEL[contextType])).toEqual([
      '记忆',
      '资源',
      '技能',
      '会话',
    ])
  })
})
