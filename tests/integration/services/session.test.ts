import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AclFileStore } from '../../../src/adapters/fs/acl-file.js';
import { ContentStore } from '../../../src/adapters/fs/content-store.js';
import { createPathLockManager, type PathLockManager } from '../../../src/adapters/fs/lock.js';
import { MetadataFileStore } from '../../../src/adapters/fs/metadata-file.js';
import { openDatabase, runMigrations } from '../../../src/adapters/sqlite/database.js';
import { NodeRepository } from '../../../src/adapters/sqlite/node-repository.js';
import { PermissionRepository } from '../../../src/adapters/sqlite/permission-repository.js';
import { TaskRepository } from '../../../src/adapters/sqlite/task-repository.js';
import { InheritingAuthorizer } from '../../../src/bootstrap/container.js';
import { ComemError } from '../../../src/domain/errors.js';
import type { Logger } from '../../../src/domain/log.js';
import type { AutoCommitPolicy, SessionMessage } from '../../../src/domain/session.js';
import { estimateTokens, renderMessageText } from '../../../src/domain/session.js';
import { Uri } from '../../../src/domain/uri.js';
import { AclService } from '../../../src/services/acl.js';
import { FileSystemService } from '../../../src/services/filesystem.js';
import { SessionService, stableMessageId } from '../../../src/services/session.js';
import { TaskService } from '../../../src/services/task.js';

const AUTH_PRINCIPALS: readonly string[] = ['user:alice', 'user:*'];

const SCOPE_ROOT = 'comem://user/alice';

/** 架构文档 §10.2.1 的默认策略；各用例只覆盖需要变化的字段。 */
const DEFAULT_POLICY: AutoCommitPolicy = {
  enabled: true,
  pendingTokenThreshold: 150000,
  messageCountThreshold: 100,
  minCommitIntervalSeconds: 0,
  idleTimeoutSeconds: 0,
  keepRecentCount: 0,
};

let dataDir: string;
let db: DatabaseSync;
let logger: Logger;
let store: ContentStore;
let locks: PathLockManager;
let tasks: TaskService;
let service: SessionService;
let authorizer: InheritingAuthorizer;
let filesystem: FileSystemService;

function createLogger(): Logger {
  const mock: Logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return mock;
}

function createService(policy: Partial<AutoCommitPolicy> = {}): SessionService {
  // `MetadataFileStore` 由 bootstrap 构造后注入（§4.2：services/ 不 new 适配器）。
  const meta = new MetadataFileStore({ dataDir, logger });
  return new SessionService({
    store,
    metadata: meta,
    locks,
    tasks,
    logger,
    meta,
    config: { autoCommit: { ...DEFAULT_POLICY, ...policy } },
    authorizer,
  });
}

function message(
  id: string,
  text = '消息正文',
  overrides: Partial<Omit<SessionMessage, 'turn'>> = {},
): Omit<SessionMessage, 'turn'> {
  return {
    id,
    role: 'user',
    parts: [{ kind: 'text', text }],
    createdAt: '2026-11-08T00:00:00.000Z',
    ...overrides,
  };
}

function sessionDirectory(sessionUri: Uri): string {
  return join(dataDir, 'user', 'alice', 'sessions', sessionUri.name);
}

function archiveDirectory(sessionUri: Uri, archiveId: string): string {
  return join(sessionDirectory(sessionUri), 'history', archiveId);
}

function archiveMessagesUri(sessionUri: Uri, archiveId: string): Uri {
  return sessionUri.child('history', archiveId, 'messages.jsonl');
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'comem-session-'));
  db = openDatabase(':memory:');
  runMigrations(db);
  logger = createLogger();
  store = new ContentStore({ dataDir, logger });
  locks = createPathLockManager({ dataDir, logger });
  tasks = new TaskService({
    tasks: new TaskRepository({ db, logger }),
    logger,
    leaseSeconds: 60,
    maxAttempts: 3,
    heartbeatSeconds: 20,
  });

  // 与生产装配同一份：写路径在物化表缺行时先物化再求权（`InheritingAuthorizer`）。
  const acl = new AclService({
    db,
    aclFile: new AclFileStore({ dataDir, logger }),
    permissions: new PermissionRepository({ db, logger }),
    nodes: new NodeRepository({ db, logger }),
    logger,
    locks,
  });
  await acl.ensureRootPreset(Uri.parse(SCOPE_ROOT));
  authorizer = new InheritingAuthorizer(acl, store);
  filesystem = new FileSystemService({ store, locks, authorizer, logger });

  service = createService();
});

