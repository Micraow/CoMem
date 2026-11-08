/**
 * HTTP 路由装配点（架构文档 §14 的端点清单）。
 *
 * 每个路由文件导出一个 `HttpRouteGroup` 工厂，依赖通过 `HttpRouteServices` 注入。
 * 这里只做两件事：声明路由需要的服务形状、按 §14 的表格顺序拼出数组。
 *
 * 为什么是工厂而不是模块级单例：`AclService` 的身份在构造期绑定（`Authorizer` 的
 * 三个方法没有 subject 参数，§12.4），路由必须拿到装配好的那一份实例；模块级
 * 单例会把「谁把服务塞进来」变成隐式的全局状态。
 */

import type { ComemConfig } from '../../../config/index.js';
import type { RetrievalIndex } from '../../../domain/retrieval.js';
import type { AclService } from '../../../services/acl.js';
import type { Authorizer } from '../../../services/authorizer.js';
import type { ConsolidationService } from '../../../services/consolidation.js';
import type { FileSystemService } from '../../../services/filesystem.js';
import type { IdentityService } from '../../../services/identity.js';
import type { MemoryService } from '../../../services/memory.js';
import type { ObservabilityService } from '../../../services/observability.js';
import type { ResourceService } from '../../../services/resource.js';
import type { SearchService } from '../../../services/search.js';
import type { SessionService } from '../../../services/session.js';
import type { SkillService } from '../../../services/skill.js';
import type { SummaryService } from '../../../services/summary.js';
import type { TaskService } from '../../../services/task.js';
import type { HttpRouteGroup } from '../server.js';

import { createAclRoutes } from './acl.js';
import { createAdminRoutes, type AdminAccess } from './admin.js';
import { createContentRoutes } from './content.js';
import { createFsRoutes } from './fs.js';
import { createMemoryRoutes } from './memories.js';
import { createOpsRoutes } from './ops.js';
import { createResourceRoutes } from './resources.js';
import { createSearchRoutes } from './search.js';
import { createSessionRoutes } from './sessions.js';
import { createSkillRoutes } from './skills.js';
import type { TaskQueryStore } from './tasks.js';
import { createTaskRoutes } from './tasks.js';
import { createTelemetryRoutes } from './telemetry.js';

/** 路由层需要的全部依赖。`acl` 同时是 `Authorizer`（管理面方法也在它上面）。 */
export interface HttpRouteServices {
  readonly config: ComemConfig;
  readonly observability: ObservabilityService;
  readonly filesystem: FileSystemService;
  /** 管理面（`getAcl` / `setAcl` / grant / revoke）。 */
  readonly acl: AclService;
  /**
   * 写路径的授权端口（与 `FileSystemService` 同一实例）。
   *
   * 它比 `AclService.check` 多一条规则：物化表里没有该节点时先物化再求权。新建
   * 节点的权限行由观察者在落盘后写，而求权发生在落盘**之前**——直接用 `acl` 会
   * 让所有「创建」类请求 403（`InheritingAuthorizer` 的注释里有完整推导）。
   */
  readonly authorizer: Authorizer;
  readonly summary: SummaryService;
  /**
   * 检索索引的只读端口。
   *
   * 文件的 L0 摘要存在索引的 `abstract` 字段里（§6.7「文件级摘要不另存档」），
   * 没有它，控制台的文件详情页只能显示「还没有摘要」——而摘要其实早就有了。
   */
  readonly index: RetrievalIndex;
  readonly session: SessionService;
  readonly tasks: TaskService;
  /** 任务行的只读查询端口；由 bootstrap 注入 `TaskRepository`。 */
  readonly taskStore: TaskQueryStore;
  readonly memory: MemoryService;
  /** 记忆合并（§11.8）。破坏性操作，只在 `POST /memories/consolidate` 上暴露。 */
  readonly consolidation: ConsolidationService;
  readonly resource: ResourceService;
  readonly skill: SkillService;
  readonly search: SearchService;
  /** 用户与组用例（`/admin/*`）。 */
  readonly identity: IdentityService;
  /** 管理面的统计与 ACL 清理端口；SQL 细节由 bootstrap 提供。 */
  readonly adminAccess: AdminAccess;
}

/** 按 §14 表格的顺序拼出全部路由分组。 */
export function createHttpRouteGroups(
  services: HttpRouteServices,
): readonly HttpRouteGroup[] {
  return [
    createFsRoutes(services),
    createContentRoutes(services),
    createSearchRoutes(services),
    createSessionRoutes(services),
    createTaskRoutes(services),
    createAclRoutes(services),
    createMemoryRoutes(services),
    createResourceRoutes(services),
    createSkillRoutes(services),
    createAdminRoutes(services),
    createOpsRoutes(services),
    createTelemetryRoutes(services),
  ];
}
