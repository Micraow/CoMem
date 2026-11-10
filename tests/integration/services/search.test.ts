import type { DatabaseSync } from 'node:sqlite';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ContentStore } from '../../../src/adapters/fs/content-store.js';
import { createPathLockManager } from '../../../src/adapters/fs/lock.js';
import { MetadataFileStore } from '../../../src/adapters/fs/metadata-file.js';
import { toDiskPath } from '../../../src/adapters/fs/path.js';
import { openDatabase, runMigrations } from '../../../src/adapters/sqlite/database.js';
import { SqliteFtsIndex } from '../../../src/adapters/sqlite/retrieval-index.js';
import { TaskRepository } from '../../../src/adapters/sqlite/task-repository.js';
import { ComemError } from '../../../src/domain/errors.js';
import type { Level } from '../../../src/domain/level.js';
import type { Logger } from '../../../src/domain/log.js';
import type { ContextType } from '../../../src/domain/node.js';
import type { IndexRecord, RetrievalIndex, SearchHit } from '../../../src/domain/retrieval.js';
import type { RerankProvider } from '../../../src/domain/rerank.js';
import type {
  AutoCommitPolicy,
  Session,
  SessionMessage,
} from '../../../src/domain/session.js';
import { Uri } from '../../../src/domain/uri.js';
import {
  permissionDenied,
  type AclAction,
  type Authorizer,
} from '../../../src/services/authorizer.js';
import { AllowAllAuthorizer } from '../../helpers/allow-all-authorizer.js';
import { ContextAssembler } from '../../../src/services/context-assembler.js';
import { FileSystemService } from '../../../src/services/filesystem.js';
import { RecallLedger, type DeliveredItem } from '../../../src/services/recall-ledger.js';
import { SessionService } from '../../../src/services/session.js';
import { TaskService } from '../../../src/services/task.js';
import {
  SearchService,
  type ContextOptions,
  type FindOptions,
  type RetrievalSettings,
} from '../../../src/services/search.js';

const SCOPE = 'comem://user/alice';
const PRINCIPALS = ['user:alice'];

/**
 * 架构文档 §18 的 `retrieval` 段。
 *
 * 第五条规则原文是 `s|^(ok|yes|继续|好|嗯)$||i`：分隔符与选择分支同字符，sed 语义
 * 下 pattern 里的 `|` 必须转义（见 `tests/unit/domain/query-filter.test.ts`）。
 */
const CONFIG: RetrievalSettings = {
  candidateMultiplier: 4,
  levelWeights: { l0: 1.15, l1: 1.05, l2: 1 },
  queryFilters: [
    's|^/\\w+.*$||',
    's|@[\\w/\\.\\-]+||g',
    's|```[\\s\\S]*?```||g',
    's|https?://\\S+||g',
    's|^(ok\\|yes\\|继续\\|好\\|嗯)$||i',
  ],
  assembly: { maxTokens: 1600, dedupTurns: 3, quotaPreset: 'coding' },
};

let dataDir: string;
let db: DatabaseSync;
let index: SqliteFtsIndex;
let store: ContentStore;
let metadata: MetadataFileStore;
let logger: Logger;
let authorizer: Authorizer;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'comem-search-'));
  logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  db = openDatabase(':memory:');
  runMigrations(db);
  index = new SqliteFtsIndex({ db, logger });
  store = new ContentStore({ dataDir, logger });
  metadata = new MetadataFileStore({ dataDir, logger });
  authorizer = new AllowAllAuthorizer();
});

afterEach(async () => {
  vi.restoreAllMocks();
  db.close();
  await rm(dataDir, { recursive: true, force: true });
});

interface RecordOverrides {
  readonly level?: Level;
  readonly contextType?: ContextType;
  readonly abstract?: string | null;
  readonly kind?: IndexRecord['kind'];
}

function record(uri: string, content: string, overrides: RecordOverrides = {}): IndexRecord {
  return {
    uri,
    parentUri: uri.slice(0, uri.lastIndexOf('/')),
    scope: 'user',
    kind: overrides.kind ?? 'document',
    contextType: overrides.contextType ?? 'memory',
    memoryType: null,
    level: overrides.level ?? 'L2',
    abstract: overrides.abstract ?? null,
    content,
    bodyDigest: '0000000000000000',
    size: Buffer.byteLength(content),
    updatedAt: '2026-11-08T00:00:00.000Z',
    status: 'active',
  };
}

/** 建索引行 + 授权。正文由调用方决定是否真的落盘。 */
async function seed(
  uri: string,
  content: string,
  overrides: RecordOverrides = {},
  principal = 'user:alice',
): Promise<void> {
  await index.upsert([record(uri, content, overrides)]);
  db.prepare('INSERT INTO node_permission (node_uri, principal, level) VALUES (?, ?, 1)').run(
    uri,
    principal,
  );
}

