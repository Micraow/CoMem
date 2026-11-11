/**
 * API Key 管理（`/admin/users/{id}/api-keys`、`/admin/api-keys/{keyId}`）。
 *
 * 函数体与拆分前逐字相同，只加了 `ok` 的类型实参与 import。
 */

import type { FastifyInstance } from 'fastify';

import { ComemError } from '../../../domain/errors.js';
import { assertValidUserId } from '../../../domain/identity.js';
import { ok } from '../envelope.js';
import {
  optionalString,
  requireRecord,
  requireString,
  type HttpRouteGroup,
} from '../server.js';

import type {
  ApiKeyCreateResponse,
  ApiKeyListResponse,
  ApiKeyRevokeResponse,
} from './admin.js';
import {
  assertManageOf,
  userRootOf,
  type AdminRouteServices,
} from './admin-request.js';

export function createAdminApiKeyRoutes(services: AdminRouteServices): HttpRouteGroup {
  const { identity, authorizer, adminAccess, systemAdmin } = services;

  return {
    prefix: '/admin',
    register(app: FastifyInstance): void {
      // ── API Key ──
      //
      // 明文只出现在创建响应里一次。列表与其它出口只回 `prefix`——它是查找键，
      // 不是秘密；`keyHash` 永不出现在任何响应里。

      app.post<{ Params: { id: string }; Body: unknown }>(
        '/users/:id/api-keys',
        async (request) => {
          const id = assertValidUserId(request.params.id);
          const body = requireRecord(request.body, 'admin/users/:id/api-keys');
          const name = requireString(body, 'name');
          const expiresAt = optionalString(body, 'expiresAt');
          await assertManageOf(request, authorizer, systemAdmin, userRootOf(id));

          const { raw, record } = await identity.createApiKey(id, {
            name,
            expiresAt: expiresAt ?? null,
          });
          return ok<ApiKeyCreateResponse>({
            id: record.id,
            name: record.name,
            prefix: record.prefix,
            createdAt: record.createdAt,
            expiresAt: record.expiresAt,
            // 唯一一次明文返回。写进响应体的注释提醒未来的改动：不要把它加进
            // 列表端点。
            key: raw,
          });
        },
      );

      app.get<{ Params: { id: string } }>('/users/:id/api-keys', async (request) => {
        const id = assertValidUserId(request.params.id);
        await assertManageOf(request, authorizer, systemAdmin, userRootOf(id));
        return ok<ApiKeyListResponse>({ keys: identity.listApiKeys(id) });
      });

      app.delete<{ Params: { keyId: string } }>('/api-keys/:keyId', async (request) => {
        const keyId = request.params.keyId;
        // 请求里只有 key 的 ID：先反查持有者，再对**持有者的根**求权。否则任何
        // 登录用户都能吊销别人的凭据（拒绝服务），这是同一类「用自身根自证」。
        const ownerUserId = adminAccess.apiKeyOwner(keyId);
        if (ownerUserId === null) {
          throw new ComemError('NOT_FOUND', `API Key 不存在：${keyId}`, { keyId });
        }
        await assertManageOf(request, authorizer, systemAdmin, userRootOf(ownerUserId));
        const revoked = identity.revokeApiKey(keyId);
        if (!revoked) {
          throw new ComemError('NOT_FOUND', `API Key 不存在：${keyId}`, { keyId });
        }
        return ok<ApiKeyRevokeResponse>({ keyId, revoked: true });
      });
    },
  };
}