afterEach(async () => {
  vi.restoreAllMocks();
  db.close();
  await rm(dataDir, { recursive: true, force: true });
});

describe('create / load', () => {
  it('建完之后 list(sessions) 能看到会话目录，且它有自己的物化权限行', async () => {
    const sessionUri = await service.create(Uri.parse(SCOPE_ROOT), AUTH_PRINCIPALS);

    // 会话服务直接写 `ContentStore`，观察者收不到通知。物化权限漏掉时
    // `GET /sessions` 的 `list(sessions/)` 会因为缺 `node_permission` 行返回空——
    // 会话建成功了，列表里却没有。
    const listed = await filesystem.list(Uri.parse(`${SCOPE_ROOT}/sessions`), AUTH_PRINCIPALS);
    expect(listed.map((entry) => entry.uri.toString())).toContain(sessionUri.toString());

    const rows = db
      .prepare('SELECT principal, level, effect FROM node_permission WHERE node_uri = ?')
      .all(sessionUri.toString());
    expect(rows.length).toBeGreaterThan(0);
  });

  it('建目录、空 messages.jsonl 与 .meta.json', async () => {
    const sessionUri = await service.create(Uri.parse(SCOPE_ROOT), AUTH_PRINCIPALS);

    expect(sessionUri.toString()).toMatch(
      /^comem:\/\/user\/alice\/sessions\/sess_[0-9a-f]{8}$/,
    );
    const directory = sessionDirectory(sessionUri);
    expect((await readdir(directory)).sort()).toEqual(['.meta.json', 'messages.jsonl']);
    expect(await readFile(join(directory, 'messages.jsonl'), 'utf8')).toBe('');

    const meta: unknown = JSON.parse(await readFile(join(directory, '.meta.json'), 'utf8'));
    expect(meta).toMatchObject({
      sessionId: sessionUri.name,
      userId: 'alice',
      status: 'open',
      commitCount: 0,
      lastCommitAt: null,
      pendingTokens: 0,
    });

    expect(await service.load(sessionUri)).toMatchObject({
      id: sessionUri.name,
      status: 'open',
      messages: [],
      messageCount: 0,
      pendingTokens: 0,
      lastCommitAt: null,
    });
  });

  it('可以指定 sessionId（幂等重放时复用同一个会话）', async () => {
    const sessionUri = await service.create(Uri.parse(SCOPE_ROOT), AUTH_PRINCIPALS, { sessionId: 'sess_manual' });

    expect(sessionUri.toString()).toBe(`${SCOPE_ROOT}/sessions/sess_manual`);
  });

  it('已存在的 sessionId 再 create 抛 ALREADY_EXISTS，消息原样保留', async () => {
    const sessionUri = await service.create(Uri.parse(SCOPE_ROOT), AUTH_PRINCIPALS, {
      sessionId: 'sess_existing',
    });
    await service.addMessage(sessionUri, message('m1', '第一句'));
    await service.addMessage(sessionUri, message('m2', '第二句'));

    // `create` 只创建、不重置：Hook 的 `PostToolUse` / `Stop` 在同一轮里各建一次，
    // 第二次拿到 200 就说明第一次采集到的消息被覆写成空文件了。
    await expect(
      service.create(Uri.parse(SCOPE_ROOT), AUTH_PRINCIPALS, { sessionId: 'sess_existing' }),
    ).rejects.toMatchObject({ code: 'ALREADY_EXISTS' });

    const live = await service.load(sessionUri);
    expect(live.messageCount).toBe(2);
    expect(live.messages.map((item) => item.id)).toEqual(['m1', 'm2']);
  });

  it('ensure 复用已存在的会话，不清空消息', async () => {
    const sessionUri = await service.create(Uri.parse(SCOPE_ROOT), AUTH_PRINCIPALS, {
      sessionId: 'sess_ensure',
    });
    await service.addMessage(sessionUri, message('m1'));

    expect(
      (await service.ensure(Uri.parse(SCOPE_ROOT), 'sess_ensure', AUTH_PRINCIPALS)).toString(),
    ).toBe(sessionUri.toString());
    expect((await service.load(sessionUri)).messageCount).toBe(1);
  });

  it('两个并发 ensure 同一个 sessionId 都成功，只建一个会话', async () => {
    // 两个 `remember` 同时上传同一个新 sessionId：两边都可能先看到 NOT_FOUND，
    // 随后都去 create。后一个 create 在 TREE 锁内看到元数据抛 ALREADY_EXISTS，
    // ensure 必须把它转成「复用」，而不是把 409 抛给调用方。
    const [first, second] = await Promise.all([
      service.ensure(Uri.parse(SCOPE_ROOT), 'sess_ensure_race', AUTH_PRINCIPALS),
      service.ensure(Uri.parse(SCOPE_ROOT), 'sess_ensure_race', AUTH_PRINCIPALS),
    ]);

    expect(second.toString()).toBe(first.toString());
    expect(await readdir(join(dataDir, 'user', 'alice', 'sessions'))).toEqual([
      'sess_ensure_race',
    ]);

    // 两个调用拿到的是同一个会话：后续写入只有一份。
    await service.addMessage(first, message('m1'));
    expect((await service.load(second)).messageCount).toBe(1);
  });

  it('不存在的会话抛 NOT_FOUND', async () => {
    await expect(service.load(Uri.parse(`${SCOPE_ROOT}/sessions/sess_missing`))).rejects.toMatchObject(
      { code: 'NOT_FOUND' },
    );
  });
});

