/**
 * 用户状态、组成员角色 → 界面文案（用户与组页共用一份）。
 *
 * ## 为什么取值也在这里声明一份
 *
 * 两张清单都来自 `src/domain/identity.ts`：`User.status` 是 `'active' | 'disabled'`，
 * `GroupMember.role` 是 `'owner' | 'member'`（`role` 是派生字段，`userId ===
 * group.ownerUserId` 才是 `owner`，见 `src/services/identity.ts`）。`GET /admin/users`
 * 原样输出 `user.status`，`GET /admin/groups/:id/members` 原样输出 `members`，
 * 中间没有运行期映射产生新值。
 *
 * 旧实现把两处映射写成内联三元（`user.status === 'active' ? '启用' : '已禁用'`、
 * `member.role === 'owner' ? '所有者' : '成员'`）：领域层加一个状态时，界面不报错，
 * 而是安静地把它显示成「已禁用」/「成员」——一个错误的标签比一句英文更难发现。
 *
 * 控制台不能 import 后端类型，所以这里的 `as const` 数组是 web 侧的取值来源：
 * 类型从数组派生，映射用 `satisfies Record<类型, 文案>` 穷举。跨项目一致性由
 * `tests/unit/web/user-labels.test.ts` 对拍——那是唯一同时 import 两边的地方。
 *
 * 文案只描述业务状态，配色留在各组件里（表格与表单的调色板不同，颜色不是文案）。
 */

/** `User.status`（`src/domain/identity.ts`）。 */
export const USER_STATUSES = ['active', 'disabled'] as const

export type UserStatus = (typeof USER_STATUSES)[number]

/** `GroupMember.role`（`src/domain/identity.ts`）。 */
export const GROUP_MEMBER_ROLES = ['owner', 'member'] as const

export type GroupMemberRole = (typeof GROUP_MEMBER_ROLES)[number]

/** 状态 → 文案。漏一个 `UserStatus` 即编译失败，多一个键也是。 */
const USER_STATUS_LABEL = {
  active: '启用',
  disabled: '已禁用',
} satisfies Record<UserStatus, string>

/** 角色 → 文案。漏一个 `GroupMemberRole` 即编译失败，多一个键也是。 */
const GROUP_MEMBER_ROLE_LABEL = {
  owner: '所有者',
  member: '成员',
} satisfies Record<GroupMemberRole, string>

/** 状态 → 界面文案（`UserRowPayload.status` 用这里的 `UserStatus`）。 */
export function userStatusLabel(status: UserStatus): string {
  return USER_STATUS_LABEL[status]
}

/** 角色 → 界面文案（`GroupMemberPayload.role` 用这里的 `GroupMemberRole`）。 */
export function groupMemberRoleLabel(role: GroupMemberRole): string {
  return GROUP_MEMBER_ROLE_LABEL[role]
}
