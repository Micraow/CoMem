/**
 * 控制台身份（架构文档 §16 的控制台身份引导、§18 的 `server.subject`）。
 *
 * 控制台不硬编码身份。`GET /health` 返回服务图绑定的主体与可寻址的根（§17.9），
 * `web/plugins/console-identity.ts` 在应用挂载前拉一次，之后每个请求用它拼
 * `x-comem-subject`。硬编码的默认值在运维把 `server.subject` 改成 `user:alice`
 * 之后仍会发 `user:local`，服务端的身份中间件按「请求头与绑定主体不一致」返回
 * 401——配置项存在但不生效，而且控制台看起来一切正常。
 *
 * ## 两种部署形态
 *
 * - `auth.enabled: false`（默认）：身份来自 `x-comem-subject`，`/health` 的
 *   `subject` / `scopes` 就是答案。没有登录页，单用户模式开箱可用。
 * - `auth.enabled: true`：`x-comem-subject` 被忽略，必须带
 *   `Authorization: Bearer <session token 或 API Key>`。此时控制台先探测认证是否
 *   打开，再读浏览器里的会话；没有会话就进登录页。
 *
 * 探测走 `GET /auth/config`：公开、只读、200 恒定，响应体只有
 * `{enabled: boolean}`。曾经用 `POST /auth/logout` 的 200 / 404 推断开关——那是
 * 拿「错误」当正常信号（默认配置下每次加载都在 console 里留一条 404），而且
 * 发了一个登出语义的写请求去做只读探测。
 *
 * ## 认证模式下为什么还要探测作用域
 *
 * `/health` 是公开端点，它回的是服务图绑定主体（`server.subject`）的根，不是
 * 当前登录用户的根。登录响应带 `subject` 与 `principals`，控制台按 `user:{uid}` /
 * `group:{gid}` 推出候选根，再逐个用 `GET /fs/tree` 验证「这个根真的可读」——
 * 组的根预置缺失时 `principals` 里仍有组，但那个组根没有可读内容。直接列出来
 * 会让用户切过去看到 403。
 *
 * 本模块不依赖 Nuxt 运行时（`useRuntimeConfig` / `useState` 都不在这里）：身份解析
 * 要能用替身 fetch 穷举——拉取失败、字段缺失、空 scopes。插件负责注入 base URL 与
 * fetch，`useApi` 只读这里的结果。
 */

import {
  clearConsoleSession,
  isConsoleSessionExpired,
  readConsoleSession,
  writeConsoleSession,
  type ConsoleSession,
} from './consoleAuth'

/** 服务端绑定的身份。字段与 MCP `health` 的 `subject` / `scopes` 同名同义（§13.2）。 */
export interface ConsoleIdentity {
  /** 服务图绑定的主体，形如 `user:alice`。 */
  readonly subject: string
  /** 该主体可寻址且可读的根；个人根在前。为空表示没有任何可访问的命名空间。 */
  readonly scopes: readonly string[]
  /**
   * 认证是否启用。
   *
   * `true` 时请求带 `Authorization: Bearer`，`false` / 缺省时带
   * `x-comem-subject`。字段可选是为了让「只从 `/health` 解析出的单用户身份」
   * 保持原来的形状——单用户模式下它本来就不需要这个开关。
   */
  readonly authEnabled?: boolean
}

/** 身份引导的状态。`pending` 只在插件跑完之前存在，控制台挂载时不会再看到它。 */
export type ConsoleIdentityState =
  | { readonly status: 'pending' }
  | { readonly status: 'ready'; readonly identity: ConsoleIdentity }
  /** 认证已打开，但浏览器里没有可用的会话。`app.vue` 渲染登录页。 */
  | { readonly status: 'unauthenticated' }
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
  /**
   * 读掉响应体。登出必须等它完成再导航，否则浏览器把请求标记成
   * `net::ERR_ABORTED`（W59）。
   *
   * 可选是为了让只断言 `ok` / `json()` 的替身不必构造它；真实 `Response` 结构上
   * 总是有。
   */
  text?(): Promise<string>
}

export type HealthFetcher = (url: string) => Promise<HealthResponseLike>

/** 需要方法 / 头 / 请求体的调用（登录、登出、作用域探测）。 */
export interface ConsoleRequestInit {
  readonly method?: 'GET' | 'POST'
  readonly headers?: Readonly<Record<string, string>>
  readonly body?: string
}

export type ConsoleRequest = (url: string, init?: ConsoleRequestInit) => Promise<HealthResponseLike>

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

/** 认证打开且没有可用会话时调用。 */
export function setConsoleIdentityUnauthenticated(): void {
  state = { status: 'unauthenticated' }
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
  if (state.status === 'unauthenticated') {
    throw new ConsoleIdentityError('UNAUTHENTICATED', '控制台需要登录后才能发送请求。')
  }
  if (state.status !== 'ready') {
    throw new ConsoleIdentityError('IDENTITY_UNAVAILABLE', '控制台还没有获取到服务端身份。')
  }
  return state.identity
}

