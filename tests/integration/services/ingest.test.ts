import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
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
import { createContainer, type Container } from '../../../src/bootstrap/container.js';
import { runIngest, renderReport } from '../../../src/commands/ingest.js';
import type { AutoCommitPolicy } from '../../../src/domain/session.js';
import { Uri } from '../../../src/domain/uri.js';
import type { Logger } from '../../../src/domain/log.js';
import { ClaudeCodeSource } from '../../../src/ingest/sources/claude-code.js';
import { CodexSource } from '../../../src/ingest/sources/codex.js';
import { DeepSeekSource } from '../../../src/ingest/sources/deepseek.js';
import { QwenSource } from '../../../src/ingest/sources/qwen.js';
import {
  IngestService,
  type ExtractionRunner,
  type IngestExtractionReport,
  type IngestReport,
  type IngestServiceOptions,
} from '../../../src/services/ingest.js';
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

/** 游标行数；`count` 已删，测试直接查表。 */
function cursorRows(): number {
  return Number(db.prepare('SELECT COUNT(*) AS total FROM ingest_cursor').get()?.['total'] ?? 0);
}

/** 游标里记的会话 URI，按宿主与原生 ID 排序。 */
function cursorSessionUris(): string[] {
  return db
    .prepare('SELECT session_uri FROM ingest_cursor ORDER BY harness, native_session_id')
    .all()
    .map((row) => String(row['session_uri']));
}

function createLogger(): Logger {
  const mock: Logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
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

function createService(
  dryRun: boolean,
  overrides: Partial<IngestServiceOptions> = {},
): IngestService {
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
    principals: ['user:alice', 'user:*'],
    logger,
    batchSize: 100,
    sessions,
    ...(dryRun ? {} : { cursors }),
    ...overrides,
  });
}

/**
 * 报告里「阶段二真的跑了」的那一支。
 *
 * `extraction` 是联合类型：`null` = 没等，`{ skipped: true }` = 没有可用模型。
 * 这些用例断言的是「跑了」；跳过时应当让测试直接失败，而不是读出一个 `undefined`。
 */