async function writeBody(uri: string, text: string): Promise<void> {
  await store.writeText(Uri.parse(uri), text);
}

async function createService(options: {
  readonly authorizer?: Authorizer;
  readonly maxTokens?: number;
  readonly index?: RetrievalIndex;
  readonly ledger?: Pick<RecallLedger, 'recentlyDelivered' | 'record'>;
  readonly sessions?: Pick<SessionService, 'load' | 'totalMessageCount'>;
  readonly rerank?: {
    readonly provider: RerankProvider;
    readonly topN: number;
    readonly keepTopN: number;
  };
} = {}): Promise<SearchService> {
  const activeAuthorizer = options.authorizer ?? authorizer;
  const assembler = new ContextAssembler({
    store,
    metadata,
    authorizer: activeAuthorizer,
    logger,
  });
  const filesystem = new FileSystemService({
    store,
    locks: createPathLockManager({ dataDir, logger, pollIntervalMs: 1 }),
    authorizer: activeAuthorizer,
    logger,
  });

  return new SearchService({
    index: options.index ?? index,
    filesystem,
    authorizer: activeAuthorizer,
    assembler,
    logger,
    config:
      options.maxTokens === undefined
        ? CONFIG
        : { ...CONFIG, assembly: { ...CONFIG.assembly, maxTokens: options.maxTokens } },
    ...(options.ledger === undefined ? {} : { ledger: options.ledger }),
    ...(options.sessions === undefined ? {} : { sessions: options.sessions }),
    ...(options.rerank === undefined ? {} : { rerank: options.rerank }),
    // 必填依赖：测试显式传默认值（`telemetry.hotness.*` 的 schema 默认值）。
    hotnessWeight: 0,
    hotnessHalfLifeHours: 168,
  });
}

/** 假索引的一行：分数写死，用于断言重排前后顺序。 */
interface FakeHit {
  readonly uri: string;
  readonly score: number;
  readonly abstract?: string | null;
}

/** 假索引：分数写死，`#rank` 只做层级加权（L2 权重 1.0，分数原样保留）。 */
function fakeIndex(entries: readonly FakeHit[]): RetrievalIndex {
  const hits: SearchHit[] = entries.map((entry) => ({
    uri: entry.uri,
    level: 'L2',
    abstract: entry.abstract ?? null,
    score: entry.score,
    contextType: 'memory',
    memoryType: null,
  }));
  return {
    upsert: async () => {},
    deleteByUri: async () => {},
    search: async () => hits.map((hit) => ({ ...hit })),
    glob: async () => hits.map((hit) => hit.uri),
    stat: async () => null,
  };
}

function findOptions(overrides: Partial<FindOptions> = {}): FindOptions {
  return { scopes: [SCOPE], subject: 'user:alice', principals: PRINCIPALS, ...overrides };
}

function contextOptions(overrides: Partial<ContextOptions> = {}): ContextOptions {
  return { ...findOptions(), ...overrides };
}

class DenyAllAuthorizer implements Authorizer {
  async check(): Promise<boolean> {
    return false;
  }

  async filterReadable(): Promise<ReadonlySet<string>> {
    return new Set();
  }

  async assert(uri: Uri, action: AclAction): Promise<void> {
    throw permissionDenied(uri, action);
  }
}

