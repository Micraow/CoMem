/**
 * 会话状态、消息角色文案与领域清单的对拍（`web/utils/sessionLabels.ts` ↔ `src/domain/session.ts`）。
 *
 * 两份清单都是领域层的闭集：
 *
 * - 角色有导出的运行期数组（`MESSAGE_ROLES`），直接两个方向对拍；
 * - 会话状态在领域层是类型联合 + 一个不导出的 `Record`（只有 `isSessionStatus`
 *   守卫），所以这里用硬编码清单 + 守卫（web 清单 ⊆ 领域层）+ 双向 `Record`
 *   （编译期：任一侧多一个成员都在 `pnpm typecheck` 时失败）。
 */
import { describe, expect, it } from 'vitest'

import {
  MESSAGE_ROLES as DOMAIN_MESSAGE_ROLES,
  isSessionStatus,
  type SessionStatus as DomainSessionStatus,
} from '../../../src/domain/session.js'
import {
  MESSAGE_ROLES,
  SESSION_STATUSES,
  messageRoleLabel,
  sessionStatusLabel,
  type SessionStatus,
} from '../../../web/utils/sessionLabels.js'

describe('会话状态与角色文案', () => {
  it('会话状态清单是文档里的两个', () => {
    expect([...SESSION_STATUSES]).toEqual(['open', 'archived'])
  })

  it('领域层的状态守卫接受清单里的每个值', () => {
    for (const status of SESSION_STATUSES) {
      expect(isSessionStatus(status)).toBe(true)
    }
  })

  it('领域层加一个会话状态时清单必须跟上（编译期）', () => {
    const webToDomain: Record<SessionStatus, DomainSessionStatus> = {
      open: 'open',
      archived: 'archived',
    }
    const domainToWeb: Record<DomainSessionStatus, SessionStatus> = {
      open: 'open',
      archived: 'archived',
    }
    expect(Object.keys(webToDomain).sort()).toEqual([...SESSION_STATUSES].sort())
    expect(Object.keys(domainToWeb).sort()).toEqual([...SESSION_STATUSES].sort())
  })

  it('角色清单与 src/domain/session.ts 的 MESSAGE_ROLES 一致', () => {
    expect([...MESSAGE_ROLES]).toEqual(['user', 'assistant', 'system', 'tool'])
    expect([...MESSAGE_ROLES]).toEqual([...DOMAIN_MESSAGE_ROLES])
  })

  it('状态与角色都有非空中文文案', () => {
    expect(SESSION_STATUSES.map(sessionStatusLabel)).toEqual(['进行中', '已归档'])
    expect(MESSAGE_ROLES.map(messageRoleLabel)).toEqual(['用户', '助手', '系统', '工具'])
  })
})
