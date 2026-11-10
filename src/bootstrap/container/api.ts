/**
 * 装配阶段 7：接口层（MCP 注册表 → 身份解析 → MCP 服务端 → 服务门面 → HTTP 路由）。
 *
 * 两处装配位置要紧：`services` 是 `Container.services` 的唯一来源（同一个
 * `taskRepository` 同时进 `services.taskStore`、`routes.taskStore` 与 `adminAccess`，
 * 只构造一次）；`resolveIdentity` 是 HTTP 与 MCP 共用的身份解析（`auth.enabled:
 * false` 时走 `resolveIdentityOf`，打开后走 Bearer 凭据）。
 *
 * `api/` 不能 import `adapters/`（§4.2），所以 `AdminAccess` 的 SQL 留在这里。两个
 * 计数函数都是同步的：`node:sqlite` 是同步 API，事务边界也必须是同步回调。
 */

import type { DatabaseSync } from 'node:sqlite';

import type { IdentityResolver } from '../../api/http/middleware.js';
import type { Identity, IdentityHeaders } from '../../api/http/middleware.js';
import { createHttpRouteGroups } from '../../api/http/routes/index.js';
import type { HttpRouteGroup } from '../../api/http/server.js';
import type { ToolRegistry } from '../../api/mcp/registry.js';
import { McpHttpServer } from '../../api/mcp/server.js';
import { createToolRegistry } from '../../api/mcp/tools/index.js';
import { USER_WILDCARD, parsePrincipal } from '../../domain/acl.js';
import { ComemError } from '../../domain/errors.js';
import { bearerCredential } from '../../services/auth.js';
import type { ContainerServices } from './types.js';
import type { Access } from './access.js';
import type { Background } from './background.js';
import type { Foundation } from './foundation.js';
import type { MemoryStack } from './memory.js';
import type { Retrieval } from './retrieval.js';
import { errorMessage } from './support.js';

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
  const { config, logger, db, index, taskRepository, prompts, userRepository, groupRepository } =
    core;
  const { memoryLink } = core;
  const { acl, subject, groups, identity: identityService, auth: authService } = access;
  const { summary, filesystem, task, session, assembler, ledger, search, indexObserver } =
    retrieval;
  const { authorizer } = retrieval;
  const { memory, consolidation, resource, reconcile, skill } = memoryStack;
  const { observability } = background;

  const mcpRegistry = createToolRegistry();
  const resolveIdentity: IdentityResolver = async (headers: IdentityHeaders) => {
    if (!config.auth.enabled) {
      return resolveIdentityOf(headers, subject, identityService);
    }
    const credential = bearerCredential(headers['authorization']);
    if (credential === null) {
      throw new ComemError('UNAUTHENTICATED', '缺少 Authorization: Bearer 凭据。');
    }
    const context = await authService.resolveBearer(credential);
    return { subject: context.subject, principals: context.principals };
  };

  const mcp = new McpHttpServer({
    registry: mcpRegistry,
    config,
    logger,
    resolveIdentity: async ({ headers }) => resolveIdentity(headers),
    context: {
      filesystem,
      search,
      summary,
      acl,
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
    filesystem,
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
    config,
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
    // 管理面与任务队列的「跨主体操作」只认这份显式名单（默认空 = 没有管理员）。
    adminUserIds: config.auth.adminUserIds,
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
      // 被吊销凭据的主人。SQL 留在这里（`api/` 不 import `adapters/`）。
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
 * 解析请求身份。
 *
 * v1 不做认证：身份由反向代理注入 `x-comem-subject`。**没有这个头时用服务图绑定的
 * 主体**（`server.subject`）——单用户桌面部署没有代理，要求它配一个头只会让
 * `curl /health` 之外的手工调用全部 401。
 *
 * 与绑定身份不一致时抛 `UNAUTHENTICATED`：服务图只有一份（见 `access.ts` 的文件头），
 * 静默换成绑定的身份就是冒充。多租户部署要换成真正的认证 + 每请求服务图。
 */
async function resolveIdentityOf(
  headers: IdentityHeaders,
  boundSubject: string,
  identityService: Access['identity'],
): Promise<Identity> {
  const raw = headers['x-comem-subject'];
  const subject = typeof raw === 'string' && raw !== '' ? raw : boundSubject;

  let principal;
  try {
    principal = parsePrincipal(subject);
  } catch (error) {
    throw new ComemError('UNAUTHENTICATED', `身份不合法：${errorMessage(error)}`, { subject });
  }
  if (principal.kind !== 'user') {
    throw new ComemError('UNAUTHENTICATED', `身份必须是 user 主体：${subject}`, { subject });
  }
  if (subject !== boundSubject) {
    throw new ComemError(
      'UNAUTHENTICATED',
      `v1 单用户部署只接受配置里的身份 ${boundSubject}，收到 ${subject}。`,
      { subject, boundSubject },
    );
  }

  // 用户目录是身份的真相：不存在的用户、已禁用的用户都不该拿到 principals。
  // 启动时已经预置了绑定主体（`createUser` 忽略 CONFLICT），所以这里对正常部署
  // 不会返回 null；返回 null 只可能是控制台把当前用户删了或禁用了。
  const identity = identityService.resolveSubject(subject);
  if (identity === null) {
    throw new ComemError('UNAUTHENTICATED', `用户不存在或已禁用：${subject}`, { subject });
  }

  return {
    subject,
    principals: [...new Set([...identity.principals, USER_WILDCARD])],
  };
}

/** 每个主体在物化表里的行数。一次 `IN (...)` 查询，不按用户逐条查。 */
function permissionCountsOf(
  db: DatabaseSync,
  principals: readonly string[],
): ReadonlyMap<string, number> {
  if (principals.length === 0) {
    return new Map();
  }
  const list = principals.map(() => '?').join(', ');
  const rows = db
    .prepare(
      `SELECT principal, COUNT(*) AS total FROM node_permission
       WHERE principal IN (${list})
       GROUP BY principal`,
    )
    .all(...principals);
  return new Map(rows.map((row) => [String(row['principal']), Number(row['total'])]));
}

/** 每个组的成员数。一次 `IN (...)` 查询。 */
function memberCountsOf(
  db: DatabaseSync,
  groupIds: readonly string[],
): ReadonlyMap<string, number> {
  if (groupIds.length === 0) {
    return new Map();
  }
  const list = groupIds.map(() => '?').join(', ');
  const rows = db
    .prepare(
      `SELECT group_id, COUNT(*) AS total FROM group_member
       WHERE group_id IN (${list})
       GROUP BY group_id`,
    )
    .all(...groupIds);
  return new Map(rows.map((row) => [String(row['group_id']), Number(row['total'])]));
}
