/**
 * 组目录（`/admin/groups*`）。
 *
 * 函数体与拆分前逐字相同，只加了 `ok` 的类型实参与 import。
 */

import type { FastifyInstance } from 'fastify';

import { groupPrincipal } from '../../../domain/acl.js';
import { ComemError } from '../../../domain/errors.js';
import { assertValidGroupId, assertValidUserId } from '../../../domain/identity.js';
import { Uri } from '../../../domain/uri.js';
import { scopeKeyOf } from '../../../services/recall-ledger.js';
import { ok } from '../envelope.js';
import {
  assertSystemAdmin,
  callerUserIdOf,
  isSystemAdmin,
  requestContextOf,
} from '../middleware.js';
import {
  optionalQueryInteger,
  requireRecord,
  requireString,
  type HttpRouteGroup,
} from '../server.js';

import type {
  AdminDeleteResponse,
  GroupListResponse,
  GroupResponse,
} from './admin.js';
import {
  DEFAULT_LIST_LIMIT,
  MANAGE,
  MAX_LIST_LIMIT,
  assertManageOf,
  groupRootOf,
  optionalNonEmptyString,
  optionalNullableString,
  requireGroup,
  type AdminRouteServices,
} from './admin-request.js';

export function createAdminGroupRoutes(services: AdminRouteServices): HttpRouteGroup {
  const { identity, authorizer, adminAccess, acl, ledger, systemAdmin } = services;

  return {
    prefix: '/admin',
    register(app: FastifyInstance): void {
      // ── 组 ──

      app.get<{ Querystring: Record<string, unknown> }>('/groups', async (request) => {
        const query = requireRecord(request.query, 'admin/groups');
        const limit = optionalQueryInteger(query, 'limit', DEFAULT_LIST_LIMIT, {
          min: 1,
          max: MAX_LIST_LIMIT,
        });
        const offset = optionalQueryInteger(query, 'offset', 0, { min: 0 });
        assertSystemAdmin(request, systemAdmin);

        const groups = identity.listGroups({ limit, offset });
        const memberCounts = adminAccess.memberCounts(groups.map((group) => group.id));
        const permissionCounts = adminAccess.permissionCounts(
          groups.map((group) => groupPrincipal(group.id)),
        );
        return ok<GroupListResponse>({
          groups: groups.map((group) => {
            const principal = groupPrincipal(group.id);
            return {
              ...group,
              ownerMissing: group.ownerUserId === null,
              memberCount: memberCounts.get(group.id) ?? 0,
              permissionCount: permissionCounts.get(principal) ?? 0,
            };
          }),
          total: adminAccess.groupCount(),
          limit,
          offset,
        });
      });

      app.post<{ Body: unknown }>('/groups', async (request) => {
        const body = requireRecord(request.body, 'admin/groups');
        const id = requireString(body, 'id');
        const displayName = requireString(body, 'displayName');
        const description = optionalNullableString(body, 'description');
        // 建组分配的是**全局组目录**里的一个新 ID，没有已存在的目标资源可以
        // 求权。归到跨主体一类：由系统管理员建组，owner 仍是创建者。
        assertSystemAdmin(request, systemAdmin);

        const ownerUserId = callerUserIdOf(request);
        const group = identity.createGroup({
          id,
          displayName,
          ...(description === undefined ? {} : { description }),
          ownerUserId,
        });
        // 根预置必须在建组之后：`ensureRootPreset` 只接受根 URI，而根要由组 ID
        // 拼出来。不补这一步，组空间没有任何可授权的节点，成员也拿不到可读范围。
        //
        // owner 就是创建者：组根只有 `group:{gid} = write` 时没有任何主体能求
        // manage，`setAcl` / `getAcl` 永远 403（§12.2 不变量 3）。
        await acl.ensureRootPreset(Uri.parse(`comem://group/${group.id}`), ownerUserId);
        return ok<GroupResponse>({ group });
      });

      app.patch<{ Params: { id: string }; Body: unknown }>('/groups/:id', async (request) => {
        const id = assertValidGroupId(request.params.id);
        const body = requireRecord(request.body, 'admin/groups/:id');
        const displayName = optionalNonEmptyString(body, 'displayName');
        const description = optionalNullableString(body, 'description');
        requireGroup(identity, id);
        await assertManageOf(request, authorizer, systemAdmin, groupRootOf(id));

        const group = identity.updateGroup(id, {
          ...(displayName === undefined ? {} : { displayName }),
          ...(description === undefined ? {} : { description }),
        });
        return ok<GroupResponse>({ group });
      });

      /**
       * 改组的 owner。
       *
       * **只有当前 owner、组根的 manage 持有者或系统管理员能改。** 不能只看
       * 「自己根的 manage」：那对任何登录用户都成立（owner 恒 manage），等于
       * 任何成员都能接管别人的组。
       *
       * 允许「当前 owner」单独成立是为迁移回填的存量组留修复路径：它们的
       * `owner_user_id` 有值，但 `.acl.json` 里还没有 `user:{owner} = manage`
       * 条目（SQL 迁移写不了文件）。owner 调一次本端点即可把预置补齐。
       */
      app.post<{ Params: { id: string }; Body: unknown }>('/groups/:id/owner', async (request) => {
        const id = assertValidGroupId(request.params.id);
        const body = requireRecord(request.body, 'admin/groups/:id/owner');
        const userId = assertValidUserId(requireString(body, 'userId'));
        const context = requestContextOf(request);

        const group = requireGroup(identity, id);
        if (identity.getUser(userId) === null) {
          throw new ComemError('NOT_FOUND', `用户不存在：${userId}`, { userId });
        }

        const groupRoot = groupRootOf(id);
        // `ownerUserId` 是元数据，不是授权（§12.2）：它只回答「谁是当前 owner」。
        // 为 `NULL` 时没有任何人是当前 owner，必须按组根 `manage` 求权——删账号会
        // 把这一列清空，组里如果没有第二个 manage 持有者，本端点就再也进不来，
        // 恢复只能走 `pnpm group:owner`（§12.6）。
        if (
          group.ownerUserId !== callerUserIdOf(request) &&
          !isSystemAdmin(request, systemAdmin)
        ) {
          // 不是当前 owner 时按组根的 manage 求权（Service 层会再求一次纵深防御
          // 之外的那部分由 `setGroupOwner` 跳过，原因见它的注释）。
          await authorizer.assert(groupRoot, MANAGE, context.principals);
        }

        await acl.setGroupOwner(groupRoot, group.ownerUserId, userId);
        const updated = identity.setGroupOwner(id, userId);
        return ok<GroupResponse>({ group: updated });
      });

      app.delete<{ Params: { id: string } }>('/groups/:id', async (request) => {
        const id = assertValidGroupId(request.params.id);
        // 先确认组存在再求权：删除路径会撤权、清账本，不能对不存在的组启动。
        requireGroup(identity, id);
        await assertManageOf(request, authorizer, systemAdmin, groupRootOf(id));

        const principal = groupPrincipal(id);
        // 当前主体属于这个组时，删组会连同它的可读范围一起消失；控制台随后每个
        // 依赖组授权的请求都会变成 403，而重建同 ID 的组不会恢复成员关系。
        if (requestContextOf(request).principals.includes(principal)) {
          throw new ComemError('CONFLICT', `不能删除当前主体所属的组：${principal}。`, {
            principal,
          });
        }

        const revokedPermissions = adminAccess.permissionCounts([principal]).get(principal) ?? 0;
        // 与删账号同序：账本是缓存，先删它失败时什么都没动。
        await ledger.remove(scopeKeyOf(Uri.parse(`comem://group/${id}`)));
        await acl.purgePrincipal(principal);
        // 组主体之外，组子树里还可能有 `user:bob = write` 这样的直接授权。
        // `purgePrincipal` 只按主体清，这些条目会留下：组不存在了，授权挂在一条
        // 谁都不认识的路径上，同 ID 重建后立刻生效——删组没有撤销共享范围。
        // 删组保留数据，但清空该子树内的全部 ACL 条目（§12.2、operations.md）。
        const clearedAclFiles = await acl.purgeSubtree(Uri.parse(`comem://group/${id}`));
        identity.deleteGroup(id);
        return ok<AdminDeleteResponse>({ id, deleted: true, revokedPermissions, clearedAclFiles });
      });
    },
  };
}
