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
 * 3. **身份走请求头，主体来自登录响应。** 控制台在挂载前读会话
 *    （`plugins/console-identity.ts`），这里只负责把 token 拼成
 *    `Authorization: Bearer`。没有身份时请求直接抛错——不带凭据的请求只对回环来源
 *    有效，而控制台不能假设自己在回环地址上。
 *
 * 超时 30 秒：控制台是内部工具，慢请求多来自摘要生成或全量树，5 秒太短；
 * 30 秒内没有响应基本等于后端挂了，继续等没有意义。
 */

import type { AclEffect, AclLevel, AclMode } from '~/utils/aclLabels'
import type { FsEntryKind } from '~/utils/fsLabels'
import type { HealthStatus } from '~/utils/healthLabels'
import type { NodeStatus } from '~/utils/nodeStatus'
import type { ClaimableTaskStatus, TaskType } from '~/utils/taskLabels'
import type { McpToolKind } from '~/utils/toolLabels'
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
 * 收到 401：会话已失效（过期 / 改过密码 / 账号被删）。
 *
 * 清掉本地会话再整页跳登录页。**不做前端重试**：token 无状态，重试只会再 401
 * 一次；`redirect` 记住原地址，重新登录后回到这里。
 */
function redirectToLoginOnUnauthenticated(): void {
  const state = consoleIdentityState()
  if (state.status !== 'ready') {
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
        ...identityHeaders(),
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

/**
 * 权限不足（403）判定。
 *
 * 服务端把 `PERMISSION_DENIED` 映射到 403（`src/domain/errors.ts`），两个条件都算。
 * 取文案（`forbiddenMessageOf`）与取状态（概览页、会话页、用户与组页在 403 时显示
 * 「需要管理员权限」的空态，而不是把原文放进错误条）共用这一个判定：同一个事实在
 * 全仓只判断一次，改判定条件不用逐页去找。
 */
export function isForbidden(caught: unknown): boolean {
  return (
    caught instanceof ApiClientError &&
    (caught.statusCode === 403 || caught.code === 'PERMISSION_DENIED')
  )
}

/**
 * 权限不足（403）换成调用方给的那句话，其它失败仍显示服务端消息。
 *
 * 403 的服务端原文是「没有权限：<uri> 需要 write（3）级别。」——动作名与级别数字
 * 都是内部术语（§11），进界面只会让人去搜文档。判定在 `isForbidden` 里，句子由
 * 调用方按页面语义给（「复核」与「查看」不是同一件事）。
 *
 * 其它失败照旧显示服务端消息：那段是排查用的诊断信息，不是给用户的操作指引。
 */
export function forbiddenMessageOf(caught: unknown, message: string): string {
  return isForbidden(caught) ? message : errorMessageOf(caught)
}

// ── 线上响应形状 ─────────────────────────────────────────────────────────
// 与服务端序列化后的字段一一对应（src/api/http/routes/*.ts）。只声明控制台
// 用到的字段；多声明一份没读过的字段，等于给「服务端改字段」制造静默兼容。

/**
 * `GET /fs/tree` 的条目。
 *
 * `kind` 用 `utils/fsLabels.ts` 派生的类型：服务端从 `fs.stat()` 推出来的只是
 * `'file' | 'directory'`（`src/adapters/fs/content-store.ts`），`routes/fs.ts` 原样
 * 带出。写成字面量联合也能编译，但界面那三处标签就会各写一份内联三元。
 */
export interface TreeEntryPayload {
  readonly uri: string
  readonly name: string
  readonly kind: FsEntryKind
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
    readonly kind: FsEntryKind
    readonly size: number
    readonly updatedAt: string
  } | null
}

/** `GET /health`（架构文档 §17.9）。 */
export interface HealthPayload {
  /**
   * `utils/healthLabels.ts` 派生的 `HealthStatus`：服务端只有 `ok` / `degraded`
   * 两档（`src/api/health-status.ts` 的 `healthStatus()` 只有两个返回值）。
   */
  readonly status: HealthStatus
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

/**
 * `GET /acl`。`effective` 是主体 → 有效级别（read=1 / write=3 / manage=7）。
 *
 * `mode` / `level` / `effect` 用 `utils/aclLabels.ts` 派生的类型：服务端这三列
 * 直接来自领域对象（`src/api/http/routes/acl.ts` 的 `snapshot.mode` /
 * `snapshot.entries`），写成 `string` 只会让标签映射退回 `?? 原值` 兜底。
 */
export interface AclPayload {
  readonly uri: string
  readonly mode: AclMode
  readonly entries: readonly {
    readonly principal: string
    readonly level: AclLevel
    readonly effect: AclEffect
  }[]
  readonly effective: Readonly<Record<string, readonly AclLevel[]>>
}

/**
 * `GET /tasks` 的任务行。
 *
 * 概览页与「会话与任务」页各读一部分字段：概览用 `updatedAt`，任务表还要
 * `createdAt` / `leaseUntil` / `error`。响应里还有 `payload` / `stepsDone`，
 * 控制台不读，不声明（`src/api/http/routes/tasks.ts` 的 `TaskRecord` 是完整形状）。
 *
 * `type` / `status` 用取值联合而不是 `string`：这个端点只列可认领的任务，状态是
 * `ClaimableTaskStatus` 子集。写成 `string` 时标签映射只能靠 `?? 原值` 兜底，
 * 一个新增的状态会以英文原值出现在界面上（`utils/taskLabels.ts` 的映射是穷举的，
 * 加成员就会编译失败）。
 */
export interface TaskPayload {
  readonly id: string
  readonly type: TaskType
  readonly status: ClaimableTaskStatus
  readonly attempts: number
  readonly leaseUntil: string | null
  readonly error: string | null
  readonly createdAt: string
  readonly updatedAt: string
}

/**
 * `GET /memories/pending` 的待复核记录。
 *
 * 与 `src/api/http/routes/memories.ts` 的 `serializeRecord` 一一对应：`fields` 是
 * 记忆字段（正文在 `content` 键下），`sources` 是这条记忆由哪几次归档产生。
 * 复核页的列表与差异视图共用这一份，不在组件里各写一遍。
 *
 * `validFrom` / `validUntil` / `supersedes` 在响应里**始终存在**，`null` 表示没有
 * 这个值（旧数据缺字段与「没有有效期」在界面上是同一种状态，不留占位）。
 * 两个时间串与 `updatedAt` 同形（ISO 8601 UTC 毫秒），展示时才换成本地时区。
 */
export interface PendingMemoryPayload {
  readonly uri: string
  /**
   * 记忆类型是开放字符串（自定义类型没注册进内置表也要能读出来），界面按已知
   * 内置类型翻译、未知值显示原值，见 `utils/memoryTypeLabels.ts`。
   */
  readonly memoryType: string
  /**
   * `utils/nodeStatus.ts` 派生的 `NodeStatus`：`serializeRecord()`
   * （`src/api/http/routes/memories.ts`）原样输出 `record.status`，而它是
   * `MemoryStatus = NodeStatus` 的三值。
   */
  readonly status: NodeStatus
  readonly updatedAt: string
  /** 这条版本从何时开始生效；`null` 表示没有记录起始时刻。 */
  readonly validFrom: string | null
  /** 有效期截止；规范记忆常态是 `null`。 */
  readonly validUntil: string | null
  /** 覆盖写产生的上一版本快照（`.history/` 下）；`null` 表示它没顶替任何东西。 */
  readonly supersedes: string | null
  readonly fields: Readonly<Record<string, unknown>>
  readonly sources: readonly string[]
}

/** `GET /memories/pending`。 */
export interface PendingListPayload {
  readonly scope: string
  readonly memories: readonly PendingMemoryPayload[]
}

/**
 * `GET /memories/{uri}/links` 的一条关联边。
 *
 * `linkType` 是开放字符串（`src/domain/memory-link.ts`），界面按已知值翻译、
 * 未知值显示原值。`description` / `matchText` 空串表示没有；`weight` 是关联强度，
 * 不展示。无权限的边由后端整条滤掉（`src/api/http/routes/memories.ts`），
 * 前端拿到的每一条都指向可读节点。
 */
export interface MemoryLinkPayload {
  readonly from: string
  readonly to: string
  readonly linkType: string
  readonly weight: number
  readonly matchText: string
  readonly description: string
}

/** `GET /memories/{uri}/links?direction=links|backlinks`。 */
export interface MemoryLinksPayload {
  readonly uri: string
  readonly direction: 'links' | 'backlinks'
  readonly links: readonly MemoryLinkPayload[]
}

/**
 * `GET /mcp/tools` 的一个工具。说明文本来自服务端注册表，界面不重写。
 *
 * `kind` 用 `utils/toolLabels.ts` 派生的类型：`serializeTool()`
 * （`src/api/http/routes/mcp.ts`）原样输出注册表里的 `tool.kind`，而它的静态类型
 * 就是 `'read' | 'write' | 'ingest'`。写成 `string` 时分组文案只能靠 `as` 断言或
 * `?? kind` 兜底，注册表多加一类工具就会显示成英文原值。
 */
export interface McpToolPayload {
  readonly name: string
  readonly kind: McpToolKind
  readonly description: string
  /** JSON Schema；界面只读 `properties` 的键名与 `required`。 */
  readonly inputSchema: Record<string, unknown>
}

export interface McpToolsPayload {
  readonly tools: readonly McpToolPayload[]
}
