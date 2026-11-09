/**
 * 「缺向量」判定的两份实现（架构文档 §8.1、§20 的运维链路）。
 *
 * 同一个判定写着两处：
 *
 * - **A（SQL，索引列对索引列）**：`commands/reindex.ts` 的 `hasDocumentsMissingVectors`，
 *   比较 `node_embedding.model = ? AND node_embedding.content_digest = node.body_digest`。
 *   启动提醒（`bootstrap/main.ts` 的 `warnIfVectorsMissing`）用它。
 * - **C（TS，拿刚读出的正文）**：`commands/reindex.ts` 的 `runReindex` 逐行判据
 *   （约 `:550`），比较 `stableDigest(document.body)`，决定「跳过还是重算」。
 *
 * 两份判据相同、**基准不同**：A 看索引声明的 `body_digest`，C 看刚从磁盘读出的正文。
 * 稳态下两者指向同一份内容，必须给出同样结论；漂移的后果是「启动一直说没缺、reindex
 * 每次都在重算」，或者反过来「启动一直报警、reindex 无事可做」。
 *
 * ## 为什么这里**不**要求 A 与 `services/index-observer.ts:946` 一致
 *
 * observer 的判据是 `row.model === model && row.contentDigest === record.digest`，
 * 其中 `record.digest` 由**刚写入的正文**算出（`index-observer.ts:842`）。它与 A 的
 * 基准在「文件被外部改动、索引还没跟上」时**故意不同**：A 看索引里那份旧的
 * `body_digest`，这种场景下会漏报；observer 拿新正文比较，会重嵌。方向是安全的
 * （多嵌一条比漏嵌一条便宜），所以这不是 bug，也不该为了「一致」把 A 改成读磁盘。
 * 看到这两处结论不同时，先确认是不是这种索引滞后场景，不要直接判定谁写错了。
 *
 * 同理，本文件的用例都在**稳态**下：`node` 行由同一次 `runReindex --only=index`
 * 从这同一批磁盘文件建立。只有在这个前提下才要求 A 与 C 同结论；索引滞后的场景
 * 是上面那条刻意保留的差别，不属于本文件覆盖的范围。
 */

import { mkdirSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ContentStore } from '../../../src/adapters/fs/content-store.js';
import { MetadataFileStore } from '../../../src/adapters/fs/metadata-file.js';
import { NullLogger } from '../../../src/adapters/log/null.js';
import { openDatabase, runMigrations } from '../../../src/adapters/sqlite/database.js';
import { EmbeddingRepository } from '../../../src/adapters/sqlite/embedding-repository.js';
import { stableDigest } from '../../../src/domain/node.js';
import { Uri } from '../../../src/domain/uri.js';

/**
 * `runReindex` 自己构造 `AiSdkEmbeddingProvider`，测试只能打桩 SDK。手法与
 * `tests/integration/commands/reindex.test.ts` 相同：保留真实错误类，只替换
 * `embedMany` 与 provider 工厂。
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

const { hasDocumentsMissingVectors, runReindex } = await import('../../../src/commands/reindex.js');

const ROOT = 'comem://user/alice';
/** 唯一一条「有正文」的文档：四种组合都挂在它身上。 */
const DOC = `${ROOT}/memories/note.md`;
const BODY = '存量记忆的正文';
/** 空正文文件：索引里 `body_digest = stableDigest('')`，不该算缺向量。 */
const EMPTY = `${ROOT}/memories/empty.md`;
/** 目录行（`memories` 目录本身）：`kind = 'directory'`，不该算缺向量。 */
const DIR = `${ROOT}/memories`;
/**
 * 目录概览正文。有概览文件时目录在索引里有 L0 与 L1 两行，且 **L1 行的
 * `body_digest` 是概览正文的摘要（非空）**——所以「`kind = 'document'`」这条
 * 不是靠「空正文摘要」顺带挡住的，它自己能挡住一条有正文摘要的行。
 */
const OVERVIEW = '团队约定的详细说明：提交前跑完整测试';

const MODEL = 'test-embedding';
const OTHER_MODEL = 'other-embedding';
const DIMENSION = 3;

const logger = new NullLogger();

/** `model` 与 `content_digest` 两列独立造，四种组合都要出现。 */
interface EmbeddingSeed {
  readonly model: string;
  /** `fresh` = 摘要与磁盘正文一致；`stale` = 摘要停在旧正文上 */
  readonly digest: 'fresh' | 'stale';
}

interface Combo {
  readonly name: string;
  /** `null` = 连向量行都没有 */
  readonly embedding: EmbeddingSeed | null;
  /** A 与 C 都应该给出的结论 */
  readonly missing: boolean;
}

const COMBOS: readonly Combo[] = [
  {
    name: 'model 与 digest 都匹配',
    embedding: { model: MODEL, digest: 'fresh' },
    missing: false,
  },
  {
    name: 'model 匹配、digest 不匹配',
    embedding: { model: MODEL, digest: 'stale' },
    missing: true,
  },
  {
    name: 'model 不匹配、digest 匹配',
    embedding: { model: OTHER_MODEL, digest: 'fresh' },
    missing: true,
  },
  {
    name: 'model 与 digest 都不匹配',
    embedding: { model: OTHER_MODEL, digest: 'stale' },
    missing: true,
  },
  {
    name: '没有向量行',
    embedding: null,
    missing: true,
  },
];

function embeddingResult(values: readonly string[]): Record<string, unknown> {
  return {
    embeddings: values.map(() => [1, 0, 0]),
    usage: { tokens: values.length },
  };
}

