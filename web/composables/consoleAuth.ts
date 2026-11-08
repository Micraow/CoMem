/**
 * 控制台会话凭据（架构文档 §12.7、§16）。
 *
 * ## 为什么是内存 + sessionStorage
 *
 * 服务端只回 JSON 里的 `token`，没有 `Set-Cookie`，所以 `httpOnly` cookie 这条路
 * 走不通——浏览器拿不到一个「脚本读不到、但请求会自动带上」的凭据。可选的两个位置
 * 都有代价：
 *
 * - **内存**：刷新即丢，用户每按一次 F5 都要重新登录。控制台是排查工具，
 *   刷新是常规操作，这个代价不可接受。
 * - **sessionStorage**：只活在当前标签页，关闭标签页即清；不自动随请求发送，
 *   没有 CSRF 面；仍然可被同源脚本读取，XSS 能拿到它。
 *
 * 选择内存 + sessionStorage 的组合：内存让同一标签页的请求不必每次解析存储，刷新
 * 后由 sessionStorage 恢复。**不选 localStorage**：它跨标签页、跨浏览器重启长期
 * 保留，泄露窗口最长，而控制台没有「关掉浏览器还要保持登录」的需求。XSS 的风险
 * 靠三件事收窄：token 只发给同源的 `/api/v1`、界面不加载第三方脚本、服务端默认
 * 24 小时过期（`auth.sessionTtlSeconds`）。
 */

/** 登录响应里控制台需要的字段。 */
export interface ConsoleSession {
  /** `Authorization: Bearer` 后面的凭据。 */
  readonly token: string
  /** `user:{uid}`。 */
  readonly subject: string
  /** 该用户的主体展开（`user:{uid}` + 加入的组）。作用域选择器用它推候选根。 */
  readonly principals: readonly string[]
  /** ISO 8601 过期时刻。过期后不拿它发请求，直接回登录页。 */
  readonly expiresAt: string
}

/** 会话存储键。改名等于让所有已登录标签页重新登录。 */
const SESSION_KEY = 'comem-console-session'

/** 作用域选择键。刷新后恢复上次的选择。 */
const SCOPE_KEY = 'comem-console-scope'

/**
 * 最近一次读到的会话。
 *
 * `undefined` 表示还没读过存储；`null` 表示读过且没有。用三态而不是每次读
 * sessionStorage：`useApi` 的每个请求都要判断凭据，存储读取在热路径上。
 */
let cached: ConsoleSession | null | undefined

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * sessionStorage 的最小形状。
 *
 * 不写 `Storage`：根 `tsconfig.json` 的 `lib` 只有 ES2023，没有 DOM。控制台的
 * 浏览器类型由 `web/tsconfig.json` 提供，但 `tests/unit/web/*` 会从根配置跟着
 * import 到这个模块，这里必须两边都能编译。
 */
interface SessionStorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

interface GlobalWithSessionStorage {
  readonly sessionStorage?: SessionStorageLike
}

/** 当前标签页的 sessionStorage。隐私模式 / 被策略禁用时返回 `null`。 */
function storageOf(): SessionStorageLike | null {
  try {
    return (globalThis as GlobalWithSessionStorage).sessionStorage ?? null
  } catch {
    return null
  }
}

function parseSession(value: unknown): ConsoleSession | null {
  if (!isRecord(value)) {
    return null
  }
  const token = value['token']
  const subject = value['subject']
  const principals = value['principals']
  const expiresAt = value['expiresAt']
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
    return null
  }
  return {
    token,
    subject,
    principals: principals.filter((principal): principal is string => typeof principal === 'string'),
    expiresAt,
  }
}

/** 读会话。存储里是坏数据时顺手清掉，不让它每次加载都失败一次。 */
export function readConsoleSession(): ConsoleSession | null {
  if (cached !== undefined) {
    return cached
  }

  const storage = storageOf()
  if (storage === null) {
    cached = null
    return null
  }

  let raw: string | null
  try {
    raw = storage.getItem(SESSION_KEY)
  } catch {
    cached = null
    return null
  }
  if (raw === null) {
    cached = null
    return null
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    removeStoredSession(storage)
    cached = null
    return null
  }

  const session = parseSession(parsed)
  if (session === null) {
    removeStoredSession(storage)
    cached = null
    return null
  }
  cached = session
  return session
}

function removeStoredSession(storage: SessionStorageLike): void {
  try {
    storage.removeItem(SESSION_KEY)
  } catch {
    // 存不了也删不了：内存里已经当作没有会话，下一次读取继续返回 null。
  }
}

/** 登录成功后写入。存储被禁用时只保留在内存里，当前标签页仍可用。 */
export function writeConsoleSession(session: ConsoleSession): void {
  cached = session
  const storage = storageOf()
  if (storage === null) {
    return
  }
  try {
    storage.setItem(SESSION_KEY, JSON.stringify(session))
  } catch {
    // 配额或隐私模式：内存里已有，不把登录判失败。
  }
}

/** 退出登录 / 收到 401 时清空。 */
export function clearConsoleSession(): void {
  cached = null
  const storage = storageOf()
  if (storage !== null) {
    removeStoredSession(storage)
  }
}

/** 会话是否已过期。过期时刻解析不出来时按过期处理——不发一个必然 401 的请求。 */
export function isConsoleSessionExpired(session: ConsoleSession, now: number = Date.now()): boolean {
  const expiresAt = Date.parse(session.expiresAt)
  return !Number.isFinite(expiresAt) || expiresAt <= now
}

/** 上次选择的作用域根（`comem://user/alice` 之类）。没有选择时返回 `null`。 */
export function readStoredScope(): string | null {
  const storage = storageOf()
  if (storage === null) {
    return null
  }
  try {
    const value = storage.getItem(SCOPE_KEY)
    return value === null || value === '' ? null : value
  } catch {
    return null
  }
}

/** 记住作用域选择。 */
export function writeStoredScope(scope: string): void {
  const storage = storageOf()
  if (storage === null) {
    return
  }
  try {
    storage.setItem(SCOPE_KEY, scope)
  } catch {
    // 存不了只影响刷新后的默认值，不影响当前选择。
  }
}
