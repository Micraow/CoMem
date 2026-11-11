/**
 * 引导端点（架构文档 §12.7 的「引导循环」）。
 *
 * 空数据根 + 默认配置下，没有任何纯浏览器路径能创建第一个可登录账号：
 * `POST /admin/users` 需要 `auth.adminUserIds`（默认空 → 403），而它只能改配置 +
 * 重启。这一组端点补上第一步。
 *
 * ## 两个端点都不认证
 *
 * `GET /bootstrap` 只回布尔与绑定身份，**不泄露用户列表**。`POST /bootstrap/admin`
 * 也没有身份可用（还没有可登录的账号），所以授权不能靠凭据，只有两条：
 *
 * 1. **回环地址**（`127.0.0.1` / `::1`）：本地开发不用抄令牌；
 * 2. **一次性初始化令牌**：Docker 部署里请求经 nginx 转发，来源是容器网段地址，
 *    回环判据永远不成立。令牌在 `needsSetup === true` 时打印到启动日志，只在内存
 *    里存在（重启换新；初始化本来就要重启）。
 *
 * 令牌不落盘、不返回给调用方。非回环且没带令牌 → `NOT_LOOPBACK`；带了但不对 →
 * `INVALID_SETUP_TOKEN`（恒定时间比较，见 `bootstrap-admin.ts`）。
 *
 * ## 只在 `needsSetup` 期间可用
 *
 * `needsSetup` 的判据只有一个：`app_user` 里没有任何一行有密码哈希。认证恒开，所以
 * 它同时就是「这份安装还没有可登录账号」。第一次成功之后端点永久关闭
 * （`BOOTSTRAP_CLOSED`），令牌也救不了——标记的写入只有一个入口
 * （`installFirstAdmin`），不存在「谁先调用谁当管理员」之外的第二个写入点。
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';

import { ComemError } from '../../../domain/errors.js';
import { assertValidUserId } from '../../../domain/identity.js';
import { isLoopbackAddress } from '../../../domain/network.js';
import { assertPasswordPolicy } from '../../../services/password.js';
import { ok } from '../envelope.js';
import {
  optionalString,
  requireRecord,
  requireString,
  type HttpRouteGroup,
} from '../server.js';

import { optionalNonEmptyString } from './admin-request.js';

import type { HttpRouteServices } from './index.js';

/**
 * 引导用例的数据端口。
 *
 * 实现由装配层注入（`bootstrap/container/bootstrap-admin.ts`）：`api/` 不能
 * import `adapters/`（架构文档 §4.2），而这里要读 `app_user` 的两列、并原子地
 * 写密码哈希 + 标记。
 */
export interface BootstrapAccess {
  /** 有任意一行设过密码。`needsSetup` 就是它的取反。 */
  hasPassword(): boolean;
  /** 引导管理员的用户 ID；还没有写过标记时返回 `null`。 */
  bootstrapAdminId(): string | null;
  /** 原子安装第一个管理员；已有别的行设过密码时返回 `false`。 */
  installFirstAdmin(userId: string, password: string): Promise<boolean>;
  /** 恒定时间比较一次性初始化令牌。 */
  verifySetupToken(token: string | undefined): boolean;
}

export type BootstrapRouteServices = Pick<
  HttpRouteServices,
  'identity' | 'subject' | 'systemAdmin' | 'bootstrap'
>;

/** `GET /bootstrap` 的响应体。只有布尔与部署身份，没有任何用户数据。 */
interface BootstrapStatusResponse {
  /** 还没有任何密码：控制台整页进 `/setup`。 */
  readonly needsSetup: boolean;
  /**
   * 回环信任使用的身份（`server.subject`）。
   *
   * `/setup` 用它做默认用户名：本机的 `curl` 与 hook 插件以这个主体发请求，控制台
   * 建的第一个管理员取同一个 ID 就不会出现「两个都是我的账号」的分裂。
   */
  readonly boundSubject: string;
  /** `auth.adminUserIds` 非空，或引导管理员已存在。 */
  readonly adminConfigured: boolean;
}

/** `POST /bootstrap/admin` 的响应体。 */
interface BootstrapAdminResponse {
  readonly userId: string;
  /** 本次是否创建了账号（false = 账号已存在，只设了密码）。 */
  readonly created: boolean;
  readonly passwordSet: true;
}

function bootstrapClosed(): ComemError {
  return new ComemError(
    'BOOTSTRAP_CLOSED',
    '初始化已经完成：引导管理员已创建，端点永久关闭。要管理账号请登录后走 /admin。',
  );
}

function isLoopbackRequest(request: FastifyRequest): boolean {
  const address: string | undefined = request.socket.remoteAddress;
  return address !== undefined && isLoopbackAddress(address);
}

export function createBootstrapRoutes(services: BootstrapRouteServices): HttpRouteGroup {
  const { identity, subject, systemAdmin, bootstrap } = services;
  // 认证恒开，所以「没有任何密码」就是「还没有可登录账号」——控制台整页进
  // `/setup`。这是控制台唯一的一条首跑路径。
  const needsSetup = (): boolean => !bootstrap.hasPassword();

  return {
    prefix: '/bootstrap',
    register(app: FastifyInstance): void {
      // 只读探测：恒定 200，初始化状态是正常状态，不是错误。
      app.get('/', async () =>
        ok<BootstrapStatusResponse>({
          needsSetup: needsSetup(),
          boundSubject: subject,
          adminConfigured:
            systemAdmin.adminUserIds.length > 0 || bootstrap.bootstrapAdminId() !== null,
        }),
      );

      app.post<{ Body: unknown }>('/admin', async (request) => {
        if (!needsSetup()) {
          throw bootstrapClosed();
        }
        const body = requireRecord(request.body, 'bootstrap/admin');
        // 回环请求免令牌（本地开发）；其余来源必须带启动日志里那串一次性令牌。
        if (!isLoopbackRequest(request)) {
          const setupToken = optionalString(body, 'setupToken');
          if (setupToken === undefined || setupToken === '') {
            throw new ComemError(
              'NOT_LOOPBACK',
              '初始化只能在服务器本机完成：请从回环地址发起请求，或提供启动日志里的一次性初始化令牌。',
            );
          }
          if (!bootstrap.verifySetupToken(setupToken)) {
            throw new ComemError('INVALID_SETUP_TOKEN', '一次性初始化令牌不正确或已失效。');
          }
        }

        const userId = assertValidUserId(requireString(body, 'userId'));
        const password = requireString(body, 'password');
        assertPasswordPolicy(password);
        const displayName = optionalNonEmptyString(body, 'displayName') ?? userId;

        const created = identity.getUser(userId) === null;
        if (created) {
          identity.createUser({ id: userId, displayName });
          // 新账号的根与四个上下文目录要立刻预置，否则第一次登录看到的是 403
          // 而不是空列表（`ensureUserNamespace` 的注释）。
          await identity.ensureUserNamespace(userId);
        }
        // 复查 + 写密码 + 写标记在同一个同步事务里：并发请求里只有一个能成功，
        // 也不存在「设了密码但没写标记」的崩溃窗口。
        if (!(await bootstrap.installFirstAdmin(userId, password))) {
          throw bootstrapClosed();
        }

        return ok<BootstrapAdminResponse>({ userId, created, passwordSet: true });
      });
    },
  };
}
