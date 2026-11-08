/**
 * L4：变体读取差集（架构文档 §18、`local/notes/config-design.md` 的「L4 实现」）。
 *
 * ## 这一层回答的问题
 *
 * L1（`scripts/check-config.ts`）只能证明「某个配置路径**在某个地方**被读了」。它
 * 看不到「只在某个引擎分支被读」：`retrieval.levelWeights` 曾经只在 `#rank` 里被
 * 读，而 `hybrid` 走 `#retrieveHybrid`、不经过 `#rank`——静态看「有消费方」，默认
 * 引擎下却完全无效。
 *
 * 这里按 `retrieval.engine` 各启动一次容器、各跑一遍五条入口，把**运行时**读到的
 * 配置路径收集起来做差集。差集非空 = 某个引擎下有配置项没有消费方。
 *
 * ## 为什么五条入口都要跑
 *
 * `find` / `search` / `context` / `grep` / `glob` 走不同的代码路径：`retrieval.assembly.*`
 * 只在 `context` 里读，`retrieval.queryFilters` 在 `find` / `search` 里读。只跑
 * `find` 会把 `retrieval.assembly.*` 误报成「只在其它引擎下被读」。
 *
 * ## 生产代码零改动
 *
 * `vi.mock` 只替换 `loadConfig` 的返回值：外面包一层 `Proxy` 记录 `get`。服务的
 * 构造与 `createContainer` 的装配完全走真实代码。
 *
 * ## 抓不到的那一类
 *
 * 「读了但输入恒空」——例如重排的候选文本永远是空字符串，整条路径空转。本测试只
 * 能证明「这个引擎下有人读了这条配置」，不能证明「读到的值改变了行为」。后者只有
 * 人写的行为契约测试能抓，见 `scripts/check-config.ts` 的文件头。
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it, vi } from 'vitest';

import type { Container } from '../../src/bootstrap/container.js';

/**
 * 读取记录。`vi.mock` 的工厂在模块导入期执行，早于本文件顶层的 `const`，所以
 * 记录容器必须走 `vi.hoisted`。
 */
const trace = vi.hoisted(() => {
  const reads = new Set<string>();

  const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

  const wrap = <T>(value: T, path: string): T => {
    if (!isRecord(value)) {
      return value;
    }
    return new Proxy(value, {
      get(target, key, receiver): unknown {
        const child: unknown = Reflect.get(target, key, receiver);
        if (typeof key !== 'string') {
          return child;
        }
        const childPath = path === '' ? key : `${path}.${key}`;
        reads.add(childPath);
        return wrap(child, childPath);
      },
    }) as T;
  };

  return { reads, wrap };
});

vi.mock('../../src/config/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/config/index.js')>();
  return {
    ...actual,
    loadConfig: (options?: Parameters<typeof actual.loadConfig>[0]) =>
      trace.wrap(actual.loadConfig(options), ''),
  };
});

const { createContainer } = await import('../../src/bootstrap/container.js');

const SUBJECT = 'user:local';
const PRINCIPALS = [SUBJECT, 'user:*'];
const SCOPES = ['comem://user/local/memories'];
const ENGINES = ['fts5', 'vector', 'hybrid'] as const;

type EngineName = (typeof ENGINES)[number];

const options = { scopes: SCOPES, subject: SUBJECT, principals: PRINCIPALS };

/**
 * 五条入口各跑一次。返回值本身不重要——这里断言的是「读了哪些配置路径」。
 */
async function runEntryPoints(service: Container['services']['search']): Promise<void> {
  await service.find('代码风格', options);
  await service.search('代码风格', options);
  await service.context('代码风格', options);
  await service.grep('代码', options);
  await service.glob('**/*.md', options);
}

