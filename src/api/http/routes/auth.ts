/** 登录、登出与当前账号安全（架构文档 §12.7）。 */

import type { FastifyInstance } from 'fastify';

import { groupPrincipal, userScopeOf } from '../../../domain/acl.js';
import { ComemError } from '../../../domain/errors.js';
import { Uri } from '../../../domain/uri.js';
import { ok } from '../envelope.js';
import {
  callerUserIdOf,
  isSystemAdmin,
  requestContextOf,
} from '../middleware.js';
import { requireRecord, requireString, type HttpRouteGroup } from '../server.js';

import type { HttpRouteServices } from './index.js';

export type AuthRouteServices = Pick<
  HttpRouteServices,
  'auth' | 'identity' | 'authorizer' | 'systemAdmin' | 'search' | 'filesystem'
>;

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
  readonly spaces: readonly CurrentSpace[];
  readonly sharedFolders: readonly { uri: string; displayName: string }[];
}

interface CurrentSpace {
  readonly scope: string;
  readonly kind: 'personal' | 'group';
  readonly displayName: string;
  readonly access: 'owner' | 'member' | 'granted';
}

interface PasswordChangeResponse {
  readonly passwordChanged: true;
}

export function createAuthRoutes(services: AuthRouteServices): HttpRouteGroup {
  const { auth, identity, authorizer, systemAdmin } = services;

  return {
    prefix: '/auth',
    register(app: FastifyInstance): void {
      app.get('/me', async (request) => {
        const { subject, principals } = requestContextOf(request);
        const spaces = await currentSpaces(identity, authorizer, subject, principals);
        const sharedFolders = await currentSharedFolders(services, subject, principals, spaces);
        return ok<MeResponse>({
          subject,
          principals,
          isAdmin: isSystemAdmin(request, systemAdmin),
          spaces,
          sharedFolders,
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

async function currentSharedFolders(
  { search, filesystem }: AuthRouteServices,
  subject: string,
  principals: readonly string[],
  spaces: readonly CurrentSpace[],
) {
  if (!spaces.some((space) => space.kind === 'personal')) return [];
  const candidates = await search.defaultScopes(subject, principals);
  const roots = spaces.map((space) => Uri.parse(space.scope));
  const folders = await Promise.all(candidates.flatMap((raw) => {
    const uri = Uri.parse(raw);
    if (uri.isRoot || roots.some((root) => root.isAncestorOf(uri))) return [];
    return [filesystem.stat(uri, principals).then((stat) => stat?.kind === 'directory'
      ? { uri: raw, displayName: uri.name }
      : null).catch((error: unknown) => {
        if (error instanceof ComemError && (error.code === 'NOT_FOUND' || error.code === 'PERMISSION_DENIED')) return null;
        throw error;
      })];
  }));
  return folders.filter((folder) => folder !== null);
}

/**
 * 当前身份能够打开的空间根。
 *
 * 空间列表以物化权限为准，成员关系与 owner 元数据只解释来源。非成员收到组根上的
 * 显式授权时同样返回该空间；成员关系存在但 ACL 不允许读取根时则不返回。
 */
async function currentSpaces(
  identity: AuthRouteServices['identity'],
  authorizer: AuthRouteServices['authorizer'],
  subject: string,
  principals: readonly string[],
): Promise<readonly CurrentSpace[]> {
  const personal = userScopeOf(subject, '认证身份');
  const groups = identity.listAllGroups();
  const groupRoots = groups.map((group) => Uri.parse(`comem://group/${group.id}`));
  const readable = await authorizer.filterReadable([personal, ...groupRoots], principals);
  const spaces: CurrentSpace[] = [];

  if (readable.has(personal.toString())) {
    const user = identity.getUser(personal.rootId);
    spaces.push({
      scope: personal.toString(),
      kind: 'personal',
      displayName: user?.displayName ?? personal.rootId,
      access: 'owner',
    });
  }

  for (const group of groups) {
    const scope = Uri.parse(`comem://group/${group.id}`);
    const value = scope.toString();
    if (!readable.has(value)) continue;

    const principal = groupPrincipal(group.id);
    const access: CurrentSpace['access'] =
      group.ownerUserId === personal.rootId
        ? 'owner'
        : principals.includes(principal) && await authorizer.check(scope, 1, [principal])
          ? 'member'
          : 'granted';
    spaces.push({
      scope: value,
      kind: 'group',
      displayName: group.displayName,
      access,
    });
  }

  return spaces;
}
