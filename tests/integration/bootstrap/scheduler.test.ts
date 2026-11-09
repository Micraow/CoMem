/**
 * 后台调度器的行为验收（架构文档 §10.2.1、§11.7）。
 *
 * 这一份测「调度器自己」：什么时候提交、什么时候过期、什么时候什么都不做、关掉时
 * 等多久。端到端（容器 + 真实配置）在 `tests/integration/services/session-scheduler.test.ts`。
 *
 * 用的是真实服务（`ContentStore` / `MetadataFileStore` / SQLite `:memory:` /
 * `SessionService` / `TaskService` / `TtlService`）与真实数据根：调度器的输入是
 * 「磁盘上有哪些会话目录」，替身数据根测不到 `#discoverSessionUris` 的路径推导。
 */

import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ContentStore } from '../../../src/adapters/fs/content-store.js';
import { createPathLockManager, type PathLockManager } from '../../../src/adapters/fs/lock.js';
import { MetadataFileStore } from '../../../src/adapters/fs/metadata-file.js';
import { openDatabase, runMigrations } from '../../../src/adapters/sqlite/database.js';
import { NodeRepository } from '../../../src/adapters/sqlite/node-repository.js';
import { TaskRepository } from '../../../src/adapters/sqlite/task-repository.js';
import {
  Scheduler,
  type PendingMemoryPort,
  type ReconcilePort,
  type SchedulerExpiry,
  type SessionAutoCommitPort,
  type TtlPort,
} from '../../../src/bootstrap/scheduler.js';
import type { Logger } from '../../../src/domain/log.js';
import type { AutoCommitPolicy, Session, SessionMessage } from '../../../src/domain/session.js';
import { Uri } from '../../../src/domain/uri.js';
import type { MemoryRecord, MemoryStatus } from '../../../src/services/memory.js';
import { SessionService } from '../../../src/services/session.js';
import { TaskService } from '../../../src/services/task.js';
import { TtlService } from '../../../src/services/ttl.js';
import { FileSystemService } from '../../../src/services/filesystem.js';
import { AllowAllAuthorizer } from '../../../src/services/authorizer.js';

const AUTH_PRINCIPALS: readonly string[] = ['user:alice', 'user:*'];

const SCOPE = 'comem://user/alice';

/** 架构文档 §10.2.1 的默认策略；各用例只覆盖需要变化的字段。 */
const DEFAULT_POLICY: AutoCommitPolicy = {
  enabled: true,
  pendingTokenThreshold: 150000,
  messageCountThreshold: 100,
  minCommitIntervalSeconds: 0,
  idleTimeoutSeconds: 0,
  keepRecentCount: 0,
};

/** 关掉过期：只测自动提交的用例不该被「空闲」误触发。 */
const EXPIRY_OFF: SchedulerExpiry = { idleTimeoutSeconds: 0, action: 'archive' };

/**
 * 相对此刻的一个 ISO 时刻。TTL 的滑动窗口从「最后一次被使用」起算，用例只需要
 * 「31 天前写入」这一种基准，不需要注入时钟。
 */
function daysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

let dataDir: string;
let db: DatabaseSync;
let logger: Logger;
let store: ContentStore;
let metadata: MetadataFileStore;
let locks: PathLockManager;
let tasks: TaskService;
let nodes: NodeRepository;
let ttl: TtlService;

function createLogger(): Logger {
  const mock: Logger = {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => mock,
  };
  return mock;
}

function createSession(policy: Partial<AutoCommitPolicy> = {}): SessionService {
  return new SessionService({
    store,
    metadata,
    locks,
    tasks,
    logger,
    meta: metadata,
    config: { autoCommit: { ...DEFAULT_POLICY, ...policy } },
  });
}

interface SchedulerHarness {
  readonly scheduler: Scheduler;
  readonly sessions: SessionAutoCommitPort;
  readonly ttlPort: TtlPort;
  readonly memories: PendingMemoryPort;
  readonly reconcile: ReconcilePort;
}

