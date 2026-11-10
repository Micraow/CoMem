/**
 * 装配阶段 1：配置 → 日志 → 数据库 → 适配器 → 仓储。
 *
 * 这是原 `createContainer` 的前半段，语句与顺序逐条保留：
 *
 * - `mkdirSync(_meta)` 必须在 `openDatabase` 之前，否则首次启动打不开库文件；
 * - `bindPromptRenderer(prompts)` 是**进程级**副作用，只能做一次，位置在提示词服务
 *   构造之后、任何调用点之前；
 * - 仓储全部由这里 `new`（§4.4：`services/` 不 new 适配器），后续阶段只收它们。
 *
 * 阶段之间只通过返回值通信：本模块没有任何模块级可变状态，也没有别处 import 本模块
 * 之外的可变单例。
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { AclFileStore } from '../../adapters/fs/acl-file.js';
import { ContentStore } from '../../adapters/fs/content-store.js';
import { createPathLockManager } from '../../adapters/fs/lock.js';
import { MetadataFileStore } from '../../adapters/fs/metadata-file.js';
import { ConsoleLogger } from '../../adapters/log/console.js';
import { FileLogger } from '../../adapters/log/file.js';
import { openDatabase, runMigrations } from '../../adapters/sqlite/database.js';
import { EmbeddingRepository } from '../../adapters/sqlite/embedding-repository.js';
import { GroupRepository } from '../../adapters/sqlite/group-repository.js';
import { MemoryLinkRepository } from '../../adapters/sqlite/memory-link-repository.js';
import { NodeRepository } from '../../adapters/sqlite/node-repository.js';
import { PermissionRepository } from '../../adapters/sqlite/permission-repository.js';
import { PromptRepository } from '../../adapters/sqlite/prompt-repository.js';
import { RequestLogRepository } from '../../adapters/sqlite/request-log-repository.js';
import { SqliteFtsIndex } from '../../adapters/sqlite/retrieval-index.js';
import { TaskRepository } from '../../adapters/sqlite/task-repository.js';
import { UserRepository } from '../../adapters/sqlite/user-repository.js';
import { SqliteVectorIndex } from '../../adapters/sqlite/vector-index.js';
import { loadConfig } from '../../config/index.js';
import type { ComemConfig } from '../../config/index.js';
import type { Logger } from '../../domain/log.js';
import { MemoryLinkService } from '../../services/memory-link.js';
import { PromptService } from '../../services/prompt-service.js';
import { bindPromptRenderer } from '../../services/prompts/registry.js';
import { META_DIRECTORY, metaPath } from './support.js';
import type { CreateContainerOptions } from './types.js';

const DATABASE_FILE = 'comem.sqlite';

/** 适配器、仓储与进程级单例。后续每个阶段都收这一份，不再各自 `new`。 */
export interface Foundation {
  readonly config: ComemConfig;
  readonly logger: Logger;
  readonly dataDir: string;
  readonly db: DatabaseSync;
  readonly store: ContentStore;
  readonly metadata: MetadataFileStore;
  readonly aclFile: AclFileStore;
  readonly locks: ReturnType<typeof createPathLockManager>;
  readonly index: SqliteFtsIndex;
  readonly nodes: NodeRepository;
  readonly memoryLink: MemoryLinkService;
  readonly permissions: PermissionRepository;
  readonly userRepository: UserRepository;
  readonly groupRepository: GroupRepository;
  readonly taskRepository: TaskRepository;
  readonly requestLog: RequestLogRepository;
  readonly prompts: PromptService;
  readonly embeddings: EmbeddingRepository;
  readonly vectors: SqliteVectorIndex;
}

export function createFoundation(options: CreateContainerOptions): Foundation {
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
  // 记忆关联边（§11.10）：存一张 `memory_link` 表，不进检索索引。
  const memoryLink = new MemoryLinkService({
    repository: new MemoryLinkRepository({ db, logger }),
    logger,
  });
  const permissions = new PermissionRepository({ db, logger });
  const userRepository = new UserRepository({ db, logger });
  const groupRepository = new GroupRepository({ db, logger });
  const taskRepository = new TaskRepository({ db, logger });
  const requestLog = new RequestLogRepository({ db, logger });
  // 提示词覆盖（§18）。构造期就把全部覆盖读进内存并校验——一条引用了不存在
  // 变量的覆盖会让每一次模型调用失败，而失败只出现在后台任务里。
  const prompts = new PromptService({ overrides: new PromptRepository({ db }) });
  // 进程级渲染器换成「覆盖优先」的实现。必须在这里做：四条提示词的调用点
  // （`search` / `summary` / `memory-extract` / `experience-distill`）不属于本 wave
  // 的所有权，推导见 `services/prompts/registry.ts`。
  bindPromptRenderer(prompts);
  // `request_log` 的裁剪跟着调度器走（§17.6）：表在进程活着的时候长，只在启动时
  // 裁一次就等于「常驻越久、表越大」。调度器那一轮每轮都调 `prune`，所以这里不裁；
  // 调度器因开关全关而不启动时，启动清理是唯一保证，见 `background.ts`。
  const embeddings = new EmbeddingRepository({ db, logger });
  const vectors = new SqliteVectorIndex({ db, logger });

  return {
    config,
    logger,
    dataDir,
    db,
    store,
    metadata,
    aclFile,
    locks,
    index,
    nodes,
    memoryLink,
    permissions,
    userRepository,
    groupRepository,
    taskRepository,
    requestLog,
    prompts,
    embeddings,
    vectors,
  };
}
