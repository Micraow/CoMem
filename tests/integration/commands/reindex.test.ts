import type { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ContentStore } from '../../../src/adapters/fs/content-store.js';
import { toDiskPath } from '../../../src/adapters/fs/path.js';
import { NullLogger } from '../../../src/adapters/log/null.js';
import { openDatabase, runMigrations } from '../../../src/adapters/sqlite/database.js';
import { EmbeddingRepository } from '../../../src/adapters/sqlite/embedding-repository.js';
import { SqliteFtsIndex } from '../../../src/adapters/sqlite/retrieval-index.js';
import { Uri } from '../../../src/domain/uri.js';

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

const { runReindex } = await import('../../../src/commands/reindex.js');

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
    expect(first.failed).toBe(3);

    mocks.embedMany.mockImplementation(({ values }: { values: string[] }) =>
      Promise.resolve(embeddingResult(values)),
    );

    const second = await runReindex({ dataDir, configPath, only: 'embeddings' });
    expect(second.skipped).toBe(2);
    expect(second.rewritten).toBe(3);
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
