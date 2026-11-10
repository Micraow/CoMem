/**
 * 装配阶段 4：检索栈（摘要 → 装配器 → 对账日志 → 观察者 → 文件系统 → 账本 → 任务
 * → 会话 → 检索服务）。顺序不是风格：`IndexObserver` 在 `FileSystemService` 之前
 * （后者要 `observers` 数组）、`SearchService` 在它之后（`grep` 要读文件）；
 * `TaskService` 在 `SessionService` 之前（阶段一提交要建任务），后者又在
 * `SearchService` 之前（意图分析要读最近几轮消息做指代消解，§8.4）。
 *
 * `IndexObserver` 不用 `FileSystemService`（直接用 `ContentStore`），不构成环。
 */

import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { ReconcileLog } from '../../adapters/fs/reconcile-log.js';
import { ContextAssembler } from '../../services/context-assembler.js';
import { FileSystemService } from '../../services/filesystem.js';
import { IndexObserver } from '../../services/index-observer.js';
import { RecallLedger } from '../../services/recall-ledger.js';
import type { LedgerStore } from '../../services/recall-ledger.js';
import { SearchService } from '../../services/search.js';
import { SessionService } from '../../services/session.js';
import {
  LlmSummarizer,
  RuleSummarizer,
  SummaryService,
} from '../../services/summary.js';
import { TaskService } from '../../services/task.js';
import type { Access } from './access.js';
import type { Foundation } from './foundation.js';
import type { Models } from './models.js';
import { InheritingAuthorizer } from './ports.js';
import { fsErrorCode } from './support.js';

/**
 * 召回账本的文件存储。`write` 必须原子（临时文件 + `rename`）：账本损坏时
 * `RecallLedger.load` 会降级成空账本（多投一次），写了一半的 JSON 则会持续损坏。 */
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
    // `rm -f` 语义：不存在不是错误。只吞 ENOENT，其余 IO 错误必须抛出去——静默
    // 失败会让删账号后的账本残留，同 ID 重建继承去重状态。
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

/** 检索栈产物。`reconcileLog` 与 `authorizer` 供后续阶段的写路径共用。 */
export interface Retrieval {
  readonly summary: SummaryService;
  readonly assembler: ContextAssembler;
  readonly reconcileLog: ReconcileLog;
  readonly indexObserver: IndexObserver;
  readonly authorizer: InheritingAuthorizer;
  readonly filesystem: FileSystemService;
  readonly ledger: RecallLedger;
  readonly task: TaskService;
  readonly session: SessionService;
  readonly search: SearchService;
}

type RetrievalCore = Pick<
  Retrieval,
  'summary' | 'assembler' | 'reconcileLog' | 'indexObserver' | 'authorizer'
>;

function createRetrievalCore(
  core: Foundation,
  models: Models,
  access: Access,
): RetrievalCore {
  const { config, logger, dataDir, db, store, metadata, locks, index, nodes, permissions } = core;
  const { embeddings } = core;
  const { llm, embedding, embeddingConfig } = models;
  const { acl } = access;

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

  // 观察者、资源与技能共用同一个 `ReconcileLog`，与重放器是同一条串行队列。
  const reconcileLog = new ReconcileLog({ dataDir, logger });

  const indexObserver = new IndexObserver({
    store,
    index,
    acl,
    summary,
    nodes,
    permissions,
    logger,
    reconcile: reconcileLog,
    embedding,
    // 未配置嵌入时 `node_embedding` 表根本没建（`ensureSchema` 只在
    // `type !== 'disabled'` 时跑）。注入删不掉的仓储只会让默认部署每次删除记一条
    // `no such table`，而那正是「什么都不做」的正常配置。
    ...(embeddingConfig.type === 'disabled' ? {} : { embeddings }),
  });

  const authorizer = new InheritingAuthorizer(acl, store);
  return { summary, assembler, reconcileLog, indexObserver, authorizer };
}

export function createRetrieval(
  core: Foundation,
  models: Models,
  access: Access,
): Retrieval {
  const { summary, assembler, reconcileLog, indexObserver, authorizer } =
    createRetrievalCore(core, models, access);
  const { config, logger, dataDir, store, metadata, locks, index, nodes, permissions } = core;
  const { taskRepository, vectors } = core;
  const { llm, embedding, rerankProvider, rerankConfig } = models;
  const { acl } = access;

  // 访问计数的唯一写入口：检索命中与按 URI 读取共用同一条 UPDATE。`SearchService`
  // 内部已经 catch，这个闭包不能写成 `async`（返回的 Promise 会被丢掉，拒绝就没人
  // 接）；`FileSystemService` 自己 catch 并记 warn。
  const recordAccess = (uris: readonly string[]): void => {
    nodes.recordAccess(uris, new Date());
  };
  const filesystem = new FileSystemService({
    store,
    locks,
    authorizer,
    logger,
    observers: [indexObserver],
    // `read` 是公开读路径：按 URI 读到正文也算一次使用，否则天天被读、从没被检索
    // 命中的记忆会被 TTL 误归档（§11.7）。
    recordAccess,
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
    // 删会话时清物化权限行：那张表没有外键级联，会话 ID 又可由调用方指定。
    permissions,
    // `messages.jsonl` 是唯一能读的会话内容：写完走一次观察者，`node` /
    // `node_permission` 里才有这一行，`list`/`tree`/`glob` 才看得到「原始对话」。
    observer: indexObserver,
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
    // 重排默认关：只有 `retrieval.rerank.enabled` 打开时才注入，未注入时整条重排
    // 路径不执行（与接线前逐字一致）。
    ...(rerankProvider === undefined
      ? {}
      : {
          rerank: {
            provider: rerankProvider,
            topN: rerankConfig.topN,
            keepTopN: config.retrieval.rerank.keepTopN,
          },
        }),
    // `telemetry.hotness.*` 是可选依赖：不传不报错，只会让配置静默失效（`weight`
    // 恒为 0、`hotness` 恒为 `null`）。只有真实装配能证明配置生效。
    hotnessWeight: config.telemetry.hotness.weight,
    hotnessHalfLifeHours: config.telemetry.hotness.halfLifeHours,
    accessStats: (uris) => nodes.readAccessStats(uris),
    recordAccess,
  });

  return {
    summary,
    assembler,
    reconcileLog,
    indexObserver,
    authorizer,
    filesystem,
    ledger,
    task,
    session,
    search,
  };
}
