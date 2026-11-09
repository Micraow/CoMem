/**
 * 并发丢更新的回归用例（架构文档 §18「并发控制」）。
 *
 * 三条缺陷都只在 `task.concurrency: 4`（四个归档同时跑阶段二）下暴露，串行跑
 * 一百遍也不会红。所以每个用例都必须**真的并发**：
 *
 * | 用例 | 并发形态 | 去掉锁之后的表现 |
 * |---|---|---|
 * | 记忆字段级合并 | 两个 `upsertMemory` 的 `Promise.all` | 后写者用陈旧正文整份覆盖，先写者的字段消失 |
 * | `archive()` 的 `.meta.json` 读改写 | `archive()` 与 `commitPhase1()` 的 `Promise.all` | `commitCount` 被写回旧值，下一个归档重号并覆盖已有归档 |
 * | 导入的稳定消息 ID | 两次 `run()`，第一次在「消息已写、游标未写」处失败 | 重跑把同一批消息再追加一次 |
 *
 * **并发不是靠调度顺序碰巧发生的。** 会丢更新的那个写者被显式放慢（写盘/写元数据
 * 前 `await delay`），让另一个写者一定在它读完、还没写之前完成。这样「去掉锁就红」
 * 是可复现的，而不是「跑 100 遍偶尔红一次」。
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ContentStore } from '../../../src/adapters/fs/content-store.js';
import { createPathLockManager } from '../../../src/adapters/fs/lock.js';
import { MetadataFileStore } from '../../../src/adapters/fs/metadata-file.js';
import { openDatabase, runMigrations } from '../../../src/adapters/sqlite/database.js';
import { IngestCursorRepository } from '../../../src/adapters/sqlite/ingest-cursor-repository.js';
import { TaskRepository } from '../../../src/adapters/sqlite/task-repository.js';
import type { Logger } from '../../../src/domain/log.js';
import type { MemoryTypeSchema } from '../../../src/domain/memory-type.js';
import type { AutoCommitPolicy, SessionMeta } from '../../../src/domain/session.js';
import { Uri } from '../../../src/domain/uri.js';
import type {
  CursorKind,
  IngestCursor,
  NormalizedMessage,
  SessionRef,
} from '../../../src/domain/ingest.js';
import type { LogSource, ReadMessagesResult } from '../../../src/ingest/source.js';
import { IngestService } from '../../../src/services/ingest.js';
import { MemoryService, type MemoryServicePorts } from '../../../src/services/memory.js';
import { SessionService } from '../../../src/services/session.js';
import { TaskService } from '../../../src/services/task.js';

const SCOPE = 'comem://user/alice';
const PRINCIPALS = ['user:alice', 'user:*'];

/**
 * 让「会丢更新的那个写者」一定后写。
 *
 * 30ms 远大于一次内存/临时目录写盘的耗时：不加锁时，它读完到写之间的窗口足够
 * 另一个写者跑完整个读改写。
 */
const RACE_DELAY_MS = 30;

/** 测试专用的记忆类型：两个互不相干的字段，用来观察「谁被覆盖了」。 */
const fieldMemoryType = {
  type: 'fields',
  description: '并发用例：同一条记忆里的两个独立字段',
  directory: 'memories/preferences',
  filename: '{topic}.md',
  operationMode: 'upsert',
  fields: [
    { name: 'topic', type: 'string', identity: true, required: true, description: '话题' },
    { name: 'content', type: 'string', merge: 'patch', description: '正文' },
    { name: 'labels', type: 'string[]', description: '标签' },
    { name: 'enabled', type: 'boolean', description: '是否启用' },
    { name: 'updatedAt', type: 'string', merge: 'replace', description: '最后更新时间' },
  ],
} satisfies MemoryTypeSchema;

const POLICY: AutoCommitPolicy = {
  enabled: true,
  pendingTokenThreshold: 150000,
  messageCountThreshold: 100,
  minCommitIntervalSeconds: 0,
  idleTimeoutSeconds: 0,
  keepRecentCount: 0,
};

function createLogger(): Logger {
  const logger: Logger = {
    trace: () => undefined,
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child: () => logger,
  };
  return logger;
}

/** 一条会话的假日志源：游标是「已经消费了几条」。 */
class FixedSource implements LogSource {
  readonly harness = 'claude-code' as const;
  readonly cursorKind: CursorKind = 'byte_offset';
  readonly #messages: readonly NormalizedMessage[];

