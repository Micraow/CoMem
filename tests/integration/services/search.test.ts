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
import { ComemError } from '../../../src/domain/errors.js';
import type { Level } from '../../../src/domain/level.js';
import type { Logger } from '../../../src/domain/log.js';
import type { ContextType } from '../../../src/domain/node.js';
import type { IndexRecord, RetrievalIndex, SearchHit } from '../../../src/domain/retrieval.js';
import type { RerankProvider } from '../../../src/domain/rerank.js';
import { Uri } from '../../../src/domain/uri.js';
import {
  AllowAllAuthorizer,
  permissionDenied,
  type AclAction,
  type Authorizer,
} from '../../../src/services/authorizer.js';
import { ContextAssembler } from '../../../src/services/context-assembler.js';
import { FileSystemService } from '../../../src/services/filesystem.js';
import type { DeliveredItem, RecallLedger } from '../../../src/services/recall-ledger.js';
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
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => logger,
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
    estimateTokens: (text) => text.length,
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

  it('scoreThreshold 在加权之后过滤', async () => {
    await seed(DOC, '上下文记忆数据库的设计', { level: 'L2' });
    const service = await createService();

    const [hit] = await service.find('记忆', findOptions());
    expect(hit).toBeDefined();
    const score = hit?.score ?? 0;

    await expect(service.find('记忆', findOptions({ scoreThreshold: score + 1 }))).resolves.toEqual(
      [],
    );
    await expect(
      service.find('记忆', findOptions({ scoreThreshold: score - 1 })),
    ).resolves.toHaveLength(1);
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

    const service = await createService({ ledger });
    const first = await service.context(
      '记忆',
      contextOptions({
        excludeDelivered: { scopeKey: 'user_alice', sessionId: 'sess_1', turn: 4 },
      }),
    );

    expect(first.items.map((item) => item.uri)).toEqual([DOC]);
    expect(ledger.record).toHaveBeenCalledWith('user_alice', 'sess_1', 4, first.items, {
      dedupTurns: CONFIG.assembly.dedupTurns,
      maxEntries: 500,
    });

    const second = await service.context(
      '记忆',
      contextOptions({
        excludeDelivered: { scopeKey: 'user_alice', sessionId: 'sess_1', turn: 4 },
      }),
    );
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

    const service = await createService({ ledger });
    const result = await service.context(
      '记忆',
      contextOptions({
        excludeDelivered: { scopeKey: 'user_alice', sessionId: 'sess_1', turn: 1 },
      }),
    );

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

  it('没有注入账本时 excludeDelivered 抛 INVALID_ARGUMENT', async () => {
    await seed(DOC, '记忆');
    const service = await createService();

    await expect(
      service.context(
        '记忆',
        contextOptions({
          excludeDelivered: { scopeKey: 'user_alice', sessionId: 'sess_1', turn: 1 },
        }),
      ),
    ).rejects.toBeInstanceOf(ComemError);
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

  it('重排失败时退化为融合分，并记 warn', async () => {
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
    expect(logger.warn).toHaveBeenCalledWith(
      '重排失败，使用融合分',
      expect.objectContaining({ model: 'test-reranker', candidates: 3 }),
    );
  });
});

describe('SearchService 构造', () => {
  it('非法的 queryFilters 在装配期抛错', async () => {
    const assembler = new ContextAssembler({
      store,
      metadata,
      authorizer,
      logger,
      estimateTokens: (text) => text.length,
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
