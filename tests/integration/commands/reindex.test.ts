import type { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ContentStore } from '../../../src/adapters/fs/content-store.js';
import { toDiskPath } from '../../../src/adapters/fs/path.js';
import { NullLogger } from '../../helpers/null-logger.js';
import { openDatabase, runMigrations } from '../../../src/adapters/sqlite/database.js';
import { EmbeddingRepository } from '../../../src/adapters/sqlite/embedding-repository.js';
import { MemoryLinkRepository } from '../../../src/adapters/sqlite/memory-link-repository.js';
import { SqliteFtsIndex } from '../../../src/adapters/sqlite/retrieval-index.js';
import type { Logger } from '../../../src/domain/log.js';
import { stableDigest } from '../../../src/domain/node.js';
import { Uri } from '../../../src/domain/uri.js';
import { EmbeddingService } from '../../../src/services/embedding.js';
import { MemoryLinkService } from '../../../src/services/memory-link.js';

/**
 * `runReindex` 自己构造 `AiSdkEmbeddingProvider`，测试只能打桩 SDK。
 *
 * 与 `tests/integration/llm/embedding-provider.test.ts` 同一套手法：
 * `importOriginal` 保留真实错误类，只替换 `embedMany` 与 provider 工厂。
 */
const mocks = vi.hoisted(() => {
  const embedMany = vi.fn();
  const embeddingModel = vi.fn((modelId: string) => ({
    provider: 'openai-compatible',
    modelId,
  }));
  const createOpenAICompatible = vi.fn(() => ({ embeddingModel }));
  return { embedMany, embeddingModel, createOpenAICompatible };
});

vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return { ...actual, embedMany: mocks.embedMany };
});

vi.mock('@ai-sdk/openai-compatible', () => ({
  createOpenAICompatible: mocks.createOpenAICompatible,
}));

const {
  documentsMissingVectors,
  embedMissingNodes,
  hasDocumentsMissingVectors,
  runReindex,
} = await import('../../../src/commands/reindex.js');

const SUBJECT = 'user:alice';
const ROOT = 'comem://user/alice';

/** `node_embedding` 的行数；`count` 已删，测试直接查表。 */
function embeddingRows(db: DatabaseSync): number {
  return Number(db.prepare('SELECT COUNT(*) AS total FROM node_embedding').get()?.['total'] ?? 0);
}
const MODEL = 'test-embedding';
const DIMENSION = 3;

const logger = new NullLogger();

let dataDir: string;
let configPath: string;

/** 供应商返回的向量维度。用例可以在中途改它，模拟「换了一个不同维度的模型」。 */
let mockDimension = DIMENSION;

function embeddingResult(texts: readonly string[]): Record<string, unknown> {
  return {
    embeddings: texts.map(() =>
      Array.from({ length: mockDimension }, (_value, index) => (index === 0 ? 1 : 0)),
    ),
    usage: { tokens: texts.length },
  };
}

beforeEach(async () => {
  mockDimension = DIMENSION;
  dataDir = await mkdtemp(join(tmpdir(), 'comem-reindex-'));
  configPath = join(dataDir, 'config.yaml');
  mocks.embedMany.mockImplementation(({ values }: { values: string[] }) =>
    Promise.resolve(embeddingResult(values)),
  );
});

afterEach(async () => {
  vi.clearAllMocks();
  await rm(dataDir, { recursive: true, force: true });
});

async function writeConfig(embedding: boolean, dimension = DIMENSION): Promise<void> {
  await writeFile(
    configPath,
    [
      'dataDir: ""',
      'logging:',
      '  level: error',
      'retrieval:',
      '  engine: fts5',
      'providers:',
      '  embedding:',
      `    type: ${embedding ? 'openai-compatible' : 'disabled'}`,
      '    baseUrl: https://example.test/v1',
      `    model: ${MODEL}`,
      '    apiKey: sk-test',
      `    dimension: ${dimension}`,
      '',
    ].join('\n'),
    'utf8',
  );
}

/** 直接写正文（不带 frontmatter）：reindex 要解析的是磁盘上的真实文件。 */
async function writeBody(uri: string, body: string): Promise<void> {
  const store = new ContentStore({ dataDir, logger });
  await store.writeText(Uri.parse(uri), body);
}

