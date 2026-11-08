import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveDataDir } from '../../src/config/data-dir.js';
import { loadConfig } from '../../src/config/index.js';
import { ComemError } from '../../src/domain/errors.js';

const EXAMPLE_CONFIG_PATH = fileURLToPath(new URL('../../config.example.yaml', import.meta.url));

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'comem-config-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

/** 固定 XDG 数据目录，避免读取真实 home。 */
function testEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { XDG_DATA_HOME: join(tempDir, 'xdg'), ...extra };
}

function writeConfig(content: string): string {
  const filePath = join(tempDir, 'config.yaml');
  writeFileSync(filePath, content, 'utf8');
  return filePath;
}

function loadError(options: Parameters<typeof loadConfig>[0]): ComemError {
  try {
    loadConfig(options);
  } catch (error) {
    expect(error).toBeInstanceOf(ComemError);
    return error as ComemError;
  }
  throw new Error('期望 loadConfig 抛错，但它返回了配置');
}

/** 架构文档 §18 的完整默认值。 */
function expectedDefaults(dataDir: string): unknown {
  return {
    dataDir,
    providers: {
      llm: {
        default: {
          type: 'openai-compatible',
          baseUrl: 'https://api.example.com/v1',
          model: 'gpt-4o-mini',
          apiKey: '',
          maxTokens: 32768,
          timeoutSeconds: 120,
          pricing: { inputPerMillion: 0.15, outputPerMillion: 0.6 },
        },
      },
      embedding: {
        type: 'disabled',
        baseUrl: '',
        model: 'text-embedding-3-small',
        apiKey: '',
        dimension: 1536,
        maxBatchSize: 128,
        timeoutSeconds: 30,
        cache: { enabled: true, maxEntries: 20_000 },
      },
      rerank: {
        type: 'disabled',
        baseUrl: '',
        model: 'BAAI/bge-reranker-v2-m3',
        apiKey: '',
        timeoutSeconds: 30,
        topN: 50,
      },
    },
    summary: { generator: 'llm', abstractMaxChars: 256, overviewMaxChars: 4000 },
    retrieval: {
      engine: 'fts5',
      candidateMultiplier: 4,
      levelWeights: { l0: 1.15, l1: 1.05, l2: 1 },
      queryFilters: [],
      assembly: { maxTokens: 1600, dedupTurns: 3, quotaPreset: 'coding' },
      rerank: { enabled: false, keepTopN: 0 },
    },
    session: {
      autoCommit: {
        enabled: true,
        pendingTokenThreshold: 150000,
        messageCountThreshold: 100,
        minCommitIntervalSeconds: 0,
        idleTimeoutSeconds: 0,
        keepRecentCount: 0,
      },
      expiry: { idleTimeoutSeconds: 0, action: 'archive' },
    },
    memory: {
      reviewRequired: ['experiences', 'rules'],
      workingMemory: { enabled: false },
      ttl: { defaultDays: 0, sweepBatchSize: 100 },
      consolidation: { enabled: false, maxIterations: 10 },
    },
    acl: { groupDefaultLevel: 'write' },
    auth: { enabled: false, sessionSecret: '', sessionTtlSeconds: 86400 },
    server: { host: '127.0.0.1', port: 1933, subject: 'user:local' },
    logging: { level: 'info', file: '' },
    telemetry: {
      metrics: { enabled: true, includeAccountLabel: false },
      requestLog: { enabled: true, retainDays: 7, retainRows: 100000, sampleRate: 1 },
      hookOverhead: { enabled: true },
      hotness: { halfLifeHours: 168, weight: 0 },
    },
    task: { leaseSeconds: 60, maxAttempts: 3, concurrency: 4 },
    ingest: {
      enabled: false,
      batchSize: 100,
      extractionBatchSize: 20,
      extractionTimeoutMs: 1_800_000,
      paths: { 'claude-code': [], codex: [], deepseek: [], qwen: [] },
    },
  };
}

