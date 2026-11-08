import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ContentStore } from '../../../src/adapters/fs/content-store.js';
import { createPathLockManager, type PathLockManager } from '../../../src/adapters/fs/lock.js';
import { MetadataFileStore } from '../../../src/adapters/fs/metadata-file.js';
import { openDatabase, runMigrations } from '../../../src/adapters/sqlite/database.js';
import { IngestCursorRepository } from '../../../src/adapters/sqlite/ingest-cursor-repository.js';
import { TaskRepository } from '../../../src/adapters/sqlite/task-repository.js';
import type { AutoCommitPolicy } from '../../../src/domain/session.js';
import { Uri } from '../../../src/domain/uri.js';
import type { Logger } from '../../../src/domain/log.js';
import { ClaudeCodeSource } from '../../../src/ingest/sources/claude-code.js';
import { CodexSource } from '../../../src/ingest/sources/codex.js';
import { DeepSeekSource } from '../../../src/ingest/sources/deepseek.js';
import { QwenSource } from '../../../src/ingest/sources/qwen.js';
import { IngestService } from '../../../src/services/ingest.js';
import { SessionService } from '../../../src/services/session.js';
import { TaskService } from '../../../src/services/task.js';

const SCOPE = Uri.parse('comem://user/alice');

const POLICY: AutoCommitPolicy = {
  enabled: true,
  pendingTokenThreshold: 150000,
  messageCountThreshold: 100,
  minCommitIntervalSeconds: 0,
  idleTimeoutSeconds: 0,
  keepRecentCount: 0,
};

let dataDir: string;
let fixtures: string;
let db: DatabaseSync;
let logger: Logger;
let store: ContentStore;
let sessions: SessionService;
let cursors: IngestCursorRepository;
let taskRepository: TaskRepository;

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

