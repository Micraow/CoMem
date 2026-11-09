import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createContainer,
  type Container,
  type CreateContainerOptions,
} from '../../../src/bootstrap/container.js';
import { ComemError } from '../../../src/domain/errors.js';
import type { Logger } from '../../../src/domain/log.js';
import type { RetrievalEngine } from '../../../src/domain/retrieval.js';
import { parseDataset, type EvalDataset } from '../../../src/eval/dataset.js';
import { EvalRunner, type EvalVariant } from '../../../src/eval/runner.js';
import { EmbeddingService } from '../../../src/services/embedding.js';

/**
 * 评估执行器的集成测试。
 *
 * ## 为什么嵌入是替身
 *
 * 集成测试不能打外网（供应商不可用、计费、结果不可复现）。这里把
 * `EmbeddingService.embed` 换成一个**受控**的确定性向量：同义词查询与它的目标
 * 文档落在同一个轴上，标识符查询落在一个没有文档的轴上。
 *
 * 这个替身不是对 bge-m3 的测量——它只是在离线环境里复现「语义检索存在的理由」
 * 与「关键词检索存在的理由」两条**管线契约**：同义改写只有向量能命中，不透明
 * 标识符只有 FTS5 能精确命中。真实数字由 `pnpm eval` 在真实供应商上跑出来。
 *
 * ## 为什么重排要起一个本地 HTTP 服务
 *
 * `retrieval.rerank.enabled = true` 需要 `providers.rerank.type = http`（配置层
 * 交叉校验），而 `HttpRerankProvider` 会真的发请求。一个回环上的 `node:http`
 * 服务让「变体隔离」这条断言走的是真实装配，而不是靠 mock 掉 provider 绕过去。
 */

const DIMENSIONS = 8;

const CODE_STYLE_DOC = '代码风格偏好：TypeScript 严格模式，两个空格缩进。';
const LOCK_DOC = '路径锁按 URI 排序后获取，避免死锁。';
const SQLITE_DOC = 'URI_CHUNK_SIZE 是 SQLite 绑定变量的分批大小。';
const DEPLOY_DOC = '上线前跑 pnpm verify，确认测试全绿。';
const ACL_DOC = 'node_permission 存物化后的有效权限。';

const SYNONYM_QUERIES = [
  '怎样让不同人写出来的东西看起来一样',
  '多个人同时改同一个文件会不会丢改动',
  '团队产出的风格怎么统一',
] as const;

const IDENTIFIER_QUERIES = ['URI_CHUNK_SIZE', 'pnpm verify', 'node_permission'] as const;

/**
 * 文本 → 轴。同义查询与它的目标文档共享一个轴；标识符查询落在一个没有文档的轴
 * （`IDENTIFIER_QUERY_AXIS`）上。
 */
const IDENTIFIER_QUERY_AXIS = DIMENSIONS - 1;

function oneHot(axis: number): number[] {
  const vector = new Array<number>(DIMENSIONS).fill(0);
  vector[axis % DIMENSIONS] = 1;
  return vector;
}

function hashAxis(text: string): number {
  let hash = 0;
  for (const char of text) {
    hash = (hash * 31 + (char.codePointAt(0) ?? 0)) % 1009;
  }
  // 避开标识符查询的轴，保证未登记的文本不会抢到那个方向。
  return hash % (DIMENSIONS - 1);
}

const AXIS_BY_TEXT: ReadonlyMap<string, number> = new Map([
  [CODE_STYLE_DOC, 0],
  [LOCK_DOC, 1],
  [SQLITE_DOC, 2],
  [DEPLOY_DOC, 3],
  [ACL_DOC, 4],
  [SYNONYM_QUERIES[0], 0],
  [SYNONYM_QUERIES[1], 1],
  [SYNONYM_QUERIES[2], 0],
  [IDENTIFIER_QUERIES[0], IDENTIFIER_QUERY_AXIS],
  [IDENTIFIER_QUERIES[1], IDENTIFIER_QUERY_AXIS],
  [IDENTIFIER_QUERIES[2], IDENTIFIER_QUERY_AXIS],
]);

function vectorFor(text: string): number[] {
  const axis = AXIS_BY_TEXT.get(text.trim());
  return oneHot(axis ?? hashAxis(text));
}

const CORPUS: Readonly<Record<string, string>> = {
  'comem://user/test/memories/preferences/code-style.md': CODE_STYLE_DOC,
  'comem://user/test/memories/experiences/lock.md': LOCK_DOC,
  'comem://user/test/resources/sqlite.md': SQLITE_DOC,
  'comem://user/test/resources/deploy.md': DEPLOY_DOC,
  'comem://user/test/resources/acl.md': ACL_DOC,
};

function synonymDataset(): EvalDataset {
  return parseDataset({
    name: 'synonym',
    description: '同义改写：query 与语料没有共享字符。',
    corpus: CORPUS,
    cases: SYNONYM_QUERIES.map((query) => ({
      query,
      relevant: ['comem://user/test/memories/preferences/code-style.md'],
      ...(query === SYNONYM_QUERIES[1]
        ? { relevant: ['comem://user/test/memories/experiences/lock.md'] }
        : {}),
    })),
  });
}