function runningExtraction(report: IngestReport): IngestExtractionReport {
  const extraction = report.extraction;
  if (extraction === null || extraction.skipped) {
    throw new Error(`预期阶段二真的跑了，实际是 ${JSON.stringify(extraction)}`);
  }
  return extraction;
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
    const report = await createService(false).run({ waitForExtraction: false });

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

    expect(cursorRows()).toBe(6);
    expect(taskRepository.countByStatus('pending')).toBe(6);

    const archived = await Promise.all(
      cursorSessionUris().map(async (sessionUriText) => {
        const sessionUri = Uri.parse(sessionUriText);
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
    await createService(false).run({ waitForExtraction: false });
    const sessionsBefore = await store.list(Uri.parse('comem://user/alice/sessions'));
    const tasksBefore = taskRepository.countByStatus('pending');

    const report = await createService(false).run({ waitForExtraction: false });
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

    const report = await createService(true).run({ dryRun: true, waitForExtraction: false });

    expect(report.harnesses[0]?.imported).toBe(3);
    expect(report.harnesses[0]?.messages).toBe(4);
    expect(create).not.toHaveBeenCalled();
    expect(addMessage).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
    expect(cursorRows()).toBe(0);
  });

  it('since 过滤：早于时间点的会话全部跳过', async () => {
    const report = await createService(false).run({
      since: '2030-01-01T00:00:00.000Z',
      waitForExtraction: false,
    });
    expect(report.harnesses.every((source) => source.imported === 0)).toBe(true);
    expect(report.harnesses[0]?.skipped).toBe(3);
    expect(cursorRows()).toBe(0);
  });

  it('只导指定来源', async () => {
    const report = await createService(false).run({ harnesses: ['codex'], waitForExtraction: false });
    expect(report.harnesses).toHaveLength(1);
    expect(report.harnesses[0]?.harness).toBe('codex');
    expect(report.harnesses[0]?.imported).toBe(1);
    expect(cursorRows()).toBe(1);
  });

  it('未知来源明确报错', async () => {
    await expect(
      createService(false).run({ harnesses: ['unknown' as 'codex'], waitForExtraction: false }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('脱敏伪影（密码保护）修复后继续，真正的坏文件跳过并进报告', async () => {
    const dir = join(fixtures, 'qwen-repair');
    await mkdir(dir, { recursive: true });
    // `4密码保护811` 是真实的脱敏伪影：数字被替换成了中文字符串，整份不是合法 JSON。
    const repaired = join(dir, 'Qwen-chat-export-10.json');
    await writeFile(
      repaired,
      `{
        "success": true,
        "data": [{
          "id": "qwen-repaired",
          "title": "脱敏",
          "chat": { "history": { "messages": {
            "n1": {"id":"n1","role":"user","content":"修复后的用户","parentId":null,"childrenIds":[],"timestamp":1790000000,"total_tokens":4密码保护811}
          } } }
        }]
      }`,
      'utf8',
    );
    const broken = join(dir, 'Qwen-chat-export-11.json');
    await writeFile(broken, '{"success": true, "data": [', 'utf8');

    const service = new IngestService({
      sources: [new QwenSource({ paths: [repaired, broken], logger })],
      scopeUri: SCOPE,
      principals: ['user:alice', 'user:*'],
      logger,
      batchSize: 100,
      sessions,
      cursors,
    });
    const report = await service.run({ waitForExtraction: false });
    const qwen = report.harnesses[0];

    // 修复后的文件照常导入，坏文件不中断同一来源。
    expect(qwen?.discovered).toBe(1);
    expect(qwen?.imported).toBe(1);
    expect(qwen?.failed).toBe(1);
    expect(qwen?.errors.map((error) => error.locator)).toEqual([broken]);
  });

  it('阶段二按批驱动：每 extractionBatchSize 个会话等一批，报告累计抽取与待复核', async () => {
    const timeouts: number[] = [];
    let sequences = 0;
    const extraction: ExtractionRunner = {
      async run(options) {
        timeouts.push(options.timeoutMs);
        sequences += 1;
        // 模拟「一批 2 条记忆」：每次执行返回两条不同的 URI（一条待复核）。
        const memories = new Map<string, string>([
          [`comem://user/alice/memories/preferences/topic-${String(sequences)}.md`, 'preferences'],
          [`comem://user/alice/memories/rules/rule-${String(sequences)}.md`, 'rules'],
        ]);
        return {
          tasksAttempted: 1,
          tasksCompleted: 1,
          tasksFailed: 0,
          memories,
          pendingReview: [`comem://user/alice/memories/rules/rule-${String(sequences)}.md`],
          timedOut: false,
        };
      },
    };

    const report = await createService(false, { extraction, extractionBatchSize: 2 }).run({
      extractionTimeoutMs: 12_345,
    });

    // 每个来源单独分批：claude 3 个会话 → [2, 1]，其余来源各 1 个。
    expect(timeouts).toEqual([12_345, 12_345, 12_345, 12_345, 12_345]);
    const extractionReport = runningExtraction(report);
    expect(extractionReport.tasksCompleted).toBe(5);
    expect(extractionReport.batches.map((batch) => batch.sessions)).toEqual([2, 1, 1, 1, 1]);
    expect(extractionReport.tasksFailed).toBe(0);
    expect(extractionReport.memoriesExtracted).toBe(10);
    expect(extractionReport.memoriesPendingReview).toBe(5);
    expect(extractionReport.batches.map((batch) => batch.index)).toEqual([1, 2, 3, 4, 5]);
  });

  it('waitForExtraction: false 时 extraction 为 null，执行器一次都不被调用', async () => {
    const run = vi.fn<ExtractionRunner['run']>();
    const report = await createService(false, {
      extraction: { run },
    }).run({ waitForExtraction: false });

    expect(run).not.toHaveBeenCalled();
    expect(report.extraction).toBeNull();
  });

  it('extractionTimeoutMs: 0 等价于不等', async () => {
    const run = vi.fn<ExtractionRunner['run']>();
    const report = await createService(false, {
      extraction: { run },
    }).run({ extractionTimeoutMs: 0 });

    expect(run).not.toHaveBeenCalled();
    expect(report.extraction).toBeNull();
  });

  it('dryRun 不跑阶段二：extraction 为 null，执行器一次都不被调用', async () => {
    const run = vi.fn<ExtractionRunner['run']>();
    const report = await createService(true, {
      extraction: { run },
    }).run({ dryRun: true });

    expect(run).not.toHaveBeenCalled();
    expect(report.extraction).toBeNull();
  });

  it('默认等待阶段二：没有注入执行器时明确拒绝，不静默停在 pending', async () => {
    await expect(createService(false).run({})).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
  });

  /**
   * 回归：`providers.llm.default.type: disabled` + `ingest.enabled: true`。
   *
   * 配置校验放行（`summary.generator: rule` 是合法组合），但阶段二每个任务都要
   * 调模型。修复前每一个会话都调一次 `DisabledLlmProvider`、抛一次
   * `INVALID_ARGUMENT`——1,076 个会话就是 1,076 条错误。要求的不是抛错（先导数据、
   * 后配模型是合法部署），而是**降级成只归档并把跳过写进报告**。
   */
  it('没有可用 LLM 时降级成只归档：阶段一成功、阶段二跳过、执行器一次都不被调用', async () => {
    const run = vi.fn<ExtractionRunner['run']>();
    const report = await createService(false, {
      extraction: { run },
      extractionSkip: 'llm_disabled',
    }).run();

    // 阶段一照常：会话归档、任务已建（任务停在 pending，等服务端执行器或下次导入）。
    expect(report.harnesses.map((source) => source.imported)).toEqual([3, 1, 1, 1]);
    expect(taskRepository.countByStatus('pending')).toBe(6);

    // 阶段二没有发生，但报告不能是 null——`null` 已经表示「没等」（--no-wait）。
    expect(report.extraction).toEqual({ skipped: true, reason: 'llm_disabled' });
    expect(run).not.toHaveBeenCalled();

    // 降级必须留痕：终端里看得见、日志里查得到。
    expect(logger.warn).toHaveBeenCalledWith(
      '阶段二被跳过：providers.llm.default.type 是 disabled',
      { reason: 'llm_disabled' },
    );
  });

  it('--no-wait 语义不变：有降级原因但没等时 extraction 仍是 null，不记跳过', async () => {
    const run = vi.fn<ExtractionRunner['run']>();
    const report = await createService(false, {
      extraction: { run },
      extractionSkip: 'llm_disabled',
    }).run({ waitForExtraction: false });

    expect(report.extraction).toBeNull();
    expect(run).not.toHaveBeenCalled();
    // 只断言「没有那条跳过日志」：坏日志行的 warn 是另一件事，与这里无关。
    expect(logger.warn).not.toHaveBeenCalledWith(
      '阶段二被跳过：providers.llm.default.type 是 disabled',
    );
  });

  it('dryRun 不报「跳过」：没有任务可跑，报告里 extraction 是 null', async () => {
    const run = vi.fn<ExtractionRunner['run']>();
    const report = await createService(true, {
      extraction: { run },
      extractionSkip: 'llm_disabled',
    }).run({ dryRun: true });

    expect(report.extraction).toBeNull();
    expect(run).not.toHaveBeenCalled();
  });

  it('执行器失败只记进报告，不影响已经导入的会话与其它批次', async () => {
    const extraction: ExtractionRunner = {
      async run() {
        throw new Error('执行器炸了');
      },
    };
    const report = await createService(false, { extraction, extractionBatchSize: 2 }).run();

    // 导入本身完成，报告说明阶段二失败。
    expect(report.harnesses.map((source) => source.imported)).toEqual([3, 1, 1, 1]);
    const extractionReport = runningExtraction(report);
    expect(extractionReport.tasksCompleted).toBe(0);
    expect(extractionReport.batches.length).toBeGreaterThan(0);
    expect(extractionReport.batches[0]?.error).toContain('执行器炸了');
  });
});

/**
 * 假模型服务：抽取请求回答「一条 preferences 记忆」（每次调用换一个 topic），
 * 经验归纳请求回答空结论。
 *
 * 走真实的 openai-compatible 适配器，而不是在服务层塞 `FakeLlmProvider`——要验证
 * 的正是「导入命令 → 执行器 → 抽取 → 写盘 → 索引 → find」这条生产接线，替换掉
 * 任何一段都会让测试绕过它。归纳是管线里第二个 `generateJson` 调用：不按提示词
 * 区分的话，抽取形状会被归纳的 schema 拒绝，任务停在 pending、`tasksCompleted` 为 0。
 */
interface FakeLlmServer {
  readonly baseUrl: string;
  close(): Promise<void>;
}

async function startFakeLlmServer(): Promise<FakeLlmServer> {
  let calls = 0;
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      calls += 1;
      const content = body.includes('经验归纳器')
        ? JSON.stringify({ experiences: [] })
        : JSON.stringify({
            operations: [
              {
                kind: 'upsert',
                pageId: 100,
                type: 'preferences',
                identity: { topic: `ingest-topic-${String(calls)}` },
                operations: [
                  { kind: 'replace', field: 'content', value: `导入抽取的记忆 ${String(calls)}` },
                ],
              },
            ],
          });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          id: `chatcmpl-${String(calls)}`,
          object: 'chat.completion',
          created: 0,
          model: 'fake',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('假模型服务没有拿到监听端口');
  }
  return {
    baseUrl: `http://127.0.0.1:${String(address.port)}/v1`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) {
            resolve();
          } else {
            reject(error);
          }
        });
      }),
  };
}

