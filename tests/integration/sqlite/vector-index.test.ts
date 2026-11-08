import type { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { openDatabase, runMigrations } from '../../../src/adapters/sqlite/database.js';
import {
  EmbeddingRepository,
  type EmbeddingRow,
} from '../../../src/adapters/sqlite/embedding-repository.js';
import { SqliteVectorIndex } from '../../../src/adapters/sqlite/vector-index.js';
import { normalizeVector, quantizeVector } from '../../../src/domain/embedding.js';
import type { Logger } from '../../../src/domain/log.js';

const MODEL = 'text-embedding-3-small';
const OLD_MODEL = 'text-embedding-ada-002';
const CREATED_AT = '2026-11-08T00:00:00.000Z';
const SCOPE = 'comem://user/alice';

/** 1 万条 × 128 维的规模测试用。 */
const SCALE_ROWS = 10_000;
const SCALE_DIMENSION = 128;

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
 * 量化并落库。
 *
 * scale 的公式与 `quantizeVector` 内部一致（`maxAbs / 127`，见 `domain/embedding.ts`
 * 的 `INT8_MAX`）。契约只返回 `Int8Array`，scale 由调用方算——测试是当前唯一的
 * 调用方，等回填管线接上之后这两处应该合并成一个 `quantizeWithScale`。
 */
function store(uri: string, vector: readonly number[], model = MODEL): void {
  const normalized = normalizeVector(vector);
  let maxAbs = 0;
  for (const value of normalized) {
    maxAbs = Math.max(maxAbs, Math.abs(value));
  }
  const quantized = quantizeVector(normalized);
  embeddings.upsert([
    {
      uri,
      model,
      dimension: normalized.length,
      vector: new Uint8Array(quantized.buffer, quantized.byteOffset, quantized.length),
      scale: maxAbs === 0 ? 0 : maxAbs / 127,
      contentDigest: '0000000000000000',
      createdAt: CREATED_AT,
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
  embeddings = new EmbeddingRepository({ db, logger });
  index = new SqliteVectorIndex({ db, embeddings, logger });
});

afterEach(() => {
  db.close();
});

describe('最近邻', () => {
  it('按余弦相似度降序返回', async () => {
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
    for (const degree of [0, 20, 40, 60]) {
      store(uriFor(`v${String(degree)}`), angle(degree));
    }

    const hits = await index.search({ vector: [1, 0], model: MODEL, limit: 2 });

    expect(hits.map((hit) => hit.uri)).toEqual([uriFor('v0'), uriFor('v20')]);
  });

  it('同分按 URI 升序（顺序稳定）', async () => {
    store(uriFor('b'), angle(0));
    store(uriFor('a'), angle(0));
    store(uriFor('c'), angle(0));

    const hits = await index.search({ vector: [1, 0], model: MODEL, limit: 10 });

    expect(hits.map((hit) => hit.uri)).toEqual([uriFor('a'), uriFor('b'), uriFor('c')]);
  });

  it('空库返回空', async () => {
    expect(await index.search({ vector: [1, 0], model: MODEL, limit: 10 })).toEqual([]);
  });
});

describe('候选集', () => {
  it('uris 限定候选集', async () => {
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

  it('uris 为空数组返回空，不是全库扫描', async () => {
    store(uriFor('a'), angle(0));

    expect(await index.search({ vector: [1, 0], model: MODEL, uris: [], limit: 10 })).toEqual([]);
    expect(logger.debug).toHaveBeenCalledWith(
      '向量检索：候选集为空',
      expect.objectContaining({ model: MODEL }),
    );
  });

  it('uris 里有不存在的 URI 时跳过', async () => {
    store(uriFor('a'), angle(0));

    const hits = await index.search({
      vector: [1, 0],
      model: MODEL,
      uris: [uriFor('a'), uriFor('missing')],
      limit: 10,
    });

    expect(hits.map((hit) => hit.uri)).toEqual([uriFor('a')]);
  });
});

describe('模型与维度', () => {
  it('模型不匹配的行被跳过并记 debug', async () => {
    store(uriFor('current'), angle(0));
    store(uriFor('stale'), angle(0), OLD_MODEL);

    const hits = await index.search({ vector: [1, 0], model: MODEL, limit: 10 });

    expect(hits.map((hit) => hit.uri)).toEqual([uriFor('current')]);
    expect(logger.debug).toHaveBeenCalledWith(
      '向量检索跳过不匹配的行',
      expect.objectContaining({ skippedByModel: 1, skippedByDimension: 0 }),
    );
  });

  it('维度不匹配的行被跳过并记 debug', async () => {
    store(uriFor('current'), [1, 0, 0]);
    // 同一模型但维度不同：换过模型、旧行还没清空。
    store(uriFor('other-dimension'), [1, 0]);

    const hits = await index.search({ vector: [1, 0, 0], model: MODEL, limit: 10 });

    expect(hits.map((hit) => hit.uri)).toEqual([uriFor('current')]);
    expect(logger.debug).toHaveBeenCalledWith(
      '向量检索跳过不匹配的行',
      expect.objectContaining({ skippedByDimension: 1 }),
    );
  });

  it('查询向量为全零时抛 INVALID_ARGUMENT', async () => {
    await expect(index.search({ vector: [0, 0], model: MODEL, limit: 10 })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
  });

  it('查询向量含 NaN 时抛 INVALID_ARGUMENT', async () => {
    await expect(
      index.search({ vector: [1, Number.NaN], model: MODEL, limit: 10 }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('limit 不是正整数时抛 INVALID_ARGUMENT', async () => {
    for (const limit of [0, -1, 1.5]) {
      await expect(index.search({ vector: [1, 0], model: MODEL, limit })).rejects.toMatchObject({
        code: 'INVALID_ARGUMENT',
      });
    }
  });
});

describe('minScore', () => {
  it('默认 0：负余弦被丢弃', async () => {
    store(uriFor('same'), angle(0));
    store(uriFor('orthogonal'), angle(90));
    store(uriFor('opposite'), angle(180));

    const hits = await index.search({ vector: [1, 0], model: MODEL, limit: 10 });

    // 90° 的余弦是 0，`score < 0` 不成立，保留；180° 是 -1，丢弃。
    expect(hits.map((hit) => hit.uri)).toEqual([uriFor('same'), uriFor('orthogonal')]);
  });

  it('minScore 过滤低于下限的命中', async () => {
    store(uriFor('same'), angle(0));
    store(uriFor('orthogonal'), angle(90));

    const hits = await index.search({ vector: [1, 0], model: MODEL, limit: 10, minScore: 0.5 });

    expect(hits.map((hit) => hit.uri)).toEqual([uriFor('same')]);
  });

  it('minScore 非有限数时抛 INVALID_ARGUMENT', async () => {
    await expect(
      index.search({ vector: [1, 0], model: MODEL, limit: 10, minScore: Number.NaN }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });
});

describe('删除', () => {
  it('deleteByUri(recursive) 清掉整棵子树，不碰兄弟节点', async () => {
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
    const directory = `${SCOPE}/projects/comem`;
    const child = `${directory}/design.md`;
    store(directory, angle(0));
    store(child, angle(0));

    expect(embeddings.deleteByUri(directory)).toBe(1);
    expect(embeddings.count()).toBe(1);
  });

  it('deleteByModel 只删指定模型的行', async () => {
    store(uriFor('a'), angle(0), MODEL);
    store(uriFor('b'), angle(0), OLD_MODEL);

    expect(embeddings.deleteByModel(OLD_MODEL)).toBe(1);
    expect(embeddings.count()).toBe(1);
    expect(embeddings.count(MODEL)).toBe(1);
  });
});

describe('回填', () => {
  function catchError(run: () => unknown): unknown {
    try {
      run();
    } catch (error) {
      return error;
    }
    return undefined;
  }

  function insertNode(uri: string): void {
    db.prepare(
      `INSERT INTO node (
         uri, parent_uri, scope, kind, context_type, memory_type, level,
         abstract, body_digest, size, updated_at, status
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      uri,
      uri.slice(0, uri.lastIndexOf('/')),
      'user',
      'document',
      'memory',
      null,
      'L2',
      null,
      '0000000000000000',
      0,
      CREATED_AT,
      'active',
    );
  }

  it('iterMissingUris 按 URI 排序，跳过已嵌入的', () => {
    for (const name of ['c', 'a', 'b']) {
      insertNode(uriFor(name));
    }
    store(uriFor('b'), angle(0));

    expect(embeddings.iterMissingUris(MODEL, { limit: 10 })).toEqual([
      uriFor('a'),
      uriFor('c'),
    ]);
  });

  it('iterMissingUris 用 after 游标分页，不跳行', () => {
    for (const name of ['a', 'b', 'c', 'd']) {
      insertNode(uriFor(name));
    }

    const first = embeddings.iterMissingUris(MODEL, { limit: 2 });
    expect(first).toEqual([uriFor('a'), uriFor('b')]);

    const second = embeddings.iterMissingUris(MODEL, { limit: 2, after: first[1] });
    expect(second).toEqual([uriFor('c'), uriFor('d')]);
  });

  it('iterMissingUris 只排除当前模型的行', () => {
    insertNode(uriFor('a'));
    store(uriFor('a'), angle(0), OLD_MODEL);

    expect(embeddings.iterMissingUris(MODEL, { limit: 10 })).toEqual([uriFor('a')]);
  });

  it('iterMissingUris 拒绝非法 limit', () => {
    expect(catchError(() => embeddings.iterMissingUris(MODEL, { limit: 0 }))).toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
  });
});

describe('规模', () => {
  it('1 万条 × 128 维的单次查询 < 200ms', async () => {
    // 200ms 是本机实测的经验上限：暴力余弦在 1 万 × 128 维下是 30–60ms，这个阈值
    // 留了 3–6 倍给 CI 抖动（共享 runner、覆盖率插桩）。超过它说明退化成了平方级
    // 或每行都重新扫全表，不是「慢一点」。
    //
    // 来源：本机（Node 26，单核）实测，不是供应商 SLA。数据规模上到十万节点时暴力
    // 余弦不再可用（见 `vector-index.ts` 文件头），那时这个测试应该先失败。
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
      const normalized = normalizeVector(vector);
      let maxAbs = 0;
      for (const value of normalized) {
        maxAbs = Math.max(maxAbs, Math.abs(value));
      }
      const quantized = quantizeVector(normalized);
      rows.push({
        uri: `${SCOPE}/memories/row-${String(row).padStart(5, '0')}`,
        model: MODEL,
        dimension: SCALE_DIMENSION,
        vector: new Uint8Array(quantized.buffer, quantized.byteOffset, quantized.length),
        scale: maxAbs === 0 ? 0 : maxAbs / 127,
        contentDigest: '0000000000000000',
        createdAt: CREATED_AT,
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
    expect(duration).toBeLessThan(200);
    // 数字进 CI 日志：失败时先看实际耗时，不用重跑。
    console.log(`[vector-index] 1 万条 × 128 维单次查询：${duration.toFixed(1)}ms`);
  }, 60_000);
});