describe('addMessage', () => {
  it('追加 JSONL 并累加 turn 与 pendingTokens', async () => {
    const sessionUri = await service.create(Uri.parse(SCOPE_ROOT), AUTH_PRINCIPALS);

    const first = await service.addMessage(sessionUri, message('m1', '第一句'));
    const second = await service.addMessage(sessionUri, message('m2', '第二句'));

    expect(first.turn).toBe(1);
    expect(second.turn).toBe(2);

    const raw = await readFile(join(sessionDirectory(sessionUri), 'messages.jsonl'), 'utf8');
    expect(raw.endsWith('\n')).toBe(true);
    const lines = raw.trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] ?? '')).toMatchObject({ id: 'm1', turn: 1 });
    expect(JSON.parse(lines[1] ?? '')).toMatchObject({ id: 'm2', turn: 2 });

    const loaded = await service.load(sessionUri);
    expect(loaded.messages.map((item) => item.id)).toEqual(['m1', 'm2']);
    expect(loaded.pendingTokens).toBe(
      estimateTokens(renderMessageText(first)) + estimateTokens(renderMessageText(second)),
    );
  });
});

/**
 * 采集侧的游标只在消息落盘之后前进：进程被杀、请求超时、跨进程锁过期时，同一批
 * 消息会被重投。重投是正常恢复路径，服务端必须按消息 ID 幂等。
 */
