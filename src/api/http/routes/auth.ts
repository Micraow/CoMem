/**
 * 登录 / 登出（架构文档 §12.7）。
 *
 * 两个端点都**不认证**：登录时还没有身份，登出没有服务端状态可清。它们进
 * `PUBLIC_PATHS`，由身份中间件直接放行。
 *
 * ## 登出只是客户端丢弃 token
 *
 * session token 是无状态 HMAC 签名串（`services/session-token.ts`），服务端没有
 * 「已签发 token」的表。因此 `POST /auth/logout` 不改变服务端任何状态：它存在是
 * 为了让客户端有统一出口，也让「如何登出」有一个文档能指向的答案。要让已签发的
 * token 立刻失效，改密码（轮换 `app_user.session_epoch`）或撤销 API Key。前者
 * 只影响自己的 token，后者只影响一把 key——看不到别人的 token，这正是无状态设计
 * 的边界。
 *
 * ## 为什么没有「认证是否启用」的探测端点
 *
 * 认证恒开，这个问题没有答案可问。控制台的状态全来自 `GET /bootstrap`（是否需要
 * 初始化）与浏览器里的会话，不再有一个「开关」要探测。
 */

import type { FastifyInstance } from 'fastify';

import { ok } from '../envelope.js';
import { requireRecord, requireString, type HttpRouteGroup } from '../server.js';

import type { HttpRouteServices } from './index.js';

export type AuthRouteServices = Pick<HttpRouteServices, 'auth'>;

/** `POST /auth/login` 的响应体：session token 与认证后的身份。 */
interface LoginResponse {
  readonly token: string;
  /** ISO 8601（UTC）。 */
  readonly expiresAt: string;
  readonly subject: string;
  readonly principals: readonly string[];
}

/** `POST /auth/logout` 的响应体：服务端没有可失效的行，只回确认。 */
interface LogoutResponse {
  readonly loggedOut: true;
}

export function createAuthRoutes(services: AuthRouteServices): HttpRouteGroup {
  const { auth } = services;

  return {
    prefix: '/auth',
    register(app: FastifyInstance): void {
      app.post<{ Body: unknown }>('/login', async (request) => {
        const body = requireRecord(request.body, 'auth/login');
        const username = requireString(body, 'username');
        const password = requireString(body, 'password');

        const result = await auth.login(username, password);
        return ok<LoginResponse>({
          token: result.token,
          expiresAt: result.expiresAt,
          subject: result.context.subject,
          principals: result.context.principals,
        });
      });

      // 客户端丢弃 token 即完成登出；服务端没有可失效的行。
      app.post('/logout', async () => ok<LogoutResponse>({ loggedOut: true }));
    },
  };
}
