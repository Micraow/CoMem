/**
 * 装配与启动（架构文档 §4.4、§18、§6.5）。
 *
 * 整个后端只有这一处 `new` 适配器：`services/` 只允许 `import type` 引用适配层，
 * 运行期实例全部在这里构造并注入。装配顺序不是风格问题——每一步都可能被后一步
 * 依赖，顺序错了拿到的就是 `undefined`。
 *
 * ## 构造顺序
 *
 * ```
 * 配置 → 日志 → 数据库/迁移 → 适配器 → IdentityService → 模型 → AclService
 *      → SummaryService → ContextAssembler → IndexObserver → FileSystemService
 *      → SearchService → TaskService → SessionService → MemoryService
 *      → ResourceService → SkillService → CommitRunner → ObservabilityService
 *      → MCP → HTTP 路由
 * ```
 *
 * 三处顺序容易踩：
 *
 * 1. **`TaskService` 必须在 `SessionService` 之前**：阶段一提交要建任务。
 * 2. **`IndexObserver` 必须在 `FileSystemService` 之前**：后者要 observers 数组。
 *    `SearchService` 又在 `FileSystemService` 之后——它的 `grep` 要读文件。
 * 3. **`AclService` 最先**：`FileSystemService` / `SearchService` / `ContextAssembler`
 *    的构造参数都是 `Authorizer`。
 *
 * `CommitRunner` 在 `MemoryService` 之后：四个步骤要用 `MemoryService`（预取、读写、
 * 删除）与 `SummaryService`（归档摘要、失效传播），构造位置比它们早只会拿到
 * `undefined`。
 *
 * ## 没有循环依赖
 *
 * `IndexObserver` 不需要 `FileSystemService`（它直接用 `ContentStore`），所以
 * 「文件系统要观察者、观察者要摘要/ACL/索引」不构成环。`MemoryService` 的端口是
 * 「原样文档」，不能接 `FileSystemService`（后者会重新序列化 frontmatter），所以它
 * 直接用 `ContentStore` 的字节读写，并在写后手动通知观察者。
 *
 * ## 身份是单租户的
 *
 * `AclService` 在构造期绑定身份（`Authorizer` 的三个方法没有 subject 参数，§12.4），
 * 而 `Container.services` 只有一份。v1 是单用户部署：服务图绑定在
 * `config.server.subject`（`options.subject` 可覆盖，测试与脚本用）。HTTP 的
 * `x-comem-subject` 与它不一致时
 * 直接 401——让「换一个身份」静默降级成「用绑定的身份」就是冒充。多租户要的是
 * 每请求一份服务图，那是另一套装配，不在本 wave。
 *
 * 启动时把绑定主体写进用户目录（`app_user`），否则 `IdentityService.resolve`
 * 返回 `null`，所有非公开端点都是 401。已存在时忽略 `CONFLICT`：启动不应该
 * 覆盖管理员改过的显示名或状态。
 */