  constructor(messages: readonly NormalizedMessage[]) {
    this.#messages = messages;
  }

  async *discoverSessions(): AsyncIterable<SessionRef> {
    yield {
      harness: this.harness,
      nativeSessionId: 'native-1',
      locator: '/tmp/native-1.jsonl',
      title: null,
      startedAt: '2026-11-08T00:00:00.000Z',
    };
  }

  async readMessages(
    _ref: SessionRef,
    cursor: IngestCursor | null,
    limit: number,
  ): Promise<ReadMessagesResult> {
    const start = cursor === null ? 0 : Number(cursor.value);
    const messages = this.#messages.slice(start, start + limit);
    return {
      messages,
      cursor: { kind: 'byte_offset', value: String(start + messages.length) },
    };
  }
}

let dataDir: string;
let store: ContentStore;
let logger: Logger;
let locks: ReturnType<typeof createPathLockManager>;
let db: DatabaseSync;
let sessions: SessionService;
let cursors: IngestCursorRepository;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'comem-concurrency-'));
  logger = createLogger();
  store = new ContentStore({ dataDir, logger });
  locks = createPathLockManager({ dataDir, logger });
  db = openDatabase(':memory:');
  runMigrations(db);
  sessions = new SessionService({
    store,
    metadata: new MetadataFileStore({ dataDir, logger }),
    locks,
    tasks: new TaskService({
      tasks: new TaskRepository({ db, logger }),
      logger,
      leaseSeconds: 60,
      maxAttempts: 3,
    }),
    logger,
    meta: new MetadataFileStore({ dataDir, logger }),
    config: { autoCommit: POLICY },
  });
  cursors = new IngestCursorRepository({ db, logger });
});

afterEach(async () => {
  db.close();
  await rm(dataDir, { recursive: true, force: true });
});

describe('缺陷 1：upsertMemory 的读在锁外', () => {
  it('两个并发写者的字段都留下（字段级合并 + exact 锁）', async () => {
    // 「原样文档」端口：与 `container.ts` 的 `rawFilesystem` 同一个语义。写前
    // 放慢，保证两个写者都先读到「文件不存在」。
    const filesystem: MemoryServicePorts['filesystem'] = {
      read: async (uri) => ({
        text: Buffer.from(await store.readBytes(uri)).toString('utf8'),
      }),
      write: async (uri, text) => {
        await delay(RACE_DELAY_MS);
        return store.writeBytes(uri, Uint8Array.from(Buffer.from(text, 'utf8')));
      },
      stat: (uri) => store.stat(uri),
      remove: (uri) => store.remove(uri),
      list: (uri) => store.list(uri),
    };
    const memory = new MemoryService({
      filesystem,
      locks,
      search: { find: async () => [] },
      logger,
    });
    const scope = Uri.parse(SCOPE);

    await Promise.all([
      memory.upsertMemory(scope, fieldMemoryType, {
        topic: 'code-style',
        content: '缩进用 2 个空格。',
        labels: ['style'],
      }),
      memory.upsertMemory(scope, fieldMemoryType, {
        topic: 'code-style',
        content: '缩进用 2 个空格。',
        enabled: true,
      }),
    ]);

    const record = await memory.read(
      Uri.parse(`${SCOPE}/memories/preferences/code-style.md`),
    );
    // 后写者的 `enabled` 与先写者的 `labels` 都在。整份替换时先写者的 `labels`
    // 被后写者那份陈旧字段集覆盖掉。
    expect(record?.fields['labels']).toEqual(['style']);
    expect(record?.fields['enabled']).toBe(true);
  });
});

