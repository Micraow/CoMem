/**
 * 控制台身份（架构文档 §16 的控制台身份引导、§18 的 `server.subject`）。
 *
 * 控制台不硬编码身份。`GET /health` 返回服务图绑定的主体与可寻址的根（§17.9），
 * `web/plugins/console-identity.ts` 在应用挂载前拉一次，之后每个请求用它拼
 * `x-comem-subject`。硬编码的默认值在运维把 `server.subject` 改成 `user:alice`
 * 之后仍会发 `user:local`，服务端的身份中间件按「请求头与绑定主体不一致」返回
 * 401——配置项存在但不生效，而且控制台看起来一切正常。
 *
 * 本模块不依赖 Nuxt 运行时（`useRuntimeConfig` / `useState` 都不在这里）：身份解析
 * 要能用替身 fetch 穷举——拉取失败、字段缺失、空 scopes。插件负责注入 base URL 与
 * fetch，`useApi` 只读这里的结果。
 */

/** 服务端绑定的身份。字段与 MCP `health` 的 `subject` / `scopes` 同名同义（§13.2）。 */
export interface ConsoleIdentity {
  /** 服务图绑定的主体，形如 `user:alice`。 */
  readonly subject: string
  /** 该主体可寻址且可读的根；个人根在前。为空表示没有任何可访问的命名空间。 */
  readonly scopes: readonly string[]
}

/** 身份引导的三个状态。`pending` 只在插件跑完之前存在，控制台挂载时不会再看到它。 */
export type ConsoleIdentityState =
  | { readonly status: 'pending' }
  | { readonly status: 'ready'; readonly identity: ConsoleIdentity }
  | { readonly status: 'failed'; readonly message: string }

export class ConsoleIdentityError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'ConsoleIdentityError'
    this.code = code
  }
}

/**
 * fetch 的最小形状。
 *
 * 只声明用到的三个成员：测试用普通对象就能当替身，不用构造真实的 `Response`。
 * `Response` 结构上可赋值。
 */
export interface HealthResponseLike {
  readonly ok: boolean
  readonly status: number
  json(): Promise<unknown>
}

export type HealthFetcher = (url: string) => Promise<HealthResponseLike>

/**
 * 浏览器会话内的身份。
 *
 * 模块级状态成立的前提是 `ssr: false`（`nuxt.config.ts`）：没有服务端渲染，也就没有
 * 「两个请求共用一份模块状态」的串号问题。整页刷新时模块重新求值，插件重新拉取。
 */
let state: ConsoleIdentityState = { status: 'pending' }

/** 当前引导状态。`app.vue` 用它决定渲染页面还是整页错误。 */
export function consoleIdentityState(): ConsoleIdentityState {
  return state
}

/** 插件拉取成功后调用。 */
export function setConsoleIdentity(identity: ConsoleIdentity): void {
  state = { status: 'ready', identity }
}

/** 插件拉取失败后调用。`message` 是给用户看的整页错误。 */
export function setConsoleIdentityFailure(message: string): void {
  state = { status: 'failed', message }
}

/**
 * 已解析的身份；未拉取或拉取失败时抛错。
 *
 * **不回落 `user:local`**：那会把「服务端不可达」变成「以错误身份发请求」，症状
 * 是每个请求 401，而界面上只看到「请求失败」。抛错也让「失败时不发后续请求」
 * 由构造保证——`useApi` 的每个请求都先过这里。
 */
export function consoleIdentityOrThrow(): ConsoleIdentity {
  if (state.status !== 'ready') {
    throw new ConsoleIdentityError('IDENTITY_UNAVAILABLE', '控制台还没有获取到服务端身份。')
  }
  return state.identity
}

/** 请求头。`useApi` 的每个请求都过这里。 */
export function identityHeaders(identity: ConsoleIdentity): Readonly<Record<string, string>> {
  return { 'x-comem-subject': identity.subject }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 解封套并取身份字段。
 *
 * 字段缺失一律报错：控制台没有「猜一个默认主体」的余地，猜错就是 401。
 */
function readHealthResult(payload: unknown): ConsoleIdentity {
  if (!isRecord(payload) || payload['status'] !== 'ok' || !isRecord(payload['result'])) {
    throw new ConsoleIdentityError(
      'INVALID_HEALTH_RESPONSE',
      '服务端 /health 返回了无法识别的响应，控制台无法确定当前身份。',
    )
  }
  const result = payload['result']

  const subject = result['subject']
  if (typeof subject !== 'string' || subject === '') {
    throw new ConsoleIdentityError(
      'INVALID_HEALTH_RESPONSE',
      '服务端 /health 没有返回绑定主体，控制台无法确定当前身份。',
    )
  }

  const rawScopes = result['scopes']
  if (!Array.isArray(rawScopes)) {
    throw new ConsoleIdentityError(
      'INVALID_HEALTH_RESPONSE',
      '服务端 /health 没有返回可访问范围，控制台无法确定当前身份。',
    )
  }
  const scopes = rawScopes.filter((scope): scope is string => typeof scope === 'string')
  if (scopes.length !== rawScopes.length) {
    throw new ConsoleIdentityError(
      'INVALID_HEALTH_RESPONSE',
      '服务端 /health 的可访问范围里有非字符串项。',
    )
  }

  return { subject, scopes }
}

/**
 * 拉取服务端身份。
 *
 * 失败一律抛出，由插件转成整页错误。`/health` 是公开端点（`middleware.ts` 的
 * `PUBLIC_PATHS`），所以这里不带 `x-comem-subject`——身份还没拿到，不能带。
 */
export async function fetchConsoleIdentity(
  baseUrl: string,
  request: HealthFetcher,
): Promise<ConsoleIdentity> {
  const base = baseUrl.replace(/\/+$/u, '')
  const response = await request(`${base}/health`)
  if (!response.ok) {
    throw new ConsoleIdentityError(
      'HEALTH_UNAVAILABLE',
      `服务端 /health 返回 HTTP ${String(response.status)}，控制台无法确定当前身份。`,
    )
  }

  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    throw new ConsoleIdentityError('INVALID_HEALTH_RESPONSE', '服务端 /health 返回的不是 JSON。')
  }
  return readHealthResult(payload)
}
