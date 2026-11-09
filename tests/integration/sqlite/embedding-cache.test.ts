/**
 * 嵌入缓存仓储（架构文档 §8.1 的 `embedding_cache` 表）。
 *
 * 这一层只测「表怎么读写」：命中、维度不一致、淘汰、清空。**为什么缓存存在**、
 * 命中之后省掉的是哪次调用，在 `tests/integration/services/embedding-cache.test.ts`
 * 里从服务层测——那是使用者看到的行为。
 */

import type { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { openDatabase, runMigrations } from '../../../src/adapters/sqlite/database.js';
import {
  EmbeddingCacheRepository,
  type EmbeddingCacheEntry,
} from '../../../src/adapters/sqlite/embedding-cache.js';
import { ComemError } from '../../../src/domain/errors.js';
import type { Logger } from '../../../src/domain/log.js';

const MODEL = 'text-embedding-3-small';
const OTHER_MODEL = 'bge-m3';
const DIMENSION = 4;

let db: DatabaseSync;
let logger: Logger;

function createLogger(): Logger {
  const created: Logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return created;
}

function createCache(maxEntries = 100): EmbeddingCacheRepository {
  return new EmbeddingCacheRepository({ db, logger, maxEntries });
}

/** 一条可辨认的向量：第 `axis` 位是 1，其余是 0。 */
function basis(axis: number): number[] {
  const vector = new Array<number>(DIMENSION).fill(0);
  vector[axis % DIMENSION] = 1;
  return vector;
}

function entry(digest: string, axis: number, model = MODEL): EmbeddingCacheEntry {
  return { model, contentDigest: digest, dimension: DIMENSION, vector: basis(axis) };
}

/** `embedding_cache` 的物理行数；`count` 是仓储私有方法，测试直接查表。 */
function cacheRows(): number {
  return Number(db.prepare('SELECT COUNT(*) AS total FROM embedding_cache').get()?.['total'] ?? 0);
}

beforeEach(() => {
  db = openDatabase(':memory:');
  runMigrations(db);
  logger = createLogger();
});

afterEach(() => {
  db.close();
  vi.restoreAllMocks();
});

describe('EmbeddingCacheRepository', () => {
  it('写进去能按 (model, digest) 读回来', () => {
    const cache = createCache();
    cache.put([entry('aaaa', 1), entry('bbbb', 2)]);

    const found = cache.getMany(MODEL, ['aaaa', 'bbbb'], DIMENSION);
    expect([...found.keys()].sort()).toEqual(['aaaa', 'bbbb']);
    expect(found.get('aaaa')?.[1]).toBe(1);
    expect(found.get('bbbb')?.[2]).toBe(1);
  });

  it('未命中的 digest 不在结果里', () => {
    const cache = createCache();
    cache.put([entry('aaaa', 0)]);

    const found = cache.getMany(MODEL, ['aaaa', 'zzzz'], DIMENSION);
    expect([...found.keys()]).toEqual(['aaaa']);
  });

  it('模型不同不算命中：缓存不跨模型', () => {
    const cache = createCache();
    cache.put([entry('aaaa', 0)]);

    expect(cache.getMany(OTHER_MODEL, ['aaaa'], DIMENSION).size).toBe(0);
    // 同一个 digest 在两个模型下可以各存一份。
    cache.put([entry('aaaa', 3, OTHER_MODEL)]);
    expect(cache.getMany(MODEL, ['aaaa'], DIMENSION).get('aaaa')?.[0]).toBe(1);
    expect(cache.getMany(OTHER_MODEL, ['aaaa'], DIMENSION).get('aaaa')?.[3]).toBe(1);
  });

  it('维度与配置不一致的行当未命中，并记一条 warn', () => {
    const cache = createCache();
    cache.put([entry('aaaa', 0)]);

    // 模型名没变、维度变了（换量化版本 / 配置写错）：主键仍然命中，向量长度不对。
    const found = cache.getMany(MODEL, ['aaaa'], DIMENSION + 1);
    expect(found.size).toBe(0);
    expect(logger.warn).toHaveBeenCalledWith(
      '嵌入缓存维度与配置不一致，按未命中处理',
      expect.objectContaining({ model: MODEL, expected: DIMENSION + 1, rows: 1 }),
    );
  });

  it('同一个 (model, digest) 覆盖写，不涨行数', () => {
    const cache = createCache();
    cache.put([entry('aaaa', 0)]);
    cache.put([entry('aaaa', 2)]);

    expect(cacheRows()).toBe(1);
    expect(cache.getMany(MODEL, ['aaaa'], DIMENSION).get('aaaa')?.[2]).toBe(1);
  });

  it('超过 maxEntries 按插入顺序淘汰最旧的行', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-11-08T00:00:00.000Z'));
      const cache = createCache(2);
      cache.put([entry('oldest', 0), entry('older', 1)]);
      vi.setSystemTime(new Date('2026-11-08T00:00:01.000Z'));
      cache.put([entry('newer', 2)]);
      vi.setSystemTime(new Date('2026-11-08T00:00:02.000Z'));
      cache.put([entry('newest', 3)]);

      expect(cacheRows()).toBe(2);
      const found = cache.getMany(MODEL, ['oldest', 'older', 'newer', 'newest'], DIMENSION);
      // 留下的是最近插入的两条。
      expect([...found.keys()].sort()).toEqual(['newer', 'newest']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('一次写超过上限时按 rowid 做确定性 tie-break', () => {
    const cache = createCache(2);
    // 同一次 put 的 created_at 相同，淘汰顺序只能靠 rowid（插入顺序）。
    cache.put([entry('a', 0), entry('b', 1), entry('c', 2), entry('d', 3)]);

    expect(cacheRows()).toBe(2);
    expect([...cache.getMany(MODEL, ['a', 'b', 'c', 'd'], DIMENSION).keys()].sort()).toEqual([
      'c',
      'd',
    ]);
  });

  it('空输入不打 SQL', () => {
    const cache = createCache();
    const prepare = vi.spyOn(db, 'prepare');

    expect(cache.getMany(MODEL, [], DIMENSION).size).toBe(0);
    cache.put([]);
    expect(prepare).not.toHaveBeenCalled();
  });

  it('maxEntries 非正整数在构造期抛 INVALID_ARGUMENT', () => {
    for (const maxEntries of [0, -1, 1.5]) {
      expect(() => new EmbeddingCacheRepository({ db, logger, maxEntries })).toThrow(ComemError);
    }
  });

  it('迁移建出表与 created_at 索引', () => {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'embedding_cache'")
      .all();
    expect(tables).toHaveLength(1);
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?")
      .all('idx_embedding_cache_created');
    expect(indexes).toHaveLength(1);
  });
});
