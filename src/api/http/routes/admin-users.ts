/**
 * 用户目录（`/admin/users*`）。
 *
 * 函数体与拆分前逐字相同，只加了 `ok` 的类型实参与 import。
 */

import type { FastifyInstance } from 'fastify';

import { userPrincipal } from '../../../domain/acl.js';
import { ComemError } from '../../../domain/errors.js';
import { assertValidUserId } from '../../../domain/identity.js';
import { Uri } from '../../../domain/uri.js';
import { scopeKeyOf } from '../../../services/recall-ledger.js';
import { ok } from '../envelope.js';
import { assertSystemAdmin, requestContextOf } from '../middleware.js';
import {
  optionalQueryInteger,
  requireRecord,
  requireString,
  type HttpRouteGroup,
} from '../server.js';

import type {
  AdminDeleteResponse,
  UserListResponse,
  UserPasswordResponse,
  UserResponse,
} from './admin.js';
import {
  DEFAULT_LIST_LIMIT,
  MAX_LIST_LIMIT,
  assertManageOf,
  optionalNonEmptyString,
  optionalNullableString,
  parseStatus,
  userRootOf,
  type AdminRouteServices,
} from './admin-request.js';

export function createAdminUserRoutes(services: AdminRouteServices): HttpRouteGroup {
  const { identity, authorizer, adminAccess, acl, ledger, systemAdmin } = services;

  return {
    prefix: '/admin',
    register(app: FastifyInstance): void {
      // ── 用户 ──

      app.get<{ Querystring: Record<string, unknown> }>('/users', async (request) => {
        const query = requireRecord(request.query, 'admin/users');
        const limit = optionalQueryInteger(query, 'limit', DEFAULT_LIST_LIMIT, {
          min: 1,
          max: MAX_LIST_LIMIT,
        });
        const offset = optionalQueryInteger(query, 'offset', 0, { min: 0 });
        assertSystemAdmin(request, systemAdmin);

        const users = identity.listUsers({ limit, offset });
        const counts = adminAccess.permissionCounts(
          users.map((user) => userPrincipal(user.id)),
        );
        return ok<UserListResponse>({
          users: users.map((user) => ({
            ...user,
            permissionCount: counts.get(userPrincipal(user.id)) ?? 0,
          })),
          total: adminAccess.userCount(),
          limit,
          offset,
        });
      });

      app.post<{ Body: unknown }>('/users', async (request) => {
        const body = requireRecord(request.body, 'admin/users');
        const id = requireString(body, 'id');
        const displayName = requireString(body, 'displayName');
        const email = optionalNullableString(body, 'email');
        assertSystemAdmin(request, systemAdmin);

        const user = identity.createUser({
          id,
          displayName,
          ...(email === undefined ? {} : { email }),
        });
        // 新账号的根与四个上下文目录要立刻预置：不预置的话，第一次登录看到的是
        // 403 而不是空列表（`ensureUserNamespace` 的注释）。
        await identity.ensureUserNamespace(id);
        return ok<UserResponse>({ user });
      });

      app.patch<{ Params: { id: string }; Body: unknown }>('/users/:id', async (request) => {
        const id = assertValidUserId(request.params.id);
        const body = requireRecord(request.body, 'admin/users/:id');
        const displayName = optionalNonEmptyString(body, 'displayName');
        const email = optionalNullableString(body, 'email');
        const status = body['status'] === undefined ? undefined : parseStatus(body['status']);
        await assertManageOf(request, authorizer, systemAdmin, userRootOf(id));

        const user = identity.updateUser(id, {
          ...(displayName === undefined ? {} : { displayName }),
          ...(email === undefined ? {} : { email }),
          ...(status === undefined ? {} : { status }),
        });
        return ok<UserResponse>({ user });
      });

      app.delete<{ Params: { id: string } }>('/users/:id', async (request) => {
        const id = assertValidUserId(request.params.id);
        await assertManageOf(request, authorizer, systemAdmin, userRootOf(id));

        const principal = userPrincipal(id);
        if (requestContextOf(request).subject === principal) {
          throw new ComemError('CONFLICT', `不能删除当前登录用户：${principal}。`, {
            principal,
          });
        }

        const revokedPermissions = adminAccess.permissionCounts([principal]).get(principal) ?? 0;
        // 删账号要撤三样东西，顺序按「失败方向」排：先删账本（缓存，丢了只多投
        // 一次），再撤主体条目（真改 `.acl.json`），最后清空命名空间里的直接授权。
        // 反过来的话，撤权成功而账本删除失败会留下「账号还在、去重状态已经丢了」
        // 的半撤状态；账本先删，失败时什么都没动。
        await ledger.remove(scopeKeyOf(Uri.parse(`comem://user/${id}`)));
        await acl.purgePrincipal(principal);
        // `purgePrincipal` 只按主体清：`comem://user/alice/...` 上别人给 alice 开的
        // 授权（`group:eng = read` 之类）不会被动。账号不存在了，它命名空间里的任何
        // 授权都不该继续有效——同 ID 重建后组员仍然能读旧数据，等于删账号没有撤销
        // 共享范围。清空条目但保留数据与 `mode`，见 `AclService.purgeSubtree`。
        const clearedAclFiles = await acl.purgeSubtree(Uri.parse(`comem://user/${id}`));
        identity.deleteUser(id);
        return ok<AdminDeleteResponse>({ id, deleted: true, revokedPermissions, clearedAclFiles });
      });

      // ── 密码 ──

      app.post<{ Params: { id: string }; Body: unknown }>(
        '/users/:id/password',
        async (request) => {
          const id = assertValidUserId(request.params.id);
          const body = requireRecord(request.body, 'admin/users/:id/password');
          const password = requireString(body, 'password');
          await assertManageOf(request, authorizer, systemAdmin, userRootOf(id));

          await identity.setPassword(id, password);
          return ok<UserPasswordResponse>({ id, passwordSet: true });
        },
      );
    },
  };
}
