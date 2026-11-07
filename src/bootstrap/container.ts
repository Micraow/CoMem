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
 * 配置 → 日志 → 数据库/迁移 → 适配器 → 模型 → AclService → SummaryService
 *      → ContextAssembler → IndexObserver → FileSystemService → SearchService
 *      → TaskService → SessionService → MemoryService → ResourceService
 *      → SkillService → ObservabilityService → MCP → HTTP 路由
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
 * `options.subject`（默认 `user:local`）。HTTP 的 `x-comem-subject` 与它不一致时
 * 直接 401——让「换一个身份」静默降级成「用绑定的身份」就是冒充。多租户要的是
 * 每请求一份服务图，那是另一套装配，不在本 wave。
 */

import { constants as fsConstants, mkdirSync } from 'node:fs';
import { access, appendFile, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { AclFileStore } from '../adapters/fs/acl-file.js';
import { ContentStore } from '../adapters/fs/content-store.js';
import { createPathLockManager } from '../adapters/fs/lock.js';
import { MetadataFileStore } from '../adapters/fs/metadata-file.js';
import { ConsoleLogger } from '../adapters/log/console.js';
import { FileLogger } from '../adapters/log/file.js';
import { AiSdkLlmProvider } from '../adapters/llm/ai-sdk-provider.js';
import { openDatabase, runMigrations } from '../adapters/sqlite/database.js';
import { NodeRepository } from '../adapters/sqlite/node-repository.js';
import { PermissionRepository } from '../adapters/sqlite/permission-repository.js';
import { RequestLogRepository } from '../adapters/sqlite/request-log-repository.js';
import { SqliteFtsIndex } from '../adapters/sqlite/retrieval-index.js';
import { TaskRepository } from '../adapters/sqlite/task-repository.js';
import { createToolRegistry } from '../api/mcp/tools/index.js';
import type { ToolRegistry } from '../api/mcp/registry.js';
import { McpHttpServer } from '../api/mcp/server.js';
import type { HttpRouteGroup } from '../api/http/server.js';
import { createHttpRouteGroups } from '../api/http/routes/index.js';
import { DEFAULT_SUBJECT, type Identity, type IdentityHeaders, type IdentityResolver } from '../api/http/middleware.js';
import { loadConfig, type ComemConfig } from '../config/index.js';
import { parsePrincipal } from '../domain/acl.js';
import { ComemError } from '../domain/errors.js';
import type { Logger } from '../domain/log.js';
import type { RetrievalIndex } from '../domain/retrieval.js';
import { Uri } from '../domain/uri.js';
import { AclService } from '../services/acl.js';
import { permissionDenied, type AclAction, type Authorizer } from '../services/authorizer.js';
import { ContextAssembler } from '../services/context-assembler.js';
import { FileSystemService } from '../services/filesystem.js';
import { IndexObserver } from '../services/index-observer.js';
import { LlmService } from '../services/llm.js';
import { MemoryService, type MemoryServicePorts } from '../services/memory.js';
import { ObservabilityService } from '../services/observability.js';
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

/** 数据库文件在数据根下的位置（§6.5 的 `_meta/comem.sqlite`）。 */
const META_DIRECTORY = '_meta';
const DATABASE_FILE = 'comem.sqlite';

/** 临时上传与对账日志的位置（`ResourceStorage` 的端口注释）。 */
const TEMP_UPLOAD_DIRECTORY = 'tmp';
const RECONCILE_LOG_FILE = 'reconcile.log';

/** 临时上传的元数据后缀。与文件同目录，`listStaged` 靠它枚举。 */
const STAGED_METADATA_SUFFIX = '.meta.json';

/** `Container` 的构造参数。`subject` / `groups` / `argv` 是任务草图之外的必要项。 */
export interface CreateContainerOptions {
  /** 配置文件路径；缺省 `config.yaml` */
  readonly configPath?: string;
  readonly env?: NodeJS.ProcessEnv;
  /** 命令行参数，识别 `--config` 与 `--data-dir`（§18） */
  readonly argv?: readonly string[];
  /** 服务图绑定的身份；默认 `user:local`（v1 单用户部署） */
  readonly subject?: string;
  /** 身份所属的组（`group:eng` 形式）；默认空 */
  readonly groups?: readonly string[];
}

export interface Container {
  readonly config: ComemConfig;
  readonly logger: Logger;
  readonly db: DatabaseSync;
  readonly observability: ObservabilityService;
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

  async check(uri: Uri, action: AclAction): Promise<boolean> {
    return this.#acl.check(uri, action);
  }

  async filterReadable(uris: readonly Uri[]): Promise<ReadonlySet<string>> {
    return this.#acl.filterReadable(uris);
  }

  async assert(uri: Uri, action: AclAction): Promise<void> {
    if (await this.#acl.check(uri, action)) {
      return;
    }
    // 写操作的目标可能还不存在（新建节点），读操作只有「磁盘上有、物化表里没有」
    // （批量写入 / 会话 / 技能这些绕过 `FileSystemService` 的路径）才值得物化。
    // `store.stat` 不求权，所以这个判断本身不会触发权限检查。
    const exists = action >= 3 ? true : (await this.#store.stat(uri)) !== null;
    if (exists) {
      await this.#acl.materializeNode(uri);
      if (await this.#acl.check(uri, action)) {
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
  });
  const nodes = new NodeRepository({ db, logger });
  const permissions = new PermissionRepository({ db, logger });
  const taskRepository = new TaskRepository({ db, logger });
  const requestLog = new RequestLogRepository({ db, logger });

  // ── 模型 ──
  const llmConfig = config.providers.llm.default;
  const llm = new LlmService({
    provider: new AiSdkLlmProvider({
      type: llmConfig.type,
      ...(llmConfig.baseUrl === '' ? {} : { baseUrl: llmConfig.baseUrl }),
      model: llmConfig.model,
      apiKey: llmConfig.apiKey,
      maxTokens: llmConfig.maxTokens,
      timeoutSeconds: llmConfig.timeoutSeconds,
      pricing: llmConfig.pricing,
      logger,
    }),
    logger,
    pricing: llmConfig.pricing,
    model: llmConfig.model,
  });

  // ── 身份与服务图 ──
  const subject = options.subject ?? DEFAULT_SUBJECT;
  const groups = [...(options.groups ?? [])];
  const acl = new AclService({
    dataDir,
    db,
    aclFile,
    permissions,
    nodes,
    logger,
    groupDefaultLevel: config.acl.groupDefaultLevel === 'write' ? 3 : 1,
    subject,
    groups,
  });

  // §12.6 根预置：`comem://user/{uid}/` 要有 `user:{uid} = manage` 这一行。
  //
  // 不预置的后果不是「权限收得太紧」而是**全新部署下什么都看不见**：`list` /
  // `tree` / `GET /sessions` 都走 `filterReadable`，它是纯 SQL 查询，物化表里没有
  // 根行就一条都返回不了。写路径上 `InheritingAuthorizer` 会顺手补，但只读路径
  // 不会——一个刚装好、还没写过东西的实例，控制台是空的。
  //
  // 幂等：行已存在就是覆盖成同样的值。
  const userRoot = Uri.parse(`comem://user/${subject.replace(/^user:/u, '')}`);
  await acl.materializeNode(userRoot);

  // §6.5 的四个上下文目录在建库时就建出来。
  //
  // 不建的话，「全新部署 + 打开会话页」会拿到 403 而不是空列表：`list` 会先对目录
  // 求 read 权限，而目录不存在就物化不出行，`InheritingAuthorizer` 只能拒绝。
  // 空列表和「没有权限」是两件事，前者是正确状态。
  for (const name of ['memories', 'resources', 'skills', 'sessions']) {
    const directory = userRoot.child(name);
    await store.mkdir(directory, { recursive: true });
    await acl.materializeNode(directory);
  }

  const summary = new SummaryService({
    nodes,
    index,
    metadata,
    store,
    db,
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

  const search = new SearchService({
    index,
    filesystem,
    authorizer: acl,
    assembler,
    logger,
    config: config.retrieval,
    ledger,
  });

  const task = new TaskService({
    tasks: taskRepository,
    logger,
    leaseSeconds: config.task.leaseSeconds,
    maxAttempts: config.task.maxAttempts,
  });

  const session = new SessionService({
    store,
    metadata,
    locks,
    tasks: task,
    logger,
    meta: metadata,
    config: { autoCommit: config.session.autoCommit },
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

  const boundPrincipal = parsePrincipal(subject);
  if (boundPrincipal.kind !== 'user') {
    throw new ComemError('INVALID_ARGUMENT', `服务图身份必须是 user 主体：${subject}`, {
      subject,
    });
  }
  const subjectScope = Uri.parse(`comem://user/${boundPrincipal.id}`);
  const principals = [subject, ...groups, 'user:*'];

  const memory = new MemoryService({
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

  const resource = new ResourceService({
    store,
    locks,
    index,
    summary,
    storage: new FileResourceStorage(dataDir),
    logger,
    maxFileBytes: DEFAULT_MAX_FILE_BYTES,
    maxFiles: DEFAULT_MAX_FILES,
  });

  const skill = new SkillService({ store, locks, index, summary, permissions, logger });

  const observability = new ObservabilityService({
    requestLog,
    db,
    metadata,
    llm,
    logger,
    requestLogPolicy: {
      enabled: config.telemetry.requestLog.enabled,
      sampleRate: config.telemetry.requestLog.sampleRate,
    },
  });

  const mcpRegistry = createToolRegistry();
  const resolveIdentity: IdentityResolver = async (headers: IdentityHeaders) =>
    resolveIdentityOf(headers, subject, groups);

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
    resource,
    skill,
    search,
  });

  let closed = false;
  return {
    config,
    logger,
    db,
    observability,
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
      // 先等后台的摘要失效跑完：`db.close()` 之后它们写库会抛。
      await indexObserver.drain();
      db.close();
      logger.info('数据库连接已关闭。');
    },
  };
}

/**
 * 解析请求身份。
 *
 * v1 不做认证：身份由反向代理注入 `x-comem-subject`。**没有这个头时用 `user:local`**
 * ——单用户桌面部署没有代理，要求它配一个头只会让 `curl /health` 之外的手工调用
 * 全部 401。
 *
 * 与绑定身份不一致时抛 `UNAUTHENTICATED`：服务图只有一份（见文件头），静默换成
 * 绑定的身份就是冒充。多租户部署要换成真正的认证 + 每请求服务图。
 */
async function resolveIdentityOf(
  headers: IdentityHeaders,
  boundSubject: string,
  groups: readonly string[],
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

  return { subject, principals: [subject, ...groups, 'user:*'] };
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
