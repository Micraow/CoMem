/**
 * 用户与组路由（架构文档 §14、§12.1、§12.5、§12.6）。
 *
 * 这一组端点包装 `IdentityService`：用户目录、组目录、组成员关系的校验与
 * 「不存在 → NOT_FOUND」都在服务层完成，这里只做 HTTP 协议转换。
 *
 * ## 授权
 *
 * 每个出口都先对**当前主体自己的根**求 `manage`（§12.4 的出口清单）。v1 是单用户
 * 部署，服务图绑定的主体就是请求身份；对自身根求权仍然是必要的：一旦以后换成
 * 每请求一份服务图，这里漏掉检查就会变成「任何登录用户都能列全部用户」。
 *
 * `Authorizer.assert` 抛的是 `PERMISSION_DENIED`：`ComemErrorCode` 是冻结枚举，
 * 没有 `FORBIDDEN`，403 的稳定码就是它。错误封套走标准的 `toErrorEnvelope`。
 *
 * ## 删除用户 / 组：清理物化权限，但不删节点
 *
 * 删账号与删记忆是两件事。`node_permission` 里 `principal = user:{id}` 的行如果
 * 留着，反查会列出不存在的主体；更糟的是同名用户重建后会**立即继承**这些行。
 * 所以删除账号时在同一个事务里清掉该主体的 `node_permission` 与 `acl_entry` 行，
 * 并把撤销的节点数返回给调用方（`revokedPermissions`）。
 *
 * **不递归删节点。** 用户写过的记忆仍然属于那个根，所有权转移或显式删除是另一个
 * 动作。把「删账号」实现成「删数据」会让一次误操作不可恢复。
 *
 * ## 事务边界
 *
 * `AdminAccess.revoke` 是 bootstrap 注入的端口：它开事务、清 ACL 行、再执行删除
 * 用户的回调。`api/` 不能 import `adapters/`（架构文档 §4.2），事务细节留在装配层。
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';

import { groupPrincipal, parsePrincipal, userPrincipal } from '../../../domain/acl.js';
import { ComemError } from '../../../domain/errors.js';
import type { GroupMember, User } from '../../../domain/identity.js';
import { assertValidGroupId, assertValidUserId } from '../../../domain/identity.js';
import { Uri } from '../../../domain/uri.js';
import type { Authorizer } from '../../../services/authorizer.js';
import { ok } from '../envelope.js';
import { requestContextOf } from '../middleware.js';
import {
  optionalQueryInteger,
  optionalString,
  requireRecord,
  requireString,
  type HttpRouteGroup,
} from '../server.js';

import type { HttpRouteServices } from './index.js';

/** §12.1：manage = 7。 */
const MANAGE = 7;

/** 列表默认条数，与两个仓储的默认值一致。 */
const DEFAULT_LIST_LIMIT = 100;

/** 单页上限。控制台一页 500 个用户已经要滚动，再多不会有人读完。 */
const MAX_LIST_LIMIT = 500;

const USER_STATUSES = ['active', 'disabled'] as const;
const MEMBER_ROLES = ['owner', 'member'] as const;

/**
 * 管理面用到的身份用例。
 *
 * 用 `Pick` 而不是整个 `IdentityService`：路由只依赖它调用的方法，测试可以传
 * 一个只实现这些方法的结构替身。`IdentityService` 结构上满足它。
 */
export type AdminIdentity = Pick<
  HttpRouteServices['identity'],
  | 'createUser'
  | 'listUsers'
  | 'updateUser'
  | 'deleteUser'
  | 'createGroup'
  | 'listGroups'
  | 'updateGroup'
  | 'deleteGroup'
  | 'addMember'
  | 'removeMember'
  | 'listMembers'
>;

/**
 * 管理面需要的统计与 ACL 清理端口。
 *
 * 实现由 `bootstrap/container.ts` 注入：`api/` 不能 import `adapters/`，而
 * 「按主体清 ACL 行」必须和「删用户」在同一个事务里。
 */
export interface AdminAccess {
  /** 每个主体在 `node_permission` 里的行数（按主体分组）。 */
  permissionCounts(principals: readonly string[]): ReadonlyMap<string, number>;
  /** 每个组的成员数。 */
  memberCounts(groupIds: readonly string[]): ReadonlyMap<string, number>;
  userCount(): number;
  groupCount(): number;
  /**
   * 在一个事务里删除该主体的 ACL 行，并执行 `work`，返回删除的
   * `node_permission` 行数。`work` 抛错时整个事务回滚。
   */
  revoke(principal: string, work: () => void): number;
}

export type AdminRouteServices = Pick<HttpRouteServices, 'identity' | 'authorizer' | 'adminAccess'>;

function invalidArgument(field: string, expected: string, value: unknown): ComemError {
  return new ComemError('INVALID_ARGUMENT', `参数 ${field} 必须是${expected}。`, {
    field,
    value,
  });
}

/** 允许 `null` 的可选字符串：`null` 表示清空，`undefined` 表示不修改。 */
function optionalNullableString(
  body: Record<string, unknown>,
  field: string,
): string | null | undefined {
  const value = body[field];
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    throw invalidArgument(field, '字符串或 null', value);
  }
  return value;
}

/** 可选字符串，但传了就不能是空串（显示名不能为空）。 */
function optionalNonEmptyString(
  body: Record<string, unknown>,
  field: string,
): string | undefined {
  const value = optionalString(body, field);
  if (value === '') {
    throw invalidArgument(field, '非空字符串', value);
  }
  return value;
}