describe('导入后等阶段二（真实 createContainer）', () => {
  let server: FakeLlmServer;
  let configPath: string;
  let container: Container | undefined;

  beforeEach(async () => {
    server = await startFakeLlmServer();
    configPath = join(dataDir, 'ingest-config.yaml');
    await writeFile(
      configPath,
      [
        `dataDir: ${dataDir}`,
        'providers:',
        '  llm:',
        '    default:',
        '      type: openai-compatible',
        `      baseUrl: ${server.baseUrl}`,
        '      model: fake',
        '      apiKey: test',
        '      maxTokens: 4096',
        '      timeoutSeconds: 30',
        'summary:',
        '  generator: rule',
        'retrieval:',
        '  engine: fts5',
        'session:',
        '  autoCommit:',
        '    enabled: false',
        'ingest:',
        '  enabled: true',
        '  extractionBatchSize: 2',
        '  extractionTimeoutMs: 30000',
        '  paths:',
        '    claude-code:',
        `      - ${join(fixtures, 'claude', 'projects')}`,
      ].join('\n'),
      'utf8',
    );
  });

  afterEach(async () => {
    await container?.close();
    container = undefined;
    await server.close();
  });

  it('导入 + 等待阶段二之后 find 能搜到抽取出的记忆', async () => {
    const report = await runIngest({ configPath, dataDir, source: 'claude-code' });

    expect(report.extraction).not.toBeNull();
    const extractionReport = runningExtraction(report);
    expect(extractionReport.tasksCompleted).toBeGreaterThan(0);
    expect(extractionReport.memoriesExtracted).toBeGreaterThan(0);
    expect(extractionReport.memoriesPendingReview).toBe(0);

    // 重新起一个容器读同一个数据根：模拟「导入进程退出后，服务端能搜到」。
    container = await createContainer({
      configPath,
      env: { ...process.env, COMEM_DATA_DIR: dataDir, COMEM_LOGGING_LEVEL: 'error' },
    });
    const hits = await container.services.search.find('导入抽取的记忆', {
      scopes: ['comem://user/local'],
      subject: 'user:local',
      principals: ['user:local'],
    });

    expect(hits.length).toBeGreaterThan(0);
  });
});

