import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Fastify, { type FastifyInstance, type InjectOptions } from 'fastify';
import { parse as parseYaml } from 'yaml';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { toErrorEnvelope } from '../../../src/api/http/error-mapper.js';
import {
  createIdentityMiddleware,
  createRequestIdMiddleware,
} from '../../../src/api/http/middleware.js';
import { createConfigRoutes } from '../../../src/api/http/routes/config.js';
import { createHttpServer } from '../../../src/api/http/server.js';
import { createContainer, type Container } from '../../../src/bootstrap/container.js';
import { loadConfigSnapshot } from '../../../src/config/index.js';
import { startFakeLlmHttp } from '../../helpers/fake-llm-http.js';

const LLM_KEY = 'sk-llm-secret-1234';
const EMBEDDING_KEY = 'sk-embed-secret-5678';
const RERANK_KEY = 'sk-rerank-secret-9012';
const SESSION_SECRET = 'session-secret-abcd';

let dataDir: string;
let configPath: string;
let container: Container;
let app: FastifyInstance;

function testEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    COMEM_DATA_DIR: dataDir,
    COMEM_LOGGING_LEVEL: 'error',
    COMEM_PROVIDERS_LLM_DEFAULT_MODEL: 'env-model',
    COMEM_AUTH_ADMIN_USER_IDS: JSON.stringify(['local']),
  };
}

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'comem-config-api-'));
  configPath = join(dataDir, 'config.yaml');
  writeFileSync(
    configPath,
    [
      'providers:',
      '  llm:',
      '    default:',
      '      baseUrl: http://file.example/v1',
      `      apiKey: "${LLM_KEY}"`,
      '  embedding:',
      '    type: openai-compatible',
      '    dimension: 2',
      `    apiKey: "${EMBEDDING_KEY}"`,
      '  rerank:',
      '    type: http',
      '    baseUrl: http://rerank.example/v1',
      `    apiKey: "${RERANK_KEY}"`,
      'auth:',
      `  sessionSecret: "${SESSION_SECRET}"`,
      '  adminUserIds:',
      '    - local',
    ].join('\n'),
    'utf8',
  );
  container = await createContainer({ configPath, env: testEnv() });
  app = await createHttpServer({
    config: container.config,
    logger: container.logger,
    observability: container.observability,
    routes: container.routes,
    mcp: container.mcp,
    resolveIdentity: container.resolveIdentity,
  });
});

afterEach(async () => {
  await container.services.indexObserver.drain();
  await app.close();
  await container.close();
  vi.unstubAllGlobals();
  rmSync(dataDir, { recursive: true, force: true });
});

function inject(options: InjectOptions) {
  return app.inject(options);
}

function resultOf(response: { readonly body: string }): Record<string, unknown> {
  const body = JSON.parse(response.body) as Record<string, unknown>;
  expect(body['status']).toBe('ok');
  return body['result'] as Record<string, unknown>;
}

function errorOf(response: { readonly body: string }): Record<string, unknown> {
  const body = JSON.parse(response.body) as Record<string, unknown>;
  expect(body['status']).toBe('error');
  return body['error'] as Record<string, unknown>;
}

function itemsOf(result: Record<string, unknown>): Map<string, Record<string, unknown>> {
  const items = result['items'] as Record<string, unknown>[];
  expect(items).toHaveLength(86);
  return new Map(items.map((item) => [item['path'] as string, item]));
}

