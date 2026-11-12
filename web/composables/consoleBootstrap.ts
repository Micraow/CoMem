/**
 * 首次初始化（架构文档 §16 的控制台身份引导、§12.7 的引导循环）。
 *
 * ## 为什么需要这一页
 *
 * 认证恒开，而空数据根下浏览器里没有任何路径能创建第一个可登录账号。控制台先问
 * `GET /api/v1/bootstrap`：这份安装是否还没有任何密码（`needsSetup`），以及回环
 * 信任使用的身份是什么（`boundSubject`，初始化页拿它做默认用户名）。`needsSetup`
 * 为 true 时整站进初始化页，而不是渲染一个没有身份的外壳。
 *
 * 建好账号即可登录：`POST /bootstrap/admin` 在同一个事务里写密码哈希与引导管理员
 * 标记，不需要重启、也不需要再改配置。
 *
 * ## 回环地址或一次性令牌
 *
 * 建账号只能从回环地址发起，**或者**带上服务端启动日志里打印的一次性令牌：容器
 * 部署必须绑 `0.0.0.0` 才能被端口转发，经 nginx 来的请求必然不是回环地址，只认
 * 回环的话 Docker 用户打开初始化页会被拒——引导页承诺了却做不到。
 *
 * 控制台分不清自己是不是回环地址，所以令牌输入框一直显示、可以留空：本地
 * `pnpm dev` 不带也能过，容器部署从日志里复制一次。
 *
 * ## 错误码是契约
 *
 * `INVALID_SETUP_TOKEN`（令牌不对）、`NOT_LOOPBACK`（不是本机发出的请求，需要
 * 令牌）与 `BOOTSTRAP_CLOSED`（已经初始化过）的界面文案在这一层决定：页面只
 * 负责把这些句子放到合适的位置。服务端的弱口令提示沿用原句——密码强度规则只有
 * 服务端知道，控制台抄一份迟早会偏。
 */

import { isRecord } from '../utils/record'

import type { ConsoleRequest } from './consoleIdentity'

/** `GET /bootstrap` 的 `result`。字段与响应体同形，缺一个就不猜。 */
export interface ConsoleBootstrap {
  /** 没有任何用户设置过密码。新装为 `true`。 */
  readonly needsSetup: boolean
  /** 回环信任使用的身份，形如 `user:local`。初始化页用它做默认用户名。 */
  readonly boundSubject: string
  /** 是否已经有系统管理员（`auth.adminUserIds` 非空，或引导管理员已存在）。 */
  readonly adminConfigured: boolean
}

/** 创建管理员账号的输入。空的显示名与令牌都不提交。 */
export interface BootstrapAdminInput {
  readonly userId: string
  readonly displayName: string
  readonly password: string
  /** 服务端启动日志里的一次性令牌。回环请求可以留空。 */
  readonly setupToken: string
}

/** `POST /bootstrap/admin` 的 `result`。 */
export interface BootstrapAdminResult {
  readonly userId: string
  readonly created: boolean
  readonly passwordSet: boolean
}

/** 表单字段 → 错误文案。没有错误的字段不出现在对象里。 */
export interface SetupFormErrors {
  readonly userId?: string
  readonly password?: string
  readonly confirmPassword?: string
}

/** 初始化页表单（不含显示名：它没有校验规则）。 */
export interface SetupFormInput {
  readonly userId: string
  readonly password: string
  readonly confirmPassword: string
}

/** 初始化接口的错误。`code` 是服务端的错误码；网络错误用 `BOOTSTRAP_UNAVAILABLE`。 */
export class ConsoleBootstrapError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'ConsoleBootstrapError'
    this.code = code
  }
}

function trimBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/u, '')
}

function readErrorEnvelope(payload: unknown): { readonly code: string; readonly message: string } | null {
  if (!isRecord(payload) || payload['status'] !== 'error' || !isRecord(payload['error'])) {
    return null
  }
  const error = payload['error']
  if (typeof error['code'] !== 'string' || typeof error['message'] !== 'string') {
    return null
  }
  return { code: error['code'], message: error['message'] }
}

function invalidBootstrap(detail: string): ConsoleBootstrapError {
  return new ConsoleBootstrapError(
    'INVALID_BOOTSTRAP_RESPONSE',
    `服务端 /bootstrap ${detail}，控制台无法判断是否需要初始化。`,
  )
}

function readBootstrapResult(payload: unknown): ConsoleBootstrap {
  if (!isRecord(payload) || payload['status'] !== 'ok' || !isRecord(payload['result'])) {
    throw invalidBootstrap('返回了无法识别的响应')
  }
  const result = payload['result']
  const needsSetup = result['needsSetup']
  const boundSubject = result['boundSubject']
  const adminConfigured = result['adminConfigured']

  if (typeof needsSetup !== 'boolean' || typeof adminConfigured !== 'boolean') {
    throw invalidBootstrap('缺少布尔状态字段')
  }
  if (typeof boundSubject !== 'string' || boundSubject === '') {
    throw invalidBootstrap('没有返回绑定主体')
  }

  return { needsSetup, boundSubject, adminConfigured }
}

