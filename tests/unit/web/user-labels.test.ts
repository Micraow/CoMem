/**
 * 用户状态、组成员角色文案与领域取值域的对拍
 * （`web/utils/userLabels.ts` ↔ `src/domain/identity.ts`）。
 *
 * 两个取值在领域层都是**内联字面量联合**（`User.status`、`GroupMember.role`），
 * 没有导出的运行期数组：`routes/admin.ts` 的 `USER_STATUSES` 与建表 SQL 的
 * `CHECK (role IN ('owner','member'))` 各自写了一份，但都不在 `domain/` 的公开面上。
 * 所以双向绑定以类型层为准：`Record<DomainUserStatus, UserStatus>` 与反向任一侧
 * 多一个成员都会在 `pnpm typecheck` 时缺键；运行期断言核对的是文档里的取值与文案，
 * 不假装能枚举领域层。
 *
 * 断言里的取值是**文档里的**（硬编码）：状态是「启用 / 已禁用」，角色是
 * 「所有者 / 成员」，不是从实现里读出来的——从实现推导的测试会跟着实现一起漂移。
 */
import { describe, expect, it } from 'vitest'

import type { GroupMember, User } from '../../../src/domain/identity.js'
import {
  GROUP_MEMBER_ROLES,
  USER_STATUSES,
  groupMemberRoleLabel,
  userStatusLabel,
  type GroupMemberRole,
  type UserStatus,
} from '../../../web/utils/userLabels.js'

type DomainUserStatus = User['status']
type DomainGroupMemberRole = GroupMember['role']

describe('用户与组成员文案', () => {
  it('用户状态清单是文档里的两档，且与领域类型双向一致', () => {
    const documented: readonly DomainUserStatus[] = ['active', 'disabled']

    expect([...USER_STATUSES]).toEqual([...documented])
    // 标签文案与清单一一对应（顺序即清单顺序）。
    expect(USER_STATUSES.map(userStatusLabel)).toEqual(['启用', '已禁用'])
  })

  it('组成员角色清单是文档里的两档，且与领域类型双向一致', () => {
    const documented: readonly DomainGroupMemberRole[] = ['owner', 'member']

    expect([...GROUP_MEMBER_ROLES]).toEqual([...documented])
    expect(GROUP_MEMBER_ROLES.map(groupMemberRoleLabel)).toEqual(['所有者', '成员'])
  })

  it('领域层加成员时双向 Record 都会缺键（编译期）', () => {
    const statusesWebToDomain: Record<UserStatus, DomainUserStatus> = {
      active: 'active',
      disabled: 'disabled',
    }
    const statusesDomainToWeb: Record<DomainUserStatus, UserStatus> = {
      active: 'active',
      disabled: 'disabled',
    }
    const rolesWebToDomain: Record<GroupMemberRole, DomainGroupMemberRole> = {
      owner: 'owner',
      member: 'member',
    }
    const rolesDomainToWeb: Record<DomainGroupMemberRole, GroupMemberRole> = {
      owner: 'owner',
      member: 'member',
    }

    // 运行期再核对一次编译期覆盖面。
    expect(Object.keys(statusesWebToDomain)).toEqual([...USER_STATUSES])
    expect(Object.keys(statusesDomainToWeb)).toEqual([...USER_STATUSES])
    expect(Object.keys(rolesWebToDomain)).toEqual([...GROUP_MEMBER_ROLES])
    expect(Object.keys(rolesDomainToWeb)).toEqual([...GROUP_MEMBER_ROLES])
  })
})