/** 请求头。`useApi` 的每个请求都过这里。 */
export function identityHeaders(identity: ConsoleIdentity): Readonly<Record<string, string>> {
  if (identity.authEnabled === true) {
    const session = readConsoleSession()
    // 没有会话时返回空头：调用方会拿到 401，由 `useApi` 统一跳登录页。这里不拼
    // 一个空的 Bearer，那会让服务端的「凭据格式错误」和「没带凭据」混在一起。
    return session === null ? {} : { authorization: `Bearer ${session.token}` }
  }
  return { 'x-comem-subject': identity.subject }
}

/**
 * 作用域的显示名。
 *
 * URI 是内部标识，不直接摆给用户。个人根显示「个人空间」，组根显示组 ID。
 */
export function consoleScopeLabel(scope: string, subject: string): string {
  const path = scope.replace(/^comem:\/\//u, '').replace(/\/+$/u, '')
  const separator = path.indexOf('/')
  if (separator <= 0) {
    return scope
  }
  const kind = path.slice(0, separator)
  const id = path.slice(separator + 1)
  if (kind === 'user') {
    const userId = subject.startsWith('user:') ? subject.slice('user:'.length) : subject
    return id === userId ? '个人空间' : `用户 ${id}`
  }
  if (kind === 'group') {
    return `组 ${id}`
  }
  return scope
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function trimBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/u, '')
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
  const base = trimBase(baseUrl)
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

/**
 * 探测认证是否打开。
 *
 * 见文件头：`GET /auth/config` 是只读端点，认证关闭与打开都返回 200，响应体是
 * `{status:'ok', result:{enabled:boolean}}`。非 200 或字段缺失都不是「能继续往下
 * 走」的答案，直接整页报错——猜一个默认值会让单用户部署以错误的分支启动。
 */
export async function probeAuthEnabled(
  baseUrl: string,
  request: ConsoleRequest,
): Promise<boolean> {
  const response = await request(`${trimBase(baseUrl)}/auth/config`, {
    headers: { accept: 'application/json' },
  })
  if (!response.ok) {
    throw new ConsoleIdentityError(
      'AUTH_PROBE_FAILED',
      `服务端 /auth/config 返回 HTTP ${String(response.status)}，控制台无法判断是否启用认证。`,
    )
  }

  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    throw new ConsoleIdentityError(
      'AUTH_PROBE_FAILED',
      '服务端 /auth/config 返回的不是 JSON，控制台无法判断是否启用认证。',
    )
  }

  const result = isRecord(payload) ? payload['result'] : undefined
  const enabled = isRecord(result) ? result['enabled'] : undefined
  if (typeof enabled !== 'boolean') {
    throw new ConsoleIdentityError(
      'AUTH_PROBE_FAILED',
      '服务端 /auth/config 没有返回 enabled 布尔值，控制台无法判断是否启用认证。',
    )
  }
  return enabled
}

/** `user:alice` → `comem://user/alice`；通配主体与非法形状返回 `null`。 */
function principalToScope(principal: string): string | null {
  const separator = principal.indexOf(':')
  if (separator <= 0) {
    return null
  }
  const kind = principal.slice(0, separator)
  const id = principal.slice(separator + 1)
  if ((kind !== 'user' && kind !== 'group') || id === '' || id === '*') {
    return null
  }
  return `comem://${kind}/${id}`
}

/** 候选根：个人根在前，组根按登录响应里的顺序。 */
function scopeCandidatesOf(session: ConsoleSession): readonly string[] {
  const candidates: string[] = []
  const personal = principalToScope(session.subject)
  if (personal !== null) {
    candidates.push(personal)
  }
  for (const principal of session.principals) {
    if (!principal.startsWith('group:')) {
      continue
    }
    const scope = principalToScope(principal)
    if (scope !== null && !candidates.includes(scope)) {
      candidates.push(scope)
    }
  }
  return candidates
}

type ScopeProbeResult =
  | { readonly status: 'ok'; readonly scopes: readonly string[] }
  | { readonly status: 'unauthenticated' }

/**
 * 逐个验证候选根可读。
 *
 * 401 表示会话已经失效（过期 / 改过密码 / 账号被删），整份身份都不成立，直接回
 * 登录页。403 / 404 表示这个根没有内容可读（组根预置缺失），跳过它——与
 * `GET /health` 的 `readableScopes` 是同一套语义。
 */
