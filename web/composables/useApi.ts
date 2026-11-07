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
 * 3. **身份走请求头。** v1 是单租户，固定 `user:local`；租户切换是 v2 的事。
 *
 * 超时 30 秒：控制台是内部工具，慢请求多来自摘要生成或全量树，5 秒太短；
 * 30 秒内没有响应基本等于后端挂了，继续等没有意义。
 */

import type { Ref } from 'vue'

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

/** v1 的固定身份（单租户）。 */
export const DEFAULT_SUBJECT = 'user:local'

/** 默认作用域根（与 `DEFAULT_SUBJECT` 对应）。 */
export const DEFAULT_SCOPE_ROOT = 'comem://user/local'

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

async function request<T>(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
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
        'x-comem-subject': DEFAULT_SUBJECT,
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      signal: controller.signal,
    })

    const payload = await readPayload(response)

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
  del<T>(path: string, query?: Record<string, unknown>): Promise<T>
}

export function useApi(): ApiClient {
  return {
    get: (path, query) => request('GET', path, { query }),
    post: (path, body) => request('POST', path, { body }),
    put: (path, body) => request('PUT', path, { body }),
    del: (path, query) => request('DELETE', path, { query }),
  }
}

/**
 * 作用域根：跨页共享一份，切页不重取。
 *
 * 现在只有一个根（`comem://user/local`），但它是「当前身份看到的世界」的入口，
 * 文件树、检索调试、权限管理都要用它，放在 `useState` 里比每页各写一个常量
 * 更容易在接入多作用域时统一改。
 */
export function useScopeRoot(): Ref<string> {
  return useState<string>('comem-scope-root', () => DEFAULT_SCOPE_ROOT)
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
  readonly abstract: string | null
}

/** `GET /fs/tree`。 */
export interface TreePayload {
  readonly root: string
  readonly entries: readonly TreeEntryPayload[]
  readonly truncated: boolean
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
  readonly index: { readonly nodes: number }
  readonly queue: { readonly pending: number; readonly processing: number }
  readonly summary: {
    readonly degraded: boolean
    readonly pendingDirs: number
    readonly degradedDirs: number
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