function identifierDataset(): EvalDataset {
  return parseDataset({
    name: 'identifier',
    description: '专有名词：只有关键词检索能精确命中。',
    corpus: CORPUS,
    cases: [
      { query: IDENTIFIER_QUERIES[0], relevant: ['comem://user/test/resources/sqlite.md'] },
      { query: IDENTIFIER_QUERIES[1], relevant: ['comem://user/test/resources/deploy.md'] },
      { query: IDENTIFIER_QUERIES[2], relevant: ['comem://user/test/resources/acl.md'] },
    ],
  });
}

interface ObservedContainer {
  readonly engine: RetrievalEngine | undefined;
  readonly rerank: boolean;
  readonly levelWeights: { readonly l0: number; readonly l1: number; readonly l2: number };
  readonly dataDir: string;
}

interface RerankRequest {
  readonly documents?: unknown;
}

let configPath: string;
let tempRoot: string;
let rerankPort: number;
let rerankServer: ReturnType<typeof createServer>;
const observed: ObservedContainer[] = [];

function createTestContainer(options: CreateContainerOptions = {}): Promise<Container> {
  return createContainer({ ...options, configPath }).then((container) => {
    observed.push({
      engine: container.config.retrieval.engine,
      rerank: container.config.retrieval.rerank.enabled,
      levelWeights: container.config.retrieval.levelWeights,
      dataDir: container.config.dataDir,
    });
    return container;
  });
}

function createTestLogger(): Logger {
  const created: Logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return created;
}

function runner(): EvalRunner {
  return new EvalRunner({ createContainer: createTestContainer, logger: createTestLogger() });
}

beforeAll(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), 'comem-eval-test-'));
  configPath = join(tempRoot, 'config.yaml');

  rerankServer = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf8');
    });
    request.on('end', () => {
      const parsed = JSON.parse(body) as RerankRequest;
      const documents = Array.isArray(parsed.documents) ? parsed.documents : [];
      // 按入参顺序给递减分：重排真的会改变名次，不是空转。
      const results = documents.map((_, index) => ({
        index,
        relevance_score: Math.max(0, 1 - index * 0.1),
      }));
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ results }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    rerankServer.once('error', reject);
    rerankServer.listen(0, '127.0.0.1', resolve);
  });
  const address = rerankServer.address();
  if (address === null || typeof address === 'string') {
    throw new Error('重排测试服务没有拿到端口。');
  }
  rerankPort = address.port;

  await writeFile(
    configPath,
    [
      'providers:',
      '  embedding:',
      '    type: openai-compatible',
      '    baseUrl: http://127.0.0.1:1/v1',
      '    model: fake-embedding',
      '    apiKey: fake',
      `    dimension: ${String(DIMENSIONS)}`,
      '  rerank:',
      '    type: http',
      `    baseUrl: http://127.0.0.1:${String(rerankPort)}/v1`,
      '    model: fake-reranker',
      "    apiKey: ''",
      '    timeoutSeconds: 2',
      'logging:',
      '    level: fatal',
      '',
    ].join('\n'),
  );
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    rerankServer.close(() => {
      resolve();
    });
  });
  await rm(tempRoot, { recursive: true, force: true });
});