function readAdminResult(payload: unknown): BootstrapAdminResult {
  const result = isRecord(payload) && payload['status'] === 'ok' ? payload['result'] : undefined
  if (!isRecord(result)) {
    throw new ConsoleBootstrapError(
      'INVALID_BOOTSTRAP_RESPONSE',
      '服务端返回了无法识别的初始化响应，账号是否创建成功无法确认。',
    )
  }

  const userId = result['userId']
  const created = result['created']
  const passwordSet = result['passwordSet']
  if (
    typeof userId !== 'string' ||
    userId === '' ||
    typeof created !== 'boolean' ||
    typeof passwordSet !== 'boolean'
  ) {
    throw new ConsoleBootstrapError(
      'INVALID_BOOTSTRAP_RESPONSE',
      '服务端返回的初始化响应缺少账号或状态字段，账号是否创建成功无法确认。',
    )
  }

  return { userId, created, passwordSet }
}

/**
 * 读初始化状态。
 *
 * 匿名端点，不带任何身份头——此时控制台还没有身份。非 200 或字段缺失都直接抛错：
 * 猜一个 `needsSetup: false` 会让一个没有账号的新装跳过初始化，回到「完整外壳 +
 * 没有登录」的状态。
 */
export async function fetchConsoleBootstrap(
  baseUrl: string,
  request: ConsoleRequest,
): Promise<ConsoleBootstrap> {
  const response = await request(`${trimBase(baseUrl)}/bootstrap`, {
    headers: { accept: 'application/json' },
  })
  if (!response.ok) {
    throw new ConsoleBootstrapError(
      'BOOTSTRAP_UNAVAILABLE',
      `服务端 /bootstrap 返回 HTTP ${String(response.status)}，控制台无法判断是否需要初始化。`,
    )
  }

  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    throw invalidBootstrap('返回的不是 JSON')
  }
  return readBootstrapResult(payload)
}

/**
 * 创建第一个管理员账号。
 *
 * 只在 `needsSetup` 时可用，且服务端只接受回环地址或正确的一次性令牌：远程
 * 打开控制台又不带令牌得到 `NOT_LOOPBACK`，令牌不对得到 `INVALID_SETUP_TOKEN`，
 * 已经初始化过得到 `BOOTSTRAP_CLOSED`。三种都不是「重试一下就好」的错误，页面按
 * `code` 分支处理。
 *
 * 空的显示名与空的令牌都不进请求体：服务端把 `displayName: ""` 当成一个空显示
 * 名，而 `setupToken` 留空是「这次走回环」的合法写法。
 */
export async function createBootstrapAdmin(
  baseUrl: string,
  request: ConsoleRequest,
  input: BootstrapAdminInput,
): Promise<BootstrapAdminResult> {
  const body: Record<string, string> = { userId: input.userId, password: input.password }
  const displayName = input.displayName.trim()
  if (displayName !== '') {
    body['displayName'] = displayName
  }
  const setupToken = input.setupToken.trim()
  if (setupToken !== '') {
    body['setupToken'] = setupToken
  }

  const response = await request(`${trimBase(baseUrl)}/bootstrap/admin`, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    payload = undefined
  }

  if (!response.ok) {
    const envelope = readErrorEnvelope(payload)
    throw new ConsoleBootstrapError(
      envelope?.code ?? `HTTP_${String(response.status)}`,
      envelope?.message ?? `服务端返回了 HTTP ${String(response.status)}，管理员账号没有创建。`,
    )
  }

  return readAdminResult(payload)
}

/**
 * 错误码 → 初始化页的提示。
 *
 * `NOT_LOOPBACK` 与 `INVALID_SETUP_TOKEN` 都指向同一件事：**去服务端启动日志里
 * 复制初始化令牌**。不说「只能在服务器本机完成」——容器部署里请求经 nginx 转发，
 * 必然不是回环地址，那句话会把主推路径说成做不到。`BOOTSTRAP_CLOSED` 页面自己
 * 会跳登录页（状态已经过期，需要整页重新引导），留一句兜底文案避免把服务端的
 * 内部句子露出来。
 */
export function bootstrapErrorNotice(code: string, message: string): string {
  if (code === 'NOT_LOOPBACK') {
    return '这次请求不是从服务器本机发出的，需要初始化令牌。'
  }
  if (code === 'INVALID_SETUP_TOKEN') {
    return '初始化令牌不正确，请从服务端启动日志重新复制。'
  }
  if (code === 'BOOTSTRAP_CLOSED') {
    return '初始化已经完成，请直接登录。'
  }
  return message
}

/**
 * 表单校验。
 *
 * 只做控制台能确定的两件事：字段非空、两次密码一致。密码长度与字符集由服务端
 * 判定（弱口令返回服务端原句），前端抄一份规则只会在两边不一致时让用户困惑。
 */
export function validateSetupForm(input: SetupFormInput): SetupFormErrors {
  const errors: { userId?: string; password?: string; confirmPassword?: string } = {}

  if (input.userId.trim() === '') {
    errors.userId = '请输入用户名。'
  }
  if (input.password === '') {
    errors.password = '请输入密码。'
  }
  if (input.confirmPassword === '') {
    errors.confirmPassword = '请再次输入密码。'
  } else if (input.confirmPassword !== input.password) {
    errors.confirmPassword = '两次输入的密码不一致。'
  }

  return errors
}
