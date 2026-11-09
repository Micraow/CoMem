/**
 * MCP 工具上下文（架构文档 §13）。
 *
 * 16 个工具共享同一组依赖。这里只声明形状，实例由 `bootstrap/` 按请求构造：
 * 身份、已展开的权限主体与 `requestId` 都在请求边界注入，工具层不做认证。
 *
 * ## 为什么 `acl` 是 `Authorizer` 而不是 `AclService`
 *
 * 工具只调用 `check` / `assert` / `filterReadable` 三个方法，它们是
 * `services/authorizer.ts` 定义的端口（§12.4 的出口清单按这个端口数）。真实装配
 * 传入的 `AclService` 实现了这个端口；测试用 `DenyAllAuthorizer` 验证「每个出口
 * 都被挡」也不需要构造 ACL 的存储依赖。依赖方向仍然正确：`api/` 依赖
 * `services/`，不反向依赖。
 */

import type { ComemConfig } from '../../config/index.js';
import type { Logger } from '../../domain/log.js';
import type { RetrievalIndex } from '../../domain/retrieval.js';
import type { Authorizer } from '../../services/authorizer.js';
import type { FileSystemService } from '../../services/filesystem.js';
import type { MemoryService } from '../../services/memory.js';
import type { ResourceService } from '../../services/resource.js';
import type { SearchService } from '../../services/search.js';
import type { SessionService } from '../../services/session.js';
import type { SkillService } from '../../services/skill.js';
import type { SummaryService } from '../../services/summary.js';
import type { TaskService } from '../../services/task.js';

import type { ToolDeadline } from './deadline.js';

export interface McpToolContext {
  readonly filesystem: FileSystemService;
  readonly search: SearchService;
  readonly summary: SummaryService;
  readonly acl: Authorizer;
  readonly session: SessionService;
  readonly memory: MemoryService;
  readonly resource: ResourceService;
  readonly skill: SkillService;
  readonly tasks: TaskService;
  readonly index: RetrievalIndex;
  readonly logger: Logger;
  readonly config: ComemConfig;
  /** 本次请求的身份。由 server 从认证头解析后注入 */
  readonly subject: string;
  /** 已展开的权限主体，含 `user:*` 与全部组 */
  readonly principals: readonly string[];
  /** 请求 ID，贯穿日志（§17.7） */
  readonly requestId: string;
  /**
   * 本次工具调用的截止时间（§13、`deadline.ts`）。
   *
   * 由 `ToolRegistry` 在 `execute` 前注入，所以工具实现里可能拿不到它（单元测试
   * 直接调用裸定义时）。**省略表示不做工具级上限**，不是「用默认值」——默认值只在
   * 注册表这一处，避免两个地方各有一份 30 秒。
   *
   * 工具把它传给服务层的 `deadlineAt` / `onUpstream`，检索因此能在总上限之前先
   * 把「向量不可用」降级成 FTS 结果。
   */
  readonly deadline?: ToolDeadline;
}