describe('loadConfig', () => {
  it('配置文件不存在时使用 §18 的默认值，不报错', () => {
    const config = loadConfig({
      path: join(tempDir, 'missing.yaml'),
      env: testEnv(),
      container: false,
      isRoot: false,
    });

    expect(config).toEqual(expectedDefaults(join(tempDir, 'xdg', 'comem')));
  });

  it('默认值里的 dataDir 非空：留空时按 §6.5 推导', () => {
    const config = loadConfig({
      path: writeConfig('dataDir: ""\n'),
      env: testEnv(),
      container: false,
      isRoot: false,
    });

    expect(config.dataDir).toBe(join(tempDir, 'xdg', 'comem'));
  });

  // §6.5 的四条规则。不注入 container / isRoot 时，宿主机上的真实判定会决定
  // 结果（容器里恒为 /var/lib/comem），这两条分支就永远测不到。
  it('容器里 dataDir 推导成 /var/lib/comem（§6.5）', () => {
    const config = loadConfig({
      path: writeConfig('dataDir: ""\n'),
      env: testEnv(),
      container: true,
    });

    expect(config.dataDir).toBe('/var/lib/comem');
  });

  it('以 root 运行时 dataDir 也推导成 /var/lib/comem（§6.5）', () => {
    const config = loadConfig({
      path: writeConfig('dataDir: ""\n'),
      env: testEnv(),
      isRoot: true,
    });

    expect(config.dataDir).toBe('/var/lib/comem');
  });

  it('显式 dataDir 优先于容器与 root 推导（§6.5 第 1 条）', () => {
    const config = loadConfig({
      path: writeConfig('dataDir: /explicit/path\n'),
      env: testEnv(),
      container: true,
      isRoot: true,
    });

    expect(config.dataDir).toBe('/explicit/path');
  });

  it('YAML 覆盖默认值，未写的字段保留默认值', () => {
    const config = loadConfig({
      path: writeConfig(
        [
          'server:',
          '  port: 8080',
          'summary:',
          '  generator: rule',
          'memory:',
          '  reviewRequired:',
          '    - rules',
        ].join('\n'),
      ),
      env: testEnv(),
    });

    expect(config.server.port).toBe(8080);
    expect(config.server.host).toBe('127.0.0.1');
    expect(config.summary.generator).toBe('rule');
    expect(config.summary.abstractMaxChars).toBe(256);
    expect(config.memory.reviewRequired).toEqual(['rules']);
  });

  it('server.subject 默认是 user:local（单用户桌面形态）', () => {
    const config = loadConfig({ path: join(tempDir, 'missing.yaml'), env: testEnv() });

    expect(config.server.subject).toBe('user:local');
  });

  it('server.subject 可以配成实际部署的用户', () => {
    const config = loadConfig({
      path: writeConfig('server:\n  subject: user:alice\n'),
      env: testEnv(),
    });

    expect(config.server.subject).toBe('user:alice');
  });

  it('server.subject 缺少 user / group 前缀时抛 INVALID_ARGUMENT', () => {
    const error = loadError({
      path: writeConfig('server:\n  subject: alice\n'),
      env: testEnv(),
    });

    expect(error.code).toBe('INVALID_ARGUMENT');
    expect(error.details).toMatchObject({ fields: ['server.subject'] });
  });

  it('server.subject 含大写字母时抛 INVALID_ARGUMENT', () => {
    const error = loadError({
      path: writeConfig('server:\n  subject: user:Alice\n'),
      env: testEnv(),
    });

    expect(error.code).toBe('INVALID_ARGUMENT');
    expect(error.details).toMatchObject({ fields: ['server.subject'] });
  });

  it('显式 dataDir 原样保留', () => {
    const config = loadConfig({ path: writeConfig('dataDir: /srv/comem\n'), env: testEnv() });

    expect(config.dataDir).toBe('/srv/comem');
  });

  it('config.example.yaml 可被加载，且与 §18 一致', () => {
    const config = loadConfig({
      path: EXAMPLE_CONFIG_PATH,
      env: testEnv({ COMEM_LLM_KEY: 'test-key', COMEM_EMBEDDING_KEY: 'test-embedding-key' }),
      container: false,
      isRoot: false,
    });

    expect(config).toEqual({
      ...(expectedDefaults(join(tempDir, 'xdg', 'comem')) as Record<string, unknown>),
      providers: {
        llm: {
          default: {
            type: 'openai-compatible',
            baseUrl: 'https://api.example.com/v1',
            model: 'gpt-4o-mini',
            apiKey: 'test-key',
            maxTokens: 32768,
            timeoutSeconds: 120,
            pricing: { inputPerMillion: 0.15, outputPerMillion: 0.6 },
          },
        },
        embedding: {
          type: 'openai-compatible',
          baseUrl: 'https://api.example.com/v1',
          model: 'BAAI/bge-m3',
          apiKey: 'test-embedding-key',
          dimension: 1024,
          maxBatchSize: 64,
          timeoutSeconds: 30,
          // config.example.yaml 与 schema 的默认值不同时以 example 为准：
          // example 里显式写了 cache 段，所以这里也是默认值。
          cache: { enabled: true, maxEntries: 20_000 },
        },
        rerank: {
          type: 'disabled',
          baseUrl: '',
          model: 'BAAI/bge-reranker-v2-m3',
          apiKey: '',
          timeoutSeconds: 30,
          topN: 50,
        },
      },
    });
  });

  it('ingest 默认关闭；paths 可以按宿主覆盖', () => {
    const config = loadConfig({
      path: writeConfig(
        [
          'ingest:',
          '  enabled: true',
          '  batchSize: 20',
          '  paths:',
          '    codex:',
          '      - /tmp/rollouts',
        ].join('\n'),
      ),
      env: testEnv(),
    });

    expect(config.ingest.enabled).toBe(true);
    expect(config.ingest.batchSize).toBe(20);
    expect(config.ingest.paths.codex).toEqual(['/tmp/rollouts']);
    expect(config.ingest.paths['claude-code']).toEqual([]);
  });

  describe('环境变量覆盖', () => {
    it('COMEM_<SECTION>_<KEY> 按目标类型强制转换', () => {
      const config = loadConfig({
        path: join(tempDir, 'missing.yaml'),
        env: testEnv({
          COMEM_SERVER_PORT: '8080',
          COMEM_RETRIEVAL_ASSEMBLY_MAX_TOKENS: '800',
          COMEM_RETRIEVAL_LEVEL_WEIGHTS_L0: '2',
          COMEM_ACL_GROUP_DEFAULT_LEVEL: 'read',
          COMEM_LOGGING_FILE: '/var/log/comem/error.log',
          COMEM_RETRIEVAL_QUERY_FILTERS: '["^recall"]',
          COMEM_MEMORY_REVIEW_REQUIRED: '["rules"]',
          COMEM_MEMORY_CONSOLIDATION_MAX_ITERATIONS: '5',
          COMEM_INGEST_ENABLED: 'true',
          COMEM_INGEST_BATCH_SIZE: '25',
          COMEM_INGEST_EXTRACTION_BATCH_SIZE: '10',
          COMEM_INGEST_EXTRACTION_TIMEOUT_MS: '600000',
        }),
      });

      expect(config.server.port).toBe(8080);
      expect(config.ingest.enabled).toBe(true);
      expect(config.ingest.batchSize).toBe(25);
      expect(config.ingest.extractionBatchSize).toBe(10);
      expect(config.ingest.extractionTimeoutMs).toBe(600000);
      expect(config.retrieval.assembly.maxTokens).toBe(800);
      expect(config.retrieval.levelWeights.l0).toBe(2);
      expect(config.acl.groupDefaultLevel).toBe('read');
      expect(config.logging.file).toBe('/var/log/comem/error.log');
      expect(config.retrieval.queryFilters).toEqual(['^recall']);
      expect(config.memory.reviewRequired).toEqual(['rules']);
      expect(config.memory.consolidation.maxIterations).toBe(5);
    });

    it('环境变量优先于配置文件', () => {
      const config = loadConfig({
        path: writeConfig('server:\n  port: 1111\n'),
        env: testEnv({ COMEM_SERVER_PORT: '2222' }),
      });

      expect(config.server.port).toBe(2222);
    });

    it('布尔值接受 true/false/1/0', () => {
      for (const [raw, expected] of [
        ['true', true],
        ['1', true],
        ['false', false],
        ['0', false],
      ] as const) {
        const config = loadConfig({
          path: join(tempDir, 'missing.yaml'),
          env: testEnv({ COMEM_TELEMETRY_HOOK_OVERHEAD_ENABLED: raw }),
        });
        expect(config.telemetry.hookOverhead.enabled).toBe(expected);
      }
    });

    it('无法转成目标类型时抛 INVALID_ARGUMENT 并带字段名', () => {
      const error = loadError({
        path: join(tempDir, 'missing.yaml'),
        env: testEnv({ COMEM_SERVER_PORT: 'not-a-port' }),
      });

      expect(error.code).toBe('INVALID_ARGUMENT');
      expect(error.details).toEqual({ field: 'COMEM_SERVER_PORT' });
      expect(error.message).toContain('COMEM_SERVER_PORT');
    });

    it('布尔值无法识别时抛 INVALID_ARGUMENT', () => {
      const error = loadError({
        path: join(tempDir, 'missing.yaml'),
        env: testEnv({ COMEM_TELEMETRY_HOOK_OVERHEAD_ENABLED: 'yes' }),
      });

      expect(error.code).toBe('INVALID_ARGUMENT');
      expect(error.details).toEqual({ field: 'COMEM_TELEMETRY_HOOK_OVERHEAD_ENABLED' });
    });

    it('数组不是合法 JSON 时抛 INVALID_ARGUMENT', () => {
      const error = loadError({
        path: join(tempDir, 'missing.yaml'),
        env: testEnv({ COMEM_RETRIEVAL_QUERY_FILTERS: 'a,b' }),
      });

      expect(error.code).toBe('INVALID_ARGUMENT');
    });
  });

  describe('${VAR} 展开', () => {
    it('字符串值里的环境变量被替换', () => {
      const config = loadConfig({
        path: writeConfig('providers:\n  llm:\n    default:\n      apiKey: ${COMEM_LLM_KEY}\n'),
        env: testEnv({ COMEM_LLM_KEY: 'sk-test' }),
      });

      expect(config.providers.llm.default.apiKey).toBe('sk-test');
    });

    it('引用未设置的变量时抛 INVALID_ARGUMENT', () => {
      const error = loadError({
        path: writeConfig('providers:\n  llm:\n    default:\n      apiKey: ${COMEM_MISSING_KEY}\n'),
        env: testEnv(),
      });

      expect(error.code).toBe('INVALID_ARGUMENT');
      expect(error.details).toEqual({ field: 'COMEM_MISSING_KEY' });
    });
  });

  describe('校验失败', () => {
    it('YAML 语法错误抛 INVALID_ARGUMENT', () => {
      const error = loadError({ path: writeConfig('server: [unclosed\n'), env: testEnv() });

      expect(error.code).toBe('INVALID_ARGUMENT');
    });

    it('顶层不是对象时抛 INVALID_ARGUMENT', () => {
      const error = loadError({ path: writeConfig('- a\n- b\n'), env: testEnv() });

      expect(error.code).toBe('INVALID_ARGUMENT');
    });

    it('字段类型错误时带字段路径', () => {
      const error = loadError({ path: writeConfig('server:\n  port: "abc"\n'), env: testEnv() });

      expect(error.code).toBe('INVALID_ARGUMENT');
      expect(error.details).toMatchObject({ fields: ['server.port'] });
      expect(error.message).toContain('server.port');
    });

    it('取值超出范围时同样报错', () => {
      const error = loadError({
        path: join(tempDir, 'missing.yaml'),
        env: testEnv({ COMEM_SERVER_PORT: '-1' }),
      });

      expect(error.code).toBe('INVALID_ARGUMENT');
      expect(error.details).toMatchObject({ fields: ['server.port'] });
    });

    it('retrieval.engine 非 fts5 而 providers.embedding 未配置时抛 INVALID_ARGUMENT', () => {
      const error = loadError({
        path: writeConfig('retrieval:\n  engine: vector\n'),
        env: testEnv(),
      });

      expect(error.code).toBe('INVALID_ARGUMENT');
      expect(error.message).toContain('providers.embedding');
      expect(error.details).toMatchObject({ field: 'providers.embedding', engine: 'vector' });
    });

    it('配了 providers.embedding 之后 vector / hybrid 引擎可用', () => {
      for (const engine of ['vector', 'hybrid']) {
        const config = loadConfig({
          path: writeConfig(
            [
              `retrieval:`,
              `  engine: ${engine}`,
              `providers:`,
              `  embedding:`,
              `    type: openai-compatible`,
              `    model: test-embedding`,
            ].join('\n'),
          ),
          env: testEnv(),
        });

        expect(config.retrieval.engine).toBe(engine);
        expect(config.providers.embedding.type).toBe('openai-compatible');
      }
    });

    it('retrieval.rerank.enabled 为 true 而 providers.rerank 未配置时抛 INVALID_ARGUMENT', () => {
      const error = loadError({
        path: writeConfig('retrieval:\n  rerank:\n    enabled: true\n'),
        env: testEnv(),
      });

      expect(error.code).toBe('INVALID_ARGUMENT');
      expect(error.message).toContain('providers.rerank');
      expect(error.details).toMatchObject({
        field: 'providers.rerank',
        rerankType: 'disabled',
      });
    });

    it('配了 providers.rerank 之后重排可用', () => {
      const config = loadConfig({
        path: writeConfig(
          [
            'retrieval:',
            '  rerank:',
            '    enabled: true',
            '    keepTopN: 10',
            'providers:',
            '  rerank:',
            '    type: http',
            '    baseUrl: https://rerank.example.test/v1',
            '    model: test-reranker',
          ].join('\n'),
        ),
        env: testEnv(),
      });

      expect(config.retrieval.rerank).toEqual({ enabled: true, keepTopN: 10 });
      expect(config.providers.rerank).toMatchObject({
        type: 'http',
        baseUrl: 'https://rerank.example.test/v1',
        model: 'test-reranker',
        timeoutSeconds: 30,
        topN: 50,
      });
    });

    it('重排关闭时 providers.rerank 保持 disabled 也不报错', () => {
      const config = loadConfig({
        path: writeConfig('retrieval:\n  rerank:\n    enabled: false\n'),
        env: testEnv(),
      });

      expect(config.providers.rerank.type).toBe('disabled');
      expect(config.retrieval.rerank.enabled).toBe(false);
    });

    it('memory.consolidation.enabled 为 true 而 summary.generator 是 rule 时抛 INVALID_ARGUMENT', () => {
      const error = loadError({
        path: writeConfig(
          [
            'summary:',
            '  generator: rule',
            'memory:',
            '  consolidation:',
            '    enabled: true',
          ].join('\n'),
        ),
        env: testEnv(),
      });

      expect(error.code).toBe('INVALID_ARGUMENT');
      expect(error.message).toContain('memory.consolidation.enabled');
      expect(error.details).toMatchObject({
        field: 'memory.consolidation.enabled',
        summaryGenerator: 'rule',
      });
    });

    it('summary.generator 是 llm 时记忆合并可用，maxIterations 真的生效', () => {
      const config = loadConfig({
        path: writeConfig(
          [
            'memory:',
            '  consolidation:',
            '    enabled: true',
            '    maxIterations: 3',
          ].join('\n'),
        ),
        env: testEnv(),
      });

      expect(config.summary.generator).toBe('llm');
      expect(config.memory.consolidation).toEqual({ enabled: true, maxIterations: 3 });
    });

    it('记忆合并默认关：不写配置时 enabled 是 false', () => {
      const config = loadConfig({ path: join(tempDir, 'missing.yaml'), env: testEnv() });

      expect(config.memory.consolidation).toEqual({ enabled: false, maxIterations: 10 });
    });

    it('workingMemory.enabled 在有 LLM 时合法（默认 provider 不是 disabled）', () => {
      const config = loadConfig({
        path: writeConfig('memory:\n  workingMemory:\n    enabled: true\n'),
        env: testEnv(),
      });

      expect(config.memory.workingMemory.enabled).toBe(true);
      expect(config.providers.llm.default.type).toBe('openai-compatible');
    });

    it('workingMemory 默认关：不写配置时 enabled 是 false', () => {
      const config = loadConfig({ path: join(tempDir, 'missing.yaml'), env: testEnv() });

      expect(config.memory.workingMemory).toEqual({ enabled: false });
    });
  });

  /**
   * 回归（W59）：没有 LLM 凭据的部署无法表达「我没有模型」。`embedding` / `rerank`
   * 都有 `disabled`，`llm` 是唯一的例外。
   *
   * 交叉校验的两条判据都表示「没有可用的模型」：摘要生成器是 `llm`，或开了记忆
   * 合并。两者在启动期失败，而不是让每次写文件都投递一次注定失败的摘要失效。
   */
  describe('providers.llm.default.type = disabled', () => {
    it('规则摘要 + 关闭合并时合法，配置里保留 disabled', () => {
      const config = loadConfig({
        path: writeConfig(
          [
            'providers:',
            '  llm:',
            '    default:',
            '      type: disabled',
            'summary:',
            '  generator: rule',
          ].join('\n'),
        ),
        env: testEnv(),
      });

      expect(config.providers.llm.default.type).toBe('disabled');
    });

    it('summary.generator 是 llm 时启动失败，错误消息指向两条修法', () => {
      const error = loadError({
        path: writeConfig(
          ['providers:', '  llm:', '    default:', '      type: disabled'].join('\n'),
        ),
        env: testEnv(),
      });

      expect(error.code).toBe('INVALID_ARGUMENT');
      expect(error.message).toContain('summary.generator');
      expect(error.message).toContain('rule');
      expect(error.message).toContain('providers.llm');
      expect(error.details).toMatchObject({
        field: 'providers.llm.default',
        summaryGenerator: 'llm',
        llmType: 'disabled',
      });
    });

    it('开了记忆合并时启动失败（复用 consolidation 的判据）', () => {
      for (const generator of ['llm', 'rule']) {
        const error = loadError({
          path: writeConfig(
            [
              'providers:',
              '  llm:',
              '    default:',
              '      type: disabled',
              'summary:',
              `  generator: ${generator}`,
              'memory:',
              '  consolidation:',
              '    enabled: true',
            ].join('\n'),
          ),
          env: testEnv(),
        });

        expect(error.code, generator).toBe('INVALID_ARGUMENT');
        expect(error.message, generator).toContain('memory.consolidation.enabled');
        expect(error.details, generator).toMatchObject({
          field: 'memory.consolidation.enabled',
          summaryGenerator: generator,
          llmType: 'disabled',
        });
      }
    });

    it('workingMemory.enabled 但没有 LLM 时启动失败（工作记忆不能降级）', () => {
      const error = loadError({
        path: writeConfig(
          [
            'providers:',
            '  llm:',
            '    default:',
            '      type: disabled',
            'summary:',
            '  generator: rule',
            'memory:',
            '  workingMemory:',
            '    enabled: true',
          ].join('\n'),
        ),
        env: testEnv(),
      });

      expect(error.code).toBe('INVALID_ARGUMENT');
      expect(error.message).toContain('memory.workingMemory.enabled');
      // 消息要说清「为什么不像 ingest 那样降级」：工作记忆没有规则生成器。
      expect(error.message).toContain('没有规则生成器');
      expect(error.details).toMatchObject({
        field: 'memory.workingMemory.enabled',
        llmType: 'disabled',
      });
    });

    it('没有配置 providers.llm 时保持 openai-compatible 默认值（默认部署不变）', () => {
      const config = loadConfig({ path: join(tempDir, 'missing.yaml'), env: testEnv() });

      expect(config.providers.llm.default.type).toBe('openai-compatible');
    });
  });

  describe('argv', () => {
    it('--data-dir 覆盖 dataDir', () => {
      const config = loadConfig({
        path: join(tempDir, 'missing.yaml'),
        env: testEnv(),
        argv: ['--data-dir', '/srv/comem-data'],
      });

      expect(config.dataDir).toBe('/srv/comem-data');
    });

    it('--data-dir=value 等价', () => {
      const config = loadConfig({
        path: join(tempDir, 'missing.yaml'),
        env: testEnv(),
        argv: ['--data-dir=/srv/comem-data'],
      });

      expect(config.dataDir).toBe('/srv/comem-data');
    });

    it('--config 指定配置文件', () => {
      const configPath = writeConfig('server:\n  port: 3000\n');
      const config = loadConfig({ env: testEnv(), argv: ['--config', configPath] });

      expect(config.server.port).toBe(3000);
    });

    it('options.path 优先于 --config', () => {
      const explicitPath = join(tempDir, 'explicit.yaml');
      writeFileSync(explicitPath, 'server:\n  port: 4000\n', 'utf8');
      const config = loadConfig({
        path: explicitPath,
        env: testEnv(),
        argv: ['--config', writeConfig('server:\n  port: 3000\n')],
      });

      expect(config.server.port).toBe(4000);
    });

    it('--data-dir 优先于 COMEM_DATA_DIR', () => {
      const config = loadConfig({
        path: join(tempDir, 'missing.yaml'),
        env: testEnv({ COMEM_DATA_DIR: '/from/env' }),
        argv: ['--data-dir', '/from/argv'],
      });

      expect(config.dataDir).toBe('/from/argv');
    });
  });
});