describe('addMessage 幂等', () => {
  const timestamp = '2026-11-08T00:00:00.000Z';

  function replayedBatch(): readonly Omit<SessionMessage, 'turn'>[] {
    return [
      {
        id: stableMessageId('user', '第一句', timestamp),
        role: 'user',
        parts: [{ kind: 'text', text: '第一句' }],
        createdAt: timestamp,
      },
      {
        id: stableMessageId('assistant', '第二句', timestamp),
        role: 'assistant',
        parts: [{ kind: 'text', text: '第二句' }],
        createdAt: timestamp,
      },
    ];
  }

  it('同一批消息提交两次只落一份，turn 不变，两次都成功', async () => {
    const sessionUri = await service.create(Uri.parse(SCOPE_ROOT), AUTH_PRINCIPALS);
    const batch = replayedBatch();

    const firstPass: SessionMessage[] = [];
    for (const item of batch) {
      firstPass.push(await service.addMessage(sessionUri, item));
    }
    expect(firstPass.map((item) => item.turn)).toEqual([1, 2]);

    const messagesPath = join(sessionDirectory(sessionUri), 'messages.jsonl');
    const metaPath = join(sessionDirectory(sessionUri), '.meta.json');
    const rawBefore = await readFile(messagesPath, 'utf8');
    const metaBefore = await readFile(metaPath, 'utf8');

    // 重复提交不写正文、不写元数据：一次磁盘写都不该发生。
    const writeText = vi.spyOn(store, 'writeText');
    const secondPass: SessionMessage[] = [];
    for (const item of batch) {
      secondPass.push(await service.addMessage(sessionUri, item));
    }
    expect(writeText).not.toHaveBeenCalled();
    writeText.mockRestore();

    expect(secondPass).toEqual(firstPass);
    expect(await readFile(messagesPath, 'utf8')).toBe(rawBefore);
    expect(await readFile(metaPath, 'utf8')).toBe(metaBefore);

    const lines = (await readFile(messagesPath, 'utf8')).trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] ?? '')).toMatchObject({ turn: 1 });
    expect(JSON.parse(lines[1] ?? '')).toMatchObject({ turn: 2 });

    const loaded = await service.load(sessionUri);
    expect(loaded.messageCount).toBe(2);
    expect(loaded.messages.map((item) => item.id)).toEqual(batch.map((item) => item.id));

    // 去重不能把轮次时钟推快：下一条新消息仍然是第 3 轮。
    expect((await service.addMessage(sessionUri, message('m3', '第三句'))).turn).toBe(3);
  });

  it('不同会话里的相同消息 ID 互不影响（去重范围是会话内）', async () => {
    const firstSession = await service.create(Uri.parse(SCOPE_ROOT), AUTH_PRINCIPALS);
    const secondSession = await service.create(Uri.parse(SCOPE_ROOT), AUTH_PRINCIPALS);
    const sameMessage = message('shared-id', '同一句话');

    expect((await service.addMessage(firstSession, sameMessage)).turn).toBe(1);
    expect((await service.addMessage(secondSession, sameMessage)).turn).toBe(1);

    expect((await service.load(firstSession)).messageCount).toBe(1);
    expect((await service.load(secondSession)).messageCount).toBe(1);
  });

  it('已归档的消息重投也只留一份，且进程重启后同样成立', async () => {
    const sessionUri = await service.create(Uri.parse(SCOPE_ROOT), AUTH_PRINCIPALS);
    const [original] = replayedBatch();
    if (original === undefined) {
      throw new Error('测试批次不能为空');
    }
    const first = await service.addMessage(sessionUri, original);
    const commit = await service.commitPhase1(sessionUri);
    expect((await service.load(sessionUri)).messages).toEqual([]);

    // 换一个服务实例：模拟进程重启，归档索引是冷的，必须从磁盘重建。
    const restarted = createService();
    const replay = await restarted.addMessage(sessionUri, original);

    expect(replay).toEqual(first);
    expect(replay.turn).toBe(1);
    expect((await restarted.load(sessionUri)).messageCount).toBe(0);
    expect(await restarted.listArchives(sessionUri)).toHaveLength(1);
    expect(
      (await restarted.readArchiveMeta(commit.archiveUri))?.phase1.archivedMessageIds,
    ).toEqual([original.id]);
  });

  it('消息 ID 为空串时拒绝，而不是把所有无身份消息合并成一条', async () => {
    const sessionUri = await service.create(Uri.parse(SCOPE_ROOT), AUTH_PRINCIPALS);

    await expect(service.addMessage(sessionUri, message(''))).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
    expect((await service.load(sessionUri)).messages).toEqual([]);
  });
});

describe('addMessage 会话状态', () => {
  it('往已归档会话追加消息会把状态改回 open', async () => {
    const sessionUri = await service.create(Uri.parse(SCOPE_ROOT), AUTH_PRINCIPALS);
    await service.addMessage(sessionUri, message('m1'));
    await service.archive(sessionUri);
    expect((await service.load(sessionUri)).status).toBe('archived');

    // 复用已归档会话：消息进来了就是活跃会话。状态不清回 open 时，调度器对
    // `status === 'archived'` 的会话直接跳过（`bootstrap/scheduler.ts` 的自动提交
    // 入口），只依赖自动提交的客户端会把这条消息永远留在 live。
    const appended = await service.addMessage(sessionUri, message('m2'));
    const reopened = await service.load(sessionUri);
    expect(reopened.status).toBe('open');
    expect(reopened.messages.map((item) => item.id)).toEqual(['m1', appended.id]);
  });

  it('重复消息不重置已归档会话的状态（没有新内容进来）', async () => {
    const sessionUri = await service.create(Uri.parse(SCOPE_ROOT), AUTH_PRINCIPALS);
    const first = await service.addMessage(sessionUri, message('m1'));
    await service.commitPhase1(sessionUri);
    await service.archive(sessionUri);

    // 重投一条已经归档的消息：返回原消息，但会话保持 archived。
    expect(await service.addMessage(sessionUri, message(first.id))).toEqual(first);
    expect((await service.load(sessionUri)).status).toBe('archived');
  });
});