function createScheduler(options: {
  readonly sessions?: SessionAutoCommitPort;
  readonly expiry?: Partial<SchedulerExpiry>;
  readonly memories?: PendingMemoryPort;
  readonly ttl?: TtlPort;
  readonly reconcile?: ReconcilePort;
  readonly ttlSweepBatchSize?: number;
} = {}): SchedulerHarness {
  const sessions = options.sessions ?? createSession();
  const ttlPort = options.ttl ?? ttl;
  const memories: PendingMemoryPort = options.memories ?? { read: async () => null };
  const reconcile: ReconcilePort = options.reconcile ?? {
    replay: async () => ({ resolved: 0, failed: 0, remaining: 0, corrupt: 0, unsupported: 0 }),
  };
  const scheduler = new Scheduler({
    logger,
    dataDir,
    sessions,
    ttl: ttlPort,
    reconcile,
    memories,
    expiry: { ...EXPIRY_OFF, ...options.expiry },
    ttlSweepBatchSize: options.ttlSweepBatchSize ?? 100,
  });
  return { scheduler, sessions, ttlPort, memories, reconcile };
}

function message(id: string, text = '消息正文'): Omit<SessionMessage, 'turn'> {
  return {
    id,
    role: 'user',
    parts: [{ kind: 'text', text }],
    // 固定在一个过去的时间：空闲过期的用例要有确定的「多久没动」。
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

function sessionDirectory(sessionUri: Uri): string {
  return join(dataDir, 'user', 'alice', 'sessions', sessionUri.name);
}

function archiveDirectory(sessionUri: Uri, archiveId: string): string {
  return join(sessionDirectory(sessionUri), 'history', archiveId);
}

/** 归档目录里的 `memory_diff.json`（保留名，`Uri.child` 拒绝，只能按磁盘路径写）。 */
async function writeMemoryDiff(
  sessionUri: Uri,
  archiveId: string,
  memoryUris: readonly string[],
): Promise<void> {
  await writeFile(
    join(archiveDirectory(sessionUri, archiveId), 'memory_diff.json'),
    `${JSON.stringify({
      archiveUri: `${sessionUri.toString()}/history/${archiveId}`,
      extractedAt: '2026-01-01T00:00:00.000Z',
      operations: {
        adds: memoryUris.map((uri) => ({ uri, memoryType: 'experiences', after: '正文' })),
        updates: [],
        deletes: [],
      },
      skippedOperations: [],
      summary: {
        totalAdds: memoryUris.length,
        totalUpdates: 0,
        totalDeletes: 0,
        totalSkipped: 0,
      },
    })}\n`,
    'utf8',
  );
}

function memoryRecord(uri: string, status: MemoryStatus): MemoryRecord {
  return { uri: Uri.parse(uri), memoryType: 'experiences', fields: {}, status, updatedAt: '2026-01-01T00:00:00.000Z' };
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let release = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    release = () => {
      resolve();
    };
  });
  return { promise, resolve: () => release() };
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'comem-scheduler-'));
  db = openDatabase(':memory:');
  runMigrations(db);
  logger = createLogger();
  store = new ContentStore({ dataDir, logger });
  metadata = new MetadataFileStore({ dataDir, logger });
  locks = createPathLockManager({ dataDir, logger });
  tasks = new TaskService({
    tasks: new TaskRepository({ db, logger }),
    logger,
    leaseSeconds: 60,
    maxAttempts: 3,
  });
  nodes = new NodeRepository({ db, logger });
  const filesystem = new FileSystemService({
    store,
    locks,
    authorizer: new AllowAllAuthorizer(),
    logger,
  });
  // 调度器测试默认 retentionDays=0（物理删除关闭），与生产默认一致；删除路径本身
  // 在 `tests/integration/services/ttl.test.ts` 里单独测。`ttlDays = 30` 让 TTL 用例
  // 有一条非零的滑动窗口，其它用例没有节点行，第一段自然是空操作。
  ttl = new TtlService({
    nodes,
    filesystem,
    principals: ['user:alice', 'user:*'],
    ttlDays: 30,
    retentionDays: 0,
    logger,
  });
  // 数据根的上一层必须存在；调度器从 `user/` 开始扫。
  await store.mkdir(Uri.parse(`${SCOPE}/sessions`), { recursive: true });
});

afterEach(async () => {
  vi.useRealTimers();
  db.close();
  await rm(dataDir, { recursive: true, force: true });
});

