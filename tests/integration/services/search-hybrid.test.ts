import type { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ContentStore } from '../../../src/adapters/fs/content-store.js';
import { createPathLockManager } from '../../../src/adapters/fs/lock.js';
import { MetadataFileStore } from '../../../src/adapters/fs/metadata-file.js';
import { openDatabase, runMigrations } from '../../../src/adapters/sqlite/database.js';
import { EmbeddingRepository } from '../../../src/adapters/sqlite/embedding-repository.js';
import { NodeRepository } from '../../../src/adapters/sqlite/node-repository.js';
import { SqliteFtsIndex } from '../../../src/adapters/sqlite/retrieval-index.js';
import { SqliteVectorIndex } from '../../../src/adapters/sqlite/vector-index.js';
import { ComemError } from '../../../src/domain/errors.js';
import type { Level } from '../../../src/domain/level.js';
import type { Logger } from '../../../src/domain/log.js';
import type { ContextType } from '../../../src/domain/node.js';
import type { IndexRecord, RetrievalEngine } from '../../../src/domain/retrieval.js';
import { AllowAllAuthorizer } from '../../../src/services/authorizer.js';
import { ContextAssembler } from '../../../src/services/context-assembler.js';
import type { EmbedOutcome } from '../../../src/services/embedding.js';
import { FileSystemService } from '../../../src/services/filesystem.js';
import {
  SearchService,
  type FindOptions,
  type RetrievalSettings,
  type SearchServiceDeps,
} from '../../../src/services/search.js';

const SCOPE = 'comem://user/alice';
const PRINCIPALS = ['user:alice'];
const MODEL = 'test-embedding';
const CREATED_AT = '2026-11-08T00:00:00.000Z';

const CONFIG: RetrievalSettings = {
  candidateMultiplier: 4,
  levelWeights: { l0: 1.15, l1: 1.05, l2: 1 },
  queryFilters: [],
  assembly: { maxTokens: 1600, dedupTurns: 3, quotaPreset: 'coding' },
};

interface FakeEmbedding {
  readonly available: boolean;
  readonly model: string | null;
  readonly embed: ReturnType<typeof vi.fn>;
}

let dataDir: string;
let db: DatabaseSync;
let index: SqliteFtsIndex;
let store: ContentStore;
let metadata: MetadataFileStore;
let logger: Logger;
let authorizer: AllowAllAuthorizer;
let embeddings: EmbeddingRepository;
let vectors: SqliteVectorIndex;
let nodes: NodeRepository;

function createLogger(): Logger {
  const created: Logger = {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => created,
  };
  return created;
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'comem-search-hybrid-'));
  logger = createLogger();
  db = openDatabase(':memory:');
  runMigrations(db);
  index = new SqliteFtsIndex({ db, logger });
  store = new ContentStore({ dataDir, logger });
  metadata = new MetadataFileStore({ dataDir, logger });
  authorizer = new AllowAllAuthorizer();
  embeddings = new EmbeddingRepository({ db, logger });
  embeddings.ensureSchema(2, MODEL);
  vectors = new SqliteVectorIndex({ db, logger });
  nodes = new NodeRepository({ db, logger });
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
}

function record(uri: string, content: string, overrides: RecordOverrides = {}): IndexRecord {
  return {
    uri,
    parentUri: uri.slice(0, uri.lastIndexOf('/')),
    scope: 'user',
    kind: 'document',
    contextType: overrides.contextType ?? 'memory',
    memoryType: null,
    level: overrides.level ?? 'L2',
    abstract: overrides.abstract ?? null,
    content,
    bodyDigest: '0000000000000000',
    size: Buffer.byteLength(content),
    updatedAt: CREATED_AT,
    status: 'active',
  };
}

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

function deny(uri: string, principal = 'user:alice'): void {
  db.prepare(
    "INSERT INTO node_permission (node_uri, principal, level, effect) VALUES (?, ?, 1, 'deny')",
  ).run(uri, principal);
}

/** 落库：归一化由仓储在写入边界做（见 `EmbeddingRepository.upsert`）。 */
function storeVector(uri: string, vector: readonly number[]): void {
  embeddings.upsert([
    {
      uri,
      model: MODEL,
      contentDigest: '0000000000000000',
      vector,
    },
  ]);
}

/** 查询向量：含「语义」的查询落到 `[1, 0]`，其余落到 `[0, 1]`。 */
function semanticEmbedding(): FakeEmbedding {
  return {
    available: true,
    model: MODEL,
    embed: vi.fn(async (texts: readonly string[]): Promise<EmbedOutcome> => ({
      vectors: texts.map((text) => (text.includes('语义') ? [1, 0] : [0, 1])),
      degraded: false,
      reason: null,
    })),
  };
}

