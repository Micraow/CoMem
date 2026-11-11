/**
 * 登录路由守卫（架构文档 §16、§12.7）。
 *
 * 判定在 `web/utils/consoleGuard.ts`：那里能用普通替身穷举「初始化未完成 / 没有
 * 会话 / 已有会话」三种状态。放在全局中间件而不是页面组件里：每个页面各写一份
 * `onBeforeMount` 迟早会漏，漏掉的页面表现为「空白 + 401」。
 */
import { consoleIdentityState } from '~/composables/consoleIdentity'
import { consoleRedirectFor } from '~/utils/consoleGuard'

export default defineNuxtRouteMiddleware((to) => {
  const redirect = consoleRedirectFor(consoleIdentityState(), to.path, to.fullPath)
  if (redirect !== null) {
    return navigateTo(redirect)
  }
})
