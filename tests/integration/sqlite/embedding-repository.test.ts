import type { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { openDatabase, runMigrations } from '../../../src/adapters/sqlite/database.js';
import { EmbeddingRepository } from '../../../src/adapters/sqlite/embedding-repository.js';
import { ComemError } from '../../../src/domain/errors.js';
import type { Logger } from '../../../src/domain/log.js';

const MODEL = 'text-embedding-3-small';
const OLD_MODEL = 'text-embedding-ada-002';
const DIMENSION = 4;
const CREATED_AT = '2026-11-08T00:00:00.000Z';
const SCOPE = 'comem://user/alice';

let db: DatabaseSync;
let embeddings: EmbeddingRepository;
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

function uriFor(name: string): string {
  return `${SCOPE}/memories/${name}`;
}

/** 单位向量：只有 `axis` 位是 1，其余是 0。 */
function basis(axis: number): number[] {
  const vector = new Array<number>(DIMENSION).fill(0);
  vector[axis % DIMENSION] = 1;
  return vector;
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

beforeEach(() => {
  db = openDatabase(':memory:');
  runMigrations(db);
  logger = createLogger();
  embeddings = new EmbeddingRepository({ db, logger });
});

afterEach(() => {
  db.close();
});

describe('ensureSchema', () => {
  it('建虚拟表与元数据行', () => {
    embeddings.ensureSchema(DIMENSION, MODEL);

    const columns = db.prepare('PRAGMA table_info(node_embedding)').all();
    expect(columns.map((column) => column['name'])).toEqual([
      'uri',
      'model',
      'content_digest',
      'embedding',
    ]);
    expect(embeddings.storedDimension()).toBe(DIMENSION);
    expect(embeddings.count()).toBe(0);
  });

  it('幂等：重复调用不改维度，也不清空已有行', () => {
    embeddings.ensureSchema(DIMENSION, MODEL);
    embeddings.upsert([
      { uri: uriFor('a'), model: MODEL, contentDigest: 'x', vector: basis(0) },
    ]);

    expect(() => {
      embeddings.ensureSchema(DIMENSION, MODEL);
    }).not.toThrow();
    expect(embeddings.storedDimension()).toBe(DIMENSION);
    expect(embeddings.count()).toBe(1);
  });

  it('维度不一致抛 CONFLICT 并带 stored / configured', () => {
    embeddings.ensureSchema(DIMENSION, MODEL);

    let caught: unknown;
    try {
      embeddings.ensureSchema(DIMENSION + 1, MODEL);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ComemError);
    const error = caught as ComemError;
    expect(error.code).toBe('CONFLICT');
    expect(error.details).toMatchObject({ stored: DIMENSION, configured: DIMENSION + 1 });
    // 抛错之后库里的维度不变：失败不留下半截状态。
    expect(embeddings.storedDimension()).toBe(DIMENSION);
  });

  it('拒绝非法维度', () => {
    for (const dimension of [0, -1, 1.5]) {
      expect(() => {
        embeddings.ensureSchema(dimension, MODEL);
      }).toThrow(ComemError);
    }
    expect(embeddings.storedDimension()).toBeNull();
  });

  it('没有元数据行时 storedDimension 是 null', () => {
    expect(embeddings.storedDimension()).toBeNull();
  });
});

describe('读写', () => {
  beforeEach(() => {
    embeddings.ensureSchema(DIMENSION, MODEL);
  });

  it('get 读回向量与摘要', () => {
    embeddings.upsert([
      { uri: uriFor('a'), model: MODEL, contentDigest: 'abcdef', vector: [0.5, 0.5, 0.5, 0.5] },
    ]);

    const row = embeddings.get(uriFor('a'));
    expect(row).not.toBeNull();
    expect(row?.model).toBe(MODEL);
    expect(row?.contentDigest).toBe('abcdef');
    // 存储前会归一化：四个 0.5 归一化后都是 0.5。
    expect(row?.vector).toHaveLength(DIMENSION);
    for (const value of row?.vector ?? []) {
      expect(value).toBeCloseTo(0.5, 5);
    }
    expect(embeddings.get(uriFor('missing'))).toBeNull();
  });

  it('upsert 覆盖同一个 URI 的向量', () => {
    embeddings.upsert([
      { uri: uriFor('a'), model: MODEL, contentDigest: 'old', vector: basis(0) },
    ]);
    embeddings.upsert([
      { uri: uriFor('a'), model: MODEL, contentDigest: 'new', vector: basis(1) },
    ]);

    expect(embeddings.count()).toBe(1);
    const row = embeddings.get(uriFor('a'));
    expect(row?.contentDigest).toBe('new');
    expect(row?.vector[1]).toBeCloseTo(1, 5);
  });

  it('getMany 按 URI 批量读，超 500 条分片', () => {
    const uris = Array.from({ length: 600 }, (_value, index) =>
      uriFor(`row-${String(index).padStart(3, '0')}`),
    );
    embeddings.upsert(
      uris.map((uri) => ({ uri, model: MODEL, contentDigest: 'd', vector: basis(0) })),
    );

    expect(embeddings.getMany(uris)).toHaveLength(600);
    expect(embeddings.getMany([])).toEqual([]);
  });

  it('count 按模型过滤', () => {
    embeddings.upsert([
      { uri: uriFor('a'), model: MODEL, contentDigest: 'd', vector: basis(0) },
      { uri: uriFor('b'), model: OLD_MODEL, contentDigest: 'd', vector: basis(0) },
    ]);

    expect(embeddings.count()).toBe(2);
    expect(embeddings.count(MODEL)).toBe(1);
    expect(embeddings.count(OLD_MODEL)).toBe(1);
  });

  it('deleteByModel 只删指定模型的行', () => {
    embeddings.upsert([
      { uri: uriFor('a'), model: MODEL, contentDigest: 'd', vector: basis(0) },
      { uri: uriFor('b'), model: OLD_MODEL, contentDigest: 'd', vector: basis(0) },
    ]);

    expect(embeddings.deleteByModel(OLD_MODEL)).toBe(1);
    expect(embeddings.count()).toBe(1);
    expect(embeddings.get(uriFor('b'))).toBeNull();
  });
});

describe('iterMissingUris', () => {
  beforeEach(() => {
    embeddings.ensureSchema(DIMENSION, MODEL);
  });

  it('按 URI 排序，跳过已嵌入的', () => {
    for (const name of ['c', 'a', 'b']) {
      insertNode(uriFor(name));
    }
    embeddings.upsert([
      { uri: uriFor('b'), model: MODEL, contentDigest: 'd', vector: basis(0) },
    ]);

    expect(embeddings.iterMissingUris(MODEL, { limit: 10 })).toEqual([uriFor('a'), uriFor('c')]);
  });

  it('after 游标分页，不跳行', () => {
    for (const name of ['a', 'b', 'c', 'd']) {
      insertNode(uriFor(name));
    }

    const first = embeddings.iterMissingUris(MODEL, { limit: 2 });
    expect(first).toEqual([uriFor('a'), uriFor('b')]);

    const second = embeddings.iterMissingUris(MODEL, { limit: 2, after: first[1] });
    expect(second).toEqual([uriFor('c'), uriFor('d')]);
  });

  it('只排除当前模型的行', () => {
    insertNode(uriFor('a'));
    embeddings.upsert([
      { uri: uriFor('a'), model: OLD_MODEL, contentDigest: 'd', vector: basis(0) },
    ]);

    expect(embeddings.iterMissingUris(MODEL, { limit: 10 })).toEqual([uriFor('a')]);
  });

  it('拒绝非法 limit', () => {
    expect(() => embeddings.iterMissingUris(MODEL, { limit: 0 })).toThrow(
      expect.objectContaining({ code: 'INVALID_ARGUMENT' }),
    );
  });
});
