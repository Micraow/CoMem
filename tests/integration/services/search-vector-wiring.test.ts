/**
 * `retrieval.engine = vector` 的接线验收（架构文档 §8.3、§18）。
 *
 * 已有覆盖分成两层，中间恰好断了一截：
 * - `tests/integration/services/search-hybrid.test.ts` 直接 `new SearchService`，
 *   证明「引擎参数传进去之后语义检索成立」；
 * - `tests/integration/config-coverage.test.ts` 用容器跑三种引擎，但只断言「配置
 *   路径被读过」，不看命中。
 *
 * 缺的是：配置写 `engine: vector` + 配好嵌入供应商之后，真实容器产出的命中与默认
 * `fts5` **不同**。这一截只有走 `createContainer` 才能覆盖——向量索引没挂上、嵌入
 * 没接到写路径，服务层单测都不会红。
 *
 * 嵌入供应商用 `fetch` 替身封住（回环地址只是书面说明，真正的隔离是替身）；
 * 同一份数据根先后用两种引擎启动容器，变量只有配置。
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createContainer, type Container } from '../../../src/bootstrap/container.js';
import { Uri } from '../../../src/domain/uri.js';

const SCOPE = 'comem://user/local';
const PRINCIPALS: readonly string[] = ['user:local', 'user:*'];

const LEXICAL = `${SCOPE}/memories/preferences/lexical.md`;
const SEMANTIC = `${SCOPE}/memories/preferences/semantic.md`;

/** 3 维，与 `providers.embedding.dimension` 一致。 */
const DIMENSION = 3;
const EXACT = [1, 0, 0] as const;
const FAR = [0, 1, 0] as const;

let dataDir: string;
let configPath: string;
let container: Container | undefined;

/**
 * 嵌入替身：把正文映射成可预期的向量。
 *
 * - 查询 `数据库` 与语义文档（正文「完全无关的正文」）落在同一方向；
 * - 关键词文档（含「数据库」但不含「完全无关」）落在另一个方向。
 *
 * 于是「向量检索找得到、关键词检索找不到」是确定的，不依赖模型。
 */
function embeddingResponse(input: string | readonly string[]): Response {
  const texts = typeof input === 'string' ? [input] : [...input];
  return new Response(
    JSON.stringify({
      object: 'list',
      data: texts.map((text, index) => ({
        object: 'embedding',
        index,
        embedding: text.includes('完全无关') || text === '数据库' ? [...EXACT] : [...FAR],
      })),
      model: 'fake-embedding',
      usage: { prompt_tokens: 1, total_tokens: 1 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

const COMMON_CONFIG = [
  'summary:',
  '  generator: rule',
  'session:',
  '  autoCommit:',
  '    enabled: false',
].join('\n');

function vectorConfig(): string {
  return [
    COMMON_CONFIG,
    'providers:',
    '  embedding:',
    '    type: openai-compatible',
    '    baseUrl: https://embedding.example.test/v1',
    '    model: fake-embedding',
    '    apiKey: test',
    `    dimension: ${String(DIMENSION)}`,
    'retrieval:',
    '  engine: vector',
  ].join('\n');
}

function fts5Config(): string {
  return [COMMON_CONFIG, 'retrieval:', '  engine: fts5'].join('\n');
}

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

function findOptions(): {
  readonly scopes: readonly string[];
  readonly subject: string;
  readonly principals: readonly string[];
} {
  return {
    scopes: [`${SCOPE}/memories`],
    subject: 'user:local',
    principals: PRINCIPALS,
  };
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'comem-search-vector-wiring-'));
  configPath = join(dataDir, 'config.yaml');
  container = undefined;

  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if (!url.endsWith('/embeddings')) {
        throw new TypeError(`集成测试只模拟嵌入请求，收到：${url}`);
      }
      const body = typeof init?.body === 'string' ? init.body : '';
      const parsed = JSON.parse(body) as { readonly input: string | readonly string[] };
      return embeddingResponse(parsed.input);
    },
  );
});

afterEach(async () => {
  await container?.close();
  container = undefined;
  vi.restoreAllMocks();
  await rm(dataDir, { recursive: true, force: true });
});

describe('retrieval.engine 的容器接线', () => {
  it('engine: vector 命中语义文档；同一数据根切回默认 fts5 后命中的是关键词文档', async () => {
    // 先写数据：LEXICAL 含查询词，SEMANTIC 不含但向量同向。
    const writer = await start(vectorConfig());
    container = writer;
    expect(writer.config.retrieval.engine).toBe('vector');
    await writer.services.filesystem.write(
      Uri.parse(LEXICAL),
      '数据库 记忆 存储',
      PRINCIPALS,
    );
    await writer.services.filesystem.write(Uri.parse(SEMANTIC), '完全无关的正文', PRINCIPALS);
    await writer.services.indexObserver.drain();

    const vectorHits = await writer.services.search.find('数据库', findOptions());
    expect(vectorHits.length).toBeGreaterThan(0);
    // 排第一的是语义文档：关键词文档与查询向量正交，语义文档完全重合。
    expect(vectorHits[0]?.uri).toBe(SEMANTIC);

    await writer.services.indexObserver.drain();
    await writer.close();
    container = undefined;

    // 同一份数据根、只把 `retrieval.engine` 切回默认值。
    const reader = await start(fts5Config());
    container = reader;
    expect(reader.config.retrieval.engine).toBe('fts5');

    const ftsHits = await reader.services.search.find('数据库', findOptions());
    expect(ftsHits.length).toBeGreaterThan(0);
    expect(ftsHits[0]?.uri).toBe(LEXICAL);
    // 两种引擎的命中不同：这就是「配置真的生效」的用户可见证据。
    expect(ftsHits.map((hit) => hit.uri)).not.toEqual(vectorHits.map((hit) => hit.uri));
  });
});