describe('find', () => {
  const DOC = 'comem://user/alice/mem/design.md';

  it('中文双字词能命中', async () => {
    await seed(DOC, '上下文记忆数据库的设计');
    const service = await createService();

    const hits = await service.find('记忆', findOptions());

    expect(hits.map((hit) => hit.uri)).toEqual([DOC]);
    expect(hits[0]?.level).toBe('L2');
    expect(hits[0]?.contextType).toBe('memory');
  });

  it('空白分隔的多个词能召回：`find` 走同一条 FTS5 查询构造', async () => {
    await seed(DOC, '支付网关层实现重试时，必须用幂等键去重。');
    const service = await createService();

    // 整串包成一个短语时要求「重试网关层支付」连续出现，这条真实文档必然落空。
    const hits = await service.find('重试 网关层 支付', findOptions());

    expect(hits.map((hit) => hit.uri)).toEqual([DOC]);
  });

  it('查询串先经过 queryFilters', async () => {
    await seed(DOC, '上下文记忆数据库的设计');
    const service = await createService();

    // `@src/foo.ts` 被过滤掉后还剩「看下  这段」，仍能命中「设计」。
    const hits = await service.find('设计 @src/foo.ts', findOptions());
    expect(hits.map((hit) => hit.uri)).toEqual([DOC]);
  });

  it('过滤后为空时不调索引', async () => {
    await seed(DOC, '上下文记忆数据库的设计');
    const service = await createService();
    const search = vi.spyOn(index, 'search');

    for (const query of ['/help', '继续', 'ok', 'https://example.com/x']) {
      await expect(service.find(query, findOptions())).resolves.toEqual([]);
    }
    expect(search).not.toHaveBeenCalled();
  });

  it('空查询与纯空白查询返回空数组', async () => {
    await seed(DOC, '上下文记忆数据库的设计');
    const service = await createService();

    await expect(service.find('', findOptions())).resolves.toEqual([]);
    await expect(service.find('   ', findOptions())).resolves.toEqual([]);
  });

  it('层级加权让同分文档里更粗的层级排前面', async () => {
    const l0 = 'comem://user/alice/mem/a.md';
    const l2 = 'comem://user/alice/mem/b.md';
    // 两份内容完全相同：bm25 相同，差别只在层级权重。
    await seed(l0, '偏好 代码 风格', { level: 'L0' });
    await seed(l2, '偏好 代码 风格', { level: 'L2' });

    const service = await createService();
    const hits = await service.find('偏好', findOptions());

    expect(hits.map((hit) => hit.uri)).toEqual([l0, l2]);
    expect(hits[0]?.score).toBeGreaterThan(hits[1]?.score ?? 0);
  });

  it('limit 生效', async () => {
    for (const name of ['a', 'b', 'c']) {
      await seed(`comem://user/alice/mem/${name}.md`, '偏好 代码 风格');
    }
    const service = await createService();

    await expect(service.find('偏好', findOptions({ limit: 2 }))).resolves.toHaveLength(2);
  });

  it('limit 必须是正整数', async () => {
    const service = await createService();
    await expect(service.find('偏好', findOptions({ limit: 0 }))).rejects.toBeInstanceOf(ComemError);
  });

  it('记 info 日志：查询长度、条数、耗时', async () => {
    await seed(DOC, '上下文记忆数据库的设计');
    const service = await createService();

    await service.find('记忆', findOptions());

    expect(logger.info).toHaveBeenCalledWith(
      '检索完成',
      expect.objectContaining({ queryLength: 2, returned: 1, durationMs: expect.any(Number) }),
    );
  });
});

describe('grep', () => {
  const FILE = 'comem://user/alice/mem/error.ts';
  const LINES = [
    'const a = 1;',
    'const b = 2;',
    "throw new Error('boom');",
    'const c = 3;',
    '// done',
  ];

  beforeEach(async () => {
    await writeBody(FILE, `${LINES.join('\n')}\n`);
    await seed(FILE, 'throw new Error');
  });

  it('返回行号与前后文', async () => {
    const service = await createService();

    const hits = await service.grep('Error', { ...findOptions(), contextLines: 1 });

    expect(hits).toEqual([
      {
        uri: FILE,
        line: 3,
        text: "throw new Error('boom');",
        before: ['const b = 2;'],
        after: ['const c = 3;'],
      },
    ]);
  });

  it('contextLines 默认 3', async () => {
    const service = await createService();

    const [hit] = await service.grep('boom', findOptions());

    expect(hit?.line).toBe(3);
    expect(hit?.before).toEqual(['const a = 1;', 'const b = 2;']);
    expect(hit?.after).toEqual(['const c = 3;', '// done']);
  });

  it('contextLines 为 0 时不带前后文', async () => {
    const service = await createService();

    const [hit] = await service.grep('boom', { ...findOptions(), contextLines: 0 });

    expect(hit?.before).toEqual([]);
    expect(hit?.after).toEqual([]);
  });

  it('一个文件里多行命中各算一条', async () => {
    const service = await createService();

    const hits = await service.grep('const', { ...findOptions(), contextLines: 0 });

    expect(hits.map((hit) => hit.line)).toEqual([1, 2, 4]);
  });

  it('非法正则抛 INVALID_ARGUMENT', async () => {
    const service = await createService();

    let caught: unknown;
    try {
      await service.grep('(', findOptions());
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ComemError);
    expect((caught as ComemError).code).toBe('INVALID_ARGUMENT');
  });

  it('contextLines 必须是非负整数', async () => {
    const service = await createService();
    await expect(
      service.grep('boom', { ...findOptions(), contextLines: -1 }),
    ).rejects.toBeInstanceOf(ComemError);
  });

  it('没有命中的文件被跳过', async () => {
    await writeBody('comem://user/alice/mem/other.ts', 'const x = 1;\n');
    await seed('comem://user/alice/mem/other.ts', 'const x = 1;');
    const service = await createService();

    const hits = await service.grep('boom', findOptions());

    expect(hits.map((hit) => hit.uri)).toEqual([FILE]);
  });

  it('磁盘上已删除的候选跳过，不断言整次 grep', async () => {
    await seed('comem://user/alice/mem/gone.ts', 'boom');
    const service = await createService();

    const hits = await service.grep('boom', findOptions());

    expect(hits.map((hit) => hit.uri)).toEqual([FILE]);
    expect(logger.warn).toHaveBeenCalledWith(
      'grep 跳过不可读的候选',
      expect.objectContaining({ uri: 'comem://user/alice/mem/gone.ts' }),
    );
  });

  it('候选文件数超过 200 时截断并记 warn', async () => {
    await mkdir(join(dataDir, 'user', 'alice', 'bulk'), { recursive: true });
    const uris = Array.from(
      { length: 201 },
      (_, index) => `comem://user/alice/bulk/f-${String(index).padStart(3, '0')}.md`,
    );
    await Promise.all(
      uris.map((uri) => writeFile(toDiskPath(dataDir, Uri.parse(uri)), 'needle\n', 'utf8')),
    );
    await index.upsert(uris.map((uri) => record(uri, 'needle')));
    for (const uri of uris) {
      db.prepare('INSERT INTO node_permission (node_uri, principal, level) VALUES (?, ?, 1)').run(
        uri,
        'user:alice',
      );
    }

    const service = await createService();
    const hits = await service.grep(
      'needle',
      findOptions({ scopes: ['comem://user/alice/bulk'], limit: 1000 }),
    );

    expect(hits).toHaveLength(200);
    expect(logger.warn).toHaveBeenCalledWith(
      'grep 候选文件数超过上限，已截断',
      expect.objectContaining({ limit: 200 }),
    );
  });
});