function degradedEmbedding(reason = '供应商不可用'): FakeEmbedding {
  return {
    available: false,
    model: MODEL,
    embed: vi.fn(
      async (): Promise<EmbedOutcome> => ({ vectors: [], degraded: true, reason }),
    ),
  };
}

function createService(options: {
  readonly engine: RetrievalEngine;
  readonly embedding?: FakeEmbedding;
  readonly levelWeights?: RetrievalSettings['levelWeights'];
  readonly rerank?: SearchServiceDeps['rerank'];
}): SearchService {
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

  return new SearchService({
    index,
    filesystem,
    authorizer,
    assembler,
    logger,
    config:
      options.levelWeights === undefined
        ? CONFIG
        : { ...CONFIG, levelWeights: options.levelWeights },
    engine: options.engine,
    ...(options.embedding === undefined
      ? {}
      : { embedding: options.embedding, vectors, nodes }),
    ...(options.rerank === undefined ? {} : { rerank: options.rerank }),
  });
}

function findOptions(overrides: Partial<FindOptions> = {}): FindOptions {
  return { scopes: [SCOPE], subject: 'user:alice', principals: PRINCIPALS, ...overrides };
}

describe('engine: fts5', () => {
  const DOC = 'comem://user/alice/mem/db.md';

  it('回归基线：命中形状与查询参数与接入向量前逐字一致', async () => {
    await seed(DOC, '上下文记忆数据库的设计');
    const service = createService({ engine: 'fts5' });
    const search = vi.spyOn(index, 'search');

    const hits = await service.find('记忆', findOptions());

    expect(hits).toEqual([
      {
        uri: DOC,
        contextType: 'memory',
        memoryType: null,
        level: 'L2',
        abstract: null,
        score: expect.any(Number),
        ranks: null,
        // 热度默认关闭（`telemetry.hotness.weight = 0`）：这一列恒为 null，
        // 分数与顺序与接线前一致。
        hotness: null,
      },
    ]);
    expect(search).toHaveBeenCalledWith({
      text: '记忆',
      scopes: [SCOPE],
      principals: PRINCIPALS,
      contextTypes: undefined,
      levels: undefined,
      limit: 20,
    });
  });

  it('不构造向量索引也不调嵌入', async () => {
    await seed(DOC, '上下文记忆数据库的设计');
    const embedding = semanticEmbedding();
    const service = createService({ engine: 'fts5', embedding });
    const vectorSearch = vi.spyOn(vectors, 'search');

    await service.find('记忆', findOptions());

    expect(embedding.embed).not.toHaveBeenCalled();
    expect(vectorSearch).not.toHaveBeenCalled();
  });
});

describe('engine: vector', () => {
  const MATCHING = 'comem://user/alice/mem/vector.md';
  const NO_EMBEDDING = 'comem://user/alice/mem/fts-only.md';

  it('只用向量，FTS5 一次都不查', async () => {
    await seed(MATCHING, '完全无关的正文');
    await seed(NO_EMBEDDING, '语义 记忆 数据库');
    storeVector(MATCHING, [1, 0]);

    const service = createService({ engine: 'vector', embedding: semanticEmbedding() });
    const ftsSearch = vi.spyOn(index, 'search');

    const hits = await service.find('语义', findOptions());

    expect(ftsSearch).not.toHaveBeenCalled();
    expect(hits.map((hit) => hit.uri)).toEqual([MATCHING]);
    expect(hits[0]?.ranks).toEqual({ fts5: null, vector: 1, hybrid: null });
  });

  it('降级时返回空命中，并有说明', async () => {
    await seed(MATCHING, '语义 记忆');
    const service = createService({ engine: 'vector', embedding: degradedEmbedding() });

    await expect(service.find('语义', findOptions())).resolves.toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      '向量检索降级',
      expect.objectContaining({ engine: 'vector', reason: '供应商不可用' }),
    );
  });

  it('search 的 plan.reason 记录降级原因', async () => {
    await seed(MATCHING, '语义 记忆');
    const service = createService({ engine: 'vector', embedding: degradedEmbedding() });

    const result = await service.search('语义', findOptions());

    expect(result.hits).toEqual([]);
    expect(result.plan.reason).toContain('供应商不可用');
  });
});

