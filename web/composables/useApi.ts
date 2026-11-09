/**
 * HTTP API 客户端（架构文档 §14 的响应封套、§19 的错误模型）。
 *
 * 三个约定：
 *
 * 1. **统一解封套。** 成功是 `{status:'ok', result}`，失败是
 *    `{status:'error', error}`。HTTP 非 2xx 时服务端同样返回错误封套，所以解包
 *    不能只在 `response.ok` 时做——否则 4xx 的 `code` / `message` 全丢，界面上只剩
 *    「请求失败」。
 * 2. **URI 参数逐段编码。** `comem://` 里的 `:` 与 `/` 在查询串里必须转义，否则
 *    服务端只拿到第一段路径。
 * 3. **身份走请求头，主体来自服务端。** 控制台在挂载前调 `GET /health` 拿绑定主体
 *    （`plugins/console-identity.ts`），这里只负责把它写进 `x-comem-subject`。没有
 *    身份时请求直接抛错——回落一个默认主体会在运维改了 `server.subject` 之后继续
 *    发旧身份，症状是每个请求 401。
 *
 * 超时 30 秒：控制台是内部工具，慢请求多来自摘要生成或全量树，5 秒太短；
 * 30 秒内没有响应基本等于后端挂了，继续等没有意义。
 */

import type { Ref } from 'vue'

import { clearConsoleSession, readStoredScope, writeStoredScope } from './consoleAuth'
import {
  consoleIdentityOrThrow,
  consoleIdentityState,
  identityHeaders,
} from './consoleIdentity'

export interface ApiOk<T> {
  readonly status: 'ok'
  readonly result: T
}

export interface ApiError {
  readonly status: 'error'
  readonly error: {
    readonly code: string
    readonly message: string
    readonly details?: unknown
  }
}

/** 请求超时（毫秒）。 */
const REQUEST_TIMEOUT_MS = 30_000

export class ApiClientError extends Error {
  readonly code: string

  readonly details?: unknown

  /** HTTP 状态码；网络错误与超时为 0。 */
  readonly statusCode: number

  constructor(message: string, code: string, statusCode: number, details?: unknown) {
    super(message)
    this.name = 'ApiClientError'
    this.code = code
    this.statusCode = statusCode
    this.details = details
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isOkEnvelope<T>(payload: unknown): payload is ApiOk<T> {
  return isRecord(payload) && payload['status'] === 'ok' && 'result' in payload
}

function isErrorEnvelope(payload: unknown): payload is ApiError {
  if (!isRecord(payload) || payload['status'] !== 'error' || !isRecord(payload['error'])) {
    return false
  }
  const error = payload['error']
  return typeof error['code'] === 'string' && typeof error['message'] === 'string'
}

/**
 * 查询串：每个键与值都过 `encodeURIComponent`。
 *
 * 不用 `URLSearchParams`：它把空格编成 `+`，服务端按 `%20` 解，URI 里的空白
 * 会变成字面加号。`undefined` / `null` 直接跳过——可选参数不传就是没有。
 */
function buildQuery(query: Record<string, unknown> | undefined): string {
  if (query === undefined) {
    return ''
  }

  const pairs: string[] = []
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) {
      continue
    }
    const text = typeof value === 'string' ? value : String(value)
    pairs.push(`${encodeURIComponent(key)}=${encodeURIComponent(text)}`)
  }
  return pairs.length === 0 ? '' : `?${pairs.join('&')}`
}

async function readPayload(response: Response): Promise<unknown> {
  try {
    const payload: unknown = await response.json()
    return payload
  } catch {
    return undefined
  }
}

interface RequestOptions {
  readonly query?: Record<string, unknown>
  readonly body?: unknown
}

/**
 * 认证打开时收到 401：会话已失效（过期 / 改过密码 / 账号被删）。
 *
 * 清掉本地会话再整页跳登录页。**不做前端重试**：token 无状态，重试只会再 401
 * 一次；`redirect` 记住原地址，重新登录后回到这里。单用户模式的 401 是身份配置
 * 问题，不是「没登录」，保持当前错误展示。
 */
