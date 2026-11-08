/**
 * 热度加权（`telemetry.hotness.weight`）的接线测试。
 *
 * 索引是假的：分数写死，才能断言 `finalScore = score × (1 + weight × hotness)` 的
 * 实测值；访问统计是真的（内存 SQLite 的 `NodeRepository`），否则「一次 `find` 之后
 * `access_count` 有没有涨」只能靠 mock 自证。
 *
 * 最后一组用**真实装配**（`createContainer`）：服务层单测全绿而生产装配没传依赖，
 * 是「配置项存在但不生效」这类缺陷唯一能藏住的地方。
 */

import type { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ContentStore } from '../../../src/adapters/fs/content-store.js';
import { createPathLockManager } from '../../../src/adapters/fs/lock.js';
import { MetadataFileStore } from '../../../src/adapters/fs/metadata-file.js';
import { openDatabase, runMigrations } from '../../../src/adapters/sqlite/database.js';
import { NodeRepository, type NodeRow } from '../../../src/adapters/sqlite/node-repository.js';
import { createContainer } from '../../../src/bootstrap/container.js';
import type { Level } from '../../../src/domain/level.js';
import type { Logger } from '../../../src/domain/log.js';
import type { ContextType } from '../../../src/domain/node.js';
import type { RetrievalIndex, SearchHit } from '../../../src/domain/retrieval.js';
import { Uri } from '../../../src/domain/uri.js';
import { AllowAllAuthorizer } from '../../../src/services/authorizer.js';
import { ContextAssembler } from '../../../src/services/context-assembler.js';
import { FileSystemService } from '../../../src/services/filesystem.js';
import {
  SearchService,
  type FindOptions,
  type RetrievalSettings,
  type SearchServiceDeps,
} from '../../../src/services/search.js';

const SCOPE = 'comem://user/alice';
const PRINCIPALS = ['user:alice'];
const CREATED_AT = '2026-11-08T00:00:00.000Z';
const HOUR_MS = 60 * 60 * 1000;

const CONFIG: RetrievalSettings = {
  candidateMultiplier: 4,
  levelWeights: { l0: 1.15, l1: 1.05, l2: 1 },
  queryFilters: [],
  assembly: { maxTokens: 1600, dedupTurns: 3, quotaPreset: 'coding' },
};

let dataDir: string;
let db: DatabaseSync;
let nodes: NodeRepository;
let store: ContentStore;
let metadata: MetadataFileStore;
let logger: Logger;
let authorizer: AllowAllAuthorizer;

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
  dataDir = await mkdtemp(join(tmpdir(), 'comem-search-hotness-'));
  logger = createLogger();
  db = openDatabase(':memory:');
  runMigrations(db);
  nodes = new NodeRepository({ db, logger });
  store = new ContentStore({ dataDir, logger });
  metadata = new MetadataFileStore({ dataDir, logger });
  authorizer = new AllowAllAuthorizer();
});

afterEach(async () => {
  vi.restoreAllMocks();
  db.close();
  await rm(dataDir, { recursive: true, force: true });
});

interface FakeHit {
  readonly uri: string;
  readonly score: number;
  readonly level?: Level;
  readonly contextType?: ContextType;
}