describe('自动提交', () => {
  it('超过 token 阈值后提交一次：归档目录出现，live 只剩 keepRecentCount 条', async () => {
    const session = createSession({ pendingTokenThreshold: 100, keepRecentCount: 2 });
    const sessionUri = await session.create(Uri.parse(SCOPE), AUTH_PRINCIPALS);
    for (let index = 0; index < 4; index += 1) {
      // 每条 140 个汉字 ≈ 140 token，超过阈值 100。
      await session.addMessage(sessionUri, message(`m${index}`, '记得用严格模式'.repeat(20)));
    }

    const { scheduler } = createScheduler({ sessions: session });
    const result = await scheduler.tick();

    expect(result).toMatchObject({
      skipped: false,
      scanned: 1,
      committed: 1,
      expired: 0,
      deleted: 0,
      ttlArchived: 0,
    });
    const live = await session.load(sessionUri);
    expect(live.messages.map((item) => item.id)).toEqual(['m2', 'm3']);
    await expect(
      stat(join(archiveDirectory(sessionUri, 'archive_001'), 'messages.jsonl')),
    ).resolves.toBeDefined();
  });

  it('提交后建了归档任务（阶段二执行器靠它）', async () => {
    const session = createSession({ messageCountThreshold: 0 });
    const sessionUri = await session.create(Uri.parse(SCOPE), AUTH_PRINCIPALS);
    await session.addMessage(sessionUri, message('m1'));

    await createScheduler({ sessions: session }).scheduler.tick();

    expect(tasks.claimable()).toHaveLength(1);
  });

  it('minCommitIntervalSeconds 内不再提交：归档不会碎成一堆', async () => {
    const session = createSession({ messageCountThreshold: 0, minCommitIntervalSeconds: 3600 });
    const sessionUri = await session.create(Uri.parse(SCOPE), AUTH_PRINCIPALS);
    await session.addMessage(sessionUri, message('m1'));

    const { scheduler } = createScheduler({ sessions: session });
    await expect(scheduler.tick()).resolves.toMatchObject({ committed: 1 });

    // 刚提交过，阈值仍然满足，但限速器是全局闸门（§10.2.1）。
    await session.addMessage(sessionUri, message('m2'));
    await expect(scheduler.tick()).resolves.toMatchObject({ committed: 0 });

    expect((await store.list(sessionUri.child('history'))).map((entry) => entry.uri.name)).toEqual([
      'archive_001',
    ]);
  });

  it('keepRecentCount 覆盖全部消息时只跳过，不每轮刷 error', async () => {
    // 一条超长消息也会满足 token 阈值，而 `commitPhase1` 对「归档 0 条」抛
    // INVALID_ARGUMENT。按 error 记会每 30 秒写一行，把真正的故障埋掉。
    const session = createSession({ pendingTokenThreshold: 100, keepRecentCount: 10 });
    const sessionUri = await session.create(Uri.parse(SCOPE), AUTH_PRINCIPALS);
    await session.addMessage(sessionUri, message('m1', '记得用严格模式'.repeat(20)));

    const result = await createScheduler({ sessions: session }).scheduler.tick();

    expect(result).toMatchObject({ committed: 0 });
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringContaining('没有可归档的消息'),
      expect.anything(),
    );
  });

  it('已归档的会话不再自动提交', async () => {
    const session = createSession({ messageCountThreshold: 0 });
    const sessionUri = await session.create(Uri.parse(SCOPE), AUTH_PRINCIPALS);
    await session.addMessage(sessionUri, message('m1'));
    await session.archive(sessionUri);

    const result = await createScheduler({ sessions: session }).scheduler.tick();

    expect(result).toMatchObject({ scanned: 1, committed: 0 });
  });
});

