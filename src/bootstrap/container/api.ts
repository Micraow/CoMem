/**
 * 装配阶段 7：接口层（MCP 注册表 → 身份解析 → MCP 服务端 → 服务门面 → HTTP 路由）。
 *
 * 两处装配位置要紧：`services` 是 `Container.services` 的唯一来源（同一个
 * `taskRepository` 同时进 `services.taskStore`、`routes.taskStore` 与 `adminAccess`，
 * 只构造一次）；`resolveIdentity` 是 HTTP 与 MCP 共用的身份解析（凭据 + 回环信任，
 * §12.7）。
 *
 * `api/` 不能 import `adapters/`（§4.2），所以 `AdminAccess` 的 SQL 留在装配层。
 * 两个计数函数拆到了 `admin-queries.ts`、引导端口的 SQL 拆到了
 * `bootstrap-admin.ts`——本文件已经到形状门禁的上限。
 */

import type { IdentityResolver, SystemAdminPolicy } from '../../api/http/middleware.js';
import type { Identity, IdentityHeaders, IdentityRequest } from '../../api/http/middleware.js';
import { createHttpRouteGroups } from '../../api/http/routes/index.js';
import type { HttpRouteGroup } from '../../api/http/server.js';
import type { ToolRegistry } from '../../api/mcp/registry.js';
import { McpHttpServer } from '../../api/mcp/server.js';
import { createToolRegistry } from '../../api/mcp/tools/index.js';
import { USER_WILDCARD, parsePrincipal } from '../../domain/acl.js';
import { ComemError } from '../../domain/errors.js';
import { isLoopbackAddress, isLoopbackHostHeader } from '../../domain/network.js';
import { bearerCredential } from '../../services/auth.js';
import { memberCountsOf, permissionCountsOf } from './admin-queries.js';
import { createBootstrapAccess, isBootstrapAdminOf } from './bootstrap-admin.js';
import type { ContainerServices } from './types.js';
import type { Access } from './access.js';
import type { Background } from './background.js';
import type { Foundation } from './foundation.js';
import type { MemoryStack } from './memory.js';
import type { Retrieval } from './retrieval.js';
import { errorMessage } from '../../domain/errors.js';

/** 接口层产物。`resolveIdentity` 给 HTTP 与 MCP 共用。 */
export interface Api {
  readonly mcpRegistry: ToolRegistry;
  readonly resolveIdentity: IdentityResolver;
  readonly mcp: McpHttpServer;
  readonly routes: readonly HttpRouteGroup[];
  readonly services: ContainerServices;
}

export function createApi(
  core: Foundation,
  access: Access,
  retrieval: Retrieval,
  memoryStack: MemoryStack,
  background: Background,
): Api {
  const { config, configSnapshot, logger, db, index, taskRepository, prompts, userRepository, groupRepository, localInference } = core;
  const { memoryLink } = core;
  const { acl, subject, groups, identity: identityService, auth: authService } = access;
  const { summary, filesystem, task, session, assembler, ledger, search, indexObserver, llm, embedding } =
    retrieval;
  const { authorizer } = retrieval;
  const { memory, consolidation, resource, reconcile, skill } = memoryStack;
  const { observability } = background;

  const mcpRegistry = createToolRegistry();
  const resolveIdentity = createIdentityResolver(config, subject, identityService, authService);
  const bootstrap = createBootstrapAccess(db, logger);
  // 每次求权查一次引导标记：它在 `POST /bootstrap/admin` 里写入，快照会让新管理员
  // 在重启前一直 403。
  const systemAdmin: SystemAdminPolicy = {
    adminUserIds: config.auth.adminUserIds,
    isBootstrapAdmin: (userId) => isBootstrapAdminOf(db, userId),
  };

  const mcp = new McpHttpServer({
    registry: mcpRegistry,
    config,
    logger,
    resolveIdentity: async ({ headers, remoteAddress }) => resolveIdentity(headers, { remoteAddress }),
    context: {
      filesystem,
      search,
      summary,
      // 与 HTTP 路由共用同一个写路径授权端口：MCP 工具对「物化表里还没有行」
      // 的新节点求权时，同样先物化再判定（`InheritingAuthorizer`）。
      acl: authorizer,
      session,
      memory,
      resource,
      skill,
      tasks: task,
      index,
      logger,
      config,
      // 与 HTTP `/health` 共用同一份降级摘要取数（`ObservabilityService.health()`）。
      observability,
    },
  });

  const services: ContainerServices = {
    filesystem, llm, embedding,
    acl,
    summary,
    session,
    task,
    memory,
    resource,
    skill,
    reconcile,
    search,
    assembler,
    ledger,
    index,
    memoryLink,
    indexObserver,
    taskStore: taskRepository,
    prompts,
    identity: identityService,
    auth: authService,
  };

  const routes = createHttpRouteGroups({
    config, configSnapshot, llm, embedding,
    localInference,
    observability,
    filesystem,
    acl,
    authorizer,
    summary,
    index,
    session,
    tasks: task,
    taskStore: taskRepository,
    memory,
    memoryLink,
    consolidation,
    resource,
    skill,
    search,
    ledger,
    identity: identityService,
    auth: authService,
    // 管理面与任务队列的「跨主体操作」只认显式名单 + 引导管理员标记。
    systemAdmin,
    bootstrap,
    prompts,
    // `/health` 回给控制台的绑定身份（§16 的身份引导）。传装配后的值而不是
    // `config.server.subject`：`options.subject` 覆盖时两者不同，回配置值会让
    // 控制台发一个必然 401 的头。
    subject,
    groups,
    // 控制台的「工具」页读它（`GET /mcp/tools`）。传注册表而不是一份名字快照：
    // 工具说明的真相在 `api/mcp/registry.ts`，硬编码一份就会出现两份文本。
    registry: mcpRegistry,
    adminAccess: {
      permissionCounts: (principals) => permissionCountsOf(db, principals),
      memberCounts: (groupIds) => memberCountsOf(db, groupIds),
      // 撤销 API Key 的端点只有 key ID：持有者由这一行反查，授权判定才能针对
      // 被吊销凭据的主人。SQL 留在装配层（`api/` 不 import `adapters/`）。
      apiKeyOwner: (keyId) => {
        const row = db.prepare('SELECT user_id FROM api_key WHERE id = ?').get(keyId);
        return row === undefined ? null : String(row['user_id']);
      },
      userCount: () => userRepository.count(),
      groupCount: () => groupRepository.count(),
    },
  });

  return { mcpRegistry, resolveIdentity, mcp, routes, services };
}

