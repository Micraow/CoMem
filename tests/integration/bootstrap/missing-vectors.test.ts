/**
 * 启动时「存量记忆没有向量」的提醒（`src/bootstrap/main.ts` 的 `warnIfVectorsMissing`）。
 *
 * 背景：把 `retrieval.engine` 从 `fts5` 改成 `vector` / `hybrid`（或第一次配好嵌入
 * 供应商）之后，旧记忆的正文从来没有嵌过。向量检索对它们一条都命中不了，用户看到
 * 的现象是「切了引擎之后老记忆全搜不到了」，而当时没有任何提示。
 *
 * 两件事都在这里验：
 * - `warnIfVectorsMissing`：启动时能发现缺失，并且只在需要时查一次；
 * - `startVectorBackfill`：监听之后的后台回填把存量补齐，`fts5` 部署一次都不查库。
 *
 * 用真实容器 + 同一份数据根先后起两种引擎：缺向量这件事只有走 SQLite 才能验证，
 * 替身数据库证明不了 `hasDocumentsMissingVectors` 的 `NOT EXISTS` 真的能认出缺失。
 * 嵌入供应商用 `ai` 模块的桩，与 `commands/reindex.test.ts` 同一套手法。
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NullLogger } from '../../../src/adapters/log/null.js';
import { EmbeddingRepository } from '../../../src/adapters/sqlite/embedding-repository.js';
import { SqliteVectorIndex } from '../../../src/adapters/sqlite/vector-index.js';
import { createContainer, type Container } from '../../../src/bootstrap/container.js';
import {
  runMain,
  shutdownGracefully,
  startVectorBackfill,
  warnIfVectorsMissing,
} from '../../../src/bootstrap/main.js';
import { hasDocumentsMissingVectors } from '../../../src/commands/reindex.js';
import { stableDigest } from '../../../src/domain/node.js';
import { Uri } from '../../../src/domain/uri.js';

/**
 * `AiSdkEmbeddingProvider` 自己调 SDK：回填要真的拿到向量，只能打桩 `ai`。
 * 与 `tests/integration/commands/reindex.test.ts` 同一套手法。
 */
const mocks = vi.hoisted(() => {
  const embedMany = vi.fn();
  const embeddingModel = vi.fn((modelId: string) => ({
    provider: 'openai-compatible',
    modelId,
  }));
  // 工厂返回值既要能当 LLM provider 调用（`provider(modelId)`），又要带
  // `embeddingModel`：容器在同一个 mock 下同时构造 `AiSdkLlmProvider` 与嵌入。
  const createOpenAICompatible = vi.fn(() =>
    Object.assign((modelId: string) => ({ provider: 'openai-compatible', modelId }), {
      embeddingModel,
    }),
  );
  /** `runMain` 内部建的容器；它不返回句柄，测试靠这层包装拿到。 */
  const created: unknown[] = [];
  return { embedMany, embeddingModel, createOpenAICompatible, created };
});

vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return { ...actual, embedMany: mocks.embedMany };
});

vi.mock('@ai-sdk/openai-compatible', () => ({
  createOpenAICompatible: mocks.createOpenAICompatible,
}));

/**
 * `runMain` 里每次 `createContainer` 都记下来：不包装它就只能眼睁睁看着回填跑在
 * 一个拿不到的容器里。
 */
vi.mock('../../../src/bootstrap/container.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/bootstrap/container.js')>();
  return {
    ...actual,
    createContainer: async (options: Parameters<typeof actual.createContainer>[0]) => {
      const container = await actual.createContainer(options);
      mocks.created.push(container);
      return container;
    },
  };
});

/**
 * `runMain` 起的 HTTP 服务换成不会占端口的桩：这里验的是回填接线，不是监听。
 * 真起一个 Fastify 实例会让测试结束时留着一个没人关的句柄。
 */
vi.mock('../../../src/api/http/server.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/api/http/server.js')>();
  return {
    ...actual,
    startHttpServer: async () => ({
      url: 'http://127.0.0.1:0',
      app: undefined as unknown as import('fastify').FastifyInstance,
      close: async () => undefined,
    }),
  };
});

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

function embeddingConfig(engine: 'fts5' | 'vector'): string {
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
    `  engine: ${engine}`,
  ].join('\n');
}

