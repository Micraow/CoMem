/**
 * 登录路由守卫（架构文档 §16、§12.7）。
 *
 * 认证打开且浏览器里没有可用会话时，任何受保护页面都跳登录页，并用 `redirect`
 * 记住原地址；登录成功回到原地址。单用户模式（`auth.enabled: false`）的状态是
 * `ready`，这里什么都不做——默认配置必须无缝可用。
 *
 * 放在全局中间件而不是页面组件里：每个页面各写一份 `onBeforeMount` 迟早会漏，
 * 漏掉的页面表现为「空白 + 401」。
 */
import { consoleIdentityState } from '~/composables/consoleIdentity'

/** 登录页路径。只此一处。 */
const LOGIN_PATH = '/login'

export default defineNuxtRouteMiddleware((to) => {
  const state = consoleIdentityState()

  if (state.status === 'unauthenticated') {
    if (to.path === LOGIN_PATH) {
      return
    }
    return navigateTo({ path: LOGIN_PATH, query: { redirect: to.fullPath } })
  }

  // 已有会话时访问登录页没有意义：回概览，避免出现「登录成功但仍停在登录页」。
  if (state.status === 'ready' && to.path === LOGIN_PATH) {
    return navigateTo('/')
  }
})