/** 假索引：分数由用例写死，`#rank` 只做层级加权（L2 权重 1.0，分数原样保留）。 */
function fakeIndex(entries: readonly FakeHit[]): RetrievalIndex {
  const hits: SearchHit[] = entries.map((entry) => ({
    uri: entry.uri,
    level: entry.level ?? 'L2',
    abstract: null,
    score: entry.score,
    contextType: entry.contextType ?? 'memory',
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

function nodeRow(uri: string): NodeRow {
  return {
    uri,
    parentUri: uri.slice(0, uri.lastIndexOf('/')),
    scope: 'user',
    kind: 'document',
    contextType: 'memory',
    memoryType: null,
    level: 'L2',
    abstract: null,
    bodyDigest: '0000000000000000',
    size: 10,
    updatedAt: CREATED_AT,
    status: 'active',
  };
}

/** 建 `node` 行（`access_count` 从 0 起），再把访问时间写成 `at`。 */
function seedAccess(uris: readonly string[], at: Date): void {
  nodes.upsert(uris.map((uri) => nodeRow(uri)));
  nodes.recordAccess(uris, at);
}

interface HotnessOptions {
  readonly weight?: number;
  readonly halfLifeHours?: number;
  readonly accessStats?: SearchServiceDeps['accessStats'];
  readonly recordAccess?: SearchServiceDeps['recordAccess'];
}

function createService(index: RetrievalIndex, hotness: HotnessOptions = {}): SearchService {
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
    config: CONFIG,
    engine: 'fts5',
    hotnessWeight: hotness.weight,
    hotnessHalfLifeHours: hotness.halfLifeHours,
    accessStats: hotness.accessStats,
    recordAccess: hotness.recordAccess,
  });
}

function findOptions(overrides: Partial<FindOptions> = {}): FindOptions {
  return { scopes: [SCOPE], subject: 'user:alice', principals: PRINCIPALS, ...overrides };
}

describe('weight = 0（默认）', () => {
  const DOC = 'comem://user/alice/mem/design.md';

  it('hotness 恒为 null，accessStats / recordAccess 一次都不调', async () => {
    seedAccess([DOC], new Date());
    const accessStats = vi.fn(() => []);
    const recordAccess = vi.fn();

    const service = createService(fakeIndex([{ uri: DOC, score: 0.5 }]), {
      accessStats,
      recordAccess,
    });
    const hits = await service.find('记忆', findOptions());

    expect(hits.map((hit) => hit.hotness)).toEqual([null]);
    // 分数与接线前逐字一致：没有乘任何系数。
    expect(hits.map((hit) => hit.score)).toEqual([0.5]);
    expect(accessStats).not.toHaveBeenCalled();
    // 默认路径不承担写放大。
    expect(recordAccess).not.toHaveBeenCalled();
  });

  it('不传 hotnessWeight 时同样不查库（默认值就是 0）', async () => {
    seedAccess([DOC], new Date());
    const accessStats = vi.fn(() => []);

    const service = createService(fakeIndex([{ uri: DOC, score: 0.5 }]), { accessStats });
    await service.find('记忆', findOptions());

    expect(accessStats).not.toHaveBeenCalled();
  });
});

describe('weight > 0', () => {
  it('同分命中里热度高的排前面', async () => {
    const COLD = 'comem://user/alice/mem/cold.md';
    const HOT = 'comem://user/alice/mem/hot.md';
    // HOT 刚被访问 100 次，COLD 从没被访问过；两条相关性分数相同。
    nodes.upsert([nodeRow(COLD), nodeRow(HOT)]);
    nodes.recordAccess(new Array<string>(100).fill(HOT), new Date());

    const service = createService(
      fakeIndex([
        { uri: COLD, score: 0.02 },
        { uri: HOT, score: 0.02 },
      ]),
      { weight: 1, accessStats: (uris) => nodes.readAccessStats(uris) },
    );
    const hits = await service.find('记忆', findOptions());

    expect(hits.map((hit) => hit.uri)).toEqual([HOT, COLD]);
    expect(hits[0]?.hotness).toBeGreaterThan(hits[1]?.hotness ?? Number.NaN);
    expect(hits[1]?.hotness).toBe(0);
    // 热度分是 `[0,1]`，weight = 1 时最高只会翻倍。
    expect(hits[0]?.score).toBeGreaterThan(0.02);
    expect(hits[0]?.score).toBeLessThanOrEqual(0.04);
    // 公式：`finalScore = score × (1 + weight × hotness)`。
    expect(hits[0]?.score).toBeCloseTo(0.02 * (1 + (hits[0]?.hotness ?? 0)), 12);
  });

  it('乘性：热度让低分命中不能超过高分命中', async () => {
    const RELEVANT = 'comem://user/alice/mem/relevant.md';
    const HOT_BUT_WEAK = 'comem://user/alice/mem/hot-but-weak.md';
    nodes.upsert([nodeRow(RELEVANT), nodeRow(HOT_BUT_WEAK)]);
    nodes.recordAccess(new Array<string>(100).fill(HOT_BUT_WEAK), new Date());

    const service = createService(
      fakeIndex([
        { uri: HOT_BUT_WEAK, score: 0.4 },
        { uri: RELEVANT, score: 1 },
      ]),
      { weight: 1, accessStats: (uris) => nodes.readAccessStats(uris) },
    );
    const hits = await service.find('记忆', findOptions());

    // 0.4 × (1 + 1 × ~0.99) ≈ 0.79 < 1.0。加性会得到 1.4，直接反超。
    expect(hits.map((hit) => hit.uri)).toEqual([RELEVANT, HOT_BUT_WEAK]);
    expect(hits[0]?.score).toBe(1);
    expect(hits[1]?.score).toBeLessThan(1);
    expect(hits[1]?.score).toBeCloseTo(0.4 * (1 + (hits[1]?.hotness ?? 0)), 12);
  });

  it('同分同热度时按 URI 升序，重复查询顺序不变', async () => {
    const A = 'comem://user/alice/mem/a.md';
    const B = 'comem://user/alice/mem/b.md';
    nodes.upsert([nodeRow(A), nodeRow(B)]);

    const service = createService(
      fakeIndex([
        { uri: B, score: 0.02 },
        { uri: A, score: 0.02 },
      ]),
      { weight: 1, accessStats: (uris) => nodes.readAccessStats(uris) },
    );

    const first = await service.find('记忆', findOptions());
    const second = await service.find('记忆', findOptions());

    expect(first.map((hit) => hit.uri)).toEqual([A, B]);
    expect(second.map((hit) => hit.uri)).toEqual([A, B]);
  });

  it('hotnessHalfLifeHours 传下去：1 小时半衰期下，一小时前的访问热度减半', async () => {
    const OLD = 'comem://user/alice/mem/old.md';
    const FRESH = 'comem://user/alice/mem/fresh.md';
    nodes.upsert([nodeRow(OLD), nodeRow(FRESH)]);
    nodes.recordAccess([OLD], new Date(Date.now() - HOUR_MS));
    nodes.recordAccess([FRESH], new Date());

    const service = createService(
      fakeIndex([
        { uri: OLD, score: 0.02 },
        { uri: FRESH, score: 0.02 },
      ]),
      {
        weight: 1,
        halfLifeHours: 1,
        accessStats: (uris) => nodes.readAccessStats(uris),
      },
    );
    const hits = await service.find('记忆', findOptions());
    const old = hits.find((hit) => hit.uri === OLD);
    const fresh = hits.find((hit) => hit.uri === FRESH);

    expect(fresh?.hotness).toBeGreaterThan(0);
    expect(old?.hotness).toBeCloseTo((fresh?.hotness ?? 0) / 2, 2);
    expect(hits.map((hit) => hit.uri)).toEqual([FRESH, OLD]);
  });
});

describe('hotness 的 null 与 0 不是一回事', () => {
  it('accessStats 里没有这条 URI 时 hotness 是 null（没算），分数不变', async () => {
    const DOC = 'comem://user/alice/mem/orphan.md';
    const service = createService(fakeIndex([{ uri: DOC, score: 0.5 }]), {
      weight: 1,
      accessStats: () => [],
    });
    const [hit] = await service.find('记忆', findOptions());

    expect(hit?.hotness).toBeNull();
    expect(hit?.score).toBe(0.5);
  });

  it('从没被访问过的记忆算出来是 0（不是 null）', async () => {
    const DOC = 'comem://user/alice/mem/never-accessed.md';
    nodes.upsert([nodeRow(DOC)]);

    const service = createService(fakeIndex([{ uri: DOC, score: 0.5 }]), {
      weight: 1,
      accessStats: (uris) => nodes.readAccessStats(uris),
    });
    const [hit] = await service.find('记忆', findOptions());

    expect(hit?.hotness).toBe(0);
  });
});

describe('访问计数', () => {
  const DOC = 'comem://user/alice/mem/design.md';

  it('find 之后 recordAccess 被调用，且不等它完成', async () => {
    nodes.upsert([nodeRow(DOC)]);
    let release: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const recordAccess = vi.fn(() => pending);

    const service = createService(fakeIndex([{ uri: DOC, score: 0.5 }]), {
      weight: 1,
      accessStats: (uris) => nodes.readAccessStats(uris),
      recordAccess,
    });

    // 写事务挂着没完成，`find` 仍然返回——这是 fire-and-forget 的全部意义。
    await expect(service.find('记忆', findOptions())).resolves.toHaveLength(1);
    expect(recordAccess).toHaveBeenCalledWith([DOC]);

    release?.();
    await pending;
  });

  it('一次 find 之后 access_count 真的涨了', async () => {
    nodes.upsert([nodeRow(DOC)]);
    expect(nodes.readAccessStats([DOC])[0]?.accessCount).toBe(0);

    const service = createService(fakeIndex([{ uri: DOC, score: 0.5 }]), {
      weight: 1,
      accessStats: (uris) => nodes.readAccessStats(uris),
      recordAccess: (uris) => nodes.recordAccess(uris, new Date()),
    });
    await service.find('记忆', findOptions());
    // fire-and-forget 在微任务里落库；等一个宏任务再读，避免依赖实现细节。
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(nodes.readAccessStats([DOC])[0]?.accessCount).toBe(1);
    expect(nodes.readAccessStats([DOC])[0]?.lastAccessedAt).not.toBeNull();
  });

  it('search 只按合并去重后的命中记一次', async () => {
    nodes.upsert([nodeRow(DOC)]);
    const recordAccess = vi.fn(() => undefined);

    const service = createService(fakeIndex([{ uri: DOC, score: 0.5 }]), {
      weight: 1,
      accessStats: (uris) => nodes.readAccessStats(uris),
      recordAccess,
    });
    const result = await service.search('记忆', findOptions());

    expect(result.hits).toHaveLength(1);
    expect(recordAccess).toHaveBeenCalledTimes(1);
    expect(recordAccess).toHaveBeenCalledWith([DOC]);
  });
});

describe('构造期校验', () => {
  it('hotnessHalfLifeHours 非正数在装配期抛 INVALID_ARGUMENT', () => {
    expect(() => createService(fakeIndex([]), { weight: 1, halfLifeHours: 0 })).toThrowError(
      expect.objectContaining({ code: 'INVALID_ARGUMENT' }),
    );
  });

  it('hotnessWeight 为负数在装配期抛 INVALID_ARGUMENT', () => {
    expect(() => createService(fakeIndex([]), { weight: -1 })).toThrowError(
      expect.objectContaining({ code: 'INVALID_ARGUMENT' }),
    );
  });
});

/**
 * 生产装配（`createContainer`）的接线。
 *
 * 前面的用例都自己 `new SearchService`，它们证明的是「依赖传进来之后公式成立」。
 * 这一组证明的是**生产装配真的会传**：`config.telemetry.hotness.weight` 是配置项，
 * 而 `SearchServiceDeps` 的四个字段全是可选的——漏传不会报错，只会静默不生效。
 */
describe('装配接线（真实 createContainer）', () => {
  it('telemetry.hotness.weight = 1 时热度参与排序，且 find 之后访问计数落库', async () => {
    const containerDir = await mkdtemp(join(tmpdir(), 'comem-hotness-wiring-'));
    const container = await createContainer({
      configPath: join(containerDir, 'config.yaml'),
      env: {
        ...process.env,
        COMEM_DATA_DIR: containerDir,
        COMEM_SUMMARY_GENERATOR: 'rule',
        COMEM_LOGGING_LEVEL: 'error',
        COMEM_TELEMETRY_HOTNESS_WEIGHT: '1',
      },
    });

    try {
      expect(container.config.telemetry.hotness.weight).toBe(1);

      const HOT = Uri.parse('comem://user/local/memories/hot.md');
      const COLD = Uri.parse('comem://user/local/memories/cold.md');
      // 正文相同 → BM25 相同 → 排序只能由热度决定。
      await container.services.filesystem.write(HOT, '热度接线验证');
      await container.services.filesystem.write(COLD, '热度接线验证');
      await container.services.indexObserver.drain();

      // 访问计数是热度公式里唯一随时间变化的部分；直接写库构造「HOT 刚被读过 100 次」。
      container.db
        .prepare('UPDATE node SET access_count = 100, last_accessed_at = ? WHERE uri = ?')
        .run(new Date().toISOString(), HOT.toString());
      container.db
        .prepare('UPDATE node SET access_count = 0, last_accessed_at = NULL WHERE uri = ?')
        .run(COLD.toString());

      const hits = await container.services.search.find('热度接线验证', {
        scopes: ['comem://user/local/memories'],
        subject: 'user:local',
        principals: ['user:local', 'user:*'],
      });

      expect(hits.map((hit) => hit.uri)).toEqual([HOT.toString(), COLD.toString()]);
      expect(hits[0]?.hotness).toBeGreaterThan(0);
      expect(hits[1]?.hotness).toBe(0);
      expect(hits[0]?.score).toBeGreaterThan(hits[1]?.score ?? Number.NaN);

      // `recordAccess` 也是装配期注入的：不接线的话计数永远停在 100 / 0。
      await container.services.indexObserver.drain();
      const counts = new Map(
        (
          container.db
            .prepare('SELECT uri, access_count FROM node WHERE uri IN (?, ?)')
            .all(HOT.toString(), COLD.toString()) as { uri: string; access_count: number }[]
        ).map((row) => [row.uri, Number(row.access_count)]),
      );
      expect(counts.get(COLD.toString())).toBe(1);
      expect(counts.get(HOT.toString())).toBe(101);
    } finally {
      await container.services.indexObserver.drain();
      await container.close();
      await rm(containerDir, { recursive: true, force: true });
    }
  });
});
