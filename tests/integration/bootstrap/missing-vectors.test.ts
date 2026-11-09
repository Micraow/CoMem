/**
 * 启动时「存量记忆没有向量」的提醒（`src/bootstrap/main.ts` 的 `warnIfVectorsMissing`）。
 *
 * 背景：把 `retrieval.engine` 从 `fts5` 改成 `vector` / `hybrid`（或第一次配好嵌入
 * 供应商）之后，旧记忆的正文从来没有嵌过。向量检索对它们一条都命中不了，用户看到
 * 的现象是「切了引擎之后老记忆全搜不到了」，而当时没有任何提示。补齐靠
 * `pnpm reindex`，这里断言的是「启动时能发现，并且只在需要时查一次」。
 *
 * 用真实容器 + 同一份数据根先后起两种引擎：缺向量这件事只有走 SQLite 才能验证，
 * 替身数据库证明不了 `iterMissingUris` 的 `NOT EXISTS` 真的能认出缺失。
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EmbeddingRepository } from '../../../src/adapters/sqlite/embedding-repository.js';
import { createContainer, type Container } from '../../../src/bootstrap/container.js';
import { warnIfVectorsMissing } from '../../../src/bootstrap/main.js';
import { stableDigest } from '../../../src/domain/node.js';
import { Uri } from '../../../src/domain/uri.js';

const SCOPE = 'comem://user/local';
const PRINCIPALS: readonly string[] = ['user:local', 'user:*'];
const MEMORY = `${SCOPE}/memories/missing.md`;
const MEMORY_BODY = '存量记忆的正文';
const OTHER_MEMORY = `${SCOPE}/memories/present.md`;
const OTHER_BODY = '另一条存量记忆';

const DIMENSION = 3;
const MODEL = 'fake-embedding';

const COMMON_CONFIG = [
  'summary:',
  '  generator: rule',
  'session:',
  '  autoCommit:',
  '    enabled: false',
].join('\n');

function fts5Config(): string {
  return [COMMON_CONFIG, 'retrieval:', '  engine: fts5'].join('\n');
}

function vectorConfig(): string {
  return [
    COMMON_CONFIG,
    'providers:',
    '  embedding:',
    '    type: openai-compatible',
    '    baseUrl: https://embedding.example.test/v1',
    `    model: ${MODEL}`,
    '    apiKey: test',
    `    dimension: ${String(DIMENSION)}`,
    'retrieval:',
    '  engine: vector',
  ].join('\n');
}

let dataDir: string;
let configPath: string;
let container: Container | undefined;

async function start(yaml: string): Promise<Container> {
  await writeFile(configPath, yaml, 'utf8');
  return createContainer({
    configPath,
    env: {
      ...process.env,
      COMEM_DATA_DIR: dataDir,
      COMEM_LOGGING_LEVEL: 'error',
    },
  });
}

/** 用 fts5 引擎把两条记忆写进磁盘与检索索引：这是「切换引擎之前就已经存在的数据」。 */
async function seedWithFts5(): Promise<void> {
  const writer = await start(fts5Config());
  try {
    await writer.services.filesystem.write(Uri.parse(MEMORY), MEMORY_BODY, PRINCIPALS);
    await writer.services.filesystem.write(Uri.parse(OTHER_MEMORY), OTHER_BODY, PRINCIPALS);
    await writer.services.indexObserver.drain();
  } finally {
    await writer.close();
  }
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'comem-missing-vectors-'));
  configPath = join(dataDir, 'config.yaml');
  container = undefined;
});

afterEach(async () => {
  await container?.close();
  container = undefined;
  vi.restoreAllMocks();
  await rm(dataDir, { recursive: true, force: true });
});

describe('warnIfVectorsMissing', () => {
  it('vector 引擎下存在缺向量的记忆：warn 一次，并指向 pnpm reindex', async () => {
    await seedWithFts5();

    const reader = await start(vectorConfig());
    container = reader;
    const warn = vi.spyOn(reader.logger, 'warn');

    warnIfVectorsMissing(reader);

    expect(warn).toHaveBeenCalledTimes(1);
    const [message, fields] = warn.mock.calls[0] ?? [];
    expect(String(message)).toContain('pnpm reindex');
    expect(fields).toMatchObject({ engine: 'vector', model: MODEL });
  });

  it('fts5 部署一次都不查：不碰数据库，也不 warn', async () => {
    await seedWithFts5();

    const reader = await start(fts5Config());
    container = reader;
    // 从建好容器之后开始数：容器自己的迁移与自检也会查库，那与这条探测无关。
    const prepare = vi.spyOn(reader.db, 'prepare');
    const warn = vi.spyOn(reader.logger, 'warn');

    warnIfVectorsMissing(reader);

    expect(prepare).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('正文改过而向量还是旧的：算缺失（reindex 会重算这一条）', async () => {
    await seedWithFts5();

    const reader = await start(vectorConfig());
    container = reader;
    const embeddings = new EmbeddingRepository({ db: reader.db, logger: reader.logger });
    for (const [uri, body] of [
      [MEMORY, MEMORY_BODY],
      [OTHER_MEMORY, OTHER_BODY],
    ] as const) {
      // `content_digest` 是旧正文的摘要：能搜到，但搜的是改之前那份内容。
      embeddings.upsert([
        { uri, model: MODEL, contentDigest: stableDigest(`${body}（旧）`), vector: [1, 0, 0] },
      ]);
    }
    const warn = vi.spyOn(reader.logger, 'warn');

    warnIfVectorsMissing(reader);

    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('vector 引擎下所有记忆都有向量：不 warn（否则每次启动都刷一条）', async () => {
    await seedWithFts5();

    const reader = await start(vectorConfig());
    container = reader;
    // 向量行的 `content_digest` 必须对上 `node.body_digest`：这对不上就是
    // 「向量还是旧正文的」，`reindex` 会重算，所以启动提醒也应该出现。
    const embeddings = new EmbeddingRepository({ db: reader.db, logger: reader.logger });
    for (const [uri, body] of [
      [MEMORY, MEMORY_BODY],
      [OTHER_MEMORY, OTHER_BODY],
    ] as const) {
      embeddings.upsert([
        { uri, model: MODEL, contentDigest: stableDigest(body), vector: [1, 0, 0] },
      ]);
    }
    const warn = vi.spyOn(reader.logger, 'warn');

    warnIfVectorsMissing(reader);

    expect(warn).not.toHaveBeenCalled();
  });
});
