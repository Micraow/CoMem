/**
 * 用户与组路由（架构文档 §14、§12.1、§12.5、§12.6）。
 *
 * 这一组端点包装 `IdentityService`：用户目录、组目录、组成员关系的校验与
 * 「不存在 → NOT_FOUND」都在服务层完成，这里只做 HTTP 协议转换。
 *
 * ## 授权：判定对象是目标资源，不是调用方自己的根
 *
 * **不能对「调用方自己的根」求 `manage`。** user 根的 owner 恒为该用户
 * （`domain/acl.ts` 的不变量 1），所以「自己的根可 manage」对每个登录用户都成立；
 * 用它当管理面的门禁等于任何登录用户都是管理员。
 *
 * 两类端点分开判定：
 *
 * | 类别 | 端点 | 判定 |
 * |---|---|---|
 * | 针对具体用户 / 组 | 改密码、签 / 列 / 撤销 key、启用禁用、删除、改资料、加退组成员、改组资料 / owner | 对 `comem://user/{target}` 或 `comem://group/{gid}` 求 `manage` |
 * | 跨主体（全局） | 列全部用户、创建用户、列全部组、创建组 | 必须是 `auth.adminUserIds` 里的系统管理员 |
 *
 * 目标级判定复用现有 ACL 语义，不新造权限：用户根默认只有本人能 manage；组根
 * 预置 `user:{owner} = manage` + `group:{gid} = write`，所以组 owner 与显式拿到
 * 组根 manage 的人能管理成员，普通组员只有 write，改不了成员关系。
 *
 * 系统管理员在两类端点上都是**显式配置**的旁路（默认空数组 = 没有人是管理员），
 * 因为它不在 ACL 里，不能通过求权得到。没有「第一个用户自动成为管理员」之类的
 * 隐式规则：默认值必须是安全的一侧。
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
 * **删组要清空组子树的直接授权。** `purgePrincipal('group:{gid}')` 只按主体清，
 * 子树里 `user:bob = write` 这样的直接授权不会被动。组不存在了，这些条目挂在谁也
 * 不认识的路径上；同 ID 重建的组会立刻继承它们——删组没有撤销共享范围。所以删组
 * 走两步：先 `purgePrincipal` 移除组主体，再 `purgeSubtree` 清空子树内的全部条目
 * （保留数据与 `mode`，见 `AclService.purgeSubtree`）。
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

import { groupPrincipal, userPrincipal } from '../../../domain/acl.js';
import { ComemError } from '../../../domain/errors.js';
import type { Group, User } from '../../../domain/identity.js';
import { assertValidGroupId, assertValidUserId } from '../../../domain/identity.js';
import { Uri } from '../../../domain/uri.js';
import type { Authorizer } from '../../../services/authorizer.js';
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
  /**
   * 一把 API Key 的持有者用户 ID；不存在返回 `null`。
   *
   * 撤销 key 的路径是 `DELETE /admin/api-keys/{keyId}`，请求里只有 key 的 ID，
   * 没有用户 ID——不反查持有者就只能对「调用方自己的根」求权，等于任何登录用户
   * 都能吊销别人的凭据。SQL 细节留在装配层（`api/` 不 import `adapters/`）。
   */
  apiKeyOwner(keyId: string): string | null;
  userCount(): number;
  groupCount(): number;
}

/**
 * 管理面需要的 ACL 操作。
 *
 * 用 `Pick` 而不是整个 `AclService`：路由只需要「建根预置」与「按主体 / 子树撤权」
 * 这几个方法。`AclService` 结构上满足它。
 */
export type AdminAcl = Pick<
  HttpRouteServices['acl'],
  'ensureRootPreset' | 'setGroupOwner' | 'purgePrincipal' | 'purgeSubtree'
>;

/**
 * 管理面需要的召回账本操作。
 *
 * 删账号 / 组时要删掉对应作用域的账本（`_meta/recall/{scopeKey}.recall_log.json`），
 * 否则同 ID 重建的账号会继承去重状态。用 `Pick` 保持与 `AdminAcl` 同样的最小依赖。
 */
export type AdminRecallLedger = Pick<HttpRouteServices['ledger'], 'remove'>;

export type AdminRouteServices = Pick<
  HttpRouteServices,
  'identity' | 'authorizer' | 'adminAccess'
> & {
  readonly acl: AdminAcl;
  readonly ledger: AdminRecallLedger;
  /**
   * 系统管理员用户 ID（`config.auth.adminUserIds`）。
   *
   * 必填而不是从 `config` 里现取：路由的授权口径应当在一处装配，测试也能直接
   * 给一个明确的名单（`[]` 表示没有管理员），不需要构造整份配置。
   */
  readonly adminUserIds: readonly string[];
};

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

