/**
 * 控制台身份引导（架构文档 §16、§12.7）。
 *
 * 应用挂载前先问初始化状态（`GET /bootstrap`），再读浏览器会话并验证可读作用域。
 * **必须串行**：页面在身份到达前发出的请求会没有凭据，服务端按 401 拒绝。
 * `ssr: false` 下首屏本来就要等 JS 包执行，多一次同源小请求不改变「用户看到
 * 第一帧」的时刻。
 *
 * 超时单独设：默认的 30 秒请求超时是为摘要生成这类慢请求定的，用它等探活会让
 * 服务端没起时首页空白 30 秒。5 秒足够冷启动，又能把「后端不可达」尽快变成
 * 可读的错误页。
 */
import { ConsoleBootstrapError } from '../composables/consoleBootstrap'
import {
  ConsoleIdentityError,
  bootstrapConsoleIdentity,
  setConsoleIdentity,
  setConsoleIdentityFailure,
  setConsoleIdentitySetupRequired,
  setConsoleIdentityUnauthenticated,
  type ConsoleRequestInit,
} from '../composables/consoleIdentity'

/** 身份拉取超时（毫秒）。本地同源请求，5 秒足够冷启动。 */
const IDENTITY_TIMEOUT_MS = 5_000

export default defineNuxtPlugin({
  name: 'comem-console-identity',
  async setup() {
    const config = useRuntimeConfig()
    const base = String(config.public.apiBase)

    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, IDENTITY_TIMEOUT_MS)

    const request = (url: string, init?: ConsoleRequestInit): Promise<Response> =>
      fetch(url, {
        ...init,
        headers: { accept: 'application/json', ...init?.headers },
        signal: controller.signal,
      })

    try {
      const state = await bootstrapConsoleIdentity(base, request)
      if (state.status === 'ready') {
        setConsoleIdentity(state.identity)
      } else if (state.status === 'setup-required') {
        setConsoleIdentitySetupRequired(state.bootstrap)
      } else if (state.status === 'unauthenticated') {
        setConsoleIdentityUnauthenticated()
      }
    } catch (error) {
      if (timedOut) {
        setConsoleIdentityFailure(
          `控制台在 ${String(IDENTITY_TIMEOUT_MS / 1_000)} 秒内没有收到服务端响应，请确认 CoMem 服务已启动。`,
        )
      } else if (error instanceof ConsoleIdentityError || error instanceof ConsoleBootstrapError) {
        setConsoleIdentityFailure(error.message)
      } else {
        const detail = error instanceof Error ? error.message : String(error)
        setConsoleIdentityFailure(`无法连接 CoMem 服务：${detail}`)
      }
    } finally {
      clearTimeout(timer)
    }
  },
})
