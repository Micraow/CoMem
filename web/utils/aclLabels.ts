/**
 * 授权级别、效果、继承模式 → 界面文案（权限管理页与文件树右栏共用一份）。
 *
 * 三份映射曾在 `components/domain/AclEditor.vue`、`AclChain.vue` 与
 * `SummaryPanel.vue` 里各写一遍，改一个标签要记得改另外两处。
 *
 * ## 为什么取值也在这里声明一份
 *
 * 三张清单都来自 `src/domain/acl.ts`（`ACL_LEVELS` / `ACL_EFFECTS` / `ACL_MODES`），
 * 且是服务端校验输入时用的同一份数组（`src/api/http/routes/acl.ts` 的 `parseLevel` /
 * `parseEffect` / `parseMode`）；`GET /acl` 的响应里 `mode` 与 `entries[].level` /
 * `entries[].effect` 直接来自领域对象，没有运行期映射产生新值。
 *
 * 控制台不能 import `src/domain`，所以这里的 `as const` 数组是 web 侧的取值来源：
 * 类型从数组派生，映射用 `satisfies Record<类型, 文案>` 穷举。跨项目一致性由
 * `tests/unit/web/acl-labels.test.ts` 对拍——那是唯一同时 import 两边的地方。
 */

/** 权限级别（§12.1）：read = 1、write = 3、manage = 7，高位包含低位。 */
export const ACL_LEVELS = [1, 3, 7] as const

export type AclLevel = (typeof ACL_LEVELS)[number]

/** 授权效果。 */
export const ACL_EFFECTS = ['allow', 'deny'] as const

export type AclEffect = (typeof ACL_EFFECTS)[number]

/** 继承模式。 */
export const ACL_MODES = ['inherit', 'restricted'] as const

export type AclMode = (typeof ACL_MODES)[number]

/** 级别 → 文案。漏一个级别即编译失败，多一个键也是。 */
export const ACL_LEVEL_LABEL = {
  1: '读取',
  3: '写入',
  7: '管理',
} satisfies Record<AclLevel, string>

/** 效果 → 文案。漏一个效果即编译失败，多一个键也是。 */
export const ACL_EFFECT_LABEL = {
  allow: '允许',
  deny: '拒绝',
} satisfies Record<AclEffect, string>

/** 继承模式 → 文案。服务端枚举不直接进界面（AGENTS §11）。 */
export const ACL_MODE_LABEL = {
  inherit: '继承父级',
  restricted: '仅本节点',
} satisfies Record<AclMode, string>
