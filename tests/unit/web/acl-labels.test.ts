/**
 * 授权文案与领域清单的对拍（`web/utils/aclLabels.ts` ↔ `src/domain/acl.ts`）。
 *
 * 三张清单都是领域层导出的运行期数组，且与服务端校验输入用的是同一份
 * （`src/api/http/routes/acl.ts` 的 `parseLevel` / `parseEffect` / `parseMode`）。
 * 这里两个方向各断言一次，再加两组双向 `Record` 把编译期也钉住：
 * 任一侧多一个成员，`npx vitest run tests/unit/web/` 或 `pnpm --dir web typecheck`
 * 都会失败。
 *
 * 断言里的取值是**文档里的**（硬编码）：`ACL_LEVELS` 的 1 / 3 / 7 来自架构文档
 * §12.1，不是从实现里读出来的。
 */
import { describe, expect, it } from 'vitest'

import {
  ACL_EFFECTS as DOMAIN_EFFECTS,
  ACL_LEVELS as DOMAIN_LEVELS,
  ACL_MODES as DOMAIN_MODES,
  type AclEffect as DomainAclEffect,
  type AclLevel as DomainAclLevel,
  type AclMode as DomainAclMode,
} from '../../../src/domain/acl.js'
import {
  ACL_EFFECTS,
  ACL_EFFECT_LABEL,
  ACL_LEVELS,
  ACL_LEVEL_LABEL,
  ACL_MODES,
  ACL_MODE_LABEL,
  type AclEffect,
  type AclLevel,
  type AclMode,
} from '../../../web/utils/aclLabels.js'

describe('授权文案', () => {
  it('级别清单是文档里的三档，且与 src/domain/acl.ts 双向一致', () => {
    expect([...ACL_LEVELS]).toEqual([1, 3, 7])

    const domainLevels = new Set<number>(DOMAIN_LEVELS)
    // web 清单 ⊆ 领域清单
    for (const level of ACL_LEVELS) {
      expect(domainLevels.has(level)).toBe(true)
    }
    // 领域清单 ⊆ web 清单
    for (const level of DOMAIN_LEVELS) {
      expect(ACL_LEVELS).toContain(level)
    }
  })

  it('效果清单与领域层双向一致', () => {
    expect([...ACL_EFFECTS]).toEqual(['allow', 'deny'])

    const domainEffects = new Set<string>(DOMAIN_EFFECTS)
    for (const effect of ACL_EFFECTS) {
      expect(domainEffects.has(effect)).toBe(true)
    }
    for (const effect of DOMAIN_EFFECTS) {
      expect(ACL_EFFECTS).toContain(effect)
    }
  })

  it('继承模式清单与领域层双向一致', () => {
    expect([...ACL_MODES]).toEqual(['inherit', 'restricted'])

    const domainModes = new Set<string>(DOMAIN_MODES)
    for (const mode of ACL_MODES) {
      expect(domainModes.has(mode)).toBe(true)
    }
    for (const mode of DOMAIN_MODES) {
      expect(ACL_MODES).toContain(mode)
    }
  })

  it('任一侧加成员时双向 Record 都会缺键（编译期）', () => {
    const levelsWebToDomain: Record<AclLevel, DomainAclLevel> = { 1: 1, 3: 3, 7: 7 }
    const levelsDomainToWeb: Record<DomainAclLevel, AclLevel> = { 1: 1, 3: 3, 7: 7 }
    const effectsWebToDomain: Record<AclEffect, DomainAclEffect> = {
      allow: 'allow',
      deny: 'deny',
    }
    const effectsDomainToWeb: Record<DomainAclEffect, AclEffect> = {
      allow: 'allow',
      deny: 'deny',
    }
    const modesWebToDomain: Record<AclMode, DomainAclMode> = {
      inherit: 'inherit',
      restricted: 'restricted',
    }
    const modesDomainToWeb: Record<DomainAclMode, AclMode> = {
      inherit: 'inherit',
      restricted: 'restricted',
    }

    expect(Object.keys(levelsWebToDomain)).toEqual(['1', '3', '7'])
    expect(Object.keys(levelsDomainToWeb)).toEqual(['1', '3', '7'])
    expect(Object.keys(effectsWebToDomain)).toEqual(['allow', 'deny'])
    expect(Object.keys(effectsDomainToWeb)).toEqual(['allow', 'deny'])
    expect(Object.keys(modesWebToDomain)).toEqual(['inherit', 'restricted'])
    expect(Object.keys(modesDomainToWeb)).toEqual(['inherit', 'restricted'])
  })

  it('文案与清单一一对应（顺序即清单顺序）', () => {
    expect(ACL_LEVELS.map((level) => ACL_LEVEL_LABEL[level])).toEqual(['读取', '写入', '管理'])
    expect(ACL_EFFECTS.map((effect) => ACL_EFFECT_LABEL[effect])).toEqual(['允许', '拒绝'])
    expect(ACL_MODES.map((mode) => ACL_MODE_LABEL[mode])).toEqual(['继承父级', '仅本节点'])
  })
})
