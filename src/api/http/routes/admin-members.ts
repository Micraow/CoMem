/**
 * 组成员关系（`/admin/groups/{id}/members*`）。
 *
 * 函数体与拆分前逐字相同，只加了 `ok` 的类型实参与 import。
 */

import type { FastifyInstance } from 'fastify';

import { ComemError } from '../../../domain/errors.js';
import { assertValidGroupId, assertValidUserId } from '../../../domain/identity.js';
import { ok } from '../envelope.js';
import {
  requireRecord,
  requireString,
  type HttpRouteGroup,
} from '../server.js';

import type {
  GroupMemberRemoveResponse,
  GroupMemberResponse,
  GroupMembersResponse,
} from './admin.js';
import {
  assertManageOf,
  groupRootOf,
  requireGroup,
  type AdminRouteServices,
} from './admin-request.js';

export function createAdminMemberRoutes(services: AdminRouteServices): HttpRouteGroup {
  const { identity, authorizer, adminUserIds } = services;

  return {
    prefix: '/admin',
    register(app: FastifyInstance): void {
      // ── 组成员 ──

      app.get<{ Params: { id: string } }>('/groups/:id/members', async (request) => {
        const groupId = assertValidGroupId(request.params.id);
        requireGroup(identity, groupId);
        await assertManageOf(request, authorizer, adminUserIds, groupRootOf(groupId));

        const members = identity.listMembers(groupId);
        return ok<GroupMembersResponse>({ groupId, members, total: members.length });
      });

      app.post<{ Params: { id: string }; Body: unknown }>(
        '/groups/:id/members',
        async (request) => {
          const groupId = assertValidGroupId(request.params.id);
          const body = requireRecord(request.body, 'admin/groups/:id/members');
          const userId = assertValidUserId(requireString(body, 'userId'));
          // 成员的 `role` 是派生值（`app_group.owner_user_id`），不是可写属性。
          // 允许显式写入会让响应里出现「owner 但没有任何 owner 能力」的行；改
          // owner 的入口只有一个。
          if (body['role'] !== undefined) {
            throw new ComemError(
              'INVALID_ARGUMENT',
              '成员的 role 是派生字段，不能显式写入；改组 owner 用 POST /admin/groups/{id}/owner。',
              { field: 'role' },
            );
          }
          requireGroup(identity, groupId);
          // **不能只看「自己的根」**：owner 恒 manage，任何登录用户都满足。加组
          // 成员会给出 `group:{gid}` 主体，而组根预置 `group:{gid} = write`——
          // 自助入组等于拿到整棵组子树。判定对象是组根。
          await assertManageOf(request, authorizer, adminUserIds, groupRootOf(groupId));

          const member = identity.addMember(groupId, userId);
          return ok<GroupMemberResponse>({ member });
        },
      );

      app.delete<{ Params: { id: string; userId: string } }>(
        '/groups/:id/members/:userId',
        async (request) => {
          const groupId = assertValidGroupId(request.params.id);
          const userId = assertValidUserId(request.params.userId);
          requireGroup(identity, groupId);
          await assertManageOf(request, authorizer, adminUserIds, groupRootOf(groupId));

          identity.removeMember(groupId, userId);
          return ok<GroupMemberRemoveResponse>({ groupId, userId, removed: true });
        },
      );
    },
  };
}