describe('GET /api/v1/config', () => {
  it('回全部 86 个叶子，密钥只有掩码', async () => {
    const response = await inject({ method: 'GET', url: '/api/v1/config' });
    const result = resultOf(response);
    const items = itemsOf(result);

    expect(result['overridePath']).toBe(join(dataDir, '_meta', 'config.override.yaml'));
    expect(result['overrideWritable']).toBe(true);

    for (const secret of [LLM_KEY, EMBEDDING_KEY, RERANK_KEY, SESSION_SECRET]) {
      expect(response.body).not.toContain(secret);
    }

    expect(items.get('providers.llm.default.apiKey')).toMatchObject({
      value: null,
      secret: true,
      configured: true,
      masked: '****1234',
      editable: true,
    });
    expect(items.get('providers.embedding.apiKey')).toMatchObject({
      value: null,
      secret: true,
      configured: true,
      masked: '****5678',
    });
    expect(items.get('providers.rerank.apiKey')).toMatchObject({
      value: null,
      secret: true,
      configured: true,
      masked: '****9012',
    });
    expect(items.get('auth.sessionSecret')).toMatchObject({
      value: null,
      secret: true,
      configured: true,
      masked: '****abcd',
      editable: false,
    });
  });

  it('不可暴露的项 value 为 null 且附原因', async () => {
    const items = itemsOf(resultOf(await inject({ method: 'GET', url: '/api/v1/config' })));

    for (const path of [
      'dataDir',
      'auth.adminUserIds',
      'auth.trustLoopback',
      'server.host',
      'server.port',
      'logging.file',
      'ingest.paths.claude-code',
      'ingest.paths.codex',
      'ingest.paths.deepseek',
      'ingest.paths.qwen',
      'task.leaseSeconds',
      'task.maxAttempts',
      'task.concurrency',
    ]) {
      const item = items.get(path);
      expect(item, path).toMatchObject({ value: null, editable: false });
      expect(String(item?.['reason']).length, path).toBeGreaterThan(0);
    }
    expect(items.get('dataDir')?.['reason']).toContain('换库');
  });

  it('来源、环境变量名与分组可读', async () => {
    const items = itemsOf(resultOf(await inject({ method: 'GET', url: '/api/v1/config' })));

    expect(items.get('providers.llm.default.baseUrl')).toMatchObject({
      value: 'http://file.example/v1',
      source: 'file',
      group: 'llm',
      envName: 'COMEM_PROVIDERS_LLM_DEFAULT_BASE_URL',
      editable: true,
    });
    expect(items.get('providers.llm.default.model')).toMatchObject({
      value: 'env-model',
      source: 'env',
    });
    expect(items.get('retrieval.queryFilters')).toMatchObject({
      editable: false,
      value: [],
    });
  });
});

