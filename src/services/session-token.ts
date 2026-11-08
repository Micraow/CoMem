/**
 * Session Token 的签发与校验（架构文档 §12.7）。
 *
 * Token 是无状态 HMAC 签名串，形如：
 *
 * ```
 * v1.<base64url(payload JSON)>.<base64url(HMAC-SHA256(secret, "v1.<payload>"))>
 * ```
 *
 * `payload` 是 `{ sub, iat, exp }`（用户 ID、签发时刻、过期时刻，秒级 Unix
 * 时间）。服务端不存 session 行：`auth.sessionTtlSeconds` 就是唯一的状态，
 * 校验只做签名与过期两件事。
 *
 * ## 为什么无状态
 *
 * 存储 session 要多一张表、一次写入、一次清理任务，而 session 的语义就是「在
 * TTL 内有效」。无状态的代价是**登出只能客户端丢弃 token**——服务端无法提前
 * 作废一个还没过期的 token。要立刻失效必须吊销 API key 或改密码（改密码不影响
 * 已签发的 session token）。这是本设计的已知限制，写在 `docs/operations.md`。
 *
 * ## 为什么要带 `v1`
 *
 * 签名格式以后会变（换算法、加字段）。版本号在签名串里，旧 token 在升级后会
 * 明确校验失败，而不是被新解析器按错误字段读出一个用户 ID。
 *
 * ## 为什么校验签名用 `timingSafeEqual`
 *
 * 与密码校验同理：逐字节比较会泄露「前几个字节对了」。比较前先比长度。
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

/** 当前签名格式版本。 */
const TOKEN_VERSION = 'v1';

/** 签名算法。 */
const HMAC_ALGORITHM = 'sha256';

/** 校验结果。 */
export interface SessionToken {
  /** `user:{uid}` 里的 uid。 */
  readonly userId: string;
  /** 过期时刻（Unix 秒）。 */
  readonly expiresAt: number;
}

/** 签名载荷的线上形状。字段名短是刻意的：token 会进 HTTP 头。 */
interface TokenPayload {
  readonly sub: string;
  readonly iat: number;
  readonly exp: number;
}

function sign(secret: string, payload: string): string {
  return createHmac(HMAC_ALGORITHM, secret).update(payload).digest('base64url');
}

/**
 * 签发一个 token。
 *
 * `now` 只用于测试注入；生产路径由服务层传当前时刻，保证同一进程内签发的
 * token 可重放（同一毫秒签两个 token 也得到同一个串）。
 */
export function issueSessionToken(
  secret: string,
  userId: string,
  ttlSeconds: number,
  now: Date = new Date(),
): { readonly token: string; readonly expiresAt: number } {
  const issuedAt = Math.floor(now.getTime() / 1000);
  const expiresAt = issuedAt + ttlSeconds;
  const payload: TokenPayload = { sub: userId, iat: issuedAt, exp: expiresAt };
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signed = `${TOKEN_VERSION}.${encoded}`;
  return { token: `${signed}.${sign(secret, signed)}`, expiresAt };
}

/**
 * 校验签名与过期。任何一步失败返回 `null`，**不抛**——认证头是调用方输入。
 */
export function verifySessionToken(
  secret: string,
  token: string,
  now: Date = new Date(),
): SessionToken | null {
  const parts = token.split('.');
  if (parts.length !== 3) {
    return null;
  }
  const [version, encoded, signature] = parts;
  if (
    version !== TOKEN_VERSION ||
    encoded === undefined ||
    signature === undefined ||
    encoded === '' ||
    signature === ''
  ) {
    return null;
  }

  const expected = Buffer.from(sign(secret, `${version}.${encoded}`), 'base64url');
  const actual = Buffer.from(signature, 'base64url');
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return null;
  }

  let payload: TokenPayload;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null) {
      return null;
    }
    const record = parsed as Record<string, unknown>;
    const sub = record['sub'];
    const exp = record['exp'];
    if (typeof sub !== 'string' || sub === '' || typeof exp !== 'number') {
      return null;
    }
    payload = { sub, iat: typeof record['iat'] === 'number' ? record['iat'] : 0, exp };
  } catch {
    return null;
  }

  if (payload.exp <= Math.floor(now.getTime() / 1000)) {
    return null;
  }
  return { userId: payload.sub, expiresAt: payload.exp };
}