async function fetchReadableScopes(
  baseUrl: string,
  request: ConsoleRequest,
  session: ConsoleSession,
): Promise<ScopeProbeResult> {
  const base = trimBase(baseUrl)
  const scopes: string[] = []

  for (const scope of scopeCandidatesOf(session)) {
    const query = new URLSearchParams({ uri: scope, depth: '1', limit: '1' })
    const response = await request(`${base}/fs/tree?${query.toString()}`, {
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${session.token}`,
      },
    })

    if (response.status === 401) {
      return { status: 'unauthenticated' }
    }
    if (response.ok) {
      scopes.push(scope)
      continue
    }
    if (response.status === 403 || response.status === 404) {
      continue
    }
    throw new ConsoleIdentityError(
      'SCOPE_PROBE_FAILED',
      `服务端在检查 ${scope} 时返回 HTTP ${String(response.status)}，控制台无法确定可访问范围。`,
    )
  }

  return { status: 'ok', scopes }
}

/**
 * 引导身份。插件调一次，结果是 `app.vue` 的整页分支。
 *
 * 认证关闭时不读存储、不要求登录——这是默认配置，必须开箱可用。
 */
export async function bootstrapConsoleIdentity(
  baseUrl: string,
  request: ConsoleRequest,
): Promise<ConsoleIdentityState> {
  const authEnabled = await probeAuthEnabled(baseUrl, request)
  if (!authEnabled) {
    return { status: 'ready', identity: await fetchConsoleIdentity(baseUrl, request) }
  }

  const session = readConsoleSession()
  if (session === null || isConsoleSessionExpired(session)) {
    clearConsoleSession()
    return { status: 'unauthenticated' }
  }

  const result = await fetchReadableScopes(baseUrl, request, session)
  if (result.status === 'unauthenticated') {
    clearConsoleSession()
    return { status: 'unauthenticated' }
  }

  return {
    status: 'ready',
    identity: { subject: session.subject, scopes: result.scopes, authEnabled: true },
  }
}

/** 登录响应解出来的会话。 */
function readLoginResult(payload: unknown): ConsoleSession {
  if (!isRecord(payload) || payload['status'] !== 'ok' || !isRecord(payload['result'])) {
    throw new ConsoleIdentityError(
      'INVALID_LOGIN_RESPONSE',
      '服务端返回了无法识别的登录响应，请确认 API 前缀是否指向 CoMem 后端。',
    )
  }
  const result = payload['result']
  const token = result['token']
  const subject = result['subject']
  const principals = result['principals']
  const expiresAt = result['expiresAt']
  if (
    typeof token !== 'string' ||
    token === '' ||
    typeof subject !== 'string' ||
    subject === '' ||
    typeof expiresAt !== 'string' ||
    !Number.isFinite(Date.parse(expiresAt)) ||
    !Array.isArray(principals) ||
    !principals.every((principal) => typeof principal === 'string')
  ) {
    throw new ConsoleIdentityError(
      'INVALID_LOGIN_RESPONSE',
      '服务端返回的登录响应缺少 token、主体或有效期。',
    )
  }

  return {
    token,
    subject,
    principals: principals.filter(
      (principal): principal is string => typeof principal === 'string',
    ),
    expiresAt,
  }
}

function errorEnvelopeOf(payload: unknown): { readonly code: string; readonly message: string } | null {
  if (!isRecord(payload) || payload['status'] !== 'error' || !isRecord(payload['error'])) {
    return null
  }
  const error = payload['error']
  if (typeof error['code'] !== 'string' || typeof error['message'] !== 'string') {
    return null
  }
  return { code: error['code'], message: error['message'] }
}

/**
 * 用户名 + 密码换会话并写进存储。
 *
 * 错误信息直接用服务端的中文句子：认证失败不区分原因（账号不存在 / 密码错都是
 * 同一句），控制台也不该在这里补一份更具体的。
 */
export async function loginConsole(
  baseUrl: string,
  request: ConsoleRequest,
  input: { readonly username: string; readonly password: string },
): Promise<ConsoleSession> {
  const response = await request(`${trimBase(baseUrl)}/auth/login`, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ username: input.username, password: input.password }),
  })

  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    payload = undefined
  }

  if (!response.ok) {
    const envelope = errorEnvelopeOf(payload)
    throw new ConsoleIdentityError(
      envelope?.code ?? `HTTP_${String(response.status)}`,
      envelope?.message ?? `服务端返回了 HTTP ${String(response.status)}，登录失败。`,
    )
  }

  const session = readLoginResult(payload)
  writeConsoleSession(session)
  return session
}

/**
 * 退出登录。
 *
 * 服务端无状态，调用失败也不影响结果：本地清掉会话就是登出。仍然发一次请求，
 * 是为了让「登出」在访问日志里有一条记录，而不是客户端单方面忘记。
 *
 * **必须等响应体读完再返回。** `fetch` 在响应头到达时就 resolve，调用方紧接着
 * `window.location.assign('/login')` 会让浏览器中止仍在进行的请求体读取，服务端
 * 记 200、浏览器记 `net::ERR_ABORTED`（W59 的实测现象）。`finally` 保证请求失败
 * 也会清掉本地会话——调用方负责跳转。
 */
export async function logoutConsole(baseUrl: string, request: ConsoleRequest): Promise<void> {
  const session = readConsoleSession()
  try {
    if (session === null) {
      return
    }
    const response = await request(`${trimBase(baseUrl)}/auth/logout`, {
      method: 'POST',
      headers: { accept: 'application/json', authorization: `Bearer ${session.token}` },
    })
    await response.text?.()
  } catch {
    // 网络失败与服务端无状态都不改变「本地已经登出」。
  } finally {
    clearConsoleSession()
  }
}