/**
 * 召回账本的时钟（架构文档 §8.7）要的是「累计消息数」，不是 live 条数。提交之后
 * live 会被清空；拿 live 条数当时钟会让 turn 归零，跨轮去重要么把旧条目当成
 * 「未来轮次」重新投放，要么把窗口退化成整个账本。
 */
describe('totalMessageCount（账本时钟）', () => {
  it('等于 live 消息数；重复提交不增加', async () => {
    const sessionUri = await service.create(Uri.parse(SCOPE_ROOT), AUTH_PRINCIPALS);
    expect(await service.totalMessageCount(sessionUri)).toBe(0);

    await service.addMessage(sessionUri, message('m1'));
    await service.addMessage(sessionUri, message('m2'));
    expect(await service.totalMessageCount(sessionUri)).toBe(2);

    // 幂等重复：没有新消息进 live，累计数也不动。
    await service.addMessage(sessionUri, message('m1'));
    expect(await service.totalMessageCount(sessionUri)).toBe(2);
  });

  it('提交归档之后不下降：keepRecentCount 保留一条时 live=1、总数仍是 3', async () => {
    const keeper = createService({ keepRecentCount: 1 });
    const sessionUri = await keeper.create(Uri.parse(SCOPE_ROOT), AUTH_PRINCIPALS);
    await keeper.addMessage(sessionUri, message('m1'));
    await keeper.addMessage(sessionUri, message('m2'));
    await keeper.addMessage(sessionUri, message('m3'));
    expect(await keeper.totalMessageCount(sessionUri)).toBe(3);

    await keeper.commitPhase1(sessionUri);
    // 核心：live 只剩 1 条，时钟不能掉回 1。
    expect((await keeper.load(sessionUri)).messageCount).toBe(1);
    expect(await keeper.totalMessageCount(sessionUri)).toBe(3);

    // 已归档消息重投也不增加累计数。
    await keeper.addMessage(sessionUri, message('m2'));
    expect(await keeper.totalMessageCount(sessionUri)).toBe(3);
  });

  it('keepRecentCount: 0 全归档后仍是 3；换新实例懒加载后仍是 3', async () => {
    const sessionUri = await service.create(Uri.parse(SCOPE_ROOT), AUTH_PRINCIPALS);
    await service.addMessage(sessionUri, message('m1'));
    await service.addMessage(sessionUri, message('m2'));
    await service.addMessage(sessionUri, message('m3'));
    await service.commitPhase1(sessionUri);
    expect((await service.load(sessionUri)).messageCount).toBe(0);
    expect(await service.totalMessageCount(sessionUri)).toBe(3);

    // 模拟进程重启：归档索引是冷的，必须从归档元数据重建。
    const restarted = createService();
    expect(await restarted.totalMessageCount(sessionUri)).toBe(3);
  });
});