describe('会话过期', () => {
  it('archive（默认）：只改 status，消息与归档都还在', async () => {
    const session = createSession();
    const sessionUri = await session.create(Uri.parse(SCOPE), AUTH_PRINCIPALS);
    await session.addMessage(sessionUri, message('m1', '这条消息不该丢'));

    const { scheduler } = createScheduler({
      expiry: { idleTimeoutSeconds: 60, action: 'archive' },
    });
    const result = await scheduler.tick();

    expect(result).toMatchObject({ scanned: 1, expired: 1, deleted: 0 });
    expect((await session.load(sessionUri)).status).toBe('archived');
    expect((await session.load(sessionUri)).messages).toHaveLength(1);
  });

  it('archive 幂等：已归档的会话不重复计数', async () => {
    const session = createSession();
    const sessionUri = await session.create(Uri.parse(SCOPE), AUTH_PRINCIPALS);
    await session.addMessage(sessionUri, message('m1'));

    const { scheduler } = createScheduler({
      expiry: { idleTimeoutSeconds: 60, action: 'archive' },
    });
    await scheduler.tick();

    await expect(scheduler.tick()).resolves.toMatchObject({ expired: 0 });
  });

  it('delete：物理删除会话目录，日志里带「删了什么」', async () => {
    const session = createSession();
    const sessionUri = await session.create(Uri.parse(SCOPE), AUTH_PRINCIPALS);
    await session.addMessage(sessionUri, message('m1'));
    await session.addMessage(sessionUri, message('m2'));

    const { scheduler } = createScheduler({
      expiry: { idleTimeoutSeconds: 60, action: 'delete' },
    });
    const result = await scheduler.tick();

    expect(result).toMatchObject({ expired: 1, deleted: 1 });
    await expect(store.exists(sessionUri)).resolves.toBe(false);
    expect(logger.info).toHaveBeenCalledWith(
      '会话空闲过期，已删除。',
      expect.objectContaining({ messages: 2, archives: 0 }),
    );
  });

  it('delete 跳过有 pending 记忆来源的会话，并记 warn', async () => {
    const session = createSession();
    const sessionUri = await session.create(Uri.parse(SCOPE), AUTH_PRINCIPALS);
    await session.addMessage(sessionUri, message('m1'));
    const archiveUri = sessionUri.child('history', 'archive_001');
    await store.mkdir(archiveUri, { recursive: true });
    const pendingMemory = `${SCOPE}/memories/experiences/code-style.md`;
    await writeMemoryDiff(sessionUri, 'archive_001', [pendingMemory]);

    const { scheduler } = createScheduler({
      expiry: { idleTimeoutSeconds: 60, action: 'delete' },
      memories: { read: async (uri) => memoryRecord(uri.toString(), 'pending') },
    });
    const result = await scheduler.tick();

    expect(result).toMatchObject({ expired: 0, deleted: 0 });
    await expect(store.exists(sessionUri)).resolves.toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('待复核'),
      expect.objectContaining({ pendingMemoryUris: [pendingMemory] }),
    );
  });

  it('delete 只在记忆仍是 pending 时跳过：已复核的记忆不挡删除', async () => {
    const session = createSession();
    const sessionUri = await session.create(Uri.parse(SCOPE), AUTH_PRINCIPALS);
    await session.addMessage(sessionUri, message('m1'));
    await store.mkdir(sessionUri.child('history', 'archive_001'), { recursive: true });
    await writeMemoryDiff(sessionUri, 'archive_001', [
      `${SCOPE}/memories/experiences/code-style.md`,
    ]);

    const { scheduler } = createScheduler({
      expiry: { idleTimeoutSeconds: 60, action: 'delete' },
      memories: { read: async (uri) => memoryRecord(uri.toString(), 'active') },
    });

    await expect(scheduler.tick()).resolves.toMatchObject({ deleted: 1 });
  });

  it('memory_diff.json 读不出来时保守跳过删除（无法证明安全）', async () => {
    const session = createSession();
    const sessionUri = await session.create(Uri.parse(SCOPE), AUTH_PRINCIPALS);
    await session.addMessage(sessionUri, message('m1'));
    await store.mkdir(sessionUri.child('history', 'archive_001'), { recursive: true });
    await writeFile(
      join(archiveDirectory(sessionUri, 'archive_001'), 'memory_diff.json'),
      '{不是 JSON',
      'utf8',
    );

    const { scheduler } = createScheduler({
      expiry: { idleTimeoutSeconds: 60, action: 'delete' },
    });
    const result = await scheduler.tick();

    expect(result).toMatchObject({ expired: 0, deleted: 0 });
    await expect(store.exists(sessionUri)).resolves.toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('清单读不出来'),
      expect.anything(),
    );
  });

  it('idleTimeoutSeconds = 0（默认）时永不过期', async () => {
    const session = createSession();
    const sessionUri = await session.create(Uri.parse(SCOPE), AUTH_PRINCIPALS);
    await session.addMessage(sessionUri, message('m1'));

    const result = await createScheduler().scheduler.tick();

    expect(result).toMatchObject({ scanned: 1, expired: 0 });
    expect((await session.load(sessionUri)).status).toBe('open');
  });

  it('从没写过消息、也没提交过的会话没有「空闲」参照点，不过期', async () => {
    const session = createSession();
    const sessionUri = await session.create(Uri.parse(SCOPE), AUTH_PRINCIPALS);

    const result = await createScheduler({
      expiry: { idleTimeoutSeconds: 1, action: 'archive' },
    }).scheduler.tick();

    expect(result).toMatchObject({ scanned: 1, expired: 0 });
    expect((await session.load(sessionUri)).status).toBe('open');
  });
});

