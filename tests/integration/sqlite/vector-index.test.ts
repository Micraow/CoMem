import type { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { openDatabase, runMigrations } from '../../../src/adapters/sqlite/database.js';
import {
  EmbeddingRepository,
  type EmbeddingRow,
} from '../../../src/adapters/sqlite/embedding-repository.js';
import { SqliteVectorIndex } from '../../../src/adapters/sqlite/vector-index.js';
import type { Logger } from '../../../src/domain/log.js';

const MODEL = 'text-embedding-3-small';
const OLD_MODEL = 'text-embedding-ada-002';
const SCOPE = 'comem://user/alice';

/** 规模测试：1 万条 × 1024 维。 */
const SCALE_ROWS = 10_000;
const SCALE_DIMENSION = 1024;

let db: DatabaseSync;
let embeddings: EmbeddingRepository;
let index: SqliteVectorIndex;
let logger: Logger;

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

/**
 * 建虚拟表并构造索引。
 *
 * `vec0` 的维度固定在 `CREATE VIRTUAL TABLE` 时，而每个用例一个 `:memory:` 库，
 * 所以维度按用例传。生产里由 `bootstrap/container.ts` 在启动时按配置调一次。
 */
function openIndex(dimension: number): void {
  embeddings = new EmbeddingRepository({ db, logger });
  embeddings.ensureSchema(dimension, MODEL);
  index = new SqliteVectorIndex({ db, logger });
}

function store(uri: string, vector: readonly number[], model = MODEL): void {
  embeddings.upsert([
    {
      uri,
      model,
      contentDigest: '0000000000000000',
      vector,
    },
  ]);
}

/** 单位圆上第 `degrees` 度的二维向量。查询向量固定为 `[1, 0]` 时，分数就是 cos。 */
function angle(degrees: number): number[] {
  const radians = (degrees * Math.PI) / 180;
  return [Math.cos(radians), Math.sin(radians)];
}

function uriFor(name: string): string {
  return `${SCOPE}/memories/${name}`;
}

beforeEach(() => {
  db = openDatabase(':memory:');
  runMigrations(db);
  logger = createLogger();
});

afterEach(() => {
  db.close();
});

describe('最近邻', () => {
  it('按余弦相似度降序返回', async () => {
    openIndex(2);
    // 0° / 30° / 60° / 90°，查询 [1, 0]：分数分别是 1、0.866、0.5、0。
    const degrees = [0, 30, 60, 90];
    for (const degree of degrees) {
      store(uriFor(`v${String(degree)}`), angle(degree));
    }

    const hits = await index.search({ vector: [1, 0], model: MODEL, limit: 10 });

    expect(hits.map((hit) => hit.uri)).toEqual(degrees.map((degree) => uriFor(`v${String(degree)}`)));
    expect(hits[0]?.score).toBeCloseTo(1, 2);
    expect(hits[1]?.score).toBeCloseTo(0.866, 2);
    expect(hits[2]?.score).toBeCloseTo(0.5, 2);
    expect(hits[3]?.score).toBeCloseTo(0, 2);
  });

  it('limit 截断到最近的 N 条', async () => {
    openIndex(2);
    for (const degree of [0, 20, 40, 60]) {
      store(uriFor(`v${String(degree)}`), angle(degree));
    }

    const hits = await index.search({ vector: [1, 0], model: MODEL, limit: 2 });

    expect(hits.map((hit) => hit.uri)).toEqual([uriFor('v0'), uriFor('v20')]);
  });

  it('同分按 URI 升序（顺序稳定）', async () => {
    openIndex(2);
    store(uriFor('b'), angle(0));
    store(uriFor('a'), angle(0));
    store(uriFor('c'), angle(0));

    const hits = await index.search({ vector: [1, 0], model: MODEL, limit: 10 });

    expect(hits.map((hit) => hit.uri)).toEqual([uriFor('a'), uriFor('b'), uriFor('c')]);
  });

  it('空库返回空', async () => {
    openIndex(2);

    expect(await index.search({ vector: [1, 0], model: MODEL, limit: 10 })).toEqual([]);
  });
});

describe('候选集', () => {
  it('uris 限定候选集', async () => {
    openIndex(2);
    store(uriFor('a'), angle(0));
    store(uriFor('b'), angle(10));
    store(uriFor('c'), angle(20));

    const hits = await index.search({
      vector: [1, 0],
      model: MODEL,
      uris: [uriFor('b'), uriFor('c')],
      limit: 10,
    });

    expect(hits.map((hit) => hit.uri)).toEqual([uriFor('b'), uriFor('c')]);
  });

  it('候选集收窄后仍返回候选：k 不会先于 uri 过滤截断', async () => {
    openIndex(2);
    // `a` 是全局最近邻但不在候选集里；`b` 是唯一候选，且比 `a` 远。
    // `k` 是 uri 过滤之前的全局最近邻个数：k = limit = 1 时 vec0 只会取出 `a`，
    // 再被 `uri IN` 丢掉，候选集不为空却返回空。类型 / 时间下推收窄候选之后这是
    // 常态（最近邻全是偏好，规则只剩几条）。
    store(uriFor('a'), angle(0));
    store(uriFor('b'), angle(30));

    const hits = await index.search({
      vector: [1, 0],
      model: MODEL,
      uris: [uriFor('b')],
      limit: 1,
    });

    expect(hits.map((hit) => hit.uri)).toEqual([uriFor('b')]);
  });

  it('uris 为空数组返回空，不是全库扫描', async () => {
    openIndex(2);
    store(uriFor('a'), angle(0));
    const statement = vi.spyOn(db, 'prepare');

    expect(await index.search({ vector: [1, 0], model: MODEL, uris: [], limit: 10 })).toEqual([]);
    expect(logger.debug).toHaveBeenCalledWith(
      '向量检索：候选集为空',
      expect.objectContaining({ model: MODEL }),
    );
    expect(statement).not.toHaveBeenCalled();
  });

  it('uris 里有不存在的 URI 时跳过', async () => {
    openIndex(2);
    store(uriFor('a'), angle(0));

    const hits = await index.search({
      vector: [1, 0],
      model: MODEL,
      uris: [uriFor('a'), uriFor('missing')],
      limit: 10,
    });

    expect(hits.map((hit) => hit.uri)).toEqual([uriFor('a')]);
  });

  it('uris 超过 500 条时分批查询并合并', async () => {
    openIndex(2);
    // 600 条按「离第 550 条多远」排：前 10 名横跨两片（545–550 在第一片，
    // 551–554 在第二片），合并顺序错了会立刻看出来。
    const uris: string[] = [];
    for (let item = 0; item < 600; item += 1) {
      const uri = uriFor(`chunk-${String(item).padStart(3, '0')}`);
      uris.push(uri);
      // 与 [1, 0] 的余弦随 |item - 550| 单调下降；第二片多 0.5，避免跨片的平局。
      store(uri, [1, (Math.abs(item - 550) + (item > 550 ? 0.5 : 0)) * 0.01]);
    }

    const hits = await index.search({ vector: [1, 0], model: MODEL, uris, limit: 10 });

    expect(hits.map((hit) => hit.uri)).toEqual(
      [550, 549, 551, 548, 552, 547, 553, 546, 554, 545].map((item) =>
        uriFor(`chunk-${String(item).padStart(3, '0')}`),
      ),
    );
  });
});

describe('模型与维度', () => {
  it('模型不匹配的行由 SQL 过滤，不参与排序', async () => {
    openIndex(2);
    store(uriFor('current'), angle(0));
    store(uriFor('stale'), angle(0), OLD_MODEL);

    const hits = await index.search({ vector: [1, 0], model: MODEL, limit: 10 });

    expect(hits.map((hit) => hit.uri)).toEqual([uriFor('current')]);
  });

  it('查询向量为全零时抛 INVALID_ARGUMENT', async () => {
    openIndex(2);

    await expect(index.search({ vector: [0, 0], model: MODEL, limit: 10 })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
  });

  it('查询向量含 NaN 时抛 INVALID_ARGUMENT', async () => {
    openIndex(2);

    await expect(
      index.search({ vector: [1, Number.NaN], model: MODEL, limit: 10 }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('limit 不是正整数时抛 INVALID_ARGUMENT', async () => {
    openIndex(2);
    for (const limit of [0, -1, 1.5]) {
      await expect(index.search({ vector: [1, 0], model: MODEL, limit })).rejects.toMatchObject({
        code: 'INVALID_ARGUMENT',
      });
    }
  });
});

describe('minScore', () => {
  it('默认 0：负余弦被丢弃', async () => {
    openIndex(2);
    store(uriFor('same'), angle(0));
    store(uriFor('orthogonal'), angle(90));
    store(uriFor('opposite'), angle(180));

    const hits = await index.search({ vector: [1, 0], model: MODEL, limit: 10 });

    // 90° 的余弦是 0，`score < 0` 不成立，保留；180° 是 -1，丢弃。
    expect(hits.map((hit) => hit.uri)).toEqual([uriFor('same'), uriFor('orthogonal')]);
  });

  it('minScore 过滤低于下限的命中', async () => {
    openIndex(2);
    store(uriFor('same'), angle(0));
    store(uriFor('orthogonal'), angle(90));

    const hits = await index.search({ vector: [1, 0], model: MODEL, limit: 10, minScore: 0.5 });

    expect(hits.map((hit) => hit.uri)).toEqual([uriFor('same')]);
  });

  it('minScore 非有限数时抛 INVALID_ARGUMENT', async () => {
    openIndex(2);

    await expect(
      index.search({ vector: [1, 0], model: MODEL, limit: 10, minScore: Number.NaN }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });
});

describe('删除', () => {
  it('deleteByUri(recursive) 清掉整棵子树，不碰兄弟节点', async () => {
    openIndex(2);
    const directory = `${SCOPE}/projects/comem`;
    const child = `${directory}/design.md`;
    const grandChild = `${directory}/nested/note.md`;
    const sibling = `${SCOPE}/projects/comem2/design.md`;

    for (const uri of [directory, child, grandChild, sibling]) {
      store(uri, angle(0));
    }

    const deleted = embeddings.deleteByUri(directory, { recursive: true });

    expect(deleted).toBe(3);
    const hits = await index.search({ vector: [1, 0], model: MODEL, limit: 10 });
    expect(hits.map((hit) => hit.uri)).toEqual([sibling]);
    expect(embeddings.count()).toBe(1);
  });

  it('deleteByUri 不带 recursive 只删自己', async () => {
    openIndex(2);
    const directory = `${SCOPE}/projects/comem`;
    const child = `${directory}/design.md`;
    store(directory, angle(0));
    store(child, angle(0));

    expect(embeddings.deleteByUri(directory)).toBe(1);
    expect(embeddings.count()).toBe(1);
  });

  it('deleteByModel 只删指定模型的行', async () => {
    openIndex(2);
    store(uriFor('a'), angle(0), MODEL);
    store(uriFor('b'), angle(0), OLD_MODEL);

    expect(embeddings.deleteByModel(OLD_MODEL)).toBe(1);
    expect(embeddings.count()).toBe(1);
    expect(embeddings.count(MODEL)).toBe(1);
  });
});

describe('规模', () => {
  /**
   * 查询下推的**因果**断言。
   *
   * `vec0` 的 KNN 形态是 `MATCH ?` + `k = ?` 同时出现，距离在 C 层的 SIMD 内核
   * 里算。一旦有人改成「把行读进 JS 再逐行算距离」，`prepare` 出来的语句里就没有
   * 这两个子句——这条断言会失败。下面的墙钟断言抓不到这个回归：JS 逐行算
   * 10,000 × 1024 只要约 45ms，远低于 500ms 的守卫。
   */
  it('KNN 下推给 vec0 的 MATCH 算子，不在 JS 里算距离', async () => {
    openIndex(2);
    store(uriFor('a'), angle(0));
    store(uriFor('b'), angle(90));

    const statements: string[] = [];
    const recording = new Proxy(db, {
      get(target, property) {
        if (property === 'prepare') {
          return (sql: string) => {
            statements.push(sql);
            return target.prepare(sql);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as DatabaseSync;

    const hits = await new SqliteVectorIndex({ db: recording, logger }).search({
      vector: [1, 0],
      model: MODEL,
      limit: 10,
    });

    expect(hits).toHaveLength(2);
    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain('MATCH ?');
    expect(statements[0]).toContain('k = ?');
  });

  /**
   * 量级守卫，**不是性能目标**。
   *
   * 500ms 是本机实测（12–14ms）的 35 倍余量，高负载下的 GC 与调度抖动不会把它
   * 顶穿。要测性能用 `pnpm bench`，不要为了「更严格」调小这个数——那样测的是
   * 机器负载，不是实现。
   *
   * 这条断言**抓不到「退化成全表扫描」**：`vec0` 的 KNN 本来就是一次全表扫描
   * （`EXPLAIN QUERY PLAN` 打印 `SCAN node_embedding VIRTUAL TABLE INDEX 0:...`），
   * 距离在 C 层算。它抓的是量级回归：每行一次查询、O(n²) 的两两距离、把全部行
   * 读出来再排序。查询是否下推到 `vec0` 由上一个用例的 `MATCH` / `k` 断言守着。
   */
  it('1 万条 × 1024 维的单次查询 < 500ms（量级守卫）', async () => {
    openIndex(SCALE_DIMENSION);

    let seed = 42;
    const next = (): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0x100000000;
    };

    const rows: EmbeddingRow[] = [];
    for (let row = 0; row < SCALE_ROWS; row += 1) {
      const vector = new Array<number>(SCALE_DIMENSION);
      for (let dimension = 0; dimension < SCALE_DIMENSION; dimension += 1) {
        vector[dimension] = next() - 0.5;
      }
      rows.push({
        uri: `${SCOPE}/memories/row-${String(row).padStart(5, '0')}`,
        model: MODEL,
        contentDigest: '0000000000000000',
        vector,
      });
    }
    embeddings.upsert(rows);
    expect(embeddings.count()).toBe(SCALE_ROWS);

    const query = new Array<number>(SCALE_DIMENSION).fill(0);
    query[0] = 1;

    const startedAt = performance.now();
    const hits = await index.search({ vector: query, model: MODEL, limit: 10 });
    const duration = performance.now() - startedAt;

    expect(hits).toHaveLength(10);
    expect(duration).toBeLessThan(500);
    // 数字进 CI 日志：失败时先看实际耗时，不用重跑。
    console.log(`[vector-index] 1 万条 × 1024 维单次查询：${duration.toFixed(1)}ms`);
  }, 120_000);
});