function redirectToLoginOnUnauthenticated(): void {
  const state = consoleIdentityState()
  if (state.status !== 'ready' || state.identity.authEnabled !== true) {
    return
  }

  clearConsoleSession()
  if (typeof window === 'undefined' || window.location.pathname === '/login') {
    return
  }

  const redirect = `${window.location.pathname}${window.location.search}`
  window.location.assign(`/login?redirect=${encodeURIComponent(redirect)}`)
}

async function request<T>(
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  options: RequestOptions,
): Promise<T> {
  const config = useRuntimeConfig()
  const base = String(config.public.apiBase).replace(/\/+$/, '')
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, REQUEST_TIMEOUT_MS)

  try {
    const response = await fetch(`${base}${path}${buildQuery(options.query)}`, {
      method,
      headers: {
        accept: 'application/json',
        // 身份未引导时这里抛错，fetch 不会被调用——见文件头第 3 条。
        ...identityHeaders(consoleIdentityOrThrow()),
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      signal: controller.signal,
    })

    const payload = await readPayload(response)

    if (response.status === 401) {
      redirectToLoginOnUnauthenticated()
    }

    if (isErrorEnvelope(payload)) {
      throw new ApiClientError(
        payload.error.message,
        payload.error.code,
        response.status,
        payload.error.details,
      )
    }

    if (!response.ok) {
      throw new ApiClientError(
        `服务端返回了 HTTP ${response.status}，但没有可读的错误信息。`,
        `HTTP_${response.status}`,
        response.status,
      )
    }

    if (!isOkEnvelope<T>(payload)) {
      throw new ApiClientError(
        '服务端返回了无法识别的响应，请确认 API 前缀是否指向 CoMem 后端。',
        'INVALID_RESPONSE',
        response.status,
      )
    }

    return payload.result
  } catch (error) {
    if (error instanceof ApiClientError) {
      throw error
    }
    if (timedOut) {
      throw new ApiClientError(
        '请求超时：服务端在 30 秒内没有响应。',
        'TIMEOUT',
        0,
      )
    }
    throw new ApiClientError(
      '无法连接 CoMem 服务，请确认后端已启动。',
      'NETWORK_ERROR',
      0,
    )
  } finally {
    clearTimeout(timer)
  }
}

export interface ApiClient {
  get<T>(path: string, query?: Record<string, unknown>): Promise<T>
  post<T>(path: string, body?: unknown): Promise<T>
  put<T>(path: string, body?: unknown): Promise<T>
  patch<T>(path: string, body?: unknown): Promise<T>
  del<T>(path: string, query?: Record<string, unknown>): Promise<T>
}

export function useApi(): ApiClient {
  return {
    get: (path, query) => request('GET', path, { query }),
    post: (path, body) => request('POST', path, { body }),
    put: (path, body) => request('PUT', path, { body }),
    patch: (path, body) => request('PATCH', path, { body }),
    del: (path, query) => request('DELETE', path, { query }),
  }
}

/**
 * 作用域根：跨页共享一份，切页不重取。
 *
 * 取服务端返回的第一个可读根（个人根）作为默认值；用户上次在顶栏选过的根如果
 * 仍在可读范围里就恢复它。刷新不丢，作用域选择与「当前标签页登录的是谁」绑定在
 * 一起（`sessionStorage`）。
 *
 * 身份还没引导时 `consoleIdentityOrThrow` 抛错——`app.vue` 在身份未知时不会渲染
 * 页面，所以调用方拿不到一个假根。
 */
export function useScopeRoot(): Ref<string> {
  return useState<string>('comem-scope-root', () => {
    const identity = consoleIdentityOrThrow()
    const stored = readStoredScope()
    if (stored !== null && identity.scopes.includes(stored)) {
      return stored
    }
    return identity.scopes[0] ?? ''
  })
}

/**
 * 切换作用域并记住。
 *
 * 所有页面监听 `useScopeRoot` 返回的 ref 重新加载自己的数据；这里只改状态，不做
 * 路由跳转——文件树、检索、复核各自的「切过去之后选中什么」不同。
 */
export function selectScopeRoot(scope: string): void {
  const root = useScopeRoot()
  if (root.value === scope) {
    return
  }
  root.value = scope
  writeStoredScope(scope)
}

/** 把任意异常转成可显示的中文句子。 */
export function errorMessageOf(error: unknown): string {
  if (error instanceof ApiClientError) {
    return error.message
  }
  if (error instanceof Error && error.message !== '') {
    return error.message
  }
  return '发生了未知错误，请重试。'
}