describe('TTL 清扫', () => {
  it('每轮清扫的条数进摘要，节点被软过期', async () => {
    const memory = `${SCOPE}/memories/preferences/code-style.md`;
    nodes.upsert([
      {
        uri: memory,
        parentUri: `${SCOPE}/memories/preferences`,
        scope: 'user',
        kind: 'document',
        contextType: 'memory',
        memoryType: 'preferences',
        level: 'L2',
        abstract: null,
        bodyDigest: 'digest',
        size: 10,
        // 31 天前写入、之后再没被访问：超出 `ttlDays = 30` 的滑动窗口。
        updatedAt: daysAgo(31),
        status: 'active',
      },
    ]);

    const result = await createScheduler().scheduler.tick();

    expect(result).toMatchObject({ ttlArchived: 1 });
    expect(nodes.get(memory)?.status).toBe('archived');
  });

  it('清扫失败只记日志，不影响这一轮的其它动作', async () => {
    const session = createSession({ messageCountThreshold: 0 });
    const sessionUri = await session.create(Uri.parse(SCOPE), AUTH_PRINCIPALS);
    await session.addMessage(sessionUri, message('m1'));

    const { scheduler } = createScheduler({
      sessions: session,
      ttl: {
        sweep: async () => {
          throw new Error('数据库被锁');
        },
      },
    });
    const result = await scheduler.tick();

    expect(result).toMatchObject({ committed: 1, ttlArchived: 0 });
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('TTL 清扫失败'),
      expect.objectContaining({ error: '数据库被锁' }),
    );
  });
});