beforeEach(() => {
  observed.length = 0;
  // 受控嵌入：见文件头「为什么嵌入是替身」。
  vi.spyOn(EmbeddingService.prototype, 'embed').mockImplementation(async (texts) => ({
    vectors: texts.map((text) => vectorFor(text)),
    degraded: false,
    reason: null,
  }));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('EvalRunner 的引擎差异', () => {
  it('同义改写查询上，向量召回高于 FTS5', async () => {
    const report = await runner().run({
      dataset: synonymDataset(),
      engines: ['fts5', 'vector'],
      k: 1,
    });

    const fts5 = report.variants.find((variant) => variant.engine === 'fts5');
    const vector = report.variants.find((variant) => variant.engine === 'vector');
    expect(fts5).toBeDefined();
    expect(vector).toBeDefined();
    expect(vector?.metrics.recallAtK ?? 0).toBeGreaterThan(fts5?.metrics.recallAtK ?? 0);
  });

  it('专有名词查询上，FTS5 召回高于向量', async () => {
    const report = await runner().run({
      dataset: identifierDataset(),
      engines: ['fts5', 'vector'],
      k: 1,
    });

    const fts5 = report.variants.find((variant) => variant.engine === 'fts5');
    const vector = report.variants.find((variant) => variant.engine === 'vector');
    expect(fts5).toBeDefined();
    expect(vector).toBeDefined();
    expect(fts5?.metrics.recallAtK ?? 0).toBeGreaterThan(vector?.metrics.recallAtK ?? 0);
  });
});

describe('EvalRunner 的变体隔离', () => {
  it('每个变体各建一次容器，rerank 开关真的切换了', async () => {
    const variants: readonly EvalVariant[] = [
      { name: 'fts5', engine: 'fts5' },
      { name: 'hybrid', engine: 'hybrid' },
      { name: 'hybrid+rerank', engine: 'hybrid', overrides: { rerankEnabled: true } },
    ];

    await runner().run({ dataset: synonymDataset(), variants, k: 3 });

    expect(observed.map((entry) => [entry.engine, entry.rerank])).toEqual([
      ['fts5', false],
      ['hybrid', false],
      ['hybrid', true],
    ]);
  });

  it('层级权重变体真的切进容器（配置项生效）', async () => {
    const variants: readonly EvalVariant[] = [
      { name: 'hybrid', engine: 'hybrid' },
      {
        name: 'hybrid+levels',
        engine: 'hybrid',
        overrides: { levelWeights: { l0: 1, l1: 1, l2: 1 } },
      },
    ];

    await runner().run({ dataset: synonymDataset(), variants, k: 3 });

    // 默认权重来自 `config/schema.ts`（1.15 / 1.05 / 1.00），覆盖来自
    // `COMEM_RETRIEVAL_LEVEL_WEIGHTS_*`。两者必须真的不同，否则「层级权重
    // 变体」只是报告里多一行与基线逐位相同的数字。
    expect(observed.map((entry) => entry.levelWeights)).toEqual([
      { l0: 1.15, l1: 1.05, l2: 1 },
      { l0: 1, l1: 1, l2: 1 },
    ]);
  });

  it('变体之间使用不同的临时数据根', async () => {
    await runner().run({ dataset: synonymDataset(), engines: ['fts5', 'vector'], k: 3 });

    const dataDirs = observed.map((entry) => entry.dataDir);
    expect(dataDirs).toHaveLength(2);
    expect(new Set(dataDirs).size).toBe(2);
  });
});

describe('EvalRunner 的报告形状', () => {
  it('包含数据集名、k 与每个变体的指标和延迟', async () => {
    const report = await runner().run({ dataset: synonymDataset(), k: 2 });

    expect(report.dataset).toBe('synonym');
    expect(report.k).toBe(2);
    expect(report.variants.map((variant) => variant.name)).toEqual([
      'fts5',
      'vector',
      'hybrid',
    ]);

    for (const variant of report.variants) {
      expect(variant.engine).toBe(variant.name);
      expect(variant.metrics.queryCount).toBe(3);
      expect(variant.metrics.recallAtK).toBeGreaterThanOrEqual(0);
      expect(variant.metrics.recallAtK).toBeLessThanOrEqual(1);
      expect(variant.metrics.mrr).toBeGreaterThanOrEqual(0);
      expect(variant.metrics.ndcgAtK).toBeGreaterThanOrEqual(0);
      expect(variant.latency.p50Ms).toBeGreaterThanOrEqual(0);
      expect(variant.latency.p95Ms).toBeGreaterThanOrEqual(variant.latency.p50Ms);
      expect(variant.latency.meanMs).toBeGreaterThanOrEqual(0);
    }
  });

  it('k 不是正整数时拒绝执行', async () => {
    await expect(
      runner().run({ dataset: synonymDataset(), engines: ['fts5'], k: 0 }),
    ).rejects.toBeInstanceOf(ComemError);
  });
});

describe('parseDataset', () => {
  const valid = {
    name: 'x',
    description: '',
    corpus: { 'comem://user/a/doc.md': '正文' },
    cases: [{ query: '查询', relevant: ['comem://user/a/doc.md'] }],
  };

  it('接受合法数据集，并把 graded 缺省值留空', () => {
    const dataset = parseDataset(valid);

    expect(dataset.name).toBe('x');
    expect(dataset.cases[0]?.relevant).toEqual(['comem://user/a/doc.md']);
    expect(dataset.cases[0]?.graded).toBeUndefined();
  });

  it('拒绝不在语料里的标注 URI', () => {
    expect(() =>
      parseDataset({
        ...valid,
        cases: [{ query: '查询', relevant: ['comem://user/a/missing.md'] }],
      }),
    ).toThrowError(ComemError);
  });

  it('拒绝非法的 corpus URI', () => {
    expect(() =>
      parseDataset({
        ...valid,
        corpus: { 'not-a-uri': '正文' },
        cases: [],
      }),
    ).toThrowError(ComemError);
  });

  it('拒绝越界的分级相关度', () => {
    expect(() =>
      parseDataset({
        ...valid,
        cases: [
          {
            query: '查询',
            relevant: ['comem://user/a/doc.md'],
            graded: { 'comem://user/a/doc.md': 4 },
          },
        ],
      }),
    ).toThrowError(ComemError);
    expect(() =>
      parseDataset({
        ...valid,
        cases: [
          {
            query: '查询',
            relevant: ['comem://user/a/doc.md'],
            graded: { 'comem://user/a/doc.md': 1.5 },
          },
        ],
      }),
    ).toThrowError(ComemError);
  });

  it('拒绝空的 cases', () => {
    expect(() => parseDataset({ ...valid, cases: [] })).toThrowError(ComemError);
  });
});
