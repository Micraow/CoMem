/** 登录、登出与当前账号安全（架构文档 §12.7）。 */

import type { FastifyInstance } from 'fastify';

import { ok } from '../envelope.js';
import {
  callerUserIdOf,
  isSystemAdmin,
  requestContextOf,
} from '../middleware.js';
import { requireRecord, requireString, type HttpRouteGroup } from '../server.js';

import type { HttpRouteServices } from './index.js';

export type AuthRouteServices = Pick<HttpRouteServices, 'auth' | 'identity' | 'systemAdmin'>;

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

interface MeResponse {
  readonly subject: string;
  readonly principals: readonly string[];
  readonly isAdmin: boolean;
}

interface PasswordChangeResponse {
  readonly passwordChanged: true;
}

export function createAuthRoutes(services: AuthRouteServices): HttpRouteGroup {
  const { auth, identity, systemAdmin } = services;

  return {
    prefix: '/auth',
    register(app: FastifyInstance): void {
      app.get('/me', async (request) => {
        const { subject, principals } = requestContextOf(request);
        return ok<MeResponse>({
          subject,
          principals,
          isAdmin: isSystemAdmin(request, systemAdmin),
        });
      });
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

      app.post<{ Body: unknown }>('/password', async (request) => {
        const body = requireRecord(request.body, 'auth/password');
        const currentPassword = requireString(body, 'currentPassword');
        const newPassword = requireString(body, 'newPassword');
        await identity.changeOwnPassword(
          callerUserIdOf(request),
          currentPassword,
          newPassword,
        );
        return ok<PasswordChangeResponse>({ passwordChanged: true });
      });

      // 客户端丢弃 token 即完成登出；服务端没有可失效的行。
      app.post('/logout', async () => ok<LogoutResponse>({ loggedOut: true }));
    },
  };
}