describe('glob', () => {
  const FILE = 'comem://user/alice/mem/design.md';

  it('返回权限过滤后的 URI 列表', async () => {
    await seed(FILE, '设计');
    const service = await createService();

    await expect(service.glob('**/*.md', findOptions())).resolves.toEqual([FILE]);
  });

  it('服务层再过一遍权限（纵深防御）', async () => {
    await seed(FILE, '设计');
    const service = await createService({ authorizer: new DenyAllAuthorizer() });

    // 索引侧按 node_permission 已经能返回它；服务层再挡一次。
    await expect(service.glob('**/*.md', findOptions())).resolves.toEqual([]);
  });

  it('记 info 日志', async () => {
    await seed(FILE, '设计');
    const service = await createService();

    await service.glob('**/*.md', findOptions());

    expect(logger.info).toHaveBeenCalledWith(
      'glob 完成',
      expect.objectContaining({ matched: 1, returned: 1, durationMs: expect.any(Number) }),
    );
  });
});

/**
 * `context` 的账本写回（§8.7）。
 *
 * 组装本身（预算、分层、去重、配额）由 `tests/unit/domain/assembly.test.ts` 穷举；
 * 这里只钉住「生产路径上账本真的被读、被写」这一条——它正是接线前断掉的地方。
 * 路由与 MCP 的出参形态在 `tests/integration/api/http.test.ts` 覆盖。
 */
