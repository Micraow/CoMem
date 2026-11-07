import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ContentStore } from '../../../src/adapters/fs/content-store.js';
import { createPathLockManager, type PathLockManager } from '../../../src/adapters/fs/lock.js';
import { MetadataFileStore } from '../../../src/adapters/fs/metadata-file.js';
import { openDatabase, runMigrations } from '../../../src/adapters/sqlite/database.js';
import { TaskRepository } from '../../../src/adapters/sqlite/task-repository.js';
import { ComemError } from '../../../src/domain/errors.js';
import type { Logger } from '../../../src/domain/log.js';
import type { AutoCommitPolicy, SessionMessage } from '../../../src/domain/session.js';
import { estimateTokens, renderMessageText } from '../../../src/domain/session.js';
import { Uri } from '../../../src/domain/uri.js';
import { SessionService } from '../../../src/services/session.js';
import { TaskService } from '../../../src/services/task.js';

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
  service = createService();
});

afterEach(async () => {
  vi.restoreAllMocks();
  db.close();
  await rm(dataDir, { recursive: true, force: true });
});

describe('create / load', () => {
  it('建目录、空 messages.jsonl 与 .meta.json', async () => {
    const sessionUri = await service.create(Uri.parse(SCOPE_ROOT));

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
    const sessionUri = await service.create(Uri.parse(SCOPE_ROOT), { sessionId: 'sess_manual' });

    expect(sessionUri.toString()).toBe(`${SCOPE_ROOT}/sessions/sess_manual`);
  });

  it('不存在的会话抛 NOT_FOUND', async () => {
    await expect(service.load(Uri.parse(`${SCOPE_ROOT}/sessions/sess_missing`))).rejects.toMatchObject(
      { code: 'NOT_FOUND' },
    );
  });
});

describe('addMessage', () => {
  it('追加 JSONL 并累加 turn 与 pendingTokens', async () => {
    const sessionUri = await service.create(Uri.parse(SCOPE_ROOT));

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

describe('commitPhase1', () => {
  it('六步落盘：messages.jsonl 在 .meta.json 之前写，phase1 从 preparing 到 ready，不写 .done', async () => {
    const sessionUri = await service.create(Uri.parse(SCOPE_ROOT));
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
    const sessionUri = await service.create(Uri.parse(SCOPE_ROOT));
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
    const sessionUri = await service.create(Uri.parse(SCOPE_ROOT));
    await service.addMessage(sessionUri, message('m1'));

    const result = await service.commitPhase1(sessionUri);
    const meta = await service.readArchiveMeta(result.archiveUri);
    const archiveUri = archiveMessagesUri(sessionUri, 'archive_001');

    expect(meta?.phase1.messagesSha256).toBe(sha256(await store.readBytes(archiveUri)));

    await store.writeText(archiveUri, '{"id":"tampered"}\n');
    expect(sha256(await store.readBytes(archiveUri))).not.toBe(meta?.phase1.messagesSha256);
  });

  it('归档序号单调递增，删除中间的归档后不复用被删编号', async () => {
    const sessionUri = await service.create(Uri.parse(SCOPE_ROOT));
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
    const sessionUri = await service.create(Uri.parse(SCOPE_ROOT));
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
    const sessionUri = await service.create(Uri.parse(SCOPE_ROOT));
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
    const sessionUri = await service.create(Uri.parse(SCOPE_ROOT));

    await expect(service.commitPhase1(sessionUri)).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
    expect(await store.exists(sessionUri.child('history'))).toBe(false);
  });

  it('keepRecentCount 覆盖全部消息时也拒绝（归档 0 条没有意义）', async () => {
    service = createService({ keepRecentCount: 10 });
    const sessionUri = await service.create(Uri.parse(SCOPE_ROOT));
    await service.addMessage(sessionUri, message('m1'));

    await expect(service.commitPhase1(sessionUri)).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
  });
});

describe('重放', () => {
  it('preparing 的归档不被当成完整：重放时补完同一个归档', async () => {
    const sessionUri = await service.create(Uri.parse(SCOPE_ROOT));
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
    const sessionUri = await service.create(Uri.parse(SCOPE_ROOT));
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

describe('readArchiveMeta / writeArchiveMeta', () => {
  it('不存在的归档返回 null', async () => {
    expect(
      await service.readArchiveMeta(Uri.parse(`${SCOPE_ROOT}/sessions/sess_x/history/archive_999`)),
    ).toBeNull();
  });

  it('写入后原样读回（阶段二用）', async () => {
    const archiveUri = Uri.parse(`${SCOPE_ROOT}/sessions/sess_x/history/archive_001`);
    const meta = {
      archiveId: 'archive_001',
      phase1: {
        status: 'ready' as const,
        messagesSha256: 'a'.repeat(64),
        archivedMessageIds: ['m1'],
        retainedMessageIds: [],
      },
      stepsDone: ['archive_summary' as const],
      taskId: 'task-1',
    };

    await service.writeArchiveMeta(archiveUri, meta);

    expect(await service.readArchiveMeta(archiveUri)).toEqual(meta);
  });
});

describe('并发', () => {
  it('addMessage 与 commitPhase1 并发执行不丢消息', async () => {
    const sessionUri = await service.create(Uri.parse(SCOPE_ROOT));

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
    const sessionUri = await service.create(Uri.parse(SCOPE_ROOT));
    await service.addMessage(sessionUri, message('m1'));

    expect(service.shouldAutoCommit(await service.load(sessionUri), new Date())).toBe(true);
  });

  it('enabled = false 时永不触发', async () => {
    const disabled = createService({ enabled: false, messageCountThreshold: 0 });
    const sessionUri = await service.create(Uri.parse(SCOPE_ROOT));
    await service.addMessage(sessionUri, message('m1'));

    expect(disabled.shouldAutoCommit(await service.load(sessionUri), new Date())).toBe(false);
  });

  it('最小提交间隔内不触发（限速器是全局闸门）', async () => {
    service = createService({ messageCountThreshold: 0, minCommitIntervalSeconds: 100 });
    const sessionUri = await service.create(Uri.parse(SCOPE_ROOT));
    await service.addMessage(sessionUri, message('m1'));

    const session = {
      ...(await service.load(sessionUri)),
      lastCommitAt: '2026-11-08T00:00:00.000Z',
    };
    expect(service.shouldAutoCommit(session, new Date('2026-11-08T00:00:10.000Z'))).toBe(false);
    expect(service.shouldAutoCommit(session, new Date('2026-11-08T00:02:00.000Z'))).toBe(true);
  });
});