/**
 * 身份解析器（HTTP 与 MCP 共用，§12.7）：**凭据优先，回环信任兜底**。
 *
 * 带了 `Authorization: Bearer` 就按凭据解析，无效一律 401——一个过期的 token 静默
 * 变成 `server.subject` 比 401 危险得多。没有凭据时，只有 `auth.trustLoopback`
 * 打开、来源是回环地址、且 `Host` 也指向本机，才认证成 `server.subject`。
 *
 * 回环信任不是第二种身份模型：拿到的仍然是一个真实的 `app_user` 行，仍然走同一套
 * ACL（`access.ts` 的文件头说明了服务图只有一份）。
 */
function createIdentityResolver(
  config: Foundation['config'],
  subject: string,
  identityService: Access['identity'],
  authService: Access['auth'],
): IdentityResolver {
  return async (headers, request) => {
    const credential = bearerCredential(headers['authorization']);
    if (credential !== null) {
      const context = await authService.resolveBearer(credential);
      return { subject: context.subject, principals: context.principals };
    }
    if (trustsLoopback(config, headers, request)) {
      return resolveBoundSubject(subject, identityService);
    }
    throw new ComemError(
      'UNAUTHENTICATED',
      '缺少 Authorization: Bearer 凭据。只有本机回环地址的请求可以不带凭据。',
    );
  };
}

/**
 * 这次请求是否命中回环信任。`Host` 也要指向本机：只看来源地址会被 DNS rebinding
 * 绕过（远程页面用自己的域名解析到 `127.0.0.1`，浏览器发出的连接来源就是回环地址）。
 */
function trustsLoopback(
  config: Foundation['config'],
  headers: IdentityHeaders,
  request: IdentityRequest | undefined,
): boolean {
  if (!config.auth.trustLoopback || !isLoopbackHostHeader(headers['host'])) {
    return false;
  }
  const address = request?.remoteAddress;
  return address !== undefined && isLoopbackAddress(address);
}

/**
 * 回环信任请求的身份：服务图绑定的主体（`server.subject`）。
 *
 * 用户目录是身份的真相：不存在的用户、已禁用的用户都不该拿到 principals。启动时
 * 已经预置了绑定主体，所以返回 null 只可能是控制台把当前用户删了或禁用了。
 */
async function resolveBoundSubject(
  boundSubject: string,
  identityService: Access['identity'],
): Promise<Identity> {
  let principal;
  try {
    principal = parsePrincipal(boundSubject);
  } catch (error) {
    throw new ComemError('UNAUTHENTICATED', `身份不合法：${errorMessage(error)}`, { subject: boundSubject });
  }
  if (principal.kind !== 'user') {
    throw new ComemError('UNAUTHENTICATED', `身份必须是 user 主体：${boundSubject}`, { subject: boundSubject });
  }

  const identity = identityService.resolveSubject(boundSubject);
  if (identity === null) {
    throw new ComemError('UNAUTHENTICATED', `用户不存在或已禁用：${boundSubject}`, { subject: boundSubject });
  }

  return {
    subject: boundSubject,
    principals: [...new Set([...identity.principals, USER_WILDCARD])],
  };
}