describe('context 账本', () => {
  const DOC = 'comem://user/alice/mem/m1.md';

  /**
   * 生产路径上时钟只有一个来源：`sessionId` + 会话的累计消息数
   * （`sessions.totalMessageCount`）。没有 HTTP / MCP 入口能直接指定 `scopeKey` /
   * `turn`，所以用假 SessionService 钉住这个推导，而不是绕过它。
   *
   * 假对象的 `load` 只为满足依赖形状（意图分析取最近消息）；时钟读的是
   * `totalMessageCount`。两者在真实实现里不是同一个数：提交后 `load` 的
   * `messageCount` 归零，累计数不变——那条路径由 `context 账本：累计时钟` 用真实
   * `SessionService` 覆盖。
   */
  function sessionsWithClock(turn: number): Pick<SessionService, 'load' | 'totalMessageCount'> {
    return {
      load: async (sessionUri: Uri): Promise<Session> => ({
        id: sessionUri.name,
        uri: sessionUri,
        status: 'open',
        messages: [],
        messageCount: turn,
        pendingTokens: 0,
        lastCommitAt: null,
      }),
      totalMessageCount: async () => turn,
    };
  }

  it('投放的条目写回账本，下一轮按账本去重', async () => {
    await writeBody(DOC, '# 标题\n\n正文。');
    await seed(DOC, '记忆', { abstract: '一句话摘要' });

    const delivered = new Set<string>();
    const ledger = {
      recentlyDelivered: vi.fn(async () => new Set(delivered)),
      record: vi.fn(
        async (
          _scopeKey: string,
          _sessionId: string,
          _turn: number,
          items: readonly DeliveredItem[],
        ) => {
          for (const item of items) {
            // §8.7 规则 1：只给了 URI 的条目不记——模型没看到正文。
            if (item.detail !== null) {
              delivered.add(item.uri);
            }
          }
        },
      ),
    };

    const service = await createService({ ledger, sessions: sessionsWithClock(4) });
    const first = await service.context('记忆', contextOptions({ sessionId: 'sess_1' }));

    expect(first.items.map((item) => item.uri)).toEqual([DOC]);
    expect(ledger.record).toHaveBeenCalledWith('user_alice', 'sess_1', 4, first.items, {
      dedupTurns: CONFIG.assembly.dedupTurns,
      maxEntries: 500,
    });

    const second = await service.context('记忆', contextOptions({ sessionId: 'sess_1' }));
    expect(second.items).toEqual([]);
    expect(second.rendered).toBe('');
  });

  it('账本写入失败只记 warn，检索仍返回结果', async () => {
    await seed(DOC, '记忆', { abstract: '一句话摘要' });
    const ledger = {
      recentlyDelivered: vi.fn(async () => new Set<string>()),
      record: vi.fn(async () => {
        throw new ComemError('INTERNAL', '磁盘满了');
      }),
    };

    const service = await createService({ ledger, sessions: sessionsWithClock(1) });
    const result = await service.context('记忆', contextOptions({ sessionId: 'sess_1' }));

    expect(result.items).toHaveLength(1);
    expect(logger.warn).toHaveBeenCalledWith(
      '召回账本写入失败',
      expect.objectContaining({
        scopeKey: 'user_alice',
        sessionId: 'sess_1',
        turn: 1,
        code: 'INTERNAL',
      }),
    );
  });

  it('有会话时钟但没有注入账本时抛 INVALID_ARGUMENT', async () => {
    await seed(DOC, '记忆');
    const service = await createService({ sessions: sessionsWithClock(1) });

    await expect(
      service.context('记忆', contextOptions({ sessionId: 'sess_1' })),
    ).rejects.toBeInstanceOf(ComemError);
  });
});

/**
 * 账本时钟的真实实现（§8.7）：`turn` 必须取**累计**消息数。
 *
 * 这一段用真实 `SessionService` + 真实 `RecallLedger`。假 sessions 只能证明调用方
 * 传了什么，证明不了「提交清空 live 之后时钟还在」——那正是接线前断掉的地方：
 * `totalMessageCount` 实现了但没人调用，`#deliveryClock` 拿 `load` 的
 * `messageCount` 当时钟。`keepRecentCount: 0`（默认）的第一次提交把 live 清空，
 * `turn` 从 2 掉到 0，账本读侧的 `entry.turn <= turn` 把 turn=2 的条目当成
 * 「未来轮次」排除，刚投过的记忆下一轮再投一次。
 */
