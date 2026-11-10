/**
 * 会话状态、消息角色 → 界面文案（「会话与任务」页的会话列表）。
 *
 * ## 为什么取值也在这里声明一份
 *
 * 两张清单都来自 `src/domain/session.ts`：`SessionStatus`（`open` / `archived`）与
 * `MESSAGE_ROLES`（`user` / `assistant` / `system` / `tool`）。`GET /sessions` 的
 * `serializeSession()` 原样输出 `session.status` 与 `session.messages` 的 `role`，
 * 两者都是领域层类型，没有清单外的生产者——旧实现的 `?? 原值` 兜底永远不命中，
 * 它只是把「领域层加一个状态、界面没跟」变成界面上一格英文原值。
 *
 * 控制台不能 import 后端类型，所以这里的 `as const` 数组是 web 侧的取值来源：类型
 * 从数组派生，映射用 `satisfies Record<类型, 文案>` 穷举。跨项目一致性由
 * `tests/unit/web/session-labels.test.ts` 对拍。
 */
export const SESSION_STATUSES = ['open', 'archived'] as const

export type SessionStatus = (typeof SESSION_STATUSES)[number]

/** 顺序与领域层一致（`MESSAGE_ROLES`），枚举即文档。 */
export const MESSAGE_ROLES = ['user', 'assistant', 'system', 'tool'] as const

export type MessageRole = (typeof MESSAGE_ROLES)[number]

/** 状态 → 文案。漏一个状态即编译失败，多一个键也是。 */
const SESSION_STATUS_LABEL = {
  open: '进行中',
  archived: '已归档',
} satisfies Record<SessionStatus, string>

/** 角色 → 文案。漏一个角色即编译失败，多一个键也是。 */
const MESSAGE_ROLE_LABEL = {
  user: '用户',
  assistant: '助手',
  system: '系统',
  tool: '工具',
} satisfies Record<MessageRole, string>

/** 状态 → 界面文案（`SessionSummaryPayload.status` 用这里的 `SessionStatus`）。 */
export function sessionStatusLabel(status: SessionStatus): string {
  return SESSION_STATUS_LABEL[status]
}

/** 角色 → 界面文案（`SessionMessagePayload.role` 用这里的 `MessageRole`）。 */
export function messageRoleLabel(role: MessageRole): string {
  return MESSAGE_ROLE_LABEL[role]
}