describe('commitPhase1', () => {
  it('六步落盘：messages.jsonl 在 .meta.json 之前写，phase1 从 preparing 到 ready，不写 .done', async () => {
    const sessionUri = await service.create(Uri.parse(SCOPE_ROOT), AUTH_PRINCIPALS);
    await service.addMessage(sessionUri, message('m1', '记得用严格模式'));
    await service.addMessage(sessionUri, message('m2', '好的'));

    const writeText = vi.spyOn(ContentStore.prototype, 'writeText');
    const writeArchive = vi.spyOn(MetadataFileStore.prototype, 'writeArchive');

    const result = await service.commitPhase1(sessionUri);

    expect(result.archiveUri.toString()).toBe(`${sessionUri.toString()}/history/archive_001`);
    expect(result.archivedCount).toBe(2);
    expect(result.taskId).not.toBe('');

    // 步骤 2 的归档消息写在步骤 3 的 .meta.json 之前，步骤 4 的 live 重写在之后。
    const archiveMessagesWrite = writeText.mock.invocationCallOrder[0] ?? 0;
    const preparingWrite = writeArchive.mock.invocationCallOrder[0] ?? 0;
    const liveWrite = writeText.mock.invocationCallOrder[1] ?? 0;
    expect(archiveMessagesWrite).toBeLessThan(preparingWrite);
    expect(preparingWrite).toBeLessThan(liveWrite);

    // 步骤 3 → 步骤 5 → 步骤 6（回填 taskId）。
    expect(writeArchive.mock.calls.map((call) => call[1].phase1.status)).toEqual([
      'preparing',
      'ready',
      'ready',
    ]);

    // `.done` 是阶段二的最后一步，阶段一不写。
    expect(await readdir(archiveDirectory(sessionUri, 'archive_001'))).not.toContain('.done');

    const meta = await service.readArchiveMeta(result.archiveUri);
    expect(meta).toMatchObject({
      archiveId: 'archive_001',
      taskId: result.taskId,
      stepsDone: [],
      phase1: {
        status: 'ready',
        archivedMessageIds: ['m1', 'm2'],
        retainedMessageIds: [],
      },
    });

    // live 被重写为空，任务的是 archive 类型且 payload 指向这次归档。
    expect((await service.load(sessionUri)).messages).toEqual([]);
    expect(tasks.claimable()).toHaveLength(1);
    expect(tasks.claimable()[0]?.payload).toEqual({
      sessionUri: sessionUri.toString(),
      archiveUri: result.archiveUri.toString(),
      archiveId: 'archive_001',
    });
  });

  it('归档文件是 JSONL：一行一条消息，不是 JSON 数组', async () => {
    const sessionUri = await service.create(Uri.parse(SCOPE_ROOT), AUTH_PRINCIPALS);
    await service.addMessage(sessionUri, message('m1'));
    await service.addMessage(sessionUri, message('m2'));

    await service.commitPhase1(sessionUri);

    const raw = await readFile(
      join(archiveDirectory(sessionUri, 'archive_001'), 'messages.jsonl'),
      'utf8',
    );
    expect(raw.trimStart().startsWith('{')).toBe(true);
    expect(raw.endsWith('\n')).toBe(true);
    expect(raw.trimEnd().split('\n')).toHaveLength(2);
  });

  it('sha256 记录归档消息的摘要；篡改后摘要对不上', async () => {
    const sessionUri = await service.create(Uri.parse(SCOPE_ROOT), AUTH_PRINCIPALS);
    await service.addMessage(sessionUri, message('m1'));

    const result = await service.commitPhase1(sessionUri);
    const meta = await service.readArchiveMeta(result.archiveUri);
    const archiveUri = archiveMessagesUri(sessionUri, 'archive_001');

    expect(meta?.phase1.messagesSha256).toBe(sha256(await store.readBytes(archiveUri)));

    await store.writeText(archiveUri, '{"id":"tampered"}\n');
    expect(sha256(await store.readBytes(archiveUri))).not.toBe(meta?.phase1.messagesSha256);
  });

  it('归档序号单调递增，删除中间的归档后不复用被删编号', async () => {
    const sessionUri = await service.create(Uri.parse(SCOPE_ROOT), AUTH_PRINCIPALS);
    const archiveIds: string[] = [];
    for (let index = 1; index <= 3; index += 1) {
      await service.addMessage(sessionUri, message(`m${index}`));
      archiveIds.push((await service.commitPhase1(sessionUri)).archiveUri.name);
    }
    expect(archiveIds).toEqual(['archive_001', 'archive_002', 'archive_003']);

    await store.remove(sessionUri.child('history', 'archive_002'), { recursive: true });
    await service.addMessage(sessionUri, message('m4'));

    expect((await service.commitPhase1(sessionUri)).archiveUri.name).toBe('archive_004');
  });

  it('删掉最新的归档后也不复用它的编号', async () => {
    // 这条是「从 history/ 最大序号 + 1」的回归：那种实现删掉最新的归档之后，
    // 下一个归档会重新拿到同一个编号，两条不同的归档指向同一个名字。
    const sessionUri = await service.create(Uri.parse(SCOPE_ROOT), AUTH_PRINCIPALS);
    for (let index = 1; index <= 2; index += 1) {
      await service.addMessage(sessionUri, message(`m${index}`));
      await service.commitPhase1(sessionUri);
    }

    await store.remove(sessionUri.child('history', 'archive_002'), { recursive: true });
    await service.addMessage(sessionUri, message('m3'));

    expect((await service.commitPhase1(sessionUri)).archiveUri.name).toBe('archive_003');
  });

  it('keepRecentCount = 2 时 5 条消息归档 3 条、live 留 2 条', async () => {
    service = createService({ keepRecentCount: 2 });
    const sessionUri = await service.create(Uri.parse(SCOPE_ROOT), AUTH_PRINCIPALS);
    for (let index = 1; index <= 5; index += 1) {
      await service.addMessage(sessionUri, message(`m${index}`, `第 ${index} 条`));
    }

    const result = await service.commitPhase1(sessionUri);

    expect(result.archivedCount).toBe(3);
    expect((await service.readArchiveMeta(result.archiveUri))?.phase1).toMatchObject({
      archivedMessageIds: ['m1', 'm2', 'm3'],
      retainedMessageIds: ['m4', 'm5'],
    });
    const live = await service.load(sessionUri);
    expect(live.messages.map((item) => item.id)).toEqual(['m4', 'm5']);
    // 轮次时钟不因归档回退（§8.7）。
    expect(live.messages.map((item) => item.turn)).toEqual([4, 5]);
  });

  it('空会话提交被拒绝（INVALID_ARGUMENT）', async () => {
    const sessionUri = await service.create(Uri.parse(SCOPE_ROOT), AUTH_PRINCIPALS);

    await expect(service.commitPhase1(sessionUri)).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
    expect(await store.exists(sessionUri.child('history'))).toBe(false);
  });

  it('keepRecentCount 覆盖全部消息时也拒绝（归档 0 条没有意义）', async () => {
    service = createService({ keepRecentCount: 10 });
    const sessionUri = await service.create(Uri.parse(SCOPE_ROOT), AUTH_PRINCIPALS);
    await service.addMessage(sessionUri, message('m1'));

    await expect(service.commitPhase1(sessionUri)).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
  });
});