function openDb(): DatabaseSync {
  mkdirSync(join(dataDir, '_meta'), { recursive: true });
  const db = openDatabase(join(dataDir, '_meta', 'comem.sqlite'));
  runMigrations(db);
  return db;
}

function grantRead(db: DatabaseSync, uri: string, principal = SUBJECT): void {
  db.prepare('INSERT INTO node_permission (node_uri, principal, level) VALUES (?, ?, 1)').run(
    uri,
    principal,
  );
}

async function searchableUris(text: string): Promise<readonly string[]> {
  const db = openDb();
  try {
    const index = new SqliteFtsIndex({ db, logger });
    const hits = await index.search({
      text,
      scopes: [ROOT],
      principals: [SUBJECT],
      limit: 10,
    });
    return hits.map((hit) => hit.uri);
  } finally {
    db.close();
  }
}

describe('index 重建', () => {
  const FILE = `${ROOT}/memories/note.md`;

  it('磁盘有文件、索引为空 → reindex 后能检索到', async () => {
    await writeConfig(false);
    await writeBody(FILE, '上下文记忆数据库的设计。');

    const db = openDb();
    grantRead(db, FILE);
    db.close();

    const result = await runReindex({ dataDir, configPath, only: 'index' });

    expect(result.failed).toBe(0);
    expect(result.scanned).toBeGreaterThanOrEqual(1);
    expect(result.rewritten).toBeGreaterThanOrEqual(1);
    await expect(searchableUris('记忆')).resolves.toContain(FILE);
  });

  it('--dry-run 只报数，不改库', async () => {
    await writeConfig(false);
    await writeBody(FILE, '上下文记忆数据库的设计。');

    const db = openDb();
    grantRead(db, FILE);
    db.close();

    const result = await runReindex({ dataDir, configPath, only: 'index', dryRun: true });

    expect(result.scanned).toBeGreaterThanOrEqual(1);
    expect(result.rewritten).toBe(0);

    const readDb = openDb();
    try {
      const row = readDb.prepare('SELECT COUNT(*) AS total FROM node').get();
      expect(Number(row?.['total'] ?? -1)).toBe(0);
    } finally {
      readDb.close();
    }
  });

  it('坏文件进 failed，不中断整批', async () => {
    await writeConfig(false);
    const bad = `${ROOT}/memories/bad.md`;
    await writeBody(FILE, '正常正文：数据库设计。');
    // frontmatter 的 YAML 语法错误：`parseDocument` 会抛 INVALID_ARGUMENT。
    await writeFile(toDiskPath(dataDir, Uri.parse(bad)), '---\nfoo: [unclosed\n---\n正文', 'utf8');

    const db = openDb();
    grantRead(db, FILE);
    db.close();

    const result = await runReindex({ dataDir, configPath, only: 'index' });

    expect(result.failed).toBeGreaterThanOrEqual(1);
    expect(result.rewritten).toBeGreaterThanOrEqual(1);
    // 坏文件之后的好文件仍然进了索引（遍历顺序按 URI，bad < note）。
    await expect(searchableUris('数据库')).resolves.toContain(FILE);
  });
});