function vectorConfig(): string {
  return embeddingConfig('vector');
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
  mocks.created.length = 0;
  mocks.embedMany.mockReset();
  // 所有正文都嵌成同一个单位向量；检索也用同一个向量，命中与否只取决于回填有没有跑。
  mocks.embedMany.mockImplementation(({ values }: { values: string[] }) =>
    Promise.resolve({
      embeddings: values.map(() => [1, 0, 0]),
      usage: { tokens: values.length },
    }),
  );
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

/**
 * 监听之后的后台回填（`startVectorBackfill`）。
 *
 * 与提醒分开验：提醒只回答「有没有缺」，回填要真的读盘、拿向量、写回
 * `node_embedding`，并且能在关闭信号下停下。
 */
describe('startVectorBackfill', () => {
  /** 真实 `SqliteVectorIndex` 上查一次：证明补出来的行能被向量检索命中。 */
  async function vectorHitUris(target: Container): Promise<readonly string[]> {
    const hits = await new SqliteVectorIndex({ db: target.db, logger: target.logger }).search({
      // 假供应商对所有正文都返回 [1, 0, 0]，查询向量用同一个。
      vector: [1, 0, 0],
      model: MODEL,
      limit: 10,
    });
    return hits.map((hit) => hit.uri);
  }

  it('把存量记忆的向量补齐：探测从有缺失变成没有，向量检索能命中它们', async () => {
    await seedWithFts5();

    const reader = await start(vectorConfig());
    container = reader;
    expect(hasDocumentsMissingVectors(reader.db, MODEL)).toBe(true);
    const info = vi.spyOn(reader.logger, 'info');

    const handle = startVectorBackfill(reader);
    await handle.done;

    expect(hasDocumentsMissingVectors(reader.db, MODEL)).toBe(false);
    await expect(vectorHitUris(reader)).resolves.toEqual(
      expect.arrayContaining([MEMORY, OTHER_MEMORY]),
    );

    // 每批一行 info（已补 / 剩余 / 失败），末尾一行汇总。
    const messages = info.mock.calls.map(([message]) => String(message));
    expect(messages).toContain('向量回填进度。');
    expect(messages).toContain('存量向量回填完成。');
  });

  it('fts5 部署一次都不查库，也不 warn', async () => {
    await seedWithFts5();

    const reader = await start(fts5Config());
    container = reader;
    // 从建好容器之后开始数：容器自己的迁移与自检也会查库，与回填无关。
    const prepare = vi.spyOn(reader.db, 'prepare');
    const warn = vi.spyOn(reader.logger, 'warn');

    const handle = startVectorBackfill(reader);
    await handle.done;

    expect(prepare).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('fts5 引擎即使配了嵌入供应商也不回填：没有向量臂，补齐只是白花配额', async () => {
    await seedWithFts5();

    const reader = await start(embeddingConfig('fts5'));
    container = reader;
    const prepare = vi.spyOn(reader.db, 'prepare');
    const warn = vi.spyOn(reader.logger, 'warn');

    const handle = startVectorBackfill(reader);
    await handle.done;

    expect(prepare).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(mocks.embedMany).not.toHaveBeenCalled();
  });

  it('同一个容器只跑一个回填：第二次启动拿到同一个句柄，不重复嵌入', async () => {
    await seedWithFts5();

    const reader = await start(vectorConfig());
    container = reader;
    const first = startVectorBackfill(reader);
    const second = startVectorBackfill(reader);

    expect(second).toBe(first);
    await first.done;

    // 两条记忆在同一批里，一次供应商调用；第二次启动没有再补一遍。
    expect(mocks.embedMany).toHaveBeenCalledTimes(1);
    expect(hasDocumentsMissingVectors(reader.db, MODEL)).toBe(false);
  });

  it('供应商失败：记 warn 后结束，不抛异常，缺向量留着下次再补', async () => {
    mocks.embedMany.mockRejectedValue(new Error('供应商挂了'));
    await seedWithFts5();

    const reader = await start(vectorConfig());
    container = reader;
    const warn = vi.spyOn(reader.logger, 'warn');

    const handle = startVectorBackfill(reader);
    await expect(handle.done).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalled();
    expect(hasDocumentsMissingVectors(reader.db, MODEL)).toBe(true);
  });

  it('关闭序列先停回填再关容器：回填写库不能撞上已关闭的连接', async () => {
    const order: string[] = [];

    await shutdownGracefully(
      {
        server: {
          close: async () => {
            order.push('server');
          },
        },
        commitRunner: {
          stop: async () => {
            order.push('commitRunner');
          },
        },
        backfill: {
          stop: async () => {
            order.push('backfill');
          },
        },
        container: {
          close: async () => {
            order.push('container');
          },
        },
        logger: new NullLogger(),
      },
      'SIGTERM',
    );

    expect(order).toEqual(['server', 'commitRunner', 'backfill', 'container']);
  });

  /**
   * 启动接线本身：`runMain` 里少掉 `startVectorBackfill(container)` 这一行，这条用例
   * 会一直等到超时。其余用例直接调 `startVectorBackfill`，证明不了 `runMain` 接了它。
   */
  it('runMain 在监听之后启动回填', async () => {
    await seedWithFts5();
    // `runMain` 不吃注入的 env，数据根写进配置文件。
    await writeFile(
      configPath,
      [vectorConfig(), `dataDir: ${dataDir}`, 'logging:', '  level: error'].join('\n'),
      'utf8',
    );

    const signals = ['SIGINT', 'SIGTERM'] as const;
    const before = new Map(signals.map((signal) => [signal, process.listeners(signal)]));
    try {
      await runMain(['--config', configPath]);

      const started = mocks.created.at(-1) as Container | undefined;
      expect(started).toBeDefined();
      const reader = started as Container;
      container = reader;

      await vi.waitFor(
        () => {
          expect(hasDocumentsMissingVectors(reader.db, MODEL)).toBe(false);
        },
        { timeout: 5_000 },
      );
      await expect(vectorHitUris(reader)).resolves.toEqual(
        expect.arrayContaining([MEMORY, OTHER_MEMORY]),
      );
    } finally {
      // `runMain` 注册的退出钩子留在进程上会污染后面的用例（包括真的收信号时）。
      for (const signal of signals) {
        const previous = before.get(signal) ?? [];
        for (const listener of process.listeners(signal)) {
          if (!previous.includes(listener)) {
            process.removeListener(signal, listener);
          }
        }
      }
    }
  });
});
