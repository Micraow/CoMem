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
 * 为了让客户端有统一出口，也让「如何登出」有一个文档能指向的答案。要立刻让一个
 * 还没过期的 token 失效，只能撤销它对应的 API Key 或改密码——这两条都不影响已
 * 签发的 session token。这个限制写进 `docs/operations.md`。
 *
 * ## 认证未启用时返回 404
 *
 * `auth.enabled: false` 是 v1 的单用户部署，身份来自 `x-comem-subject`。此时
 * 登录端点签发的 token 不会被任何地方接受——一个「成功但没用」的端点比一个明确
 * 的 404 更难发现（AGENTS.md §1 的「假配置」）。
 */

import type { FastifyInstance } from 'fastify';

import { ComemError } from '../../../domain/errors.js';
import { ok } from '../envelope.js';
import { requireRecord, requireString, type HttpRouteGroup } from '../server.js';

import type { HttpRouteServices } from './index.js';

export type AuthRouteServices = Pick<HttpRouteServices, 'auth' | 'config'>;

function assertEnabled(config: HttpRouteServices['config']): void {
  if (!config.auth.enabled) {
    throw new ComemError('NOT_FOUND', '认证未启用（auth.enabled = false）。');
  }
}

export function createAuthRoutes(services: AuthRouteServices): HttpRouteGroup {
  const { auth, config } = services;

  return {
    prefix: '/auth',
    register(app: FastifyInstance): void {
      app.post<{ Body: unknown }>('/login', async (request) => {
        assertEnabled(config);
        const body = requireRecord(request.body, 'auth/login');
        const username = requireString(body, 'username');
        const password = requireString(body, 'password');

        const result = await auth.login(username, password);
        return ok({
          token: result.token,
          expiresAt: result.expiresAt,
          subject: result.context.subject,
          principals: result.context.principals,
        });
      });

      // 客户端丢弃 token 即完成登出；服务端没有可失效的行。
      app.post('/logout', async () => {
        assertEnabled(config);
        return ok({ loggedOut: true });
      });
    },
  };
}