// ── 线上响应形状 ─────────────────────────────────────────────────────────
// 与服务端序列化后的字段一一对应（src/api/http/routes/*.ts）。只声明控制台
// 用到的字段；多声明一份没读过的字段，等于给「服务端改字段」制造静默兼容。

/** `GET /fs/tree` 的条目。 */
export interface TreeEntryPayload {
  readonly uri: string
  readonly name: string
  readonly kind: 'file' | 'directory'
  readonly size: number
}

/**
 * `GET /fs/ls` 的直接子项。
 *
 * 文件树按需展开走这个端点而不是 `/fs/tree`：一次只拉一层，`truncated` 与
 * `depth` 这两件事都不需要，而 `depth` 边界上的目录只要还有子项就算「截断」——
 * 按需展开时那会变成恒为真。
 */
export interface FsListPayload {
  readonly uri: string
  readonly entries: readonly TreeEntryPayload[]
}

/** `GET /fs/stat`。`stat` 为 null 表示节点不存在。 */
export interface FsStatPayload {
  readonly uri: string
  readonly stat: {
    readonly kind: 'file' | 'directory'
    readonly size: number
    readonly updatedAt: string
  } | null
}

/** `GET /health`（架构文档 §17.9）。 */
export interface HealthPayload {
  readonly status: 'ok' | 'degraded'
  /** 服务图绑定的主体；控制台的身份引导也读它（`consoleIdentity.ts`）。 */
  readonly subject: string
  /** 该主体可寻址且可读的根。为空表示没有任何可访问的命名空间。 */
  readonly scopes: readonly string[]
  readonly index: { readonly totalNodes: number }
  readonly queue: { readonly pending: number; readonly processing: number }
  readonly summary: {
    readonly degraded: boolean
    readonly pendingDirs: number
    readonly degradedDirs: number
  }
  /**
   * 记忆健康度（§17.5）。`oldestPendingAgeSeconds` 为 null 表示没有待复核记忆。
   *
   * 这两个字段由 `ObservabilityService.health()` 计算、`routes/ops.ts` 的封套带出；
   * 不要改回从 `GET /memories/pending` 的第一页重算——那个端点不排序且会截断，
   * 「第一条」不是「最老一条」。
   */
  readonly memory: {
    readonly pendingReview: number
    readonly oldestPendingAgeSeconds: number | null
  }
  readonly version: string
}

/** `GET /content/abstract` 与 `/content/overview` 的公共形状。 */
export interface SummaryLayerPayload {
  readonly uri: string
  readonly abstract?: string | null
  readonly overview?: string | null
  readonly degraded: boolean
}

/** `GET /content/read`。 */
export interface ContentReadPayload {
  readonly uri: string
  readonly text: string
  readonly truncated: boolean
}

/** `GET /acl`。`effective` 是主体 → 有效级别（read=1 / write=3 / manage=7）。 */
export interface AclPayload {
  readonly uri: string
  readonly mode: 'inherit' | 'restricted'
  readonly entries: readonly {
    readonly principal: string
    readonly level: 1 | 3 | 7
    readonly effect: 'allow' | 'deny'
  }[]
  readonly effective: Readonly<Record<string, readonly (1 | 3 | 7)[]>>
}

/** `GET /tasks` 的任务行。 */
export interface TaskPayload {
  readonly id: string
  readonly type: string
  readonly status: string
  readonly attempts: number
  readonly updatedAt: string
  readonly error: string | null
}

/** `GET /memories/pending`。 */
export interface PendingMemoriesPayload {
  readonly scope: string
  readonly memories: readonly {
    readonly uri: string
    readonly memoryType: string
    readonly status: string
    readonly updatedAt: string
  }[]
}

/** `GET /mcp/tools` 的一个工具。说明文本来自服务端注册表，界面不重写。 */
export interface McpToolPayload {
  readonly name: string
  /** `read` / `write` / `ingest`。只用于分组展示，不参与权限判定。 */
  readonly kind: string
  readonly description: string
  /** JSON Schema；界面只读 `properties` 的键名与 `required`。 */
  readonly inputSchema: Record<string, unknown>
}

export interface McpToolsPayload {
  readonly tools: readonly McpToolPayload[]
}