function line(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function claudeLine(role: 'user' | 'assistant', text: string, sessionId: string): string {
  return line({
    type: role,
    isSidechain: false,
    isMeta: false,
    sessionId,
    timestamp: '2026-08-25T03:13:44.308Z',
    cwd: '/work',
    message: { role, content: [{ type: 'text', text }] },
  });
}

async function writeClaudeFixture(name: string, lines: readonly string[]): Promise<void> {
  const dir = join(fixtures, 'claude', 'projects', '-work');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${name}.jsonl`), lines.join(''), 'utf8');
}

async function writeCodexFixture(): Promise<void> {
  const dir = join(fixtures, 'codex');
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'rollout-2026-08-25T03-05-51-codex.jsonl'),
    [
      line({
        timestamp: '2026-08-25T03:05:51.031Z',
        type: 'session_meta',
        payload: { session_id: 'codex-native', cwd: '/work' },
      }),
      line({
        timestamp: '2026-08-25T03:05:52.000Z',
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'codex 用户' }] },
      }),
      line({
        timestamp: '2026-08-25T03:05:53.000Z',
        type: 'response_item',
        payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'codex 回答' }] },
      }),
    ].join(''),
    'utf8',
  );
}

async function writeDeepSeekFixture(): Promise<void> {
  const dir = join(fixtures, 'deepseek');
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'conversations.json'),
    JSON.stringify([
      {
        id: 'deepseek-native',
        title: '导出',
        inserted_at: '2025-01-05T11:25:58.137000+08:00',
        mapping: {
          root: { id: 'root', parent: null, children: ['n1'], message: null },
          n1: {
            id: 'n1',
            parent: 'root',
            children: ['n2'],
            message: { fragments: [{ type: 'REQUEST', content: 'ds 用户' }] },
          },
          n2: {
            id: 'n2',
            parent: 'n1',
            children: [],
            message: { fragments: [{ type: 'RESPONSE', content: 'ds 回答' }] },
          },
        },
      },
    ]),
    'utf8',
  );
}

async function writeQwenFixture(): Promise<void> {
  const dir = join(fixtures, 'qwen');
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'Qwen-chat-export-1.json'),
    JSON.stringify({
      success: true,
      data: [
        {
          id: 'qwen-native',
          title: 'Qwen',
          chat: {
            history: {
              messages: {
                n1: {
                  id: 'n1',
                  role: 'user',
                  content: 'qwen 用户',
                  parentId: null,
                  childrenIds: ['n2'],
                  timestamp: 1790000000,
                },
                n2: {
                  id: 'n2',
                  role: 'assistant',
                  content: 'qwen 回答',
                  parentId: 'n1',
                  childrenIds: [],
                  timestamp: 1790000001,
                },
              },
            },
          },
        },
      ],
    }),
    'utf8',
  );
  // 整份导出损坏：必须进报告，不能静默返回 0 个会话。
  await writeFile(join(dir, 'Qwen-chat-export-2.json'), '{"success": true, "data": [', 'utf8');
}

function createService(dryRun: boolean): IngestService {
  const sources = [
    new ClaudeCodeSource({ paths: [join(fixtures, 'claude', 'projects')], logger }),
    new CodexSource({ paths: [join(fixtures, 'codex')], logger }),
    new DeepSeekSource({ paths: [join(fixtures, 'deepseek', 'conversations.json')], logger }),
    new QwenSource({
      paths: [
        join(fixtures, 'qwen', 'Qwen-chat-export-1.json'),
        join(fixtures, 'qwen', 'Qwen-chat-export-2.json'),
      ],
      logger,
    }),
  ];
  return new IngestService({
    sources,
    scopeUri: SCOPE,
    logger,
    batchSize: 100,
    sessions,
    ...(dryRun ? {} : { cursors }),
  });
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'comem-ingest-'));
  fixtures = await mkdtemp(join(tmpdir(), 'comem-ingest-fixtures-'));
  logger = createLogger();
  store = new ContentStore({ dataDir, logger });
  db = openDatabase(':memory:');
  runMigrations(db);

  const metadata = new MetadataFileStore({ dataDir, logger });
  const locks: PathLockManager = createPathLockManager({ dataDir, logger });
  taskRepository = new TaskRepository({ db, logger });
  const tasks = new TaskService({
    tasks: taskRepository,
    logger,
    leaseSeconds: 60,
    maxAttempts: 3,
  });
  sessions = new SessionService({
    store,
    metadata,
    locks,
    tasks,
    logger,
    meta: metadata,
    config: { autoCommit: POLICY },
  });
  cursors = new IngestCursorRepository({ db, logger });

  await writeClaudeFixture('s1', [
    claudeLine('user', 'claude 用户', 'claude-native-1'),
    claudeLine('assistant', 'claude 回答', 'claude-native-1'),
  ]);
  await writeClaudeFixture('s2', [claudeLine('user', '只有一条', 'claude-native-2')]);
  await writeClaudeFixture('s3', [
    '{坏行}\n',
    claudeLine('assistant', '坏行之后', 'claude-native-3'),
  ]);
  await writeCodexFixture();
  await writeDeepSeekFixture();
  await writeQwenFixture();
});

afterEach(async () => {
  db.close();
  await rm(dataDir, { recursive: true, force: true });
  await rm(fixtures, { recursive: true, force: true });
});

describe('IngestService', () => {
  it('导入四个来源：建会话、写消息、提交归档、建任务、写游标', async () => {
    const report = await createService(false).run();

    expect(report.harnesses).toHaveLength(4);
    const claude = report.harnesses[0];
    expect(claude?.harness).toBe('claude-code');
    expect(claude?.discovered).toBe(3);
    expect(claude?.imported).toBe(3);
    expect(claude?.messages).toBe(4);
    expect(claude?.failed).toBe(0);

    const qwen = report.harnesses[3];
    expect(qwen?.discovered).toBe(1);
    expect(qwen?.imported).toBe(1);
    expect(qwen?.failed).toBe(1);
    expect(qwen?.errors[0]?.message).toContain('不是合法 JSON');

    expect(cursors.count()).toBe(6);
    expect(taskRepository.countByStatus('pending')).toBe(6);

    const archived = await Promise.all(
      cursors.list().map(async (row) => {
        const sessionUri = Uri.parse(row.sessionUri);
        const archiveUri = sessionUri.child('history', 'archive_001');
        return Buffer.from(await store.readBytes(archiveUri.child('messages.jsonl'))).toString('utf8');
      }),
    );
    const all = archived.join('\n');
    for (const text of [
      'claude 用户',
      'claude 回答',
      '只有一条',
      '坏行之后',
      'codex 用户',
      'codex 回答',
      'ds 用户',
      'ds 回答',
      'qwen 用户',
      'qwen 回答',
    ]) {
      expect(all).toContain(text);
    }

    // 原始会话消息按设计**不进检索索引**（`GET /sessions` 从磁盘列目录，
    // 记忆由阶段二抽取）。这里断言归档正文完整，证明导入真的落盘。
    expect(archived.every((text) => text.trim() !== '')).toBe(true);
  });

  it('幂等：第二次跑全部跳过，不新建会话、不新建任务', async () => {
    await createService(false).run();
    const sessionsBefore = await store.list(Uri.parse('comem://user/alice/sessions'));
    const tasksBefore = taskRepository.countByStatus('pending');

    const report = await createService(false).run();
    expect(report.harnesses.map((source) => source.discovered)).toEqual([3, 1, 1, 1]);
    expect(report.harnesses.map((source) => source.imported)).toEqual([0, 0, 0, 0]);
    expect(report.harnesses.map((source) => source.appended)).toEqual([0, 0, 0, 0]);
    expect(report.harnesses[0]?.skipped).toBe(3);
    expect(report.harnesses[3]?.failed).toBe(1);

    expect(await store.list(Uri.parse('comem://user/alice/sessions'))).toHaveLength(
      sessionsBefore.length,
    );
    expect(taskRepository.countByStatus('pending')).toBe(tasksBefore);
  });

  it('dryRun 零写入：会话服务与游标仓储一次都不被调用', async () => {
    const create = vi.spyOn(sessions, 'create');
    const addMessage = vi.spyOn(sessions, 'addMessage');
    const commit = vi.spyOn(sessions, 'commitPhase1');
    const upsert = vi.spyOn(cursors, 'upsert');

    const report = await createService(true).run({ dryRun: true });

    expect(report.harnesses[0]?.imported).toBe(3);
    expect(report.harnesses[0]?.messages).toBe(4);
    expect(create).not.toHaveBeenCalled();
    expect(addMessage).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
    expect(cursors.count()).toBe(0);
  });

  it('since 过滤：早于时间点的会话全部跳过', async () => {
    const report = await createService(false).run({ since: '2030-01-01T00:00:00.000Z' });
    expect(report.harnesses.every((source) => source.imported === 0)).toBe(true);
    expect(report.harnesses[0]?.skipped).toBe(3);
    expect(cursors.count()).toBe(0);
  });

  it('只导指定来源', async () => {
    const report = await createService(false).run({ harnesses: ['codex'] });
    expect(report.harnesses).toHaveLength(1);
    expect(report.harnesses[0]?.harness).toBe('codex');
    expect(report.harnesses[0]?.imported).toBe(1);
    expect(cursors.count()).toBe(1);
  });

  it('未知来源明确报错', async () => {
    await expect(
      createService(false).run({ harnesses: ['unknown' as 'codex'] }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });
});
