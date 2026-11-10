/**
 * 记忆类型 → 中文名与徽章配色（复核队列、检索命中共用一份）。
 *
 * 取值来自 `src/domain/memory-types/index.ts` 的 `BUILTIN_MEMORY_TYPE_NAMES`：内置
 * 八个类型，`BUILTIN_MEMORY_TYPES` 的键、`TTL_EXEMPT_MEMORY_TYPES` 的成员、
 * `MemoryRecord.memoryType` 的取值都从那个数组派生，顺序也就是这里与提示词里的展示
 * 顺序。
 *
 * 控制台是独立包（`web/` 不在根 pnpm workspace 里，`web/tsconfig.json` 只覆盖
 * `web/`），不能 import `src/domain`，所以这里的 `as const` 数组是 web 侧清单：类型从
 * 数组派生，两张映射用 `satisfies Record<类型, …>` 穷举，内置类型加一个而界面没跟时
 * 缺键即编译失败。跨项目一致性由 `tests/unit/web/memory-type-labels.test.ts` 对拍
 * ——那是唯一同时 import 两边的地方。
 *
 * ## 为什么入参是 `string`，不是 `MemoryType`
 *
 * 读路径**刻意开放**：`src/services/memory/document.ts` 的
 * `MemoryDocument.memoryType` 是 `string`，注释写明「`read` 不该因为一个自定义类型
 * 没注册进内置表而返回不存在」。所以这两个函数也接受任意字符串——内置八个翻译成
 * 中文名，其余原样输出。把入参收窄成 `MemoryType` 会把「写进去了、界面显示不出来」
 * 变成编译期拒绝，而自定义类型是合法数据；统一显示成「未知」同样是删掉它的名字。
 *
 * 徽章配色沿用既有语义：`experiences` / `rules` 走复核闸门（§11.6），用蓝 / 紫区分；
 * 其余类型提交后直接生效，用中性灰。颜色不单独表意，文字始终同时出现。
 */

/** `BUILTIN_MEMORY_TYPE_NAMES`（`src/domain/memory-types/index.ts`），顺序一致。 */
export const MEMORY_TYPES = [
  'profile',
  'preferences',
  'entities',
  'events',
  'identity',
  'soul',
  'experiences',
  'rules',
] as const

export type MemoryType = (typeof MEMORY_TYPES)[number]

/** 类型 → 中文名。漏一个 `MemoryType` 即编译失败，多一个键也是。 */
const MEMORY_TYPE_LABEL = {
  profile: '画像',
  preferences: '偏好',
  entities: '实体',
  events: '事件',
  identity: '身份',
  soul: '原则',
  experiences: '经验',
  rules: '规则',
} satisfies Record<MemoryType, string>

/** 类型 → 徽章配色。只列这里用得到的三种，其余配色不凭空声明。 */
export type MemoryTypeVariant = 'blue' | 'purple' | 'gray'

/** 类型 → 配色。漏一个 `MemoryType` 即编译失败，多一个键也是。 */
const MEMORY_TYPE_VARIANT = {
  profile: 'gray',
  preferences: 'gray',
  entities: 'gray',
  events: 'gray',
  identity: 'gray',
  soul: 'gray',
  experiences: 'blue',
  rules: 'purple',
} satisfies Record<MemoryType, MemoryTypeVariant>

/**
 * 内置类型守卫。
 *
 * 写成 `.some()` 而不是 `Object.hasOwn(MEMORY_TYPE_LABEL, ...)`：后者收窄不了类型，
 * 下标只能靠断言；与领域层 `isMemoryType` 同一做法。
 */
function isMemoryType(value: string): value is MemoryType {
  return MEMORY_TYPES.some((type) => type === value)
}

/**
 * 记忆类型 → 中文名。
 *
 * 未知类型返回原值：自定义记忆类型没注册进内置表不代表它不存在，界面要显示它真实的
 * 名字（`memory_type` 是开放字符串，见文件头）。
 */
export function memoryTypeLabelOf(value: string): string {
  return isMemoryType(value) ? MEMORY_TYPE_LABEL[value] : value
}

/** 记忆类型 → 徽章配色。未知类型落中性灰，与「其余类型」同一处理。 */
export function memoryTypeVariantOf(value: string): MemoryTypeVariant {
  return isMemoryType(value) ? MEMORY_TYPE_VARIANT[value] : 'gray'
}