/** `comem://user/{uid}` —— 用户的管理面判定对象。 */
function userRootOf(userId: string): Uri {
  return Uri.parse(`comem://user/${userId}`);
}

/** `comem://group/{gid}` —— 组的管理面判定对象。 */
function groupRootOf(groupId: string): Uri {
  return Uri.parse(`comem://group/${groupId}`);
}

/**
 * 目标资源的门禁：系统管理员，或对该资源所在的根有 `manage`。
 *
 * `target` 必须是**被操作的对象**（用户的根、组的根），不能是调用方自己的根——
 * owner 恒 manage，用自身根判定等于放行任何登录用户。
 */
async function assertManageOf(
  request: FastifyRequest,
  authorizer: Authorizer,
  adminUserIds: readonly string[],
  target: Uri,
): Promise<void> {
  if (isSystemAdmin(request, adminUserIds)) {
    return;
  }
  await authorizer.assert(target, MANAGE, requestContextOf(request).principals);
}

/** 取组；不存在抛 `NOT_FOUND`。先于求权：不能对不存在的组根做判定（也没法物化）。 */
function requireGroup(identity: AdminIdentity, groupId: string): Group {
  const group = identity.getGroup(groupId);
  if (group === null) {
    throw new ComemError('NOT_FOUND', `组不存在：${groupId}`, { groupId });
  }
  return group;
}

export function createAdminRoutes(services: AdminRouteServices): HttpRouteGroup {
  const { identity, authorizer, adminAccess, acl, ledger, adminUserIds } = services;

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
        assertSystemAdmin(request, adminUserIds);

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
        assertSystemAdmin(request, adminUserIds);

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
        await assertManageOf(request, authorizer, adminUserIds, userRootOf(id));

        const user = identity.updateUser(id, {
          ...(displayName === undefined ? {} : { displayName }),
          ...(email === undefined ? {} : { email }),
          ...(status === undefined ? {} : { status }),
        });
        return ok({ user });
      });

      app.delete<{ Params: { id: string } }>('/users/:id', async (request) => {
        const id = assertValidUserId(request.params.id);
        await assertManageOf(request, authorizer, adminUserIds, userRootOf(id));

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
        return ok({ id, deleted: true, revokedPermissions, clearedAclFiles });
      });

      // ── 密码 ──

      app.post<{ Params: { id: string }; Body: unknown }>(
        '/users/:id/password',
        async (request) => {
          const id = assertValidUserId(request.params.id);
          const body = requireRecord(request.body, 'admin/users/:id/password');
          const password = requireString(body, 'password');
          await assertManageOf(request, authorizer, adminUserIds, userRootOf(id));

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
          await assertManageOf(request, authorizer, adminUserIds, userRootOf(id));

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
        await assertManageOf(request, authorizer, adminUserIds, userRootOf(id));
        return ok({ keys: identity.listApiKeys(id) });
      });

      app.delete<{ Params: { keyId: string } }>('/api-keys/:keyId', async (request) => {
        const keyId = request.params.keyId;
        // 请求里只有 key 的 ID：先反查持有者，再对**持有者的根**求权。否则任何
        // 登录用户都能吊销别人的凭据（拒绝服务），这是同一类「用自身根自证」。
        const ownerUserId = adminAccess.apiKeyOwner(keyId);
        if (ownerUserId === null) {
          throw new ComemError('NOT_FOUND', `API Key 不存在：${keyId}`, { keyId });
        }
        await assertManageOf(request, authorizer, adminUserIds, userRootOf(ownerUserId));
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
        assertSystemAdmin(request, adminUserIds);

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
        assertSystemAdmin(request, adminUserIds);

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
        requireGroup(identity, id);
        await assertManageOf(request, authorizer, adminUserIds, groupRootOf(id));

        const group = identity.updateGroup(id, {
          ...(displayName === undefined ? {} : { displayName }),
          ...(description === undefined ? {} : { description }),
        });
        return ok({ group });
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
          !isSystemAdmin(request, adminUserIds)
        ) {
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
        // 先确认组存在再求权：删除路径会撤权、清账本，不能对不存在的组启动。
        requireGroup(identity, id);
        await assertManageOf(request, authorizer, adminUserIds, groupRootOf(id));

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
        return ok({ id, deleted: true, revokedPermissions, clearedAclFiles });
      });

      // ── 组成员 ──

      app.get<{ Params: { id: string } }>('/groups/:id/members', async (request) => {
        const groupId = assertValidGroupId(request.params.id);
        requireGroup(identity, groupId);
        await assertManageOf(request, authorizer, adminUserIds, groupRootOf(groupId));

        const members = identity.listMembers(groupId);
        return ok({ groupId, members, total: members.length });
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
          return ok({ member });
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
          return ok({ groupId, userId, removed: true });
        },
      );
    },
  };
}