async function containerFor(engine: EngineName): Promise<Container> {
  const dataDir = await mkdtemp(join(tmpdir(), `comem-config-coverage-${engine}-`));
  return createContainer({
    configPath: join(dataDir, 'config.yaml'),
    env: {
      ...process.env,
      COMEM_DATA_DIR: dataDir,
      COMEM_SUMMARY_GENERATOR: 'rule',
      COMEM_LOGGING_LEVEL: 'fatal',
      // 调度器会起 30 秒定时器；本测试只关心配置读取，不需要它。
      COMEM_SESSION_AUTOCOMMIT_ENABLED: 'false',
      COMEM_RETRIEVAL_ENGINE: engine,
      // 三个变体都配置嵌入：否则 `fts5` 变体会跳过 `providers.embedding.*` 的
      // 读取，差集里会多出「只在 vector/hybrid 下被读」的噪声，把真正的引擎
      // 差异淹掉。引擎是这次唯一的自变量。
      COMEM_PROVIDERS_EMBEDDING_TYPE: 'openai-compatible',
      COMEM_PROVIDERS_EMBEDDING_BASE_URL: 'http://127.0.0.1:1/v1',
      COMEM_PROVIDERS_EMBEDDING_API_KEY: 'test',
      // 维度决定 `node_embedding` 的表结构与供应商返回的向量长度；3 维足够。
      COMEM_PROVIDERS_EMBEDDING_DIMENSION: '3',
      COMEM_PROVIDERS_LLM_DEFAULT_BASE_URL: 'http://127.0.0.1:1/v1',
      COMEM_PROVIDERS_LLM_DEFAULT_API_KEY: 'test',
    },
  });
}

afterAll(() => {
  vi.unstubAllGlobals();
});

describe('配置覆盖（L4）', () => {
  it('fts5 / vector / hybrid 读到的配置路径完全相同', async () => {
    // 嵌入与意图分析都会出网。测试里不连外网：
    //
    // - 嵌入返回一个合法向量。**必须让 vector 分支走完正常路径**，否则
    //   `#retrieveVector` 在降级处提前返回、`#rank` 不被调用，
    //   `retrieval.levelWeights` 会凭空出现「只在 fts5 下被读」——那是测试
    //   环境的假阳性，不是分支缺口。
    // - 意图分析返回 400（不可重试），服务层降级成原查询，不影响检索路径。
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.includes('/embeddings')) {
          return new Response(
            JSON.stringify({
              object: 'list',
              data: [{ object: 'embedding', index: 0, embedding: [0.1, 0.2, 0.3] }],
              model: 'text-embedding-3-small',
              usage: { prompt_tokens: 1, total_tokens: 1 },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        return new Response(JSON.stringify({ error: { message: 'config-coverage test' } }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );

    const readsByEngine = new Map<EngineName, ReadonlySet<string>>();
    for (const engine of ENGINES) {
      trace.reads.clear();
      const container = await containerFor(engine);
      try {
        await runEntryPoints(container.services.search);
        readsByEngine.set(engine, new Set(trace.reads));
      } finally {
        await container.close();
        await rm(join(container.config.dataDir), { recursive: true, force: true });
      }
    }

    const baseline = readsByEngine.get('fts5') ?? new Set<string>();
    const report: string[] = [];
    for (const engine of ENGINES) {
      if (engine === 'fts5') {
        continue;
      }
      const current = readsByEngine.get(engine) ?? new Set<string>();
      const onlyBaseline = [...baseline].filter((path) => !current.has(path)).sort();
      const onlyEngine = [...current].filter((path) => !baseline.has(path)).sort();
      if (onlyBaseline.length > 0) {
        report.push(
          `只在 fts5（默认）下被读（${String(onlyBaseline.length)}）：\n${onlyBaseline
            .map((path) => `  - ${path}`)
            .join('\n')}`,
        );
      }
      if (onlyEngine.length > 0) {
        report.push(
          `只在 ${engine} 下被读（${String(onlyEngine.length)}）：\n${onlyEngine
            .map((path) => `  - ${path}`)
            .join('\n')}`,
        );
      }
    }

    expect(report.join('\n\n')).toBe('');
    // 空转的差集没有价值：至少证明真的记录到了配置读取。
    expect(baseline.size).toBeGreaterThan(0);
  });
});
