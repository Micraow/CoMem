/**
 * 容器对外的类型面。
 *
 * 这几个接口就是 `container.ts` 的公开契约（`main`、`commands/`、`tests/` 直接消费），
 * 搬到独立文件只为让装配阶段共用同一份声明；字段、注释与顺序都与拆分前一致。
 */

import type { DatabaseSync } from 'node:sqlite';

import type { ContentStore } from '../../adapters/fs/content-store.js';
import type { EmbeddingRepository } from '../../adapters/sqlite/embedding-repository.js';
import type { TaskRepository } from '../../adapters/sqlite/task-repository.js';
import type { IdentityResolver } from '../../api/http/middleware.js';
import type { HttpRouteGroup } from '../../api/http/server.js';
import type { ToolRegistry } from '../../api/mcp/registry.js';
import type { McpHttpServer } from '../../api/mcp/server.js';
import type { ComemConfig } from '../../config/index.js';
import type { Logger } from '../../domain/log.js';
import type { RetrievalIndex } from '../../domain/retrieval.js';
import type { AclService } from '../../services/acl.js';
import type { AuthService } from '../../services/auth.js';
import type { ContextAssembler } from '../../services/context-assembler.js';
import type { EmbeddingService } from '../../services/embedding.js';
import type { FileSystemService } from '../../services/filesystem.js';
import type { IdentityService } from '../../services/identity.js';
import type { IndexObserver } from '../../services/index-observer.js';
import type { MemoryService } from '../../services/memory.js';
import type { MemoryLinkService } from '../../services/memory-link.js';
import type { ObservabilityService } from '../../services/observability.js';
import type { PromptService } from '../../services/prompt-service.js';
import type { RecallLedger } from '../../services/recall-ledger.js';
import type { ReconcileService } from '../../services/reconcile.js';
import type { ResourceService } from '../../services/resource.js';
import type { SearchService } from '../../services/search.js';
import type { SessionService } from '../../services/session.js';
import type { SkillService } from '../../services/skill.js';
import type { SummaryService } from '../../services/summary.js';
import type { TaskService } from '../../services/task.js';
import type { CommitRunner } from '../commit-runner.js';
import type { Scheduler } from '../scheduler.js';

/** `Container` 的构造参数。`subject` / `groups` / `argv` 是任务草图之外的必要项。 */
export interface CreateContainerOptions {
  /** 配置文件路径；缺省 `config.yaml` */
  readonly configPath?: string;
  readonly env?: NodeJS.ProcessEnv;
  /** 命令行参数，识别 `--config` 与 `--data-dir`（§18） */
  readonly argv?: readonly string[];
  /** 覆盖配置里的 `server.subject`；缺省取 `config.server.subject`（默认 `user:local`） */
  readonly subject?: string;
  /** 身份所属的组（`group:eng` 形式）；默认空 */
  readonly groups?: readonly string[];
}

export interface Container {
  readonly config: ComemConfig;
  readonly logger: Logger;
  readonly db: DatabaseSync;
  readonly observability: ObservabilityService;
  /**
   * 阶段二执行器（§10.1、§10.4）。
   *
   * `main` 在 `task.recover()` 之后启动它，`close()` 停它。没有它，阶段二的任务
   * 永远停在 `pending`——`POST /sessions/{id}/commit` 只做阶段一。
   */
  readonly commitRunner: CommitRunner;
  /**
   * 后台调度器（§10.2.1 的自动提交、§11.7 的会话过期与记忆 TTL、`_meta/tmp/`
   * 的临时上传清理）。
   *
   * 三个配置全关时**不启动定时器**（`background.ts` 里判断）——空转的 30 秒定时器
   * 是纯浪费。`close()` 里先停它再关数据库：它会写 `.meta.json`、建任务、删临时上传。
   */
  readonly scheduler: Scheduler;
  readonly services: ContainerServices;
  readonly mcpRegistry: ToolRegistry;
  /** MCP Streamable HTTP 服务端；`main` 挂到 HTTP 上。 */
  readonly mcp: McpHttpServer;
  /** 已装配好的 HTTP 路由分组。 */
  readonly routes: readonly HttpRouteGroup[];
  /** 请求身份解析（凭据 + 回环信任，§12.7）。 */
  readonly resolveIdentity: IdentityResolver;
  /**
   * 存量向量回填的依赖（`main.ts` 的 `startVectorBackfill` 消费）。
   *
   * 放三样东西而不是让 `main` 自己 `new`：适配器只允许在这里构造（§4.4）。
   * 候选集、分批与失败处理都不属于装配，留在 `main` / `commands/reindex.ts`。
   */
  readonly vectorBackfill: {
    readonly store: ContentStore;
    readonly embeddings: EmbeddingRepository;
    readonly embedding: EmbeddingService;
  };
  /** 关闭数据库连接。幂等。 */
  close(): Promise<void>;
}

export interface ContainerServices {
  readonly filesystem: FileSystemService;
  readonly acl: AclService;
  readonly summary: SummaryService;
  readonly session: SessionService;
  readonly task: TaskService;
  readonly memory: MemoryService;
  readonly resource: ResourceService;
  readonly skill: SkillService;
  /**
   * 对账日志重放（§10.6「索引双写补偿」）。
   *
   * `main` 在 HTTP 监听之前跑一次，调度器每个轮次也跑一次；测试可以直接调
   * `container.services.reconcile.replay()`。
   */
  readonly reconcile: ReconcileService;
  readonly search: SearchService;
  readonly assembler: ContextAssembler;
  readonly ledger: RecallLedger;
  /** 检索索引。测试与对账脚本要直接查它，不经过 `SearchService` 的排序与过滤。 */
  readonly index: RetrievalIndex;
  /** 记忆关联边（§11.10）。存 + 查；不参与 `find`。 */
  readonly memoryLink: MemoryLinkService;
  /** 写路径的派生数据维护；`drain()` 给测试一个确定的完成点。 */
  readonly indexObserver: IndexObserver;
  /** 任务行的只读查询端口（`TaskRepository`）。路由用它查任务。 */
  readonly taskStore: TaskRepository;
  /**
   * 提示词（§9.2、§11.3、§11.4）。
   *
   * 它同时是 `prompts/registry.ts` 的**进程级渲染器**：容器构造时把默认实现
   * （只读 `prompts/*.md`）换成「覆盖优先」的实现，四条提示词的调用点才能看到
   * 控制台里的修改。推导写在 `services/prompts/registry.ts`。
   */
  readonly prompts: PromptService;
  /** 用户与组用例（`/admin/*`、登录）。 */
  readonly identity: IdentityService;
  /** 登录与入站凭据解析（§12.7）。 */
  readonly auth: AuthService;
}