describe('PATCH /api/v1/config', () => {
  function patch(values: Record<string, unknown>) {
    return inject({ method: 'PATCH', url: '/api/v1/config', payload: { values } });
  }

  function overridePath(): string {
    return join(dataDir, '_meta', 'config.override.yaml');
  }

  it('未知配置项返回 400', async () => {
    const response = await inject({
      method: 'PATCH',
      url: '/api/v1/config',
      payload: { values: { 'providers.llm.default.baseURL': 'http://typo/v1' } },
    });

    expect(response.statusCode).toBe(400);
    expect(errorOf(response)['code']).toBe('INVALID_ARGUMENT');
    expect(existsSync(overridePath())).toBe(false);
  });

  it('dataDir 与不可编辑项被白名单拒绝', async () => {
    for (const path of ['dataDir', 'task.concurrency', 'retrieval.queryFilters']) {
      const response = await inject({
        method: 'PATCH',
        url: '/api/v1/config',
        payload: { values: { [path]: 1 } },
      });
      expect(response.statusCode, path).toBe(400);
      expect(errorOf(response)['code'], path).toBe('INVALID_ARGUMENT');
    }
    expect(existsSync(overridePath())).toBe(false);
  });

  it('类型不符时一个字节都不写', async () => {
    const response = await inject({
      method: 'PATCH',
      url: '/api/v1/config',
      payload: { values: { 'providers.llm.default.maxTokens': 'lots' } },
    });

    expect(response.statusCode).toBe(400);
    expect(errorOf(response)['code']).toBe('INVALID_ARGUMENT');
    expect(existsSync(overridePath())).toBe(false);
  });

  it('被环境变量遮住的项拒绝写入', async () => {
    const response = await inject({
      method: 'PATCH',
      url: '/api/v1/config',
      payload: { values: { 'providers.llm.default.model': 'other-model' } },
    });

    expect(response.statusCode).toBe(400);
    const error = errorOf(response);
    expect(error['code']).toBe('INVALID_ARGUMENT');
    expect(String(error['message'])).toContain('COMEM_PROVIDERS_LLM_DEFAULT_MODEL');
    expect(existsSync(overridePath())).toBe(false);
  });

  it('原子保存并让下一次实际生成请求使用新连接；重启项仍显示运行值和保存值', async () => {
    const model = await startFakeLlmHttp(() => 'pong');
    try {
      const result = resultOf(await patch({
        'providers.llm.default.baseUrl': model.baseUrl,
        'providers.llm.default.apiKey': '',
        'retrieval.assembly.compressRecallTimeoutMs': 1250,
        'summary.generator': 'rule',
      }));
      expect(result).toMatchObject({ written: 4, restartRequired: true, applied: expect.arrayContaining([
        'providers.llm.default.baseUrl', 'providers.llm.default.apiKey', 'retrieval.assembly.compressRecallTimeoutMs',
      ]) });
      if (process.platform !== 'win32') expect(statSync(overridePath()).mode & 0o777).toBe(0o600);
      expect(parseYaml(readFileSync(overridePath(), 'utf8'))).toMatchObject({
        providers: { llm: { default: { baseUrl: model.baseUrl, apiKey: '' } } },
        summary: { generator: 'rule' },
      });
      const items = itemsOf(resultOf(await inject({ method: 'GET', url: '/api/v1/config' })));
      expect(items.get('providers.llm.default.baseUrl')).toMatchObject({ value: model.baseUrl, source: 'override' });
      expect(items.get('providers.llm.default.apiKey')).toMatchObject({ configured: false, masked: null });
      expect(items.get('retrieval.assembly.compressRecallTimeoutMs')?.['value']).toBe(1250);
      expect(items.get('summary.generator')).toMatchObject({ value: 'llm', pending: { value: 'rule' } });
      const probe = resultOf(await inject({ method: 'POST', url: '/api/v1/config/test', payload: { target: 'llm' } }));
      expect(probe).toMatchObject({ ok: true });
      expect(model.requests).toHaveLength(1);
      expect(JSON.parse(model.requests[0] ?? '{}')).toMatchObject({ model: 'env-model' });
      expect(loadConfigSnapshot({ path: configPath, env: testEnv() }).config.summary.generator).toBe('rule');
    } finally {
      await model.close();
    }
  });

  it('嵌入故障熔断后，保存新连接即恢复；维度变化不会应用或串进后续保存', async () => {
    const fetchMock = vi.fn(async (_url: unknown, request?: RequestInit) => {
      const input = (JSON.parse(String(request?.body)) as { input: string[] }).input;
      return Response.json({ data: input.map((_text, index) => ({ index, embedding: [1, 2] })) });
    });
    vi.stubGlobal('fetch', fetchMock);
    const urlKey = 'providers.embedding.baseUrl';
    const dimensionKey = 'providers.embedding.dimension';
    const batchKey = 'providers.embedding.maxBatchSize';
    const apiKey = 'providers.embedding.apiKey';
    const { embedding } = container.services;
    for (let index = 0; index < 5; index++) {
      fetchMock.mockImplementationOnce(async () => new Response('', { status: 401 }));
      expect((await embedding.embed(['failure'])).degraded).toBe(true);
    }
    expect(embedding.available).toBe(false);
    expect(resultOf(await patch({ [urlKey]: 'http://embedding.test/v1', [batchKey]: 1, [apiKey]: 'new-key-5678' })))
      .toMatchObject({ restartRequired: false, applied: [urlKey, batchKey, apiKey] });
    expect(await embedding.embed(['first', 'second'])).toMatchObject({ degraded: false, vectors: [[1, 2], [1, 2]] });
    expect(fetchMock.mock.calls.slice(-2).map(([url, init]) => [String(url), new Headers(init?.headers).get('authorization')]))
      .toEqual(Array(2).fill(['http://embedding.test/v1/embeddings', 'Bearer new-key-5678']));
    expect(resultOf(await patch({ [dimensionKey]: 3, [apiKey]: 'pending-key-5678' })))
      .toMatchObject({ restartRequired: true, applied: [] });
    expect(resultOf(await patch({ [batchKey]: 2, 'retrieval.assembly.compressRecall': false })))
      .toMatchObject({ restartRequired: true, applied: ['retrieval.assembly.compressRecall'] });
    expect(embedding.maxBatchSize).toBe(1);
    expect((await embedding.embed(['third'])).degraded).toBe(false);
    expect(new Headers(fetchMock.mock.lastCall?.[1]?.headers).get('authorization')).toBe('Bearer new-key-5678');
    const response = await inject({ method: 'GET', url: '/api/v1/config' });
    expect(response.body).not.toContain('pending-key');
    const items = itemsOf(resultOf(response));
    expect(items.get(dimensionKey)).toMatchObject({ value: 2, pending: { value: 3 } });
    expect(items.get(apiKey)).toMatchObject({ masked: '****5678', pending: { value: null } });
  });

  it('待重启的 LLM 协议不会因为再次改密钥而换掉运行中的供应商', async () => {
    const type = 'providers.llm.default.type';
    const key = 'providers.llm.default.apiKey';
    expect(resultOf(await patch({ [type]: 'anthropic' }))).toMatchObject({ restartRequired: true, applied: [] });
    expect(resultOf(await patch({ [key]: 'different-key-1234' }))).toMatchObject({ restartRequired: true, applied: [] });
    expect(container.config.providers.llm.default).toMatchObject({ type: 'openai-compatible', apiKey: LLM_KEY });
    const items = itemsOf(resultOf(await inject({ method: 'GET', url: '/api/v1/config' })));
    expect(items.get(key)).toMatchObject({ masked: '****1234', source: 'file', pending: { value: null } });
  });

  it('非系统管理员返回 403', async () => {
    const snapshot = loadConfigSnapshot({ path: configPath, env: testEnv() });
    const bob = Fastify({ logger: false });
    bob.addHook('onRequest', createRequestIdMiddleware());
    bob.addHook(
      'onRequest',
      createIdentityMiddleware(async () => ({
        subject: 'user:bob',
        principals: ['user:bob', 'user:*'],
      })),
    );
    bob.setErrorHandler((error, _request, reply) => {
      const mapped = toErrorEnvelope(error);
      reply.code(mapped.statusCode).send(mapped.body);
    });
    bob.register(
      createConfigRoutes({
        config: snapshot.config,
        configSnapshot: snapshot,
        applyConfig: container.applyConfig,
        llm: container.services.llm,
        embedding: container.services.embedding,
        systemAdmin: { adminUserIds: ['local'], isBootstrapAdmin: () => false },
      }).register,
    );
    await bob.ready();

    try {
      const response = await bob.inject({ method: 'GET', url: '/config' });
      expect(response.statusCode).toBe(403);
      const body = JSON.parse(response.body) as Record<string, unknown>;
      expect((body['error'] as Record<string, unknown>)['code']).toBe('PERMISSION_DENIED');

      const patch = await bob.inject({
        method: 'PATCH',
        url: '/config',
        payload: { values: { 'providers.llm.default.baseUrl': 'http://evil/v1' } },
      });
      expect(patch.statusCode).toBe(403);
      expect(existsSync(overridePath())).toBe(false);
    } finally {
      await bob.close();
    }
  });
});