function parseStatus(value: unknown): User['status'] {
  const status = USER_STATUSES.find((candidate) => candidate === value);
  if (status === undefined) {
    throw invalidArgument('status', USER_STATUSES.join(' / '), value);
  }
  return status;
}

function parseRole(value: unknown): GroupMember['role'] {
  if (value === undefined) {
    return 'member';
  }
  const role = MEMBER_ROLES.find((candidate) => candidate === value);
  if (role === undefined) {
    throw invalidArgument('role', MEMBER_ROLES.join(' / '), value);
  }
  return role;
}

/** 当前主体自己的根。中间件已经保证 subject 是 `user:` 主体。 */
function ownRootOf(request: FastifyRequest): Uri {
  const context = requestContextOf(request);
  const principal = parsePrincipal(context.subject);
  return Uri.parse(`comem://user/${principal.id}`);
}

async function assertManage(request: FastifyRequest, authorizer: Authorizer): Promise<void> {
  await authorizer.assert(ownRootOf(request), MANAGE);
}

export function createAdminRoutes(services: AdminRouteServices): HttpRouteGroup {
  const { identity, authorizer, adminAccess } = services;

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
        await assertManage(request, authorizer);

        const users = identity.listUsers({ limit, offset });
        const counts = adminAccess.permissionCounts(
          users.map((user) => userPrincipal(user.id)),
        );
        return ok({
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
        await assertManage(request, authorizer);

        const user = identity.createUser({
          id,
          displayName,
          ...(email === undefined ? {} : { email }),
        });
        return ok({ user });
      });

      app.patch<{ Params: { id: string }; Body: unknown }>('/users/:id', async (request) => {
        const id = assertValidUserId(request.params.id);
        const body = requireRecord(request.body, 'admin/users/:id');
        const displayName = optionalNonEmptyString(body, 'displayName');
        const email = optionalNullableString(body, 'email');
        const status = body['status'] === undefined ? undefined : parseStatus(body['status']);
        await assertManage(request, authorizer);

        const user = identity.updateUser(id, {
          ...(displayName === undefined ? {} : { displayName }),
          ...(email === undefined ? {} : { email }),
          ...(status === undefined ? {} : { status }),
        });
        return ok({ user });
      });

      app.delete<{ Params: { id: string } }>('/users/:id', async (request) => {
        const id = assertValidUserId(request.params.id);
        await assertManage(request, authorizer);

        const revokedPermissions = adminAccess.revoke(userPrincipal(id), () =>
          identity.deleteUser(id),
        );
        return ok({ id, deleted: true, revokedPermissions });
      });

      // ── 组 ──

      app.get<{ Querystring: Record<string, unknown> }>('/groups', async (request) => {
        const query = requireRecord(request.query, 'admin/groups');
        const limit = optionalQueryInteger(query, 'limit', DEFAULT_LIST_LIMIT, {
          min: 1,
          max: MAX_LIST_LIMIT,
        });
        const offset = optionalQueryInteger(query, 'offset', 0, { min: 0 });
        await assertManage(request, authorizer);

        const groups = identity.listGroups({ limit, offset });
        const memberCounts = adminAccess.memberCounts(groups.map((group) => group.id));
        const permissionCounts = adminAccess.permissionCounts(
          groups.map((group) => groupPrincipal(group.id)),
        );
        return ok({
          groups: groups.map((group) => {
            const principal = groupPrincipal(group.id);
            return {
              ...group,
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
        await assertManage(request, authorizer);

        const group = identity.createGroup({
          id,
          displayName,
          ...(description === undefined ? {} : { description }),
        });
        return ok({ group });
      });

      app.patch<{ Params: { id: string }; Body: unknown }>('/groups/:id', async (request) => {
        const id = assertValidGroupId(request.params.id);
        const body = requireRecord(request.body, 'admin/groups/:id');
        const displayName = optionalNonEmptyString(body, 'displayName');
        const description = optionalNullableString(body, 'description');
        await assertManage(request, authorizer);

        const group = identity.updateGroup(id, {
          ...(displayName === undefined ? {} : { displayName }),
          ...(description === undefined ? {} : { description }),
        });
        return ok({ group });
      });

      app.delete<{ Params: { id: string } }>('/groups/:id', async (request) => {
        const id = assertValidGroupId(request.params.id);
        await assertManage(request, authorizer);

        const revokedPermissions = adminAccess.revoke(groupPrincipal(id), () =>
          identity.deleteGroup(id),
        );
        return ok({ id, deleted: true, revokedPermissions });
      });

      // ── 组成员 ──

      app.get<{ Params: { id: string } }>('/groups/:id/members', async (request) => {
        const groupId = assertValidGroupId(request.params.id);
        await assertManage(request, authorizer);

        const members = identity.listMembers(groupId);
        return ok({ groupId, members, total: members.length });
      });

      app.post<{ Params: { id: string }; Body: unknown }>(
        '/groups/:id/members',
        async (request) => {
          const groupId = assertValidGroupId(request.params.id);
          const body = requireRecord(request.body, 'admin/groups/:id/members');
          const userId = assertValidUserId(requireString(body, 'userId'));
          const role = parseRole(body['role']);
          await assertManage(request, authorizer);

          const member = identity.addMember(groupId, userId, role);
          return ok({ member });
        },
      );

      app.delete<{ Params: { id: string; userId: string } }>(
        '/groups/:id/members/:userId',
        async (request) => {
          const groupId = assertValidGroupId(request.params.id);
          const userId = assertValidUserId(request.params.userId);
          await assertManage(request, authorizer);

          identity.removeMember(groupId, userId);
          return ok({ groupId, userId, removed: true });
        },
      );
    },
  };
}
