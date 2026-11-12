/**
 * 普通对象判定。
 *
 * 五处 `isRecord` 逐字相同：API 客户端的响应信封、会话存储的解析、初始化接口、
 * 身份引导与设置页的错误 `details`。放在 `utils/` 下用显式 import，是因为
 * `consoleIdentity.ts` 与 `settings.ts` 必须能脱离 Nuxt 自动导入被单测直接 import。
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