describe('context 账本：累计时钟', () => {
  const DOC = 'comem://user/alice/mem/m1.md';

  /** §10.2.1 的默认策略；`keepRecentCount: 0` 是默认值，也是本回归的触发条件。 */
  const POLICY: AutoCommitPolicy = {
    enabled: true,
    pendingTokenThreshold: 150000,
    messageCountThreshold: 100,
    minCommitIntervalSeconds: 0,
    idleTimeoutSeconds: 0,
    keepRecentCount: 0,
  };

  function createSessions(policy: Partial<AutoCommitPolicy> = {}): SessionService {
    const meta = new MetadataFileStore({ dataDir, logger });
    return new SessionService({
      store,
      metadata: meta,
      locks: createPathLockManager({ dataDir, logger, pollIntervalMs: 1 }),
      tasks: new TaskService({ tasks: new TaskRepository({ db, logger }), logger }),
      logger,
      meta,
      config: { autoCommit: { ...POLICY, ...policy } },
      authorizer,
    });
  }

  /** 真实账本 + 内存端口：过滤规则跑真的，只把落盘换成 Map。 */
  function createLedger(): RecallLedger {
    const files = new Map<string, string>();
    return new RecallLedger({
      dataDir,
      store: {
        read: async (key) => files.get(key) ?? null,
        write: async (key, text) => {
          files.set(key, text);
        },
        remove: async (key) => {
          files.delete(key);
        },
      },
      logger,
    });
  }

  function message(id: string): Omit<SessionMessage, 'turn'> {
    return {
      id,
      role: 'user',
      parts: [{ kind: 'text', text: '消息正文' }],
      createdAt: '2026-11-08T00:00:00.000Z',
    };
  }

  /** 一条可召回的文档 + 一个写了若干条消息的会话（默认 2 条、`keepRecentCount: 0`）。 */
  async function prepare(
    options: {
      readonly policy?: Partial<AutoCommitPolicy>;
      readonly messageIds?: readonly string[];
    } = {},
  ): Promise<{
    readonly sessions: SessionService;
    readonly sessionUri: Uri;
  }> {
    await writeBody(DOC, '# 标题\n\n正文。');
    await seed(DOC, '记忆', { abstract: '一句话摘要' });

    const sessions = createSessions(options.policy);
    const sessionUri = await sessions.create(Uri.parse(SCOPE), PRINCIPALS);
    for (const id of options.messageIds ?? ['m1', 'm2']) {
      await sessions.addMessage(sessionUri, message(id));
    }
    return { sessions, sessionUri };
  }

  it('提交清空 live 之后，第二次 context 不重复投放第一次给过的 URI', async () => {
    const { sessions, sessionUri } = await prepare();
    const service = await createService({ ledger: createLedger(), sessions });
    const options = contextOptions({ sessionId: sessionUri.name });

    const first = await service.context('记忆', options);
    const firstUris = first.items.map((item) => item.uri);
    expect(firstUris).toEqual([DOC]);

    // `keepRecentCount: 0`：提交把 live 全部移进归档，live 条数归零。
    await sessions.commitPhase1(sessionUri);
    expect((await sessions.load(sessionUri)).messageCount).toBe(0);
    expect(await sessions.totalMessageCount(sessionUri)).toBe(2);

    const second = await service.context('记忆', options);
    const secondUris = second.items.map((item) => item.uri);
    expect(secondUris.filter((uri) => firstUris.includes(uri))).toEqual([]);

    // 时钟没有退化：投在 turn=2 的条目仍在窗口内，第二次的 turn 也是 2。
    expect(await sessions.totalMessageCount(sessionUri)).toBe(2);
  });

  it('轮次时钟单调：提交前后 turn 不下降', async () => {
    const { sessions, sessionUri } = await prepare();
    const ledger = createLedger();
    const record = vi.spyOn(ledger, 'record');
    const service = await createService({ ledger, sessions });
    const options = contextOptions({ sessionId: sessionUri.name });

    await service.context('记忆', options);
    // 2 条 live 消息 = turn 2。
    expect(record.mock.calls.map((call) => call[2])).toEqual([2]);

    await sessions.commitPhase1(sessionUri);
    await service.context('记忆', options);

    // 提交后 live = 0，累计数仍是 2：turn 不回到 0。
    const turns = record.mock.calls.map((call) => call[2]);
    expect(turns).toEqual([2, 2]);
    expect(turns[1]).toBeGreaterThanOrEqual(turns[0] ?? 0);
  });

  /**
   * `keepRecentCount > 0` 的边界：提交只归档前 `n - keepRecentCount` 条，最后
   * `keepRecentCount` 条留在 live。累计数取「归档段 ID 数 + live 条数」，两段互斥
   * （`archivedMessageIds` 只收归档段），所以和等于提交前的消息总数——不重不漏，
   * 时钟不回退。默认值 0 之外的这个分支以前没有测试。
   */
  it('keepRecentCount > 0 时归档段与保留段不重不漏，时钟仍单调', async () => {
    const { sessions, sessionUri } = await prepare({
      policy: { keepRecentCount: 1 },
      messageIds: ['m1', 'm2', 'm3'],
    });
    const ledger = createLedger();
    const record = vi.spyOn(ledger, 'record');
    const service = await createService({ ledger, sessions });
    const options = contextOptions({ sessionId: sessionUri.name });

    const first = await service.context('记忆', options);
    const firstUris = first.items.map((item) => item.uri);
    expect(firstUris).toEqual([DOC]);
    // 3 条 live 消息 = turn 3。
    expect(record.mock.calls.map((call) => call[2])).toEqual([3]);

    await sessions.commitPhase1(sessionUri);

    // 3 条里归档 2 条、保留 1 条：live 只剩 1，累计数仍是 3。
    const loaded = await sessions.load(sessionUri);
    expect(loaded.messageCount).toBe(1);
    expect(loaded.messages.map((item) => item.id)).toEqual(['m3']);
    expect(await sessions.totalMessageCount(sessionUri)).toBe(3);

    const second = await service.context('记忆', options);
    expect(second.items.map((item) => item.uri).filter((uri) => firstUris.includes(uri))).toEqual(
      [],
    );
    expect(record.mock.calls.map((call) => call[2])).toEqual([3, 3]);
  });

  it('会话读不到时只记 warn，检索照常返回（本次不做跨轮去重）', async () => {
    await writeBody(DOC, '# 标题\n\n正文。');
    await seed(DOC, '记忆', { abstract: '一句话摘要' });
    const service = await createService({ ledger: createLedger(), sessions: createSessions() });

    const result = await service.context('记忆', contextOptions({ sessionId: 'sess_missing' }));

    expect(result.items.map((item) => item.uri)).toEqual([DOC]);
    expect(logger.warn).toHaveBeenCalledWith(
      '会话不可读，本次不做跨轮去重',
      expect.objectContaining({ sessionId: 'sess_missing', code: 'NOT_FOUND' }),
    );
  });
});

