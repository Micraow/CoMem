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
 * ## 删除用户 / 组：撤权，但不删节点
 *
 * 删账号与删记忆是两件事。`node_permission` 里 `principal = user:{id}` 的行如果
 * 留着，反查会列出不存在的主体；更糟的是同名用户重建后会**立即继承**这些行。
 *
 * 只删行还不够：两张表是 `.acl.json` 的物化结果，下次 `materializeNode` 会把
 * 授权重新算出来。所以删除账号之前必须调 `AclService.purgePrincipal` 真改文件。
 * 顺序是「先撤权、再删账号」——反过来时撤权失败会留下一个「账号没了、授权还在」
 * 的状态，而失败方向应当收得更紧，不是更松。
 *
 * **不递归删节点。** 用户写过的记忆仍然属于那个根，所有权转移或显式删除是另一个
 * 动作。把「删账号」实现成「删数据」会让一次误操作不可恢复。
 *
 * ## 不能删掉当前绑定主体
 *
 * 删掉 `user:local` 之后服务仍在跑，但它绑定的 `app_user` 行没了，控制台每个
 * 请求都 401；重启会重建用户，而授权已经被撤掉。删组同理：当前主体属于那个组时，
 * 删组会让它失去组空间的全部可读范围。两者都返回 409。
 *
 * ## 建组要写根预置
 *
 * `IdentityService.createGroup` 只写 `app_group`。没有 `comem://group/{gid}/` 的
 * ACL 根，这个组任何节点都无法授权、成员也没有可读范围——它是一个死组。根预置是
 * 异步写盘（`ensureRootPreset`），只能在路由里等它完成。
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
  | 'getUser'
  | 'listUsers'
  | 'updateUser'
  | 'deleteUser'
  | 'createGroup'
  | 'getGroup'
  | 'listGroups'
  | 'updateGroup'
  | 'setGroupOwner'
  | 'deleteGroup'
  | 'addMember'
  | 'removeMember'
  | 'listMembers'
  | 'ensureUserNamespace'
  | 'setPassword'
  | 'createApiKey'
  | 'listApiKeys'
  | 'revokeApiKey'
>;

/**
 * 管理面需要的统计端口。
 *
 * 实现由 `bootstrap/container.ts` 注入：`api/` 不能 import `adapters/`（架构文档
 * §4.2），SQL 细节留在装配层。
 */
export interface AdminAccess {
  /** 每个主体在 `node_permission` 里的行数（按主体分组）。 */
  permissionCounts(principals: readonly string[]): ReadonlyMap<string, number>;
  /** 每个组的成员数。 */
  memberCounts(groupIds: readonly string[]): ReadonlyMap<string, number>;
  userCount(): number;
  groupCount(): number;
}

/**
 * 管理面需要的 ACL 操作。
 *
 * 用 `Pick` 而不是整个 `AclService`：路由只需要「建根预置」与「按主体撤权」两个
 * 方法。`AclService` 结构上满足它。
 */
export type AdminAcl = Pick<
  HttpRouteServices['acl'],
  'ensureRootPreset' | 'setGroupOwner' | 'purgePrincipal'
>;

export type AdminRouteServices = Pick<
  HttpRouteServices,
  'identity' | 'authorizer' | 'adminAccess'
> & { readonly acl: AdminAcl };

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

/** 当前主体的用户 ID（`user:{uid}` 的 uid）。中间件已经保证 subject 是 user。 */
function callerUserIdOf(request: FastifyRequest): string {
  return parsePrincipal(requestContextOf(request).subject).id;
}

async function assertManage(request: FastifyRequest, authorizer: Authorizer): Promise<void> {
  await authorizer.assert(ownRootOf(request), MANAGE, requestContextOf(request).principals);
}

export function createAdminRoutes(services: AdminRouteServices): HttpRouteGroup {
  const { identity, authorizer, adminAccess, acl } = services;

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
        // 新账号的根与四个上下文目录要立刻预置：不预置的话，第一次登录看到的是
        // 403 而不是空列表（`ensureUserNamespace` 的注释）。
        await identity.ensureUserNamespace(id);
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

        const principal = userPrincipal(id);
        if (requestContextOf(request).subject === principal) {
          throw new ComemError('CONFLICT', `不能删除当前登录用户：${principal}。`, {
            principal,
          });
        }

        const revokedPermissions = adminAccess.permissionCounts([principal]).get(principal) ?? 0;
        await acl.purgePrincipal(principal);
        identity.deleteUser(id);
        return ok({ id, deleted: true, revokedPermissions });
      });

      // ── 密码 ──

      app.post<{ Params: { id: string }; Body: unknown }>(
        '/users/:id/password',
        async (request) => {
          const id = assertValidUserId(request.params.id);
          const body = requireRecord(request.body, 'admin/users/:id/password');
          const password = requireString(body, 'password');
          await assertManage(request, authorizer);

          await identity.setPassword(id, password);
          return ok({ id, passwordSet: true });
        },
      );

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
          await assertManage(request, authorizer);

          const { raw, record } = await identity.createApiKey(id, {
            name,
            expiresAt: expiresAt ?? null,
          });
          return ok({
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
        await assertManage(request, authorizer);
        return ok({ keys: identity.listApiKeys(id) });
      });

      app.delete<{ Params: { keyId: string } }>('/api-keys/:keyId', async (request) => {
        const keyId = request.params.keyId;
        await assertManage(request, authorizer);
        const revoked = identity.revokeApiKey(keyId);
        if (!revoked) {
          throw new ComemError('NOT_FOUND', `API Key 不存在：${keyId}`, { keyId });
        }
        return ok({ keyId, revoked: true });
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

      /**
       * 改组的 owner。
       *
       * **只有当前 owner 或组根的 manage 持有者能改。** 不能只看「自己根的
       * manage」：那对任何登录用户都成立（owner 恒 manage），等于任何成员都能
       * 接管别人的组。
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

        const group = identity.getGroup(id);
        if (group === null) {
          throw new ComemError('NOT_FOUND', `组不存在：${id}`, { groupId: id });
        }
        if (identity.getUser(userId) === null) {
          throw new ComemError('NOT_FOUND', `用户不存在：${userId}`, { userId });
        }

        const groupRoot = Uri.parse(`comem://group/${id}`);
        if (group.ownerUserId !== callerUserIdOf(request)) {
          // 不是当前 owner 时按组根的 manage 求权（Service 层会再求一次纵深防御
          // 之外的那部分由 `setGroupOwner` 跳过，原因见它的注释）。
          await authorizer.assert(groupRoot, MANAGE, context.principals);
        }

        await acl.setGroupOwner(groupRoot, group.ownerUserId, userId);
        const updated = identity.setGroupOwner(id, userId);
        return ok({ group: updated });
      });

      app.delete<{ Params: { id: string } }>('/groups/:id', async (request) => {
        const id = assertValidGroupId(request.params.id);
        await assertManage(request, authorizer);

        const principal = groupPrincipal(id);
        // 当前主体属于这个组时，删组会连同它的可读范围一起消失；控制台随后每个
        // 依赖组授权的请求都会变成 403，而重建同 ID 的组不会恢复成员关系。
        if (requestContextOf(request).principals.includes(principal)) {
          throw new ComemError('CONFLICT', `不能删除当前主体所属的组：${principal}。`, {
            principal,
          });
        }

        const revokedPermissions = adminAccess.permissionCounts([principal]).get(principal) ?? 0;
        await acl.purgePrincipal(principal);
        identity.deleteGroup(id);
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
