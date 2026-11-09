/**
 * `retrieval.rerank.enabled` 的开关差异验收（架构文档 §8.5、§18）。
 *
 * 已有覆盖：`tests/integration/api/http.test.ts` 的「重排接线」证明打开后 `find` 会
 * 调供应商、模型分成为最终分；`tests/integration/services/search.test.ts` 直接构造
 * `SearchService` 证明 `topN` / `keepTopN` 与降级。它们都没有回答这个开关的**用途**：
 * 同样的两条同分命中，关闭时与打开时的顺序是否不同。
 *
 * 这一条在同一份数据根上先后用两种配置启动容器（变量只有 `retrieval.rerank.enabled`），
 * 断言排序被重排结果改写。`keepTopN: 0`（默认）意味着只重排不截断。
 *
 * 供应商用 `fetch` 替身：按候选摘要给分（「乙」高、「甲」低），不出网。
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createContainer, type Container } from '../../../src/bootstrap/container.js';
import { Uri } from '../../../src/domain/uri.js';

const SCOPE = 'comem://user/local';
const PRINCIPALS: readonly string[] = ['user:local', 'user:*'];

/** 两条正文相同 → BM25 相同；排序只能由重排分或 URI 决定。 */
const FIRST_BY_URI = `${SCOPE}/memories/preferences/a.md`;
const SECOND_BY_URI = `${SCOPE}/memories/preferences/b.md`;
const BODY = '共同正文';

let dataDir: string;
let configPath: string;
let container: Container | undefined;

const COMMON_CONFIG = [
  'summary:',
  '  generator: rule',
  'session:',
  '  autoCommit:',
  '    enabled: false',
  'retrieval:',
  '  engine: fts5',
].join('\n');

function rerankOffConfig(): string {
  return COMMON_CONFIG;
}

function rerankOnConfig(): string {
  return [
    COMMON_CONFIG,
    '  rerank:',
    '    enabled: true',
    'providers:',
    '  rerank:',
    '    type: http',
    '    baseUrl: https://rerank.example.test/v1',
    '    model: fake-reranker',
    '    apiKey: test',
  ].join('\n');
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

/** 摘要「甲」低分、「乙」高分：重排打开后 b.md 必须越过按 URI 排序的 a.md。 */
function rerankResponse(documents: readonly string[]): Response {
  return new Response(
    JSON.stringify({
      results: documents.map((document, index) => ({
        index,
        relevance_score: document === '乙' ? 0.9 : 0.1,
      })),
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'comem-rerank-switch-'));
  configPath = join(dataDir, 'config.yaml');
  container = undefined;

  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if (!url.endsWith('/rerank')) {
        throw new TypeError(`集成测试只模拟重排请求，收到：${url}`);
      }
      const body = typeof init?.body === 'string' ? init.body : '';
      const parsed = JSON.parse(body) as { readonly documents: readonly string[] };
      return rerankResponse(parsed.documents);
    },
  );
});

afterEach(async () => {
  await container?.close();
  container = undefined;
  vi.restoreAllMocks();
  await rm(dataDir, { recursive: true, force: true });
});

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

describe('retrieval.rerank.enabled 的开关差异（container → find）', () => {
  it('关闭时同分按 URI 排序；打开后顺序被重排分改写', async () => {
    const writer = await start(rerankOffConfig());
    container = writer;
    await writer.services.filesystem.write(Uri.parse(FIRST_BY_URI), BODY, PRINCIPALS, {
      frontmatter: { summary: '甲' },
    });
    await writer.services.filesystem.write(Uri.parse(SECOND_BY_URI), BODY, PRINCIPALS, {
      frontmatter: { summary: '乙' },
    });
    await writer.services.indexObserver.drain();

    const off = await writer.services.search.find('共同正文', findOptions());
    expect(off.map((hit) => hit.uri)).toEqual([FIRST_BY_URI, SECOND_BY_URI]);

    await writer.services.indexObserver.drain();
    await writer.close();
    container = undefined;

    // 同一份数据根，只把重排开关打开。
    const reader = await start(rerankOnConfig());
    container = reader;
    expect(reader.config.retrieval.rerank.enabled).toBe(true);

    const on = await reader.services.search.find('共同正文', findOptions());
    expect(on.map((hit) => hit.uri)).toEqual([SECOND_BY_URI, FIRST_BY_URI]);
    expect(on[0]?.score).toBe(0.9);
    expect(on[1]?.score).toBe(0.1);
  });
});
