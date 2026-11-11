/**
 * 控制台路由守卫的判定（架构文档 §16）。
 *
 * 判定是纯函数，中间件只负责把结果交给 `navigateTo`。理由和 `healthLabels.ts`
 * 一样：守卫有几种「必须跳」与几种「必须放行」，写在 `defineNuxtRouteMiddleware`
 * 里就没法用普通替身穷举——测一个中间件要装整个 Nuxt 运行时。
 *
 * ## 两个状态是同一条路径的两段
 *
 * `setup-required` 是「这份安装还没有账号」，`unauthenticated` 是「有账号、浏览器
 * 里没有会话」。它们不是两种模式：前者建完账号就转到后者，后者登录成功就是
 * `ready`。所以这里只有一条规则链，没有按部署形态分叉。
 *
 * ## 为什么初始化完成前也放行登录页
 *
 * 「初始化未完成时除 `/setup` 外全部重定向」会让登录页底部的「首次使用？创建
 * 管理员账号」永远不可达：那个链接只在 `needsSetup` 为 true 时显示，而那个状态
 * 下登录页已经被重定向走了。放行 `/login` 的代价是用户可以手动打开一个没有账号
 * 可用的登录表单，收益是那个入口真的能点。
 *
 * ## `redirect` 只接受站内路径
 *
 * `redirect` 来自 URL，不校验就是一个开放重定向：`//evil.example` 会被浏览器
 * 当成协议相对地址。登录页在读取时还会再校验一次（`safeRedirect`），这里只保证
 * 拼出来的值是站内路径。
 */
import type { ConsoleIdentityState } from '../composables/consoleIdentity'

/** 登录页路径。 */
export const CONSOLE_LOGIN_PATH = '/login'

/** 初始化页路径。 */
export const CONSOLE_SETUP_PATH = '/setup'

/**
 * 当前状态与目标路径 → 需要跳转的地址；`null` 表示放行。
 *
 * `pending` / `failed` 不跳转：身份还没确定时 `app.vue` 自己渲染加载态或整页
 * 错误，先跳一次页面只会把「后端不可达」变成「反复重定向」。
 */
export function consoleRedirectFor(
  state: ConsoleIdentityState,
  path: string,
  fullPath: string,
): string | null {
  if (state.status === 'setup-required') {
    if (path === CONSOLE_SETUP_PATH || path === CONSOLE_LOGIN_PATH) {
      return null
    }
    return CONSOLE_SETUP_PATH
  }

  if (state.status === 'unauthenticated') {
    if (path === CONSOLE_LOGIN_PATH) {
      return null
    }
    // 初始化页在这里没有意义：账号已经有了（`needsSetup` 是 false），直接去登录，
    // 不把它当成 `redirect` 目标带回来。
    if (path === CONSOLE_SETUP_PATH) {
      return CONSOLE_LOGIN_PATH
    }
    return `${CONSOLE_LOGIN_PATH}?redirect=${encodeURIComponent(fullPath)}`
  }

  // 已有身份时登录页与初始化页都没有意义：回概览，避免出现「登录成功但仍停在
  // 登录页」。
  if (state.status === 'ready' && (path === CONSOLE_LOGIN_PATH || path === CONSOLE_SETUP_PATH)) {
    return '/'
  }

  return null
}