import { randomBytes } from 'node:crypto';
import { constants as fsConstants, mkdirSync } from 'node:fs';
import {
  access,
  appendFile,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { AclFileStore } from '../adapters/fs/acl-file.js';
import { ContentStore } from '../adapters/fs/content-store.js';
import { createPathLockManager } from '../adapters/fs/lock.js';
import { MetadataFileStore } from '../adapters/fs/metadata-file.js';
import { ConsoleLogger } from '../adapters/log/console.js';
import { FileLogger } from '../adapters/log/file.js';
import { AiSdkLlmProvider } from '../adapters/llm/ai-sdk-provider.js';
import { DisabledLlmProvider } from '../adapters/llm/disabled-provider.js';
import { AiSdkEmbeddingProvider } from '../adapters/llm/embedding-provider.js';
import { HttpRerankProvider } from '../adapters/llm/rerank-provider.js';
import { openDatabase, runMigrations } from '../adapters/sqlite/database.js';
import { EmbeddingCacheRepository } from '../adapters/sqlite/embedding-cache.js';
import { EmbeddingRepository } from '../adapters/sqlite/embedding-repository.js';
import { ApiKeyRepository } from '../adapters/sqlite/api-key-repository.js';
import { GroupRepository } from '../adapters/sqlite/group-repository.js';
import { NodeRepository } from '../adapters/sqlite/node-repository.js';
import { PermissionRepository } from '../adapters/sqlite/permission-repository.js';
import { PromptRepository } from '../adapters/sqlite/prompt-repository.js';
import { UserRepository } from '../adapters/sqlite/user-repository.js';
import { RequestLogRepository } from '../adapters/sqlite/request-log-repository.js';
import { SqliteFtsIndex } from '../adapters/sqlite/retrieval-index.js';
import { TaskRepository } from '../adapters/sqlite/task-repository.js';
import { SqliteVectorIndex } from '../adapters/sqlite/vector-index.js';
import { createToolRegistry } from '../api/mcp/tools/index.js';
import type { ToolRegistry } from '../api/mcp/registry.js';
import { McpHttpServer } from '../api/mcp/server.js';
import type { HttpRouteGroup } from '../api/http/server.js';
import { createHttpRouteGroups } from '../api/http/routes/index.js';
import type { Identity, IdentityHeaders, IdentityResolver } from '../api/http/middleware.js';
import { loadConfig, type ComemConfig } from '../config/index.js';
import { groupPrincipal, parsePrincipal } from '../domain/acl.js';
import type { CommitStepName, CommitStepSkipReason } from '../domain/archive.js';
import { ComemError } from '../domain/errors.js';
import type { Logger } from '../domain/log.js';
import type { RetrievalIndex } from '../domain/retrieval.js';
import { Uri } from '../domain/uri.js';
import { AclService } from '../services/acl.js';
import { permissionDenied, type AclAction, type Authorizer } from '../services/authorizer.js';
import { CommitPipeline } from '../services/commit/pipeline.js';
import { ArchiveSummaryStep } from '../services/commit/steps/archive-summary.js';
import { MemoryExtractStep } from '../services/commit/steps/memory-extract.js';
import { MemoryMergeStep } from '../services/commit/steps/memory-merge.js';
import { SummaryInvalidateStep } from '../services/commit/steps/summary-invalidate.js';
import { ConsolidationService } from '../services/consolidation.js';
import { ContextAssembler } from '../services/context-assembler.js';
import { EmbeddingService } from '../services/embedding.js';
import { FileSystemService } from '../services/filesystem.js';
import { AuthService, bearerCredential } from '../services/auth.js';
import { IdentityService, type UserNamespace } from '../services/identity.js';
import { IndexObserver } from '../services/index-observer.js';
import { LlmService } from '../services/llm.js';
import { MemoryService, type MemoryServicePorts } from '../services/memory.js';
import { ObservabilityService } from '../services/observability.js';
import { PromptService } from '../services/prompt-service.js';
import { bindPromptRenderer } from '../services/prompts/registry.js';
import { RecallLedger, type LedgerStore } from '../services/recall-ledger.js';
import {
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_MAX_FILES,
  ResourceService,
  type ReconcileEntry,
  type ResourceStorage,
  type StageUploadInput,
  type StagedUpload,
  type StagedUploadInfo,
} from '../services/resource.js';
import { SearchService } from '../services/search.js';
import { SessionService } from '../services/session.js';
import { SkillService } from '../services/skill.js';
import {
  LlmSummarizer,
  RuleSummarizer,
  SummaryService,
} from '../services/summary.js';
import { TaskService } from '../services/task.js';
import { TtlService } from '../services/ttl.js';

import { createArchivePorts, createArchiveArtifacts } from './archive-ports.js';
import { CommitRunner } from './commit-runner.js';
import { DEFAULT_INTERVAL_MS, Scheduler } from './scheduler.js';

/** 数据库文件在数据根下的位置（§6.5 的 `_meta/comem.sqlite`）。 */
const META_DIRECTORY = '_meta';
const DATABASE_FILE = 'comem.sqlite';

/** 临时上传与对账日志的位置（`ResourceStorage` 的端口注释）。 */
const TEMP_UPLOAD_DIRECTORY = 'tmp';
const RECONCILE_LOG_FILE = 'reconcile.log';

/** 临时上传的元数据后缀。与文件同目录，`listStaged` 靠它枚举。 */
const STAGED_METADATA_SUFFIX = '.meta.json';

/** 秒 → 毫秒。`providers.embedding.timeoutSeconds` 是秒，`EmbeddingService` 收毫秒。 */
const MILLISECONDS_PER_SECOND = 1000;

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
   * 后台调度器（§10.2.1 的自动提交、§11.7 的会话过期与记忆 TTL）。
   *
   * 三个配置全关时**不启动定时器**（`createContainer` 里判断）——空转的 30 秒定时器
   * 是纯浪费。`close()` 里先停它再关数据库：它会写 `.meta.json`、建任务。
   */
  readonly scheduler: Scheduler;
  readonly services: ContainerServices;
  readonly mcpRegistry: ToolRegistry;
  /** MCP Streamable HTTP 服务端；`main` 挂到 HTTP 上。 */
  readonly mcp: McpHttpServer;
  /** 已装配好的 HTTP 路由分组。 */
  readonly routes: readonly HttpRouteGroup[];
  /** 请求身份解析（`x-comem-subject`）。 */
  readonly resolveIdentity: IdentityResolver;
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
  readonly search: SearchService;
  readonly assembler: ContextAssembler;
  readonly ledger: RecallLedger;
  /** 检索索引。测试与对账脚本要直接查它，不经过 `SearchService` 的排序与过滤。 */
  readonly index: RetrievalIndex;
  /** 写路径的派生数据维护；`drain()` 给测试一个确定的完成点。 */
  readonly indexObserver: IndexObserver;
  /** 任务行的只读查询端口（`TaskRepository`）。路由用它查任务。 */
  readonly taskStore: TaskRepository;
  /**
   * 提示词（§9.2、§11.3、§11.4）。
   *
   * 它同时是 `prompts/registry.ts` 的**进程级渲染器**：容器构造时把默认实现
   * （只读 `prompts/*.md`）换成「覆盖优先」的实现，三条提示词的调用点才能看到
   * 控制台里的修改。推导写在 `services/prompts/registry.ts`。
   */
  readonly prompts: PromptService;
  /** 用户与组用例（`/admin/*`、登录）。 */
  readonly identity: IdentityService;
  /** 登录与入站凭据解析（`auth.enabled: true` 时生效）。 */
  readonly auth: AuthService;
}

function fsErrorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return null;
  }
  const code: unknown = error.code;
  return typeof code === 'string' ? code : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 数据根下 `_meta` 的绝对路径。 */
function metaPath(dataDir: string, ...segments: readonly string[]): string {
  return join(dataDir, META_DIRECTORY, ...segments);
}

/**
 * 召回账本的文件存储。
 *
 * `write` 必须原子（临时文件 + `rename`）：账本损坏时 `RecallLedger.load` 会降级成
 * 空账本（多投一次），但写了一半的 JSON 会持续损坏到下一次成功写为止。
 */
