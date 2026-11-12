/**
 * 装配阶段 3：身份、认证与服务图授权。
 *
 * ## 为什么这三样在同一个阶段
 *
 * `IdentityService` 的 `namespace` 端口要在**构造期**注入，而它调用的
 * `ensureUserNamespace` 要 `AclService` 与 `ContentStore`（写目录 + 物化权限行）。
 * 原来的写法靠「函数声明提升 + 同一函数作用域里的 `const acl`」表达这个前向引用；
 * 拆文件后如果把它拆到两个阶段，就得引入跨模块可变状态或调换构造顺序。两样都不做：
 * 保持同一函数作用域，语句顺序逐条不变——`ensureUserNamespace` 只在 `acl` 赋值之后
 * 被调用（`createUser` 与显式 `ensure`），与拆分前完全相同。
 *
 * ## 服务图仍绑定一个身份
 *
 * `Container.services` 只有一份，服务图绑定在 `config.server.subject`
 * （`options.subject` 可覆盖，测试与脚本用）。它有两个用途：回环信任把不带凭据的
 * 本机请求认证成它（§12.7）；后台任务（记忆合并、摘要）以它作为写入主体。
 *
 * **请求身份不经过这里。** 每个 HTTP / MCP 请求的 `principals` 由凭据解析得出
 * （`api.ts` 的 `createIdentityResolver`），`Authorizer` 收的是每请求的身份。
 * 把「换一个身份」静默降级成「用绑定的身份」就是冒充，所以回环信任只在没有凭据
 * 且来源确实是本机时生效。
 */

import { randomBytes } from 'node:crypto';

import { ApiKeyRepository } from '../../adapters/sqlite/api-key-repository.js';
import { groupPrincipal, userScopeOf } from '../../domain/acl.js';
import type { Principal } from '../../domain/acl.js';
import { ComemError } from '../../domain/errors.js';
import { Uri } from '../../domain/uri.js';
import { AclService } from '../../services/acl.js';
import { AuthService } from '../../services/auth.js';
import { IdentityService } from '../../services/identity.js';
import type { UserNamespace } from '../../services/identity.js';
import type { Foundation } from './foundation.js';
import type { CreateContainerOptions } from './types.js';

/** 服务图身份与授权入口。`boundPrincipal` 供后续阶段拼 scope 用。 */
export interface Access {
  readonly subject: string;
  readonly boundPrincipal: Principal;
  readonly groups: readonly string[];
  readonly acl: AclService;
  readonly identity: IdentityService;
  readonly auth: AuthService;
}

export async function createAccess(
  core: Foundation,
  options: CreateContainerOptions,
): Promise<Access> {
  const {
    config,
    logger,
    db,
    store,
    aclFile,
    locks,
    nodes,
    permissions,
    userRepository,
    groupRepository,
  } = core;

  const userNamespace: UserNamespace = {
    ensure: (userId) => ensureUserNamespace(userId),
  };
  const identityService = new IdentityService({
    users: userRepository,
    groups: groupRepository,
    apiKeys: new ApiKeyRepository({ db, logger }),
    namespace: userNamespace,
    logger,
  });
  // `auth.sessionSecret` 为空时生成进程随机值：重启即失效，不需要运维配置；
  // 要跨重启保持登录就显式配置同一个 secret。
  const authService = new AuthService({
    identity: identityService,
    sessionSecret:
      config.auth.sessionSecret === ''
        ? randomBytes(32).toString('base64url')
        : config.auth.sessionSecret,
    sessionTtlSeconds: config.auth.sessionTtlSeconds,
    logger,
  });

  // ── 身份与服务图 ──
  const subject = options.subject ?? config.server.subject;
  const boundPrincipal: Principal = {
    kind: 'user',
    id: userScopeOf(subject, '服务图身份').rootId,
  };

  // 启动时确保配置的主体存在于用户目录（§12.6）。
  //
  // 没有这一行，`resolveBoundSubject` 第一次调 `IdentityService.resolve` 就拿到
  // `null`，所有非公开端点都是 401——一个刚部署、还没通过控制台建过任何用户的
  // 实例，连登录都做不到。已存在时 `createUser` 抛 `CONFLICT`，这是唯一可以忽略
  // 的错误：用户目录里已经有这个主体，启动不需要改它的显示名或状态。
  try {
    identityService.createUser({ id: boundPrincipal.id, displayName: boundPrincipal.id });
  } catch (error) {
    if (!(error instanceof ComemError) || error.code !== 'CONFLICT') {
      throw error;
    }
  }

  // 服务图绑定的组来自配置与用户目录两处：前者是部署时静态声明的组身份，后者
  // 是控制台维护的成员关系。启动后新加的成员关系要重启才进服务图——§12.5 的
  // 「退组立即生效」靠的是 ACL 存组主体，不是每请求重读身份。
  const groups = [
    ...new Set([
      ...(options.groups ?? []),
      ...groupRepository.listGroupIdsOfUser(boundPrincipal.id).map(groupPrincipal),
    ]),
  ];
  const acl = new AclService({
    db,
    aclFile,
    permissions,
    nodes,
    logger,
    // ACL 写入是「读整个 .acl.json → 改 → 写」，锁必须覆盖读写两步（§10.6）。
    locks,
    groupDefaultLevel: config.acl.groupDefaultLevel === 'write' ? 3 : 1,
  });

  /**
   * 预置用户命名空间：`comem://user/{uid}/` 的根行 + 四个上下文目录。
   *
   * 不预置的后果不是「权限收得太紧」而是**全新部署下什么都看不见**：`list` /
   * `tree` / `GET /sessions` 都走 `filterReadable`，它是纯 SQL 查询，物化表里没有
   * 根行就一条都返回不了。写路径上 `InheritingAuthorizer` 会顺手补，但只读路径
   * 不会——一个刚装好、还没写过东西的实例，控制台是空的。
   *
   * `POST /admin/users` 也要调它（通过 `IdentityService.ensureUserNamespace`）：
   * 新建的账号第一次登录时，会话页必须是空列表而不是 403。
   */
  async function ensureUserNamespace(userId: string): Promise<void> {
    const userRoot = Uri.parse(`comem://user/${userId}`);
    await acl.materializeNode(userRoot);
    for (const name of ['memories', 'resources', 'skills', 'sessions']) {
      const directory = userRoot.child(name);
      await store.mkdir(directory, { recursive: true });
      await acl.materializeNode(directory);
    }
  }

  // §12.6 根预置 + §6.5 的四个上下文目录。见 `ensureUserNamespace` 的注释。
  //
  // 幂等：行已存在就是覆盖成同样的值。
  await userNamespace.ensure(boundPrincipal.id);

  return {
    subject,
    boundPrincipal,
    groups,
    acl,
    identity: identityService,
    auth: authService,
  };
}
