/**
 * 检索面契约套件的注册处：同一个 fixture、同一组断言，分别在 `fts5` / `vector` /
 * `hybrid` 三种引擎下跑一遍。
 *
 * 这不是「三个实现各写一套期望」：`describeRetrievalSurfaceConformance` 里只有一份
 * 断言，三个引擎是它的参数。任何一条分支对权限、`status`、`asOf` 的处理漂移，都会
 * 让对应引擎的那一组红。
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { describe, vi } from 'vitest';

import { ContentStore } from '../../src/adapters/fs/content-store.js';
import { createPathLockManager } from '../../src/adapters/fs/lock.js';
import { MetadataFileStore } from '../../src/adapters/fs/metadata-file.js';
import { openDatabase, runMigrations } from '../../src/adapters/sqlite/database.js';
import { EmbeddingRepository } from '../../src/adapters/sqlite/embedding-repository.js';
import { NodeRepository } from '../../src/adapters/sqlite/node-repository.js';
import { SqliteFtsIndex } from '../../src/adapters/sqlite/retrieval-index.js';
import { SqliteVectorIndex } from '../../src/adapters/sqlite/vector-index.js';
import type { Logger } from '../../src/domain/log.js';
import type { IndexRecord, RetrievalEngine } from '../../src/domain/retrieval.js';
import { Uri } from '../../src/domain/uri.js';
import { ContextAssembler } from '../../src/services/context-assembler.js';
import type { EmbedOutcome } from '../../src/services/embedding.js';
import { FileSystemService } from '../../src/services/filesystem.js';
import {
  SearchService,
  type FindOptions,
  type RetrievalSettings,
} from '../../src/services/search.js';
import { AllowAllAuthorizer } from '../helpers/allow-all-authorizer.js';
import {
  describeRetrievalSurfaceConformance,
  type RetrievalSurfaceHarness,
  type SeedRecord,
} from './retrieval-surface-suite.js';

const ROOT = 'comem://user/alice';
const PRINCIPALS: readonly string[] = ['user:alice', 'user:*'];
const MODEL = 'contract-embedding';
const DIMENSION = 2;
const CREATED_AT = '2026-11-08T00:00:00.000Z';
const DIGEST = '0000000000000000';

const CONFIG: RetrievalSettings = {
  candidateMultiplier: 4,
  levelWeights: { l0: 1.15, l1: 1.05, l2: 1 },
  queryFilters: [],
  assembly: { maxTokens: 1600, dedupTurns: 3, quotaPreset: 'coding' },
};

function createLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function toIndexRecord(seed: SeedRecord): IndexRecord {
  return {
    uri: seed.uri,
    parentUri: seed.uri.slice(0, seed.uri.lastIndexOf('/')),
    scope: 'user',
    kind: 'document',
    contextType: seed.contextType ?? 'memory',
    memoryType: seed.memoryType ?? null,
    level: seed.level ?? 'L2',
    abstract: null,
    content: seed.content,
    bodyDigest: DIGEST,
    size: Buffer.byteLength(seed.content),
    updatedAt: CREATED_AT,
    status: seed.status ?? 'active',
    validFrom: seed.validFrom ?? null,
    validUntil: seed.validUntil ?? null,
  };
}

function options(overrides: Partial<FindOptions> = {}): FindOptions {
  return { scopes: [ROOT], subject: 'user:alice', principals: PRINCIPALS, ...overrides };
}

/**
 * 每个引擎一份独立的库与临时目录。向量维度固定 2，查询向量与所有落库向量都是
 * `[1, 0]`——这保证「向量臂返回所有可见候选」，可见性断言不依赖语义分数。
 */
async function createHarness(engine: RetrievalEngine): Promise<RetrievalSurfaceHarness> {
  const dataDir = await mkdtemp(join(tmpdir(), `comem-contract-retrieval-${engine}-`));
  const logger = createLogger();
  const db: DatabaseSync = openDatabase(':memory:');
  runMigrations(db);

  const index = new SqliteFtsIndex({ db, logger });
  const store = new ContentStore({ dataDir, logger });
  const metadata = new MetadataFileStore({ dataDir, logger });
  const authorizer = new AllowAllAuthorizer();
  const embeddings = new EmbeddingRepository({ db, logger });
  const vectors = new SqliteVectorIndex({ db, logger });
  const nodes = new NodeRepository({ db, logger });

  if (engine !== 'fts5') {
    embeddings.ensureSchema(DIMENSION, MODEL);
  }

  const embedding = {
    available: true,
    model: MODEL,
    embed: async (texts: readonly string[]): Promise<EmbedOutcome> => ({
      vectors: texts.map(() => [1, 0]),
      degraded: false,
      reason: null,
    }),
  };

  const assembler = new ContextAssembler({ store, metadata, authorizer, logger });
  const filesystem = new FileSystemService({
    store,
    locks: createPathLockManager({ dataDir, logger, pollIntervalMs: 1 }),
    authorizer,
    logger,
  });
  const service = new SearchService({
    index,
    filesystem,
    authorizer,
    assembler,
    logger,
    config: CONFIG,
    engine,
    ...(engine === 'fts5' ? {} : { embedding, vectors, nodes }),
    // 必填依赖：测试显式传默认值（`telemetry.hotness.*` 的 schema 默认值）。
    hotnessWeight: 0,
    hotnessHalfLifeHours: 168,
  });

  return {
    engine,
    async seed(records) {
      for (const record of records) {
        await index.upsert([toIndexRecord(record)]);
        if (record.body !== null) {
          await store.writeText(Uri.parse(record.uri), record.body ?? record.content);
        }
        const permissions =
          record.permissions ?? [{ principal: 'user:alice', level: 1, effect: 'allow' as const }];
        for (const permission of permissions) {
          db.prepare(
            'INSERT INTO node_permission (node_uri, principal, level, effect) VALUES (?, ?, ?, ?)',
          ).run(
            record.uri,
            permission.principal,
            permission.level ?? 1,
            permission.effect ?? 'allow',
          );
        }
        if (engine !== 'fts5') {
          embeddings.upsert([
            {
              uri: record.uri,
              model: MODEL,
              contentDigest: DIGEST,
              vector: [1, 0],
            },
          ]);
        }
      }
    },
    find: (query, overrides) => service.find(query, options(overrides)),
    glob: (pattern, overrides) => service.glob(pattern, options(overrides)),
    grep: (pattern, overrides) => service.grep(pattern, options(overrides)),
    async dispose() {
      db.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

const ENGINES: readonly RetrievalEngine[] = ['fts5', 'vector', 'hybrid'];

describe('检索面契约', () => {
  for (const engine of ENGINES) {
    describeRetrievalSurfaceConformance(engine, () => createHarness(engine));
  }
});