/**
 * 回归（真实装配）：`providers.llm.default.type: disabled` + `ingest.enabled: true`
 * + `waitForExtraction: true`。
 *
 * 走的是 `runIngest` 的完整接线：容器 → 来源 → 阶段一 → 阶段二。修复前阶段二每个
 * 会话都调一次 `DisabledLlmProvider`，1,076 个会话就是 1,076 次 `INVALID_ARGUMENT`。
 * 修复后一次模型调用都不该发生，报告与终端输出都要说明「记忆没被抽取」。
 */
describe('没有可用 LLM 时只归档（真实 createContainer）', () => {
  let configPath: string;

  beforeEach(async () => {
    vi.spyOn(globalThis, 'fetch');
    configPath = join(dataDir, 'ingest-disabled-config.yaml');
    await writeFile(
      configPath,
      [
        `dataDir: ${dataDir}`,
        'providers:',
        '  llm:',
        '    default:',
        '      type: disabled',
        'summary:',
        '  generator: rule',
        'retrieval:',
        '  engine: fts5',
        'session:',
        '  autoCommit:',
        '    enabled: false',
        'ingest:',
        '  enabled: true',
        '  paths:',
        '    claude-code:',
        `      - ${join(fixtures, 'claude', 'projects')}`,
      ].join('\n'),
      'utf8',
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('阶段一成功、阶段二跳过、报告字段正确、fetch 一次都没被调用', async () => {
    const report = await runIngest({ configPath, dataDir, source: 'claude-code' });

    // 阶段一：3 个会话、4 条消息，全部归档。
    expect(report.harnesses.map((source) => source.imported)).toEqual([3]);
    expect(report.harnesses[0]?.messages).toBe(4);
    expect(report.harnesses[0]?.failed).toBe(0);

    // 阶段二没有发生，报告自己说明原因（不是 `null`——那是「没等」）。
    expect(report.extraction).toEqual({ skipped: true, reason: 'llm_disabled' });

    // 没有可用模型 ⇒ 一次模型调用都没有。任务停在 pending，等配好模型后重跑。
    expect(globalThis.fetch).not.toHaveBeenCalled();
    const db = openDatabase(join(dataDir, '_meta', 'comem.sqlite'), { readonly: true });
    try {
      const pending = db.prepare("SELECT COUNT(*) AS total FROM task WHERE status = 'pending'").get();
      expect(Number(pending?.['total'] ?? 0)).toBe(3);
    } finally {
      db.close();
    }
  });

  it('终端输出里写明阶段二被跳过', async () => {
    const report = await runIngest({ configPath, dataDir, source: 'claude-code' });
    const output = renderReport(report, false);

    expect(output).toContain('阶段二（记忆抽取）：跳过——providers.llm.default.type 是 disabled');
    expect(output).toContain('记忆还没抽取');
  });
});