describe('缺陷 2：archive() 无锁读改写 .meta.json', () => {
  it('归档与提交并发时 commitCount 不回退（归档序号不重号）', async () => {
    // 归档那条 `writeSession` 一定后落盘：它读到的是提交之前的 `commitCount`。
    class SlowArchiveMeta extends MetadataFileStore {
      override async writeSession(sessionUri: Uri, meta: SessionMeta): Promise<void> {
        if (meta.status === 'archived') {
          await delay(RACE_DELAY_MS);
        }
        return super.writeSession(sessionUri, meta);
      }
    }
    const meta = new SlowArchiveMeta({ dataDir, logger });
    const racing = new SessionService({
      store,
      metadata: meta,
      locks,
      tasks: new TaskService({
        tasks: new TaskRepository({ db, logger }),
        logger,
        leaseSeconds: 60,
        maxAttempts: 3,
      }),
      logger,
      meta,
      config: { autoCommit: POLICY },
    });

    const sessionUri = await racing.create(Uri.parse(SCOPE), PRINCIPALS);
    await appendMessages(racing, sessionUri, 2);

    await Promise.all([racing.archive(sessionUri), racing.commitPhase1(sessionUri)]);

    // 没有锁时归档把 `commitCount` 写回 0（它读到的是提交之前的元数据）。
    const after = await new MetadataFileStore({ dataDir, logger }).readSession(sessionUri);
    expect(after?.commitCount).toBe(1);
    expect(after?.status).toBe('archived');

    const firstArchive = sessionUri.child('history', 'archive_001', 'messages.jsonl');
    const firstContent = await store.readBytes(firstArchive);

    // 第二次提交必须落在 archive_002。重号时它原子覆盖 archive_001 的
    // `messages.jsonl`——上一份归档的消息从此不存在。
    await appendMessages(racing, sessionUri, 2);
    const second = await racing.commitPhase1(sessionUri);
    expect(second.archiveUri.name).toBe('archive_002');
    expect(await store.readBytes(firstArchive)).toEqual(firstContent);
  });
});

describe('缺陷 3：每条消息随机 UUID', () => {
  it('「消息已写、游标未写」处崩溃后重跑不重复追加', async () => {
    const messages: NormalizedMessage[] = [
      { role: 'user', text: '第一条', createdAt: '2026-11-08T00:00:01.000Z', model: null, cwd: null },
      {
        role: 'assistant',
        text: '第二条',
        createdAt: '2026-11-08T00:00:02.000Z',
        model: null,
        cwd: null,
      },
      { role: 'user', text: '第三条', createdAt: '2026-11-08T00:00:03.000Z', model: null, cwd: null },
    ];

    // 每批一条：第 2 次游标写失败 = 「第 2 条消息已落盘、游标没前进」。
    const flaky = {
      get: (harness: 'claude-code', nativeSessionId: string) =>
        cursors.get(harness, nativeSessionId),
      upsert: (row: Parameters<IngestCursorRepository['upsert']>[0]): void => {
        if (row.cursorValue === '2') {
          throw new Error('模拟崩溃：游标没有写进去');
        }
        cursors.upsert(row);
      },
    };
    const crashing = new IngestService({
      sources: [new FixedSource(messages)],
      scopeUri: Uri.parse(SCOPE),
      principals: PRINCIPALS,
      logger,
      batchSize: 1,
      sessions,
      cursors: flaky,
    });

    const first = await crashing.run({ waitForExtraction: false });
    expect(first.harnesses[0]?.failed).toBe(1);

    const resumed = new IngestService({
      sources: [new FixedSource(messages)],
      scopeUri: Uri.parse(SCOPE),
      principals: PRINCIPALS,
      logger,
      batchSize: 1,
      sessions,
      cursors,
    });
    const second = await resumed.run({ waitForExtraction: false });
    expect(second.harnesses[0]?.imported).toBe(0);

    // 3 条源消息，不是 4 条：第 2 条已经在 live 里，重跑按稳定 ID 跳过它。
    expect(await countMessages(onlySessionUri())).toBe(3);
  });
});

async function appendMessages(
  service: SessionService,
  sessionUri: Uri,
  count: number,
): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await service.addMessage(sessionUri, {
      id: `m-${sessionUri.toString()}-${Date.now()}-${index}`,
      role: 'user',
      parts: [{ kind: 'text', text: `第 ${index} 条` }],
      createdAt: new Date(2026, 10, 8, 0, 0, index).toISOString(),
    });
  }
}

/** live + 全部归档里的消息条数。 */
async function countMessages(sessionUri: Uri): Promise<number> {
  let total = (await sessions.load(sessionUri)).messages.length;
  for (const archiveUri of await sessions.listArchives(sessionUri)) {
    total += (await sessions.readArchiveMeta(archiveUri))?.phase1.archivedMessageIds.length ?? 0;
  }
  return total;
}

/** 游标行里记的会话 URI（导入的唯一会话）。 */
function onlySessionUri(): Uri {
  const row = db.prepare('SELECT session_uri FROM ingest_cursor LIMIT 1').get();
  if (row === undefined) {
    throw new Error('导入没有写下游标行。');
  }
  return Uri.parse(String(row['session_uri']));
}
