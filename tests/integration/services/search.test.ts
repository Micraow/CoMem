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
import type { IndexRecord } from '../../../src/domain/retrieval.js';
import { Uri } from '../../../src/domain/uri.js';
import {
  AllowAllAuthorizer,
  permissionDenied,
  type AclAction,
  type Authorizer,
} from '../../../src/services/authorizer.js';
import { ContextAssembler } from '../../../src/services/context-assembler.js';
import { FileSystemService } from '../../../src/services/filesystem.js';
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
  readonly ledger?: { recentlyDelivered: () => Promise<ReadonlySet<string>> };
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
    index,
    filesystem,
    authorizer: activeAuthorizer,
    assembler,
    logger,
    config:
      options.maxTokens === undefined
        ? CONFIG
        : { ...CONFIG, assembly: { ...CONFIG.assembly, maxTokens: options.maxTokens } },
    ledger: options.ledger,
  });
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

describe('context', () => {
  const DOC = 'comem://user/alice/mem/m1.md';

  it('返回可直接注入模型的文本', async () => {
    await writeBody(DOC, '# 标题\n\n正文。');
    await seed(DOC, '记忆', { abstract: '一句话摘要' });

    const service = await createService();
    const result = await service.context('记忆', contextOptions());

    expect(result.items).toHaveLength(1);
    expect(result.rendered).toContain('<memory');
    expect(result.tokensUsed).toBeGreaterThan(0);
  });

  it('预算不足时降级而不是超预算', async () => {
    await writeBody(DOC, '正'.repeat(1000));
    await seed(DOC, '记忆', { abstract: '一句话摘要' });

    const service = await createService({ maxTokens: 200 });
    const result = await service.context('记忆', contextOptions());

    expect(result.tokensUsed).toBeLessThanOrEqual(200);
    expect(result.items[0]?.detail).not.toBe('full');
  });

  it('渲染后正文相同的条目只投一次', async () => {
    const other = 'comem://user/alice/mem/m2.md';
    await seed(DOC, '记忆', { abstract: '同一句话' });
    await seed(other, '记忆', { abstract: '同一句话' });

    const service = await createService();
    const result = await service.context('记忆', contextOptions());

    expect(result.items).toHaveLength(1);
  });

  it('excludeDelivered 按召回账本去重', async () => {
    await seed(DOC, '记忆', { abstract: '一句话摘要' });
    const ledger = { recentlyDelivered: vi.fn(async () => new Set([DOC])) };

    const service = await createService({ ledger });
    const result = await service.context(
      '记忆',
      contextOptions({ excludeDelivered: { scopeKey: 'user_alice', turn: 4 } }),
    );

    expect(result.items).toEqual([]);
    expect(ledger.recentlyDelivered).toHaveBeenCalledWith('user_alice', 4, {
      dedupTurns: CONFIG.assembly.dedupTurns,
      maxEntries: 500,
    });
  });

  it('没有注入账本时 excludeDelivered 抛 INVALID_ARGUMENT', async () => {
    await seed(DOC, '记忆');
    const service = await createService();

    await expect(
      service.context(
        '记忆',
        contextOptions({ excludeDelivered: { scopeKey: 'user_alice', turn: 1 } }),
      ),
    ).rejects.toBeInstanceOf(ComemError);
  });

  it('quotaPreset 覆盖配置默认值', async () => {
    await seed(DOC, '记忆', { contextType: 'skill' });
    const service = await createService();

    const result = await service.context('记忆', contextOptions({ quotaPreset: 'chat' }));

    expect(result.items).toHaveLength(1);
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
        }),
    ).toThrow(ComemError);
  });
});