describe('rerank', () => {
  const A = 'comem://user/alice/mem/a.md';
  const B = 'comem://user/alice/mem/b.md';
  const C = 'comem://user/alice/mem/c.md';

  function threeHits(): RetrievalIndex {
    return fakeIndex([
      { uri: A, score: 9, abstract: '摘要A' },
      { uri: B, score: 5, abstract: '摘要B' },
      { uri: C, score: 1, abstract: '摘要C' },
    ]);
  }

  function provider(
    score: RerankProvider['score'],
    model = 'test-reranker',
  ): RerankProvider {
    return { model, score };
  }

  it('未注入时不调模型，顺序与融合分一致', async () => {
    const service = await createService({ index: threeHits() });

    const hits = await service.find('记忆', findOptions());

    expect(hits.map((hit) => hit.uri)).toEqual([A, B, C]);
    expect(hits.map((hit) => hit.score)).toEqual([9, 5, 1]);
  });

  it('按模型分数降序，候选文本用摘要，未给分时用融合分', async () => {
    const score = vi.fn(async () => [0.1, 0.9, null] as (number | null)[]);
    const service = await createService({
      index: threeHits(),
      rerank: { provider: provider(score), topN: 50, keepTopN: 0 },
    });

    const hits = await service.find('记忆', findOptions());

    // 候选文本是摘要，不是正文。
    expect(score).toHaveBeenCalledWith('记忆', ['摘要A', '摘要B', '摘要C']);
    // C 没给分：用融合分 1；分数未归一化，直接按原值降序。
    expect(hits.map((hit) => hit.uri)).toEqual([C, B, A]);
    expect(hits.map((hit) => hit.score)).toEqual([1, 0.9, 0.1]);
  });

  it('负数分数不 clamp 到 [0, 1]', async () => {
    const service = await createService({
      index: threeHits(),
      rerank: { provider: provider(async () => [-5, 0.9, 2]), topN: 50, keepTopN: 0 },
    });

    const hits = await service.find('记忆', findOptions());

    expect(hits.map((hit) => hit.score)).toEqual([2, 0.9, -5]);
  });

  it('topN 是送去重排的条数上限', async () => {
    const score = vi.fn(async (_query: string, documents: readonly string[]) =>
      documents.map(() => 0),
    );
    const service = await createService({
      index: threeHits(),
      rerank: { provider: provider(score), topN: 2, keepTopN: 0 },
    });

    const hits = await service.find('记忆', findOptions());

    expect(score).toHaveBeenCalledTimes(1);
    expect(score.mock.calls[0]?.[1]).toEqual(['摘要A', '摘要B']);
    // 没送去重排的 C 保留融合分。
    expect(hits.find((hit) => hit.uri === C)?.score).toBe(1);
  });

  it('keepTopN 在重排之后截断', async () => {
    const service = await createService({
      index: threeHits(),
      rerank: { provider: provider(async () => [0.1, 0.9, 0.5]), topN: 50, keepTopN: 2 },
    });

    const hits = await service.find('记忆', findOptions());

    expect(hits.map((hit) => hit.uri)).toEqual([B, C]);
  });

  it('重排失败时退化为融合分，并记 warn（带 reason / 耗时 / topN）', async () => {
    const service = await createService({
      index: threeHits(),
      rerank: {
        provider: provider(async () => {
          throw new ComemError('PROVIDER_UNAVAILABLE', '供应商挂了');
        }),
        topN: 50,
        keepTopN: 0,
      },
    });

    const hits = await service.find('记忆', findOptions());

    expect(hits.map((hit) => hit.uri)).toEqual([A, B, C]);
    // 没有状态码的 PROVIDER_UNAVAILABLE 是网络不可达（fetch 抛 TypeError）。
    expect(logger.warn).toHaveBeenCalledWith(
      '重排失败，使用融合分',
      expect.objectContaining({
        model: 'test-reranker',
        reason: 'network',
        topN: 3,
        durationMs: expect.any(Number),
      }),
    );
  });

  it('重排健康度：失败后 degraded 为真，成功一次即复位', async () => {
    let fail = true;
    const service = await createService({
      index: threeHits(),
      rerank: {
        provider: provider(async () => {
          if (fail) {
            throw new ComemError('PROVIDER_UNAVAILABLE', '重排调用超时（10000 毫秒）。', {
              timeout: true,
              timeoutMs: 10_000,
            });
          }
          return [0.1, 0.9, 0.5];
        }),
        topN: 50,
        keepTopN: 0,
      },
    });

    expect(service.rerankHealth).toMatchObject({
      configured: true,
      degraded: false,
      failures: 0,
      lastFailure: null,
    });

    await service.find('记忆', findOptions());
    const degraded = service.rerankHealth;
    expect(degraded.degraded).toBe(true);
    expect(degraded.failures).toBe(1);
    expect(degraded.lastFailure?.reason).toBe('timeout');
    expect(degraded.lastFailure?.topN).toBe(3);

    fail = false;
    await service.find('记忆', findOptions());
    // 最近一次成功：degraded 复位，累计失败次数保留（间歇性失败仍看得见）。
    expect(service.rerankHealth).toMatchObject({
      configured: true,
      degraded: false,
      failures: 1,
      lastFailure: null,
    });
  });
});