describe('resolveDataDir', () => {
  const home = '/home/alice';

  it('显式值优先于运行形态', () => {
    expect(
      resolveDataDir({ explicit: '/srv/comem', env: {}, platform: 'linux', homedir: home }),
    ).toBe('/srv/comem');
  });

  it('COMEM_DATA_DIR 作为显式值', () => {
    expect(
      resolveDataDir({
        env: { COMEM_DATA_DIR: '/srv/from-env' },
        platform: 'linux',
        homedir: home,
        container: false,
        isRoot: false,
      }),
    ).toBe('/srv/from-env');
  });

  it('空串按未提供处理', () => {
    expect(
      resolveDataDir({ explicit: '', env: {}, platform: 'linux', homedir: home, container: false, isRoot: false }),
    ).toBe('/home/alice/.local/share/comem');
  });

  it('容器里用 /var/lib/comem（不走 XDG）', () => {
    expect(
      resolveDataDir({
        env: { XDG_DATA_HOME: '/xdg' },
        platform: 'linux',
        homedir: home,
        container: true,
        isRoot: false,
      }),
    ).toBe('/var/lib/comem');
  });

  it('以 root 运行的系统服务用 /var/lib/comem', () => {
    expect(
      resolveDataDir({ env: {}, platform: 'linux', homedir: home, container: false, isRoot: true }),
    ).toBe('/var/lib/comem');
  });

  it('linux 用 $XDG_DATA_HOME/comem', () => {
    expect(
      resolveDataDir({
        env: { XDG_DATA_HOME: '/xdg/data' },
        platform: 'linux',
        homedir: home,
        container: false,
        isRoot: false,
      }),
    ).toBe('/xdg/data/comem');
  });

  it('linux 没有 XDG 时用 ~/.local/share/comem', () => {
    expect(
      resolveDataDir({ env: {}, platform: 'linux', homedir: home, container: false, isRoot: false }),
    ).toBe('/home/alice/.local/share/comem');
  });

  it('darwin 用 ~/Library/Application Support/comem', () => {
    expect(
      resolveDataDir({ env: {}, platform: 'darwin', homedir: home, container: false, isRoot: false }),
    ).toBe('/home/alice/Library/Application Support/comem');
  });

  it('win32 用 %APPDATA%\\comem', () => {
    expect(
      resolveDataDir({
        env: { APPDATA: '/appdata/roaming' },
        platform: 'win32',
        homedir: home,
        container: false,
        isRoot: false,
      }),
    ).toBe(join('/appdata/roaming', 'comem'));
  });

  it('win32 没有 APPDATA 时回到 home 下的默认位置', () => {
    expect(
      resolveDataDir({ env: {}, platform: 'win32', homedir: home, container: false, isRoot: false }),
    ).toBe(join(home, 'AppData', 'Roaming', 'comem'));
  });
});
