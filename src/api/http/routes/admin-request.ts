/**
 * 管理面的请求解析、参数校验与共享依赖契约。
 *
 * 这里只做请求解析与参数校验，不碰响应形状——响应 DTO 在 `admin.ts` 顶部。
 * 函数体与拆分前逐字相同，只改了 import 与导出。
 *
 * 四个资源文件（用户目录 / API Key / 组目录 / 组成员）共用这里的常量与门禁：
 * 「对目标资源的根求 `manage`」是这一组端点唯一的授权口径，复制四份必然漂移。
 */

import type { FastifyRequest } from 'fastify';

import { ComemError } from '../../../domain/errors.js';
import type { Group, User } from '../../../domain/identity.js';
import { Uri } from '../../../domain/uri.js';
import type { Authorizer } from '../../../services/authorizer.js';
import { isSystemAdmin, requestContextOf, type SystemAdminPolicy } from '../middleware.js';
import { optionalString } from '../server.js';

import type { HttpRouteServices } from './index.js';

/** §12.1：manage = 7。 */
export const MANAGE = 7;

/** 列表默认条数，与两个仓储的默认值一致。 */
export const DEFAULT_LIST_LIMIT = 100;

/** 单页上限。控制台一页 500 个用户已经要滚动，再多不会有人读完。 */
export const MAX_LIST_LIMIT = 500;

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
   * 系统管理员判定（`config.auth.adminUserIds` + 引导管理员）。
   *
   * 必填而不是从 `config` 里现取：路由的授权口径应当在一处装配，测试也能直接
   * 给一个明确的策略（空名单 + 无引导管理员表示没有管理员），不需要构造整份配置。
   */
  readonly systemAdmin: SystemAdminPolicy;
};

function invalidArgument(field: string, expected: string, value: unknown): ComemError {
  return new ComemError('INVALID_ARGUMENT', `参数 ${field} 必须是${expected}。`, {
    field,
    value,
  });
}

/** 允许 `null` 的可选字符串：`null` 表示清空，`undefined` 表示不修改。 */
export function optionalNullableString(
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
export function optionalNonEmptyString(
  body: Record<string, unknown>,
  field: string,
): string | undefined {
  const value = optionalString(body, field);
  if (value === '') {
    throw invalidArgument(field, '非空字符串', value);
  }
  return value;
}

export function parseStatus(value: unknown): User['status'] {
  const status = USER_STATUSES.find((candidate) => candidate === value);
  if (status === undefined) {
    throw invalidArgument('status', USER_STATUSES.join(' / '), value);
  }
  return status;
}

/** `comem://user/{uid}` —— 用户的管理面判定对象。 */
export function userRootOf(userId: string): Uri {
  return Uri.parse(`comem://user/${userId}`);
}

/** `comem://group/{gid}` —— 组的管理面判定对象。 */
export function groupRootOf(groupId: string): Uri {
  return Uri.parse(`comem://group/${groupId}`);
}

/**
 * 目标资源的门禁：系统管理员，或对该资源所在的根有 `manage`。
 *
 * `target` 必须是**被操作的对象**（用户的根、组的根），不能是调用方自己的根——
 * owner 恒 manage，用自身根判定等于放行任何登录用户。
 */
export async function assertManageOf(
  request: FastifyRequest,
  authorizer: Authorizer,
  systemAdmin: SystemAdminPolicy,
  target: Uri,
): Promise<void> {
  if (isSystemAdmin(request, systemAdmin)) {
    return;
  }
  await authorizer.assert(target, MANAGE, requestContextOf(request).principals);
}

/** 取组；不存在抛 `NOT_FOUND`。先于求权：不能对不存在的组根做判定（也没法物化）。 */
export function requireGroup(identity: AdminIdentity, groupId: string): Group {
  const group = identity.getGroup(groupId);
  if (group === null) {
    throw new ComemError('NOT_FOUND', `组不存在：${groupId}`, { groupId });
  }
  return group;
}