describe('engine: hybrid', () => {
  const BOTH = 'comem://user/alice/mem/both.md';
  const VECTOR_ONLY = 'comem://user/alice/mem/vector-only.md';

  it('两路都跑、融合、去重、ranks 正确', async () => {
    await seed(BOTH, '语义 记忆');
    await seed(VECTOR_ONLY, '完全无关的正文');
    storeVector(BOTH, [0.8, 0.6]);
    storeVector(VECTOR_ONLY, [1, 0]);

    const service = createService({ engine: 'hybrid', embedding: semanticEmbedding() });
    const ftsSearch = vi.spyOn(index, 'search');
    const vectorSearch = vi.spyOn(vectors, 'search');

    const hits = await service.find('语义', findOptions());

    expect(ftsSearch).toHaveBeenCalledTimes(1);
    expect(vectorSearch).toHaveBeenCalledTimes(1);
    // BOTH 同时被两个后端命中：融合分 1/61 + 1/62 高于只有向量的 VECTOR_ONLY。
    expect(hits.map((hit) => hit.uri)).toEqual([BOTH, VECTOR_ONLY]);
    expect(hits[0]?.ranks).toEqual({ fts5: 1, vector: 2, hybrid: null });
    expect(hits[1]?.ranks).toEqual({ fts5: null, vector: 1, hybrid: null });
    // 去重：同一个 URI 只出现一次。
    expect(new Set(hits.map((hit) => hit.uri)).size).toBe(hits.length);
  });

  it('向量降级时退化成纯 FTS5，并在 plan 里标明', async () => {
    await seed(BOTH, '语义 记忆');
    const service = createService({ engine: 'hybrid', embedding: degradedEmbedding('供应商 503') });

    const hits = await service.find('语义', findOptions());
    expect(hits.map((hit) => hit.uri)).toEqual([BOTH]);
    expect(hits[0]?.ranks).toEqual({ fts5: 1, vector: null, hybrid: null });

    const result = await service.search('语义', findOptions());
    expect(result.plan.reason).toContain('供应商 503');
  });

  it('search 的 matchedQuery 与 ranks 字段完整', async () => {
    await seed(BOTH, '语义 记忆');
    await seed(VECTOR_ONLY, '完全无关的正文');
    storeVector(BOTH, [0.8, 0.6]);
    storeVector(VECTOR_ONLY, [1, 0]);

    const service = createService({ engine: 'hybrid', embedding: semanticEmbedding() });
    const result = await service.search('语义', findOptions());

    expect(result.hits).toHaveLength(2);
    for (const hit of result.hits) {
      // 没有注入 LlmService 时兜底成单条原查询。
      expect(hit.matchedQuery).toBe('语义');
      expect(hit.ranks).not.toBeNull();
    }
  });
});

describe('层级权重（§8.5）', () => {
  /**
   * 两个文档各只被一个后端命中：L0 只进 FTS5，L2 只进向量。
   *
   * 这样两边的原始 RRF 贡献都是 `1/61`，**同分**——不加层级先验时按 URI 升序，
   * 加了之后 L0（1.15）必须排到 L2（1.00）前面。用同分构造是为了证明「权重真的
   * 作用在融合分上」，而不是被别的排序因素盖住。
   */
  const L0_ONLY_FTS = 'comem://user/alice/mem/z-l0.md';
  const L2_ONLY_VECTOR = 'comem://user/alice/mem/a-l2.md';

  async function seedTie(): Promise<FakeEmbedding> {
    await seed(L0_ONLY_FTS, '语义 记忆', { level: 'L0' });
    await seed(L2_ONLY_VECTOR, '完全无关的正文', { level: 'L2' });
    storeVector(L2_ONLY_VECTOR, [1, 0]);
    return semanticEmbedding();
  }

  it('层级权重乘在每个后端对融合分的贡献上', async () => {
    const embedding = await seedTie();
    const service = createService({ engine: 'hybrid', embedding });

    const hits = await service.find('语义', findOptions());

    expect(hits.map((hit) => hit.uri)).toEqual([L0_ONLY_FTS, L2_ONLY_VECTOR]);
    expect(hits[0]?.score).toBeCloseTo(1.15 / 61, 12);
    expect(hits[1]?.score).toBeCloseTo(1 / 61, 12);
  });

  it('权重全为 1 时退化成标准 RRF（向后兼容）', async () => {
    const embedding = await seedTie();
    const service = createService({
      engine: 'hybrid',
      embedding,
      levelWeights: { l0: 1, l1: 1, l2: 1 },
    });

    const hits = await service.find('语义', findOptions());

    // 同分按 URI 升序：a-l2 在 z-l0 前面。
    expect(hits.map((hit) => hit.uri)).toEqual([L2_ONLY_VECTOR, L0_ONLY_FTS]);
    expect(hits[0]?.score).toBeCloseTo(1 / 61, 12);
    expect(hits[1]?.score).toBeCloseTo(1 / 61, 12);
  });
});