beforeEach(() => {
  mocks.embedMany.mockImplementation(({ values }: { values: string[] }) =>
    Promise.resolve(embeddingResult(values)),
  );
});

afterEach(() => {
  vi.clearAllMocks();
});

async function writeConfig(configPath: string): Promise<void> {
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
      '    type: openai-compatible',
      '    baseUrl: https://example.test/v1',
      `    model: ${MODEL}`,
      '    apiKey: sk-test',
      `    dimension: ${String(DIMENSION)}`,
      '',
    ].join('\n'),
    'utf8',
  );
}

function openDb(dataDir: string): DatabaseSync {
  mkdirSync(join(dataDir, '_meta'), { recursive: true });
  const db = openDatabase(join(dataDir, '_meta', 'comem.sqlite'));
  runMigrations(db);
  return db;
}

function nodeRow(
  db: DatabaseSync,
  uri: string,
  level: string,
): Record<string, unknown> | undefined {
  return db
    .prepare('SELECT kind, level, body_digest FROM node WHERE uri = ? AND level = ?')
    .get(uri, level);
}

function embeddingUris(db: DatabaseSync): string[] {
  return db
    .prepare('SELECT uri FROM node_embedding ORDER BY uri')
    .all()
    .map((row) => String(row['uri']));
}

/**
 * 稳态：磁盘写正文 → `reindex --only=index` 建 `node` 行 → 按组合种 `node_embedding`
 * → 取 A 的结论 → 用 C 真跑一次 `reindex --only=embeddings` 取它的结论。
 *
 * 每个组合用一份新的数据根，避免上一轮的向量行影响「没有向量行」这类组合。
 *
 * C 的结论从公开输出里读（`vectors` = 实际重算并写入的行数），不复制它的判据：
 * 复制一份判据只能证明测试自己自洽，证明不了生产代码。
 */
async function runCombo(combo: Combo): Promise<void> {
  const dataDir = await mkdtemp(join(tmpdir(), 'comem-embedding-freshness-'));
  try {
    const configPath = join(dataDir, 'config.yaml');
    await writeConfig(configPath);

    const store = new ContentStore({ dataDir, logger });
    await store.writeText(Uri.parse(DOC), BODY);
    await store.writeText(Uri.parse(EMPTY), '');
    await new MetadataFileStore({ dataDir, logger }).writeSummary(
      Uri.parse(DIR),
      '团队约定',
      OVERVIEW,
      { generatedBy: 'rule', degraded: false },
    );

    const indexed = await runReindex({ dataDir, configPath, only: 'index' });
    expect(indexed.failed, combo.name).toBe(0);

    // 稳态前提：索引里的 `body_digest` 就是磁盘正文的摘要；空正文行与目录行都在。
    const readDb = openDb(dataDir);
    let indexSaysMissing: boolean;
    let seededEmbeddingUris: readonly string[];
    try {
      const embeddings = new EmbeddingRepository({ db: readDb, logger });
      embeddings.ensureSchema(DIMENSION, MODEL);
      if (combo.embedding !== null) {
        embeddings.upsert([
          {
            uri: DOC,
            model: combo.embedding.model,
            contentDigest:
              combo.embedding.digest === 'fresh'
                ? stableDigest(BODY)
                : stableDigest(`${BODY}（旧）`),
            vector: [1, 0, 0],
          },
        ]);
      }

      expect(nodeRow(readDb, DOC, 'L2'), combo.name).toEqual({
        kind: 'document',
        level: 'L2',
        body_digest: stableDigest(BODY),
      });
      expect(nodeRow(readDb, EMPTY, 'L2'), combo.name).toEqual({
        kind: 'document',
        level: 'L2',
        body_digest: stableDigest(''),
      });
      expect(nodeRow(readDb, DIR, 'L0'), combo.name).toEqual({
        kind: 'directory',
        level: 'L0',
        body_digest: stableDigest(''),
      });
      // 概览行：`kind = 'directory'` 且 `body_digest` 非空。A 只靠 `kind` 排除它，
      // 「空正文」那条子句在这里不起作用。
      expect(nodeRow(readDb, DIR, 'L1'), combo.name).toEqual({
        kind: 'directory',
        level: 'L1',
        body_digest: stableDigest(OVERVIEW),
      });

      seededEmbeddingUris = embeddingUris(readDb);
      indexSaysMissing = hasDocumentsMissingVectors(readDb, MODEL);
    } finally {
      readDb.close();
    }

    // 种子只落在 DOC 上：否则「空正文 / 目录有没有被排除」这条就测不出来了。
    expect(
      seededEmbeddingUris.filter((uri) => uri !== DOC),
      combo.name,
    ).toEqual([]);

    const reindexed = await runReindex({ dataDir, configPath, only: 'embeddings' });
    expect(reindexed.failed, combo.name).toBe(0);
    // C 的逐行判据只有两种落点：跳过（摘要对得上）或重算（写回向量）。
    // 只有一条可嵌入的正文，所以两个计数之和必须是 1——空正文与目录都不进这条路。
    expect(reindexed.vectors + reindexed.skipped, combo.name).toBe(1);
    const reindexSaysMissing = reindexed.vectors > 0;

    expect(reindexSaysMissing, combo.name).toBe(indexSaysMissing);
    expect(indexSaysMissing, combo.name).toBe(combo.missing);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

describe('「缺向量」的 SQL 判定与 reindex 逐行判据', () => {
  it('model × digest 四组组合（含无向量行）下两份实现给出同一结论', async () => {
    for (const combo of COMBOS) {
      await runCombo(combo);
    }
  });
});
