/**
 * 认证入口（架构文档 §12.7）。
 *
 * 这一层只做两件事：把「登录请求」换成 session token，把「入站凭据」换成
 * `RequestContext`。真正的凭据校验（密码哈希、API Key 哈希、账号状态、组展开）
 * 在 `IdentityService.resolve` 里——它同时被 v1 的 `x-comem-subject` 路径使用。
 *
 * ## 无状态 session
 *
 * token 是 HMAC 签名串（`services/session-token.ts`），服务端不存 session。
 * 因此**登出只能客户端丢弃 token**：服务端无法提前作废一个还没过期的 token。
 * 要立刻失效必须撤销 API Key 或改密码。这是本设计的已知限制，写在
 * `docs/operations.md` 的「多用户部署」一节。
 *
 * ## 一个 Secret 管全部 token
 *
 * `auth.sessionSecret` 为空时由装配层生成进程随机值：重启即失效，不需要运维
 * 配任何东西；要跨重启保持登录就显式配置。两种情况都只用这一个 secret。
 */

import { ComemError } from '../domain/errors.js';
import type { Logger } from '../domain/log.js';
import type { IdentityService, RequestContext } from './identity.js';
import { issueSessionToken, verifySessionToken } from './session-token.js';

export interface AuthServiceDeps {
  readonly identity: IdentityService;
  /** HMAC 密钥。空串由装配层替换成进程随机值。 */
  readonly sessionSecret: string;
  /** token 有效期（秒）。 */
  readonly sessionTtlSeconds: number;
  readonly logger: Logger;
}

/** 登录成功的响应体。`token` 只在这一处出现。 */
export interface LoginResult {
  readonly token: string;
  /** ISO 8601（UTC），与控制面其它时间字段一致。 */
  readonly expiresAt: string;
  /** 认证后的身份，路由用来回显 `subject`。 */
  readonly context: RequestContext;
}

export class AuthService {
  readonly #identity: IdentityService;
  readonly #secret: string;
  readonly #ttlSeconds: number;
  readonly #logger: Logger;

  constructor(deps: AuthServiceDeps) {
    this.#identity = deps.identity;
    this.#secret = deps.sessionSecret;
    this.#ttlSeconds = deps.sessionTtlSeconds;
    this.#logger = deps.logger;
  }

  /**
   * 用户名 + 密码换 session token。
   *
   * 失败一律抛 `UNAUTHENTICATED`（`IdentityService.resolve` 保证不区分原因），
   * 不在这里二次包装——错误码是稳定契约，路由只做 HTTP 映射。
   */
  async login(username: string, password: string, now: Date = new Date()): Promise<LoginResult> {
    const context = await this.#identity.resolve({ kind: 'password', username, password });
    const issued = issueSessionToken(
      this.#secret,
      context.subject.replace(/^user:/u, ''),
      this.#ttlSeconds,
      now,
    );
    this.#logger.info('登录成功', { subject: context.subject, expiresAt: issued.expiresAt });
    return {
      token: issued.token,
      expiresAt: new Date(issued.expiresAt * 1000).toISOString(),
      context,
    };
  }

  /**
   * 把 `Authorization: Bearer <credential>` 的凭据换成请求身份。
   *
   * 两种凭据靠前缀区分：`comem_` 开头是 API Key（`services/api-key.ts` 的
   * 格式），其余按 session token 校验。API Key 先匹配前缀再查库，不给
   * 「拿一个格式不对的串去验签」留路径。
   */
  async resolveBearer(credential: string): Promise<RequestContext> {
    if (credential.startsWith('comem_')) {
      return this.#identity.resolve({ kind: 'api-key', apiKey: credential });
    }
    const parsed = verifySessionToken(this.#secret, credential);
    if (parsed === null) {
      throw new ComemError('UNAUTHENTICATED', 'Session token 无效或已过期。');
    }
    return this.#identity.resolve({ kind: 'session', userId: parsed.userId });
  }
}

/**
 * 从 `Authorization` 头里取 Bearer 凭据。
 *
 * 方案名大小写不敏感（RFC 7235 §2.1），冒号后的单空格也是可选的。
 * 没有 `Bearer` 方案时返回 `null`，由调用方决定 401 的措辞。
 */
export function bearerCredential(authorization: string | undefined): string | null {
  if (authorization === undefined) {
    return null;
  }
  const match = /^Bearer[ ]+(?<credential>.+)$/iu.exec(authorization.trim());
  return match?.groups?.['credential'] ?? null;
}