describe('健壮性与关闭', () => {
  it('一个会话的元数据坏掉不影响其它会话', async () => {
    const session = createSession({ messageCountThreshold: 0 });
    const good = await session.create(Uri.parse(SCOPE), AUTH_PRINCIPALS, { sessionId: 'sess_good' });
    await session.addMessage(good, message('m1'));
    const bad = await session.create(Uri.parse(SCOPE), AUTH_PRINCIPALS, { sessionId: 'sess_bad' });
    await writeFile(join(sessionDirectory(bad), '.meta.json'), '{不是 JSON', 'utf8');

    const { scheduler } = createScheduler({ sessions: session });
    const result = await scheduler.tick();

    expect(result).toMatchObject({ scanned: 2, committed: 1 });
    expect(logger.error).toHaveBeenCalledWith(
      '会话调度失败，已跳过。',
      expect.objectContaining({ uri: bad.toString() }),
    );
  });

  it('建了一半的会话（有目录、没有 .meta.json）被跳过，不记错误', async () => {
    const session = createSession();
    await session.create(Uri.parse(SCOPE), AUTH_PRINCIPALS, { sessionId: 'sess_half' });
    await rm(join(sessionDirectory(Uri.parse(`${SCOPE}/sessions/sess_half`)), '.meta.json'));

    const result = await createScheduler().scheduler.tick();

    expect(result).toMatchObject({ scanned: 1, committed: 0, expired: 0 });
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('上一轮没跑完时这一轮直接跳过，不排队、不重叠', async () => {
    const gate = deferred();
    const started = deferred();
    const sessions: SessionAutoCommitPort = {
      load: async (): Promise<Session> => {
        started.resolve();
        await gate.promise;
        return { id: 'sess_1', uri: Uri.parse(`${SCOPE}/sessions/sess_1`), status: 'open', messages: [], messageCount: 0, pendingTokens: 0, lastCommitAt: null };
      },
      shouldAutoCommit: () => false,
      commitPhase1: () => {
        throw new Error('不该提交');
      },
      listArchives: async () => [],
      archive: async () => undefined,
      remove: () => {
        throw new Error('不该删除');
      },
    };
    await store.mkdir(Uri.parse(`${SCOPE}/sessions/sess_1`), { recursive: true });
    const { scheduler } = createScheduler({ sessions });

    const first = scheduler.tick();
    await started.promise;

    await expect(scheduler.tick()).resolves.toMatchObject({ skipped: true, scanned: 0 });

    gate.resolve();
    await expect(first).resolves.toMatchObject({ skipped: false, scanned: 1 });
  });

  it('stop() 等在途的一轮跑完再返回', async () => {
    const gate = deferred();
    const started = deferred();
    const sessions: SessionAutoCommitPort = {
      load: async (): Promise<Session> => {
        started.resolve();
        await gate.promise;
        return { id: 'sess_1', uri: Uri.parse(`${SCOPE}/sessions/sess_1`), status: 'open', messages: [], messageCount: 0, pendingTokens: 0, lastCommitAt: null };
      },
      shouldAutoCommit: () => false,
      commitPhase1: () => {
        throw new Error('不该提交');
      },
      listArchives: async () => [],
      archive: async () => undefined,
      remove: () => {
        throw new Error('不该删除');
      },
    };
    await store.mkdir(Uri.parse(`${SCOPE}/sessions/sess_1`), { recursive: true });
    const { scheduler } = createScheduler({ sessions });

    const ticking = scheduler.tick();
    await started.promise;

    let stopped = false;
    const stopping = scheduler.stop().then(() => {
      stopped = true;
    });
    await new Promise((resolve) => {
      setTimeout(resolve, 5);
    });

    // 在途的一轮**不打断**（见 `Scheduler.stop` 的注释）：stop 必须等它跑完。
    expect(stopped).toBe(false);

    gate.resolve();
    await stopping;
    await ticking;

    expect(stopped).toBe(true);
    expect(scheduler.started).toBe(false);
  });

  it('stop 之后 tick 是空转；start 幂等', async () => {
    const { scheduler } = createScheduler();

    scheduler.start();
    expect(scheduler.started).toBe(true);
    scheduler.start();
    expect(scheduler.started).toBe(true);

    await scheduler.stop();
    expect(scheduler.started).toBe(false);
    await expect(scheduler.tick()).resolves.toMatchObject({ skipped: true });
  });
});

describe('对账重放', () => {
  it('每个调度轮次都重放一次，计数进轮次摘要', async () => {
    const results = [
      { resolved: 2, failed: 1, remaining: 3, corrupt: 0, unsupported: 0 },
      { resolved: 0, failed: 0, remaining: 0, corrupt: 0, unsupported: 0 },
    ];
    const replay = vi.fn(async () => results.shift() ?? {
      resolved: 0,
      failed: 0,
      remaining: 0,
      corrupt: 0,
      unsupported: 0,
    });
    const { scheduler } = createScheduler({ reconcile: { replay } });

    await expect(scheduler.tick()).resolves.toMatchObject({
      reconcileResolved: 2,
      reconcileFailed: 1,
      reconcileRemaining: 3,
    });
    await expect(scheduler.tick()).resolves.toMatchObject({
      reconcileResolved: 0,
      reconcileFailed: 0,
      reconcileRemaining: 0,
    });

    expect(replay).toHaveBeenCalledTimes(2);
  });

  it('重放抛错只记 error，不影响这一轮', async () => {
    const { scheduler } = createScheduler({
      reconcile: {
        replay: async () => {
          throw new Error('日志磁盘坏了');
        },
      },
    });
    await store.mkdir(Uri.parse(`${SCOPE}/sessions/sess_1`), { recursive: true });

    const result = await scheduler.tick();

    expect(result.skipped).toBe(false);
    expect(result.reconcileResolved).toBe(0);
    expect(logger.error).toHaveBeenCalledWith(
      '对账重放失败，下一轮重试。',
      expect.objectContaining({ error: '日志磁盘坏了' }),
    );
  });
});