describe('embeddings 重建', () => {
  const URIS = ['a', 'b', 'c', 'd', 'e'].map((name) => `${ROOT}/memories/${name}.md`);

  it('断点续跑：第一次写一半，重跑只处理剩下的', async () => {
    await writeConfig(true);
    for (const uri of URIS) {
      await writeBody(uri, `正文：${uri}`);
    }
    openDb().close();

    let calls = 0;
    mocks.embedMany.mockImplementation(({ values }: { values: string[] }) => {
      calls += 1;
      if (calls > 2) {
        return Promise.reject(new Error('down'));
      }
      return Promise.resolve(embeddingResult(values));
    });

    const first = await runReindex({ dataDir, configPath, only: 'embeddings' });
    expect(first.rewritten).toBe(2);
    // 补齐的向量条数单独报：切换 `retrieval.engine` 之后要看的就是这个数字，
    // `rewritten` 混着检索索引行，回答不了「补了多少条向量」。
    expect(first.vectors).toBe(2);
    expect(first.failed).toBe(3);

    mocks.embedMany.mockImplementation(({ values }: { values: string[] }) =>
      Promise.resolve(embeddingResult(values)),
    );

    const second = await runReindex({ dataDir, configPath, only: 'embeddings' });
    expect(second.skipped).toBe(2);
    expect(second.rewritten).toBe(3);
    expect(second.vectors).toBe(3);
    expect(second.failed).toBe(0);

    const db = openDb();
    try {
      expect(embeddingRows(db)).toBe(5);
    } finally {
      db.close();
    }
  });

  it('配置换维度后重建虚拟表（旧表先备份，成功后删掉）', async () => {
    const file = `${ROOT}/memories/dimension.md`;
    await writeConfig(true, 3);
    await writeBody(file, '维度会变的正文。');
    openDb().close();

    const first = await runReindex({ dataDir, configPath, only: 'embeddings' });
    expect(first.failed).toBe(0);
    expect(first.rewritten).toBeGreaterThanOrEqual(1);

    mockDimension = 4;
    await writeConfig(true, 4);

    const second = await runReindex({ dataDir, configPath, only: 'embeddings' });
    expect(second.failed).toBe(0);

    const db = openDb();
    try {
      const embeddings = new EmbeddingRepository({ db, logger });
      expect(embeddings.storedDimension()).toBe(4);
      expect(embeddingRows(db)).toBe(1);
      expect(embeddings.get(file)?.vector).toHaveLength(4);
      // 成功之后备份表不留在库里。
      const backup = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get('node_embedding_backup');
      expect(backup).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it('没配置 providers.embedding 时拒绝重算嵌入', async () => {
    await writeConfig(false);
    await writeBody(URIS[0] ?? `${ROOT}/memories/a.md`, '正文');
    openDb().close();

    await expect(runReindex({ dataDir, configPath, only: 'embeddings' })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
  });
});

/**
 * 回归：`--config` / `--data-dir` 曾经只合成 `--data-dir`，真实 `process.argv`
 * 被丢掉——`--config` 静默失效，遍历的是默认数据根。
 */
describe('--config / --data-dir', () => {
  const FILE = `${ROOT}/memories/note.md`;

  it('--config 坏 YAML 必须报错，不能静默用默认值', async () => {
    const bad = join(dataDir, 'bad.yaml');
    await writeFile(bad, 'not: [valid', 'utf8');

    await expect(
      runReindex({
        argv: ['--config', bad],
        env: { ...process.env, COMEM_DATA_DIR: join(dataDir, 'from-env') },
        only: 'index',
      }),
    ).rejects.toThrow(/YAML/);
  });

  it('--data-dir 覆盖 COMEM_DATA_DIR：扫描的是 --data-dir 指向的数据根', async () => {
    await writeConfig(false);
    await writeBody(FILE, '上下文记忆数据库的设计。');

    const result = await runReindex({
      configPath,
      argv: ['--data-dir', dataDir],
      env: { ...process.env, COMEM_DATA_DIR: join(dataDir, 'from-env') },
      only: 'index',
    });

    expect(result.scanned).toBeGreaterThanOrEqual(1);
  });
});

/**
 * `memory_link` 的 `derived_from` 重建（架构文档 §11.10）。
 *
 * `sources`（frontmatter）是真相，`memory_link` 是它的派生读模型。写路径只在归档时
 * 增量写边，边写失败、行被删错、手工改过 `sources` 之后两者会漂移——这个入口按磁盘
 * 现状整批替换 derived 部分。
 */
describe('links 重建（memory_link 的 derived_from）', () => {
  const PREFERENCES = `${ROOT}/memories/preferences`;
  const MEMORY_A = `${PREFERENCES}/a.md`;
  const MEMORY_B = `${ROOT}/memories/experiences/b.md`;
  const ARCHIVE_1 = `${ROOT}/sessions/s1/history/archive_001`;
  const ARCHIVE_2 = `${ROOT}/sessions/s1/history/archive_002`;
  /** `sources` 里出现、但磁盘上没有对应目录的归档：边照写（来源是真相）。 */
  const ARCHIVE_MISSING = `${ROOT}/sessions/s1/history/archive_999`;

  interface LinkRecord {
    readonly from: string;
    readonly to: string;
    readonly linkType: string;
    readonly weight: number;
    readonly matchText: string;
    readonly description: string;
  }

  /** 写一份带 `sources` 的记忆文件（`memory_type` 让 `contextType` 是 memory）。 */
  async function writeMemory(uri: string, sources: readonly string[]): Promise<void> {
    const store = new ContentStore({ dataDir, logger });
    const document = [
      '---',
      'memory_type: preferences',
      'status: active',
      'created_at: 2026-11-01T00:00:00.000Z',
      'updated_at: 2026-11-01T00:00:00.000Z',
      'sources:',
      ...sources.map((source) => `  - ${source}`),
      '---',
      '',
      '## content',
      '',
      '正文',
    ].join('\n');
    await store.writeBytes(Uri.parse(uri), Uint8Array.from(Buffer.from(document, 'utf8')));
  }

  function readLinks(): readonly LinkRecord[] {
    const db = openDb();
    try {
      const rows = db
        .prepare(
          `SELECT from_uri, to_uri, link_type, weight, match_text, description
             FROM memory_link ORDER BY from_uri, to_uri`,
        )
        .all();
      return rows.map((row) => ({
        from: String(row['from_uri']),
        to: String(row['to_uri']),
        linkType: String(row['link_type']),
        weight: Number(row['weight']),
        matchText: String(row['match_text']),
        description: String(row['description']),
      }));
    } finally {
      db.close();
    }
  }

  it('--only=links 按 sources 建 derived_from 边；归档文件不存在也照写', async () => {
    await writeConfig(false);
    await writeMemory(MEMORY_A, [ARCHIVE_1, ARCHIVE_MISSING]);
    await writeMemory(MEMORY_B, [ARCHIVE_2]);
    openDb().close();

    const result = await runReindex({ dataDir, configPath, only: 'links' });

    expect(result.failed).toBe(0);
    expect(result.rewritten).toBe(0);
    expect(result.links).toBe(3);
    expect(readLinks()).toEqual([
      {
        from: MEMORY_B,
        to: ARCHIVE_2,
        linkType: 'derived_from',
        weight: 1,
        matchText: '',
        description: '',
      },
      {
        from: MEMORY_A,
        to: ARCHIVE_1,
        linkType: 'derived_from',
        weight: 1,
        matchText: '',
        description: '',
      },
      {
        from: MEMORY_A,
        to: ARCHIVE_MISSING,
        linkType: 'derived_from',
        weight: 1,
        matchText: '',
        description: '',
      },
    ]);
  });

  it('先清空再写：手工删掉 sources 之后，表里多出来的旧边被清掉', async () => {
    await writeConfig(false);
    await writeMemory(MEMORY_A, [ARCHIVE_1, ARCHIVE_2]);
    openDb().close();

    const first = await runReindex({ dataDir, configPath, only: 'links' });
    expect(first.links).toBe(2);

    // 手工把 sources 改短（或者边写失败后残留）：增量补齐会留下 ARCHIVE_1 的旧边。
    await writeMemory(MEMORY_A, [ARCHIVE_2]);
    const second = await runReindex({ dataDir, configPath, only: 'links' });

    expect(second.links).toBe(1);
    expect(readLinks().map((row) => row.to)).toEqual([ARCHIVE_2]);
  });

  it('只替换 derived_from：references 边与它的 weight / description 不受影响', async () => {
    await writeConfig(false);
    await writeMemory(MEMORY_A, [ARCHIVE_1]);
    await writeMemory(MEMORY_B, []);

    const db = openDb();
    try {
      new MemoryLinkService({
        repository: new MemoryLinkRepository({ db, logger }),
        logger,
      }).addLinks(Uri.parse(MEMORY_A), [
        { toUri: Uri.parse(MEMORY_B), linkType: 'references', weight: 3, description: '手工写的' },
      ]);
    } finally {
      db.close();
    }

    // 跑两次：重建幂等，derived 边不重复、references 边不丢。
    await runReindex({ dataDir, configPath, only: 'links' });
    const result = await runReindex({ dataDir, configPath, only: 'links' });

    expect(result.links).toBe(1);
    expect(readLinks()).toEqual([
      {
        from: MEMORY_A,
        to: MEMORY_B,
        linkType: 'references',
        weight: 3,
        matchText: '',
        description: '手工写的',
      },
      {
        from: MEMORY_A,
        to: ARCHIVE_1,
        linkType: 'derived_from',
        weight: 1,
        matchText: '',
        description: '',
      },
    ]);
  });

  it('跳过 .history 下的版本文件；文件名是 .history.md 的普通记忆照常建边', async () => {
    await writeConfig(false);
    // 覆盖写留下的版本快照：写路径从不给它写边，重建也不能凭空造。
    await writeMemory(`${PREFERENCES}/.history/a.md--20260101T000000000Z.md`, [ARCHIVE_1]);
    await writeMemory(`${PREFERENCES}/.history.md`, [ARCHIVE_2]);
    openDb().close();

    const result = await runReindex({ dataDir, configPath, only: 'links' });

    expect(result.links).toBe(1);
    expect(readLinks().map((row) => row.from)).toEqual([`${PREFERENCES}/.history.md`]);
  });

  it('sources 里的非法 URI 跳过，不写进表（否则反查会整次抛错）', async () => {
    await writeConfig(false);
    await writeMemory(MEMORY_A, ['不是 URI', '', ARCHIVE_1]);
    openDb().close();

    const result = await runReindex({ dataDir, configPath, only: 'links' });

    expect(result.failed).toBe(0);
    expect(result.links).toBe(1);
    expect(readLinks().map((row) => row.to)).toEqual([ARCHIVE_1]);
  });
});

/**
 * `embedMissingNodes`：CLI 与启动回填共用的嵌入循环（架构文档 §8.1、§20）。
 *
 * 这里直接用真实 `EmbeddingService` + 假供应商，不走 `runReindex`——档位（批大小、
 * 中止信号、进度回调）只有直接调它才验得到。
 */
describe('embedMissingNodes', () => {
  const FILE = `${ROOT}/memories/note.md`;

  /** 假供应商：按正文长度产出可区分的向量，并记录每次看到的正文。 */
  function fakeProvider(): {
    readonly provider: {
      readonly model: string;
      readonly dimension: number;
      embed(
        texts: readonly string[],
      ): Promise<{ vectors: number[][]; usage: { promptTokens: number; totalTokens: number } }>;
    };
    readonly seen: string[];
  } {
    const seen: string[] = [];
    return {
      seen,
      provider: {
        model: MODEL,
        dimension: DIMENSION,
        embed: (texts) => {
          seen.push(...texts);
          return Promise.resolve({
            vectors: texts.map((text) => [text.length + 1, 1, 0]),
            usage: { promptTokens: texts.length, totalTokens: texts.length },
          });
        },
      },
    };
  }

  function serviceWith(
    provider: ReturnType<typeof fakeProvider>['provider'],
    target: Logger = logger,
  ): EmbeddingService {
    return new EmbeddingService({
      provider,
      logger: target,
      cache: null,
      config: { dimension: DIMENSION, maxBatchSize: 8, timeoutMs: 5_000 },
    });
  }

  /** 记录 warn 的 logger：失败策略（继续下一批）只有看到日志才算验到。 */
  function recordingLogger(warnings: string[]): Logger {
    return {
      debug: () => undefined,
      info: () => undefined,
      warn: (message) => {
        warnings.push(message);
      },
      error: () => undefined,
    };
  }

  it('摘要与正文都从磁盘读：索引行落后于磁盘时写的是磁盘那一份', async () => {
    const NEW_BODY = '磁盘上的新正文';
    const OLD_BODY = '旧';
    await writeBody(FILE, NEW_BODY);

    const db = openDb();
    try {
      // 索引行与向量行都停在旧正文上（「digest 对得上索引、向量来自旧正文」）。
      await new SqliteFtsIndex({ db, logger }).upsert([
        {
          uri: FILE,
          parentUri: `${ROOT}/memories`,
          scope: 'user',
          kind: 'document',
          contextType: 'memory',
          memoryType: null,
          level: 'L2',
          abstract: null,
          content: OLD_BODY,
          bodyDigest: stableDigest(OLD_BODY),
          size: OLD_BODY.length,
          updatedAt: '2026-11-01T00:00:00.000Z',
          status: 'active',
        },
      ]);
      const embeddings = new EmbeddingRepository({ db, logger });
      embeddings.ensureSchema(DIMENSION, MODEL);
      embeddings.upsert([
        { uri: FILE, model: MODEL, contentDigest: stableDigest(OLD_BODY), vector: [0, 1, 0] },
      ]);

      const { provider, seen } = fakeProvider();
      const result = await embedMissingNodes([FILE], {
        embeddings,
        embedding: serviceWith(provider),
        store: new ContentStore({ dataDir, logger }),
        logger,
        batchSize: 8,
      });

      // 向量来自磁盘正文，摘要也是磁盘正文的摘要——不是 `node.body_digest` 那一份。
      expect(seen).toEqual([NEW_BODY]);
      expect(result.embeddedUris).toEqual([FILE]);
      expect(result.failedUris).toEqual([]);
      expect(embeddings.get(FILE)?.contentDigest).toBe(stableDigest(NEW_BODY));
    } finally {
      db.close();
    }
  });

  it('幂等：第二次跑全部跳过，不再打供应商', async () => {
    const OTHER = `${ROOT}/memories/other.md`;
    await writeBody(FILE, '第一条正文');
    await writeBody(OTHER, '第二条正文');

    const db = openDb();
    try {
      const embeddings = new EmbeddingRepository({ db, logger });
      embeddings.ensureSchema(DIMENSION, MODEL);
      const { provider, seen } = fakeProvider();
      const service = serviceWith(provider);
      const deps = {
        embeddings,
        embedding: service,
        store: new ContentStore({ dataDir, logger }),
        logger,
        batchSize: 8,
      };

      const first = await embedMissingNodes([FILE, OTHER], deps);
      expect(first.embeddedUris).toHaveLength(2);
      expect(first.skipped).toBe(0);
      expect(seen).toHaveLength(2);

      const second = await embedMissingNodes([FILE, OTHER], deps);
      expect(second.embeddedUris).toEqual([]);
      expect(second.skipped).toBe(2);
      // 摘要没变就不打供应商：幂等的判据是「没有第二次网络调用」，不是「写了一样的行」。
      expect(seen).toHaveLength(2);
    } finally {
      db.close();
    }
  });

  it('单个节点失败只记 warn，继续处理后面的节点', async () => {
    const BAD = `${ROOT}/memories/bad.md`;
    await writeBody(FILE, '正常正文');

    const db = openDb();
    try {
      const embeddings = new EmbeddingRepository({ db, logger });
      embeddings.ensureSchema(DIMENSION, MODEL);
      const { provider } = fakeProvider();
      const warnings: string[] = [];
      const result = await embedMissingNodes([BAD, FILE], {
        embeddings,
        // 坏节点读不出来（文件不存在）：它进 failedUris，后面的节点照常嵌。
        embedding: serviceWith(provider, recordingLogger(warnings)),
        store: new ContentStore({ dataDir, logger }),
        logger: recordingLogger(warnings),
        batchSize: 1,
      });

      expect(result.failedUris).toEqual([BAD]);
      expect(result.embeddedUris).toEqual([FILE]);
      expect(warnings.length).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  it('已经中止的信号：一次都不打供应商', async () => {
    await writeBody(FILE, '正文');
    const db = openDb();
    try {
      const embeddings = new EmbeddingRepository({ db, logger });
      embeddings.ensureSchema(DIMENSION, MODEL);
      const { provider, seen } = fakeProvider();
      const abort = new AbortController();
      abort.abort();

      const result = await embedMissingNodes([FILE], {
        embeddings,
        embedding: serviceWith(provider),
        store: new ContentStore({ dataDir, logger }),
        logger,
        batchSize: 8,
        signal: abort.signal,
      });

      expect(result.aborted).toBe(true);
      expect(seen).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('候选集共用「缺向量」的 SQL 谓词：补完之后它立刻变空', async () => {
    const EMPTY = `${ROOT}/memories/empty.md`;
    await writeConfig(false);
    await writeBody(FILE, '存量记忆的正文');
    await writeBody(EMPTY, '');

    // 用真实的索引重建造 `node` 行（空正文行也在，谓词靠摘要挡掉它）。
    const indexed = await runReindex({ dataDir, configPath, only: 'index' });
    expect(indexed.failed).toBe(0);

    const db = openDb();
    try {
      const embeddings = new EmbeddingRepository({ db, logger });
      embeddings.ensureSchema(DIMENSION, MODEL);
      expect(documentsMissingVectors(db, MODEL)).toEqual([FILE]);
      expect(hasDocumentsMissingVectors(db, MODEL)).toBe(true);

      const { provider } = fakeProvider();
      await embedMissingNodes([FILE], {
        embeddings,
        embedding: serviceWith(provider),
        store: new ContentStore({ dataDir, logger }),
        logger,
        batchSize: 8,
      });

      expect(documentsMissingVectors(db, MODEL)).toEqual([]);
      expect(hasDocumentsMissingVectors(db, MODEL)).toBe(false);
    } finally {
      db.close();
    }
  });
});