describe('重排后的层级先验', () => {
  const L0_DOC = 'comem://user/alice/mem/z-summary.md';
  const L2_DOC = 'comem://user/alice/mem/a-original.md';

  /** 模型对两条候选给**同一个分**：此时先后完全由层级先验决定。 */
  function fixedRerank(score = 0.5): SearchServiceDeps['rerank'] {
    return {
      provider: { model: 'test-reranker', score: vi.fn(async () => [score, score]) },
      topN: 50,
      keepTopN: 0,
    };
  }

  it('重排后重新施加层级先验（模型同分时 L0 赢 L2）', async () => {
    await seed(L0_DOC, '语义 记忆', { level: 'L0', abstract: 'L0 摘要' });
    await seed(L2_DOC, '语义 记忆', { level: 'L2', abstract: 'L2 原文' });
    const service = createService({ engine: 'fts5', rerank: fixedRerank() });

    const hits = await service.find('语义', findOptions());

    expect(hits.map((hit) => hit.uri)).toEqual([L0_DOC, L2_DOC]);
    expect(hits[0]?.score).toBeCloseTo(0.5 * 1.15, 12);
    expect(hits[1]?.score).toBeCloseTo(0.5, 12);
  });

  it('层级权重全为 1 时重排分原样保留', async () => {
    await seed(L0_DOC, '语义 记忆', { level: 'L0', abstract: 'L0 摘要' });
    await seed(L2_DOC, '语义 记忆', { level: 'L2', abstract: 'L2 原文' });
    const service = createService({
      engine: 'fts5',
      levelWeights: { l0: 1, l1: 1, l2: 1 },
      rerank: fixedRerank(),
    });

    const hits = await service.find('语义', findOptions());

    // 同分按 URI 升序：a-original 在 z-summary 前面。
    expect(hits.map((hit) => hit.uri)).toEqual([L2_DOC, L0_DOC]);
    expect(hits.map((hit) => hit.score)).toEqual([0.5, 0.5]);
  });

  it('全部候选都没有可用文本时不发重排请求', async () => {
    // 只写索引、不写文件：`#rerankText` 读正文会抛 `NOT_FOUND`，摘要又是 null，
    // 两条候选的文本都是空串。模型对空串打不出有意义的分数，这次请求不该发。
    await seed(L0_DOC, '语义 记忆', { level: 'L0' });
    await seed(L2_DOC, '语义 记忆', { level: 'L2' });
    const rerank = fixedRerank();
    const service = createService({ engine: 'fts5', rerank });

    const hits = await service.find('语义', findOptions());

    expect(hits).toHaveLength(2);
    expect(rerank?.provider.score).not.toHaveBeenCalled();
  });
});

describe('权限过滤', () => {
  const ALLOWED = 'comem://user/alice/mem/allowed.md';
  const DENIED = 'comem://user/alice/mem/denied.md';

  it('传给向量索引的是权限过滤后的全量 URI', async () => {
    await seed(ALLOWED, '语义 记忆');
    // §8.2：通配 allow + 具体 deny 共存，deny 赢。两者是不同主体，不会撞主键。
    await seed(DENIED, '语义 记忆', {}, 'user:*');
    deny(DENIED);
    storeVector(ALLOWED, [1, 0]);
    storeVector(DENIED, [1, 0]);

    const principals = ['user:alice', 'user:*'];
    const service = createService({ engine: 'vector', embedding: semanticEmbedding() });
    const vectorSearch = vi.spyOn(vectors, 'search');

    const hits = await service.find('语义', findOptions({ principals }));

    expect(hits.map((hit) => hit.uri)).toEqual([ALLOWED]);
    const [query] = vectorSearch.mock.calls[0] ?? [];
    expect(query?.uris).toEqual([ALLOWED]);
  });
});

describe('引擎差异', () => {
  const LEXICAL = 'comem://user/alice/mem/lexical.md';
  const SEMANTIC = 'comem://user/alice/mem/semantic.md';

  it('同一个 query 在 fts5 与 vector 下返回不同命中（配置真的生效）', async () => {
    // LEXICAL 含查询词、没有向量；SEMANTIC 语义相关、但不含查询词。
    await seed(LEXICAL, '语义 记忆');
    await seed(SEMANTIC, '完全无关的正文');
    storeVector(SEMANTIC, [1, 0]);

    const fts5Hits = await createService({ engine: 'fts5' }).find('语义', findOptions());
    const vectorHits = await createService({
      engine: 'vector',
      embedding: semanticEmbedding(),
    }).find('语义', findOptions());

    expect(fts5Hits.map((hit) => hit.uri)).toEqual([LEXICAL]);
    expect(vectorHits.map((hit) => hit.uri)).toEqual([SEMANTIC]);
  });
});

describe('SearchService 构造', () => {
  it('engine 非 fts5 时缺向量依赖在装配期抛 INVALID_ARGUMENT', () => {
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
          config: CONFIG,
          engine: 'vector',
        }),
    ).toThrow(ComemError);
  });
});