describe('重放', () => {
  it('preparing 的归档不被当成完整：重放时补完同一个归档', async () => {
    const sessionUri = await service.create(Uri.parse(SCOPE_ROOT), AUTH_PRINCIPALS);
    await service.addMessage(sessionUri, message('m1', '第一句'));
    await service.addMessage(sessionUri, message('m2', '第二句'));

    // 让步骤 4（重写 live 消息）抛错，模拟「步骤 3 之后、步骤 4 之前崩溃」。
    const originalWriteText = ContentStore.prototype.writeText;
    const writeText = vi.spyOn(ContentStore.prototype, 'writeText');
    writeText.mockImplementation(async (uri, text, options) => {
      if (uri.equals(sessionUri.child('messages.jsonl'))) {
        throw new Error('模拟步骤 4 崩溃');
      }
      return originalWriteText.call(store, uri, text, options);
    });

    await expect(service.commitPhase1(sessionUri)).rejects.toThrow('模拟步骤 4 崩溃');
    writeText.mockRestore();

    const interrupted = await service.readArchiveMeta(sessionUri.child('history', 'archive_001'));
    expect(interrupted?.phase1.status).toBe('preparing');
    expect(interrupted?.taskId).toBeNull();
    // 归档消息完整，live 还没被重写，也没有建任务。
    expect(await store.exists(archiveMessagesUri(sessionUri, 'archive_001'))).toBe(true);
    expect((await service.load(sessionUri)).messages).toHaveLength(2);
    expect(tasks.claimable()).toHaveLength(0);

    const result = await service.commitPhase1(sessionUri);

    expect(result.archiveUri.name).toBe('archive_001');
    expect(result.archivedCount).toBe(2);
    const ready = await service.readArchiveMeta(result.archiveUri);
    expect(ready?.phase1.status).toBe('ready');
    expect(ready?.phase1.retainedMessageIds).toEqual([]);
    expect(ready?.taskId).toBe(result.taskId);
    expect((await service.load(sessionUri)).messages).toEqual([]);
    expect((await store.list(sessionUri.child('history'))).map((entry) => entry.uri.name)).toEqual([
      'archive_001',
    ]);
  });

  it('崩溃在步骤 1 与 2 之间（只有空目录）时删掉重来', async () => {
    const sessionUri = await service.create(Uri.parse(SCOPE_ROOT), AUTH_PRINCIPALS);
    await store.mkdir(sessionUri.child('history', 'archive_001'), { recursive: true });
    await service.addMessage(sessionUri, message('m1'));

    const result = await service.commitPhase1(sessionUri);

    expect(result.archiveUri.name).toBe('archive_001');
    expect((await service.readArchiveMeta(result.archiveUri))?.phase1.status).toBe('ready');
    expect((await store.list(sessionUri.child('history'))).map((entry) => entry.uri.name)).toEqual([
      'archive_001',
    ]);
  });
});

