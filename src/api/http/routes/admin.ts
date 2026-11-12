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
 *
 * 请求解析与共享依赖契约在 `admin-request.ts`；四个资源各自一个文件，本文件只做
 * 装配与响应形状。
 */

import type { FastifyInstance } from 'fastify';

import type { Group, GroupMember, User } from '../../../domain/identity.js';
import type { HttpRouteGroup } from '../server.js';

import type { HttpRouteServices } from './index.js';
import type { AdminRouteServices } from './admin-request.js';
import { createAdminApiKeyRoutes } from './admin-api-keys.js';
import { createAdminGroupRoutes } from './admin-groups.js';
import { createAdminMemberRoutes } from './admin-members.js';
import { createAdminUserRoutes } from './admin-users.js';

export type {
  AdminAccess,
  AdminAcl,
  AdminIdentity,
  AdminRecallLedger,
  AdminRouteServices,
} from './admin-request.js';

/**
 * 用户视图：资料 + 是否设过密码。
 *
 * `hasPassword` 只回布尔，`app_user.password_hash` 不进任何响应。列表、创建、更新
 * 共用这一份形状：少给一处，控制台换行渲染时就会把这个字段丢掉。
 */
type UserView = User & { readonly hasPassword: boolean };

/** 用户列表项：用户视图 + 该主体在 `node_permission` 里的行数。 */
interface SerializedUser extends UserView {
  readonly permissionCount: number;
}

/** 组列表项：组资料 + owner 是否存在 + 成员数 + 授权行数。 */
interface SerializedGroup extends Group {
  readonly ownerMissing: boolean;
  readonly memberCount: number;
  readonly permissionCount: number;
}

/** `GET /admin/users` 的响应体。 */
interface UserListResponse {
  readonly users: readonly SerializedUser[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}

/** `POST /admin/users`、`PATCH /admin/users/{id}` 的响应体。 */
interface UserResponse {
  readonly user: UserView;
}

/** `DELETE /admin/users/{id}`、`DELETE /admin/groups/{id}` 的响应体。 */
interface AdminDeleteResponse {
  readonly id: string;
  readonly deleted: true;
  readonly revokedPermissions: number;
  readonly clearedAclFiles: number;
}

/** `POST /admin/users/{id}/password` 的响应体。 */
interface UserPasswordResponse {
  readonly id: string;
  readonly passwordSet: true;
}

/** API Key 行的读视图（`IdentityService.listApiKeys` 的返回元素）。 */
type ApiKeyView = ReturnType<HttpRouteServices['identity']['listApiKeys']>[number];

/** `POST /admin/users/{id}/api-keys` 的响应体：明文 `key` 只在这里出现一次。 */
interface ApiKeyCreateResponse {
  readonly id: string;
  readonly name: string;
  readonly prefix: string;
  readonly createdAt: string;
  readonly expiresAt: string | null;
  /** 唯一一次明文返回；列表端点没有这个字段。 */
  readonly key: string;
}

/** `GET /admin/users/{id}/api-keys` 的响应体。 */
interface ApiKeyListResponse {
  readonly keys: readonly ApiKeyView[];
}

/** `DELETE /admin/api-keys/{keyId}` 的响应体。 */
interface ApiKeyRevokeResponse {
  readonly keyId: string;
  readonly revoked: true;
}

/** `GET /admin/groups` 的响应体。 */
interface GroupListResponse {
  readonly groups: readonly SerializedGroup[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}

/** `POST /admin/groups`、`PATCH /admin/groups/{id}`、`POST /admin/groups/{id}/owner` 的响应体。 */
interface GroupResponse {
  readonly group: Group;
}

/** `GET /admin/groups/{id}/members` 的响应体。 */
interface GroupMembersResponse {
  readonly groupId: string;
  readonly members: readonly GroupMember[];
  readonly total: number;
}

/** `POST /admin/groups/{id}/members` 的响应体。 */
interface GroupMemberResponse {
  readonly member: GroupMember;
}

/** `DELETE /admin/groups/{id}/members/{userId}` 的响应体。 */
interface GroupMemberRemoveResponse {
  readonly groupId: string;
  readonly userId: string;
  readonly removed: true;
}

export function createAdminRoutes(services: AdminRouteServices): HttpRouteGroup {
  return {
    prefix: '/admin',
    register(app: FastifyInstance): void {
      createAdminUserRoutes(services).register(app);
      createAdminApiKeyRoutes(services).register(app);
      createAdminGroupRoutes(services).register(app);
      createAdminMemberRoutes(services).register(app);
    },
  };
}

export type {
  ApiKeyCreateResponse,
  ApiKeyListResponse,
  ApiKeyRevokeResponse,
  AdminDeleteResponse,
  GroupListResponse,
  GroupMemberRemoveResponse,
  GroupMemberResponse,
  GroupMembersResponse,
  GroupResponse,
  SerializedGroup,
  SerializedUser,
  UserListResponse,
  UserPasswordResponse,
  UserResponse,
};