describe('SearchService 构造', () => {
  it('非法的 queryFilters 在装配期抛错', async () => {
    const assembler = new ContextAssembler({
      store,
      metadata,
      authorizer,
      logger,
    });
    const filesystem = new FileSystemService({
      store,
      locks: createPathLockManager({ dataDir, logger, pollIntervalMs: 1 }),
      authorizer,
      logger,
    });

    expect(
      () =>
        new SearchService({
          index,
          filesystem,
          authorizer,
          assembler,
          logger,
          config: { ...CONFIG, queryFilters: ['not-a-rule'] },
          hotnessWeight: 0,
          hotnessHalfLifeHours: 168,
        }),
    ).toThrow(ComemError);
  });
});

/**
 * 目录的 L1 概览行在检索面上的行为（§8.5、§8.6）。
 *
 * 同一个目录有两行：L0 行（只索引 L0 摘要）与 L1 行（索引概览正文）。两行的
 * `abstract` 相同，所以「同时命中」时要靠 `(uri, abstract)` 去重——否则模型会拿到
 * 两段逐字相同的摘要。
 */
describe('目录的 L1 概览行', () => {
  const DIR = 'comem://user/alice/mem';
  /** 只出现在概览正文里的句子（L0 摘要里没有）。 */
  const OVERVIEW_ONLY = '提交前跑完整测试';
  const L0 = '团队约定';

  async function seedDirectoryRows(): Promise<void> {
    await seed(DIR, '', { kind: 'directory', level: 'L0', abstract: L0 });
    await index.upsert([
      record(DIR, `${L0}的详细说明：${OVERVIEW_ONLY}`, {
        kind: 'directory',
        level: 'L1',
        abstract: L0,
      }),
    ]);
  }

  it('find(levels: [L1]) 命中概览正文，返回的层级是 L1', async () => {
    await seedDirectoryRows();
    const service = await createService();

    const hits = await service.find(OVERVIEW_ONLY, findOptions({ levels: ['L1'] }));

    expect(hits.map((hit) => [hit.uri, hit.level])).toEqual([[DIR, 'L1']]);
    // 展示的仍是 L0 摘要：命中概览行不代表把 4000 字概览塞进结果列表。
    expect(hits[0]?.abstract).toBe(L0);
  });

  it('同一目录的 L0 与 L1 同时命中时只返回一条（摘要逐字相同）', async () => {
    await seedDirectoryRows();
    const service = await createService();

    const hits = await service.find(L0, findOptions());

    const forDirectory = hits.filter((hit) => hit.uri === DIR);
    expect(forDirectory).toHaveLength(1);
    // 留下的是分数高的那条：L1 行的权重 1.05 低于 L0 的 1.15，匹配位置也相同，
    // 所以这里通常是 L0 行；断言不断言具体层级，只断言「只有一条」。
    expect(forDirectory[0]?.abstract).toBe(L0);
  });

  it('find(levels: [L0]) 不会命中 L1 行：层级过滤作用在检索行上', async () => {
    await seedDirectoryRows();
    const service = await createService();

    const hits = await service.find(OVERVIEW_ONLY, findOptions({ levels: ['L0'] }));

    expect(hits).toEqual([]);
  });
});