describe('readArchiveMeta', () => {
  it('不存在的归档返回 null', async () => {
    expect(
      await service.readArchiveMeta(Uri.parse(`${SCOPE_ROOT}/sessions/sess_x/history/archive_999`)),
    ).toBeNull();
  });


});

describe('并发', () => {
  it('addMessage 与 commitPhase1 并发执行不丢消息', async () => {
    const sessionUri = await service.create(Uri.parse(SCOPE_ROOT), AUTH_PRINCIPALS);

    const operations: Promise<unknown>[] = [];
    for (let index = 0; index < 20; index += 1) {
      operations.push(service.addMessage(sessionUri, message(`m${index}`, `消息 ${index}`)));
    }
    for (let index = 0; index < 3; index += 1) {
      operations.push(
        service.commitPhase1(sessionUri).catch((error: unknown) => {
          if (error instanceof ComemError && error.code === 'INVALID_ARGUMENT') {
            return null;
          }
          throw error;
        }),
      );
    }
    await Promise.all(operations);

    const live = await service.load(sessionUri);
    const archivedIds: string[] = [];
    for (const entry of await store.list(sessionUri.child('history'))) {
      const meta = await service.readArchiveMeta(entry.uri);
      expect(meta?.phase1.status).toBe('ready');
      archivedIds.push(...(meta?.phase1.archivedMessageIds ?? []));
    }

    // 没有消息被归档两次，也没有一条消息同时留在 live 和归档里。
    expect(new Set(archivedIds).size).toBe(archivedIds.length);
    const allIds = new Set([...live.messages.map((item) => item.id), ...archivedIds]);
    expect(allIds.size).toBe(20);
    expect(live.messages.length + archivedIds.length).toBe(20);
  });
});

describe('shouldAutoCommit', () => {
  it('消息数超过阈值时触发', async () => {
    service = createService({ messageCountThreshold: 0 });
    const sessionUri = await service.create(Uri.parse(SCOPE_ROOT), AUTH_PRINCIPALS);
    await service.addMessage(sessionUri, message('m1'));

    expect(service.shouldAutoCommit(await service.load(sessionUri), new Date())).toBe(true);
  });

  it('enabled = false 时永不触发', async () => {
    const disabled = createService({ enabled: false, messageCountThreshold: 0 });
    const sessionUri = await service.create(Uri.parse(SCOPE_ROOT), AUTH_PRINCIPALS);
    await service.addMessage(sessionUri, message('m1'));

    expect(disabled.shouldAutoCommit(await service.load(sessionUri), new Date())).toBe(false);
  });

  it('最小提交间隔内不触发（限速器是全局闸门）', async () => {
    service = createService({ messageCountThreshold: 0, minCommitIntervalSeconds: 100 });
    const sessionUri = await service.create(Uri.parse(SCOPE_ROOT), AUTH_PRINCIPALS);
    await service.addMessage(sessionUri, message('m1'));

    const session = {
      ...(await service.load(sessionUri)),
      lastCommitAt: '2026-11-08T00:00:00.000Z',
    };
    expect(service.shouldAutoCommit(session, new Date('2026-11-08T00:00:10.000Z'))).toBe(false);
    expect(service.shouldAutoCommit(session, new Date('2026-11-08T00:02:00.000Z'))).toBe(true);
  });
});