class FileLedgerStore implements LedgerStore {
  async read(key: string): Promise<string | null> {
    try {
      return await readFile(key, 'utf8');
    } catch (error) {
      if (fsErrorCode(error) === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  async write(key: string, text: string): Promise<void> {
    await mkdir(dirname(key), { recursive: true });
    const temporary = `${key}.${process.pid.toString(36)}.tmp`;
    await writeFile(temporary, text, 'utf8');
    await rename(temporary, key);
  }

  async remove(key: string): Promise<void> {
    // `rm -f` 语义：不存在不是错误（与 `read` 返回 `null` 一致）。只吞 ENOENT，
    // 其余 IO 错误必须抛出去——静默失败会让删账号后的账本残留，同 ID 重建继承
    // 去重状态。
    try {
      await unlink(key);
    } catch (error) {
      if (fsErrorCode(error) === 'ENOENT') {
        return;
      }
      throw error;
    }
  }
}

/**
 * 临时上传与对账日志的存储（`ResourceStorage` 的 `node:fs` 实现）。
 *
 * 元数据与字节分开存：`listStaged` 不需要把每个上传的文件读进内存就能回答「有哪些」。
 */
class FileResourceStorage implements ResourceStorage {
  readonly #dataDir: string;

  constructor(dataDir: string) {
    this.#dataDir = dataDir;
  }

  async stage(input: StageUploadInput): Promise<string> {
    const tempPath = this.#tempPathOf(input.uploadId);
    const metadataPath = this.#metadataPathOf(input.uploadId);
    await mkdir(dirname(tempPath), { recursive: true });
    await writeFile(tempPath, input.bytes);
    await writeFile(
      metadataPath,
      `${JSON.stringify({
        uploadId: input.uploadId,
        fileName: input.fileName,
        size: input.bytes.byteLength,
        stagedAtMs: input.stagedAtMs,
      })}\n`,
      'utf8',
    );
    return tempPath;
  }

  async readStaged(uploadId: string): Promise<StagedUpload | null> {
    const info = await this.#readInfo(uploadId);
    if (info === null) {
      return null;
    }
    try {
      const bytes = await readFile(this.#tempPathOf(uploadId));
      return { info, bytes: new Uint8Array(bytes) };
    } catch (error) {
      if (fsErrorCode(error) === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  async listStaged(): Promise<readonly StagedUploadInfo[]> {
    const directory = this.#tempDirectory();
    let names: readonly string[];
    try {
      names = await readdir(directory);
    } catch (error) {
      if (fsErrorCode(error) === 'ENOENT') {
        return [];
      }
      throw error;
    }

    const infos: StagedUploadInfo[] = [];
    for (const name of names) {
      if (!name.endsWith(STAGED_METADATA_SUFFIX)) {
        continue;
      }
      const info = await this.#readInfo(name.slice(0, -STAGED_METADATA_SUFFIX.length));
      if (info !== null) {
        infos.push(info);
      }
    }
    return infos.sort((left, right) => left.stagedAtMs - right.stagedAtMs);
  }

  async removeStaged(uploadId: string): Promise<void> {
    await rm(this.#tempPathOf(uploadId), { force: true });
    await rm(this.#metadataPathOf(uploadId), { force: true });
  }

  async appendReconcile(entry: ReconcileEntry): Promise<void> {
    const path = metaPath(this.#dataDir, RECONCILE_LOG_FILE);
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${JSON.stringify(entry)}\n`, 'utf8');
  }

  #tempDirectory(): string {
    return metaPath(this.#dataDir, TEMP_UPLOAD_DIRECTORY);
  }

  #tempPathOf(uploadId: string): string {
    return join(this.#tempDirectory(), uploadId);
  }

  #metadataPathOf(uploadId: string): string {
    return `${this.#tempPathOf(uploadId)}${STAGED_METADATA_SUFFIX}`;
  }

  async #readInfo(uploadId: string): Promise<StagedUploadInfo | null> {
    try {
      const raw = await readFile(this.#metadataPathOf(uploadId), 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (!isRecord(parsed)) {
        return null;
      }
      const record = parsed;
      const fileName = record['fileName'];
      const size = record['size'];
      const stagedAtMs = record['stagedAtMs'];
      if (typeof size !== 'number' || typeof stagedAtMs !== 'number') {
        return null;
      }
      return {
        uploadId,
        fileName: typeof fileName === 'string' ? fileName : null,
        size,
        tempPath: this.#tempPathOf(uploadId),
        stagedAtMs,
      };
    } catch (error) {
      if (fsErrorCode(error) === 'ENOENT' || error instanceof SyntaxError) {
        return null;
      }
      throw error;
    }
  }
}

/**
 * 写路径的授权端口：物化表里没有这一行时先按链求值并落表。
 *
 * `node_permission` 是**物化缓存**（§8.2），`AclService.check` 只查缓存里该节点的行。
 * 新建节点时缓存里没有它，直接查就是 deny——「文件都还没写，权限先被拒」，写路径
 * 根本走不到观察者。`AclService.materializeNode` 的文档写的正是「用于「新建节点时
 * 从父目录复制有效权限」」，但 `FileSystemService` 不知道它该在什么时候调。
 *
 * 这里把「写操作发现行缺失 → 物化一次 → 再查」收在一处，而不是在每个路由 / 工具里
 * 各写一遍：
 *
 * - 写操作（`write` / `manage`）无条件物化：目标是新建的，磁盘上还没有它。
 * - 读操作只在**节点确实存在于磁盘**时物化：批量摄取、会话、技能这些绕过
 *   `FileSystemService` 的写入路径已经把文件写下去了，但物化表里没有行。一个拼错的
 *   URI 不会因为 GET 就在数据库里多一条权限行。
 * - 已经在缓存里的节点不会重复物化（第一次 `check` 就通过）。
 *
 * 这不是「绕过授权」：物化的结果就是 `effective(N)` 本身，与 `setAcl` 重算整棵子树
 * 用的是同一个纯函数。
 */
export class InheritingAuthorizer implements Authorizer {
  readonly #acl: AclService;
  readonly #store: ContentStore;

  constructor(acl: AclService, store: ContentStore) {
    this.#acl = acl;
    this.#store = store;
  }

  async check(
    uri: Uri,
    action: AclAction,
    principals: readonly string[],
  ): Promise<boolean> {
    return this.#acl.check(uri, action, principals);
  }

  async filterReadable(
    uris: readonly Uri[],
    principals: readonly string[],
  ): Promise<ReadonlySet<string>> {
    return this.#acl.filterReadable(uris, principals);
  }

  async assert(
    uri: Uri,
    action: AclAction,
    principals: readonly string[],
  ): Promise<void> {
    if (await this.#acl.check(uri, action, principals)) {
      return;
    }
    // 写操作的目标可能还不存在（新建节点），读操作只有「磁盘上有、物化表里没有」
    // （批量写入 / 会话 / 技能这些绕过 `FileSystemService` 的路径）才值得物化。
    // `store.stat` 不求权，所以这个判断本身不会触发权限检查。
    const exists = action >= 3 ? true : (await this.#store.stat(uri)) !== null;
    if (exists) {
      await this.#acl.materializeNode(uri);
      if (await this.#acl.check(uri, action, principals)) {
        return;
      }
    }
    throw permissionDenied(uri, action);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `MemoryService.prefetch` 传的是 `{scopes, limit}`；身份由装配方补。 */
function readScopesOption(options: unknown, fallback: readonly string[]): readonly string[] {
  if (!isRecord(options)) {
    return fallback;
  }
  const scopes = options['scopes'];
  if (!Array.isArray(scopes)) {
    return fallback;
  }
  const strings = scopes.filter((item): item is string => typeof item === 'string');
  return strings.length === 0 ? fallback : strings;
}

function readLimitOption(options: unknown): number | undefined {
  if (!isRecord(options)) {
    return undefined;
  }
  const limit = options['limit'];
  return typeof limit === 'number' && Number.isInteger(limit) && limit > 0 ? limit : undefined;
}

/**
 * 模板里的占位地址。`api.example.com` 是 IANA 保留域名（RFC 2606），永远不可达。
 *
 * 按**主机名**判断而不是整串相等：路径、端口、协议都可能被改成看起来更真实的
 * 样子，但保留域名本身仍然是占位。`new URL` 解析失败时不算占位——那是另一种
 * 配置错误，不该被这条 warn 掩盖。
 */
const PLACEHOLDER_LLM_BASE_URL_HOST = 'api.example.com';

export function llmBaseUrlIsPlaceholder(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname === PLACEHOLDER_LLM_BASE_URL_HOST;
  } catch {
    return false;
  }
}

/**
 * 构造整个后端。
 *
 * `await` 只用于启动自检（建目录、迁移）；所有服务构造都是同步的。异步是为了给
 * 未来的异步适配器留接口，不是现在需要。
 */
export async function createContainer(options: CreateContainerOptions = {}): Promise<Container> {
  const config = loadConfig({
    ...(options.configPath === undefined ? {} : { path: options.configPath }),
    ...(options.env === undefined ? {} : { env: options.env }),
    argv: [...(options.argv ?? [])],
  });

  const consoleLogger = new ConsoleLogger({ level: config.logging.level });
  const logger =
    config.logging.file === ''
      ? consoleLogger
      : new FileLogger({ inner: consoleLogger, filePath: config.logging.file });

  const dataDir = config.dataDir;
  mkdirSync(metaPath(dataDir), { recursive: true });

  const db = openDatabase(join(dataDir, META_DIRECTORY, DATABASE_FILE));
  const appliedVersion = runMigrations(db);
  logger.info('数据库迁移完成。', { version: appliedVersion, dataDir });

  // ── 适配器 ──
  const store = new ContentStore({ dataDir, logger });
  const metadata = new MetadataFileStore({ dataDir, logger });
  const aclFile = new AclFileStore({ dataDir, logger });
  const locks = createPathLockManager({ dataDir, logger });
  const index = new SqliteFtsIndex({
    db,
    logger,
    candidateMultiplier: config.retrieval.candidateMultiplier,
    // `memory.ttl.defaultDays` 在**写入时**算成绝对时刻（`0010_ttl.sql` 的文件头）。
    // 装配层是唯一能把它接到索引写入点的位置。
    defaultTtlDays: config.memory.ttl.defaultDays,
  });
  const nodes = new NodeRepository({ db, logger });
  const permissions = new PermissionRepository({ db, logger });
  const userRepository = new UserRepository({ db, logger });
  const groupRepository = new GroupRepository({ db, logger });
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
  const taskRepository = new TaskRepository({ db, logger });
  const requestLog = new RequestLogRepository({ db, logger });
  // 提示词覆盖（§18）。构造期就把全部覆盖读进内存并校验——一条引用了不存在
  // 变量的覆盖会让每一次模型调用失败，而失败只出现在后台任务里。
  const prompts = new PromptService({ overrides: new PromptRepository({ db }) });
  // 进程级渲染器换成「覆盖优先」的实现。必须在这里做：三条提示词的调用点
  // （`search` / `summary` / `memory-extract`）不属于本 wave 的所有权，推导见
  // `services/prompts/registry.ts`。
  bindPromptRenderer(prompts);
  // 请求记录的保留策略在启动时执行一次（§17.6 的 7 天 / 10 万条）。
  //
  // **不做定时任务**：单机部署的「启动清理」已经能挡住无限增长，常驻定时器要多
  // 一个生命周期与并发问题，收益抵不过成本。`prune` 自己在删到行时记 info 日志
  // （含 `deleted`），启动日志因此能回答「这次清掉了多少」。
  requestLog.prune({
    retainDays: config.telemetry.requestLog.retainDays,
    retainRows: config.telemetry.requestLog.retainRows,
    now: new Date(),
  });
  const embeddings = new EmbeddingRepository({ db, logger });
  const vectors = new SqliteVectorIndex({ db, logger });

  // ── 模型 ──
  //
  // `type: disabled` 时构造桩：每个方法都抛 `INVALID_ARGUMENT`，保证「关掉模型」
  // 不会产生任何网络调用。选桩而不是 `null`，理由见 `adapters/llm/disabled-provider.ts`。
  const llmConfig = config.providers.llm.default;
  if (llmConfig.type !== 'disabled' && llmBaseUrlIsPlaceholder(llmConfig.baseUrl)) {
    // 模板里的 `https://api.example.com/v1` 是 IANA 保留域名（RFC 2606），永远
    // 不可达。把它当默认值等于「默认配置下有一个功能静默不工作」——摘要失效投递
    // 会失败、HTTP 仍然 200，用户只会看到「写成功了」。启动时明说比事后排查好。
    logger.warn(
      'providers.llm.default.baseUrl 是占位值 api.example.com（保留域名，永远不可达）：摘要、记忆抽取、合并与检索改写都不会工作。配置真实的 baseUrl；不需要模型时把 type 改成 disabled 并把 summary.generator 改成 rule。',
      { baseUrl: llmConfig.baseUrl },
    );
  }
  const llmProvider =
    llmConfig.type === 'disabled'
      ? new DisabledLlmProvider()
      : new AiSdkLlmProvider({
          type: llmConfig.type,
          ...(llmConfig.baseUrl === '' ? {} : { baseUrl: llmConfig.baseUrl }),
          model: llmConfig.model,
          apiKey: llmConfig.apiKey,
          maxTokens: llmConfig.maxTokens,
          timeoutSeconds: llmConfig.timeoutSeconds,
          pricing: llmConfig.pricing,
          logger,
        });
  const llm = new LlmService({
    provider: llmProvider,
    logger,
    pricing: llmConfig.pricing,
    model: llmConfig.model,
  });

  // ── 嵌入 ──
  //
  // `type: disabled`（默认）时传 `null`，`EmbeddingService` 因此 `available: false`，
  // 写路径与检索路径都不会打网络。这是「没配就不该悄悄产生嵌入调用」的唯一实现点。
  const embeddingConfig = config.providers.embedding;
  const embeddingProvider =
    embeddingConfig.type === 'disabled'
      ? null
      : new AiSdkEmbeddingProvider({
          type: embeddingConfig.type,
          ...(embeddingConfig.baseUrl === '' ? {} : { baseUrl: embeddingConfig.baseUrl }),
          model: embeddingConfig.model,
          apiKey: embeddingConfig.apiKey,
          dimension: embeddingConfig.dimension,
          maxBatchSize: embeddingConfig.maxBatchSize,
          timeoutSeconds: embeddingConfig.timeoutSeconds,
          logger,
        });
  const embedding = new EmbeddingService({
    provider: embeddingProvider,
    logger,
    // 缓存按 `(model, content_digest)` 去重，与「配了哪个引擎」无关：`reindex`
    // 回填、检索查询、写路径都该共享同一份结果。关掉只对「每次都要新向量」的
    // 调试场景有意义。
    cache: embeddingConfig.cache.enabled
      ? new EmbeddingCacheRepository({
          db,
          logger,
          maxEntries: embeddingConfig.cache.maxEntries,
        })
      : null,
    config: {
      dimension: embeddingConfig.dimension,
      maxBatchSize: embeddingConfig.maxBatchSize,
      timeoutMs: embeddingConfig.timeoutSeconds * MILLISECONDS_PER_SECOND,
    },
  });
  // 启动期就把向量表建好、把维度与配置对齐：等到第一次写入才发现维度不一致，
  // 那时错误已经落在「用户等着检索结果」的路径上，而且症状是「一条都搜不到」。
  //
  // 未配置嵌入时不建表：默认维度 1536 会写进元数据，之后换成 1024 维的模型要先
  // 跑一次 `reindex` 才能启动，而那次重建没有任何数据要救。
  if (embeddingConfig.type !== 'disabled') {
    embeddings.ensureSchema(embeddingConfig.dimension, embeddingConfig.model);
  }
  if (config.retrieval.engine !== 'fts5' && embedding.available) {
    logger.info('向量检索已启用', {
      engine: config.retrieval.engine,
      model: embedding.model,
      dimension: embeddingConfig.dimension,
    });
  }

  // ── 重排 ──
  //
  // `retrieval.rerank.enabled` 为 false（默认）时不构造 provider，`SearchService`
  // 拿到 `undefined`，整条重排路径不执行——默认路径与接线前逐字一致。
  //
  // 交叉校验（`config/schema.ts`）保证 enabled 为 true 时 `providers.rerank.type`
  // 不是 `disabled`；这里只按 `http` 构造，不静默降级成「不重排」。
  const rerankConfig = config.providers.rerank;
  const rerankProvider =
    config.retrieval.rerank.enabled && rerankConfig.type === 'http'
      ? new HttpRerankProvider({
          baseUrl: rerankConfig.baseUrl,
          model: rerankConfig.model,
          apiKey: rerankConfig.apiKey,
          timeoutSeconds: rerankConfig.timeoutSeconds,
          logger,
        })
      : undefined;
  if (rerankProvider !== undefined) {
    logger.info('重排已启用', {
      model: rerankProvider.model,
      topN: rerankConfig.topN,
      keepTopN: config.retrieval.rerank.keepTopN,
    });
  }

  // ── 身份与服务图 ──
  const subject = options.subject ?? config.server.subject;
  const boundPrincipal = parsePrincipal(subject);
  if (boundPrincipal.kind !== 'user') {
    throw new ComemError('INVALID_ARGUMENT', `服务图身份必须是 user 主体：${subject}`, {
      subject,
    });
  }

  // 启动时确保配置的主体存在于用户目录（§12.6）。
  //
  // 没有这一行，`resolveIdentityOf` 第一次调 `IdentityService.resolve` 就拿到
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
    dataDir,
    db,
    aclFile,
    permissions,
    nodes,
    logger,
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

  const summary = new SummaryService({
    nodes,
    index,
    metadata,
    store,
    db,
    acl,
    generator:
      config.summary.generator === 'llm'
        ? new LlmSummarizer(llm, {
            abstractMaxChars: config.summary.abstractMaxChars,
            overviewMaxChars: config.summary.overviewMaxChars,
          })
        : new RuleSummarizer(),
    logger,
    config: {
      abstractMaxChars: config.summary.abstractMaxChars,
      overviewMaxChars: config.summary.overviewMaxChars,
    },
    locks,
  });

  const assembler = new ContextAssembler({ store, metadata, authorizer: acl, logger });

  const indexObserver = new IndexObserver({
    store,
    index,
    acl,
    summary,
    nodes,
    permissions,
    logger,
    embedding,
    // 未配置嵌入时 `node_embedding` 表根本没有建（`ensureSchema` 只在
    // `type !== 'disabled'` 时跑）。注入一个删不掉的仓储只会让默认部署的每一次
    // 删除都记一条 `no such table`，而那正是「什么都不做」的正常配置。
    ...(embeddingConfig.type === 'disabled' ? {} : { embeddings }),
  });

  const authorizer = new InheritingAuthorizer(acl, store);
  const filesystem = new FileSystemService({
    store,
    locks,
    authorizer,
    logger,
    observers: [indexObserver],
  });

  const ledger = new RecallLedger({
    dataDir,
    store: new FileLedgerStore(),
    logger,
  });

  const task = new TaskService({
    tasks: taskRepository,
    logger,
    leaseSeconds: config.task.leaseSeconds,
    maxAttempts: config.task.maxAttempts,
  });

  // `SessionService` 在 `SearchService` 之前：`search` 的意图分析要读最近几轮
  // 消息做指代消解（§8.4 的「用 session」那一列）。两者没有反向往来，调换顺序
  // 就够，不需要惰性引用。
  const session = new SessionService({
    store,
    metadata,
    locks,
    tasks: task,
    logger,
    meta: metadata,
    config: { autoCommit: config.session.autoCommit },
    // 写后物化权限：服务直接写 `ContentStore`，观察者收不到通知（§12.4）。
    authorizer,
    // 删除会话时清物化权限行：那张表没有外键级联，而会话 ID 可以由调用方指定
    // （重建同名会话会继承上一轮的行）。
    permissions,
  });

  const search = new SearchService({
    index,
    filesystem,
    authorizer: acl,
    assembler,
    logger,
    config: config.retrieval,
    ledger,
    llm,
    sessions: session,
    embedding,
    vectors,
    nodes,
    engine: config.retrieval.engine,
    // 重排默认关；只有 `retrieval.rerank.enabled` 打开时才注入，未注入时
    // `SearchService` 的整条重排路径不执行（与接线前逐字一致）。
    ...(rerankProvider === undefined
      ? {}
      : {
          rerank: {
            provider: rerankProvider,
            topN: rerankConfig.topN,
            keepTopN: config.retrieval.rerank.keepTopN,
          },
        }),
    // `telemetry.hotness.*` 是四个可选依赖：不传不会报错，只会让配置项静默失效
    // （`weight` 恒为 0、`hotness` 恒为 `null`）。服务层单测全绿也发现不了这种
    // 缺口，只有真实装配能证明配置生效。
    hotnessWeight: config.telemetry.hotness.weight,
    hotnessHalfLifeHours: config.telemetry.hotness.halfLifeHours,
    accessStats: (uris) => nodes.readAccessStats(uris),
    // `recordAccess` 是 fire-and-forget：`SearchService` 内部已经 catch，闭包不能
    // 写成 `async`（返回的 Promise 会被丢掉，拒绝就没人接）。
    recordAccess: (uris) => {
      nodes.recordAccess(uris, new Date());
    },
  });

  /**
   * 记忆文件的端口语义是「原样文档」（含 frontmatter）。
   *
   * 不能接 `FileSystemService`：它的 `read` 去掉 frontmatter、`write` 会用自己的
   * 序列化器重新拼一段，记忆字段会被吃掉或写出两段。用 `ContentStore` 的字节读写，
   * 写后手动通知观察者（字节路径绕过了 `FileSystemService`）。
   */
  const rawFilesystem: MemoryServicePorts['filesystem'] = {
    read: async (uri) => ({
      text: Buffer.from(await store.readBytes(uri)).toString('utf8'),
    }),
    write: async (uri, text) => {
      const stat = await store.writeBytes(uri, Uint8Array.from(Buffer.from(text, 'utf8')));
      await indexObserver.onNodeWritten(uri, 'file');
      return stat;
    },
    stat: (uri) => store.stat(uri),
    remove: async (uri) => {
      const removed = await store.remove(uri, { recursive: true });
      await indexObserver.onNodeRemoved(uri);
      return removed;
    },
    list: (uri) => store.list(uri),
  };

  const subjectScope = Uri.parse(`comem://user/${boundPrincipal.id}`);
  const principals = [subject, ...groups, 'user:*'];

  const memory = new MemoryService({
    // 配置项必须真的生效：写死的复核列表让 `memory.reviewRequired` 变成假配置。
    reviewRequired: config.memory.reviewRequired,
    // 记忆文件的「读 → 序列化 → 写」由 `MemoryService` 自己持 `exact` 锁：
    // `rawFilesystem` 直接写字节，绕过了 `FileSystemService.write` 的锁。
    locks,
    filesystem: rawFilesystem,
    search: {
      find: async (query, findOptions) => {
        const hits = await search.find(query, {
          scopes: readScopesOption(findOptions, [subjectScope.toString()]),
          subject,
          principals,
          ...(readLimitOption(findOptions) === undefined
            ? {}
            : { limit: readLimitOption(findOptions) }),
        });
        return hits.map((hit) => ({
          uri: hit.uri,
          abstract: hit.abstract,
          score: hit.score,
        }));
      },
    },
    logger,
  });

  /**
   * 记忆合并（§11.8）。
   *
   * 装配位置在 `MemoryService` 与 `SearchService` 之后：清单来自检索索引，写回走
   * `MemoryService`。检索端口用**请求身份**而不是服务图身份（见
   * `ConsolidateOptions.subject`）——合并是写操作，`restricted` 切断的节点不能
   * 因为「scope 根是调用方」就被读出来。
   */
  const consolidation = new ConsolidationService({
    memory,
    search,
    llm,
    logger,
    maxIterations: config.memory.consolidation.maxIterations,
  });

  const resource = new ResourceService({
    store,
    locks,
    index,
    summary,
    storage: new FileResourceStorage(dataDir),
    logger,
    // 写后物化权限：资源与技能服务直接写 `ContentStore`，观察者收不到通知（§12.4）。
    authorizer,
    maxFileBytes: DEFAULT_MAX_FILE_BYTES,
    maxFiles: DEFAULT_MAX_FILES,
  });

  const skill = new SkillService({ store, locks, index, summary, permissions, logger, authorizer });

  /**
   * 阶段二执行器（§10.1、§10.3、§10.4）。
   *
   * 端口绑定归档目录，所以管线按任务现造（`archive-ports.ts` 的文件头）。装配位置
   * 必须在 `MemoryService` 之后——四个步骤要用它（预取、读写、删除）与
   * `SummaryService`（归档摘要、失效传播）。
   *
   * **步骤顺序是 §10.3 定死的**：`archive_summary` → `memory_extract` →
   * `memory_merge` → `summary_invalidate`。合并必须在摘要失效之前——失效步骤读的是
   * 合并步骤写进 `state` 的「真正写过的文件」集合，顺序调换后它什么都读不到，
   * 目录摘要从此永远不重算，而日志里只会有一行「没有记忆写入，跳过摘要失效」。
   */
  /**
   * 没有可用模型时不能执行的步骤。
   *
   * `DisabledLlmProvider` 抛 `INVALID_ARGUMENT`，而它是 `isTerminalStepError` 的
   * 终态错误——第一次就把任务置 `failed`，归档永远停在 `archive_summary`。阶段一
   * （归档落盘、建任务、`session` 关联）不依赖模型，缺模型只让阶段二的产物消失，
   * 所以这两步跳过、归档照常完成。判据与 `ingest` 的
   * `{ skipped: true, reason: 'llm_disabled' }` 完全相同：装配层从
   * `providers.llm.default.type` 推出，`services/` 不 import `config/`。
   *
   * `memory_merge` 跟着跳过：它的输入是抽取结果，没有抽取就没有可合并的操作。另外
   * 两步不调模型——`archive_summary` 走规则摘要，`summary_invalidate` 只标脏。
   */
  const commitSkippedSteps =
    config.providers.llm.default.type === 'disabled'
      ? new Map<CommitStepName, CommitStepSkipReason>([
          ['memory_extract', 'llm_disabled'],
          ['memory_merge', 'llm_disabled'],
        ])
      : new Map<CommitStepName, CommitStepSkipReason>();

  const commitRunner = new CommitRunner({
    tasks: task,
    createPipeline: (archiveUri, onStepsChanged) => {
      const ports = createArchivePorts(archiveUri, {
        store,
        metadata,
        logger,
        dataDir,
        onStepsChanged,
      });
      const archiveArtifacts = createArchiveArtifacts(archiveUri, {
        store,
        metadata,
        logger,
        dataDir,
      });
      return new CommitPipeline({
        steps: [
          new ArchiveSummaryStep({
            summary,
            llm,
            metadata,
            workingMemory: { enabled: config.memory.workingMemory.enabled },
            logger,
          }),
          new MemoryExtractStep({ memory, llm, archive: archiveArtifacts, logger }),
          new MemoryMergeStep({ memory, archive: archiveArtifacts, logger }),
          new SummaryInvalidateStep({ summary, logger }),
        ],
        ports,
        skippedSteps: commitSkippedSteps,
        logger,
      });
    },
    logger,
    concurrency: config.task.concurrency,
  });

  /**
   * 记忆 TTL 与会话过期（§11.7）。
   *
   * 装配位置在 `MemoryService` 之后：删除会话前要读「它产出的记忆是否还在待复核」。
   */
  const ttl = new TtlService({ nodes, logger });

  const scheduler = new Scheduler({
    logger,
    dataDir,
    sessions: session,
    ttl,
    memories: { read: (uri) => memory.read(uri) },
    expiry: {
      idleTimeoutSeconds: config.session.expiry.idleTimeoutSeconds,
      action: config.session.expiry.action,
    },
    ttlSweepBatchSize: config.memory.ttl.sweepBatchSize,
  });

  // 三个开关全关时不起定时器：空转的 30 秒定时器是纯浪费，而且会让「调度器在跑」
  // 这条日志失去信息量。
  const schedulerEnabled =
    config.session.autoCommit.enabled ||
    config.session.expiry.idleTimeoutSeconds > 0 ||
    config.memory.ttl.defaultDays > 0;
  if (schedulerEnabled) {
    scheduler.start();
    logger.info('调度器已启动。', {
      intervalSeconds: DEFAULT_INTERVAL_MS / MILLISECONDS_PER_SECOND,
      autoCommit: config.session.autoCommit.enabled ? '开' : '关',
      expiry:
        config.session.expiry.idleTimeoutSeconds > 0
          ? `开（${String(config.session.expiry.idleTimeoutSeconds)} 秒空闲后 ${config.session.expiry.action}）`
          : '关',
      ttl:
        config.memory.ttl.defaultDays > 0
          ? `开（默认 ${String(config.memory.ttl.defaultDays)} 天）`
          : '关',
    });
  } else {
    logger.info('调度器未启动：自动提交、会话过期、记忆 TTL 全部关闭。', {});
  }

  const observability = new ObservabilityService({
    requestLog,
    db,
    metadata,
    llm,
    logger,
    hookOverheadEnabled: config.telemetry.hookOverhead.enabled,
    includeAccountLabel: config.telemetry.metrics.includeAccountLabel,
    requestLogPolicy: {
      enabled: config.telemetry.requestLog.enabled,
      sampleRate: config.telemetry.requestLog.sampleRate,
    },
  });

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
    search,
    assembler,
    ledger,
    index,
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
    consolidation,
    resource,
    skill,
    search,
    ledger,
    identity: identityService,
    auth: authService,
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
      userCount: () => userRepository.count(),
      groupCount: () => groupRepository.count(),
    },
  });

  let closed = false;
  return {
    config,
    logger,
    db,
    observability,
    commitRunner,
    scheduler,
    services,
    mcpRegistry,
    mcp,
    routes,
    resolveIdentity,
    close: async () => {
      if (closed) {
        return;
      }
      closed = true;
      // 先停调度器：它会写 `.meta.json`（归档）、删会话目录、建归档任务。
      await scheduler.stop();
      // 再停在途提交任务：它们调模型、写归档与记忆，`db.close()` 之后写库会抛。
      // 与 `main.ts` 的退出路径都调 `stop()`，所以它必须幂等（它确实幂等）。
      await commitRunner.stop();
      // 再等后台的摘要失效跑完：`db.close()` 之后它们写库会抛。
      await indexObserver.drain();
      db.close();
      logger.info('数据库连接已关闭。');
    },
  };
}

/**
 * 解析请求身份。
 *
 * v1 不做认证：身份由反向代理注入 `x-comem-subject`。**没有这个头时用服务图绑定的
 * 主体**（`server.subject`）——单用户桌面部署没有代理，要求它配一个头只会让
 * `curl /health` 之外的手工调用全部 401。
 *
 * 与绑定身份不一致时抛 `UNAUTHENTICATED`：服务图只有一份（见文件头），静默换成
 * 绑定的身份就是冒充。多租户部署要换成真正的认证 + 每请求服务图。
 */
async function resolveIdentityOf(
  headers: IdentityHeaders,
  boundSubject: string,
  identityService: IdentityService,
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
    principals: [...new Set([...identity.principals, 'user:*'])],
  };
}

// ── 管理面的统计 ──
//
// `api/` 不能 import `adapters/`（架构文档 §4.2），所以 `AdminAccess` 的 SQL 实现
// 留在这里。两个函数都是同步的：`node:sqlite` 是同步 API，事务边界也必须是同步
// 回调，异步函数会让 `withWriteTransaction` 在 Promise 完成前提交。
//
// 撤权不在这一层：它要改 `.acl.json`（异步文件写入），编排在 `AclService.purgePrincipal`
// 里，由 `DELETE /admin/users/{id}` / `DELETE /admin/groups/{id}` 调用。

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

/**
 * 启动自检：数据根可写。
 *
 * 只读数据根时服务能起来，但第一次写入才失败——那时已经在处理用户请求了。启动期
 * 拒绝比运行期 500 好。
 */
export async function assertDataDirWritable(dataDir: string): Promise<void> {
  try {
    await access(dataDir, fsConstants.W_OK);
    await access(join(dataDir, META_DIRECTORY), fsConstants.W_OK);
  } catch (error) {
    throw new ComemError('INTERNAL', `数据根不可写：${dataDir}`, {
      dataDir,
      error: errorMessage(error),
    });
  }
}
