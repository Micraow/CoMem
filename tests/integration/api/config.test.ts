import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Fastify, { type FastifyInstance, type InjectOptions } from 'fastify';
import { parse as parseYaml } from 'yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { toErrorEnvelope } from '../../../src/api/http/error-mapper.js';
import {
  createIdentityMiddleware,
  createRequestIdMiddleware,
} from '../../../src/api/http/middleware.js';
import { createConfigRoutes } from '../../../src/api/http/routes/config.js';
import { createHttpServer } from '../../../src/api/http/server.js';
import { createContainer, type Container } from '../../../src/bootstrap/container.js';
import { loadConfigSnapshot } from '../../../src/config/index.js';

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
  expect(items).toHaveLength(84);
  return new Map(items.map((item) => [item['path'] as string, item]));
}

describe('GET /api/v1/config', () => {
  it('回全部 84 个叶子，密钥只有掩码', async () => {
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

  it('成功时原子写入覆盖文件，权限 0600，并声明需要重启', async () => {
    const response = await inject({
      method: 'PATCH',
      url: '/api/v1/config',
      payload: {
        values: {
          'providers.llm.default.baseUrl': 'http://127.0.0.1:8089/v1',
          'providers.llm.default.apiKey': '',
        },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(resultOf(response)).toMatchObject({
      written: 2,
      overridePath: overridePath(),
      restartRequired: true,
    });

    expect(statSync(overridePath()).mode & 0o777).toBe(0o600);
    const written = parseYaml(readFileSync(overridePath(), 'utf8')) as {
      providers: { llm: { default: { baseUrl: string; apiKey: string } } };
    };
    expect(written.providers.llm.default.baseUrl).toBe('http://127.0.0.1:8089/v1');
    expect(written.providers.llm.default.apiKey).toBe('');

    // 当前进程仍是启动快照：写盘不等于生效。
    const items = itemsOf(resultOf(await inject({ method: 'GET', url: '/api/v1/config' })));
    expect(items.get('providers.llm.default.baseUrl')?.['value']).toBe('http://file.example/v1');

    // 下一次启动才会读到覆盖文件。
    const reloaded = loadConfigSnapshot({ path: configPath, env: testEnv() });
    expect(reloaded.config.providers.llm.default.baseUrl).toBe('http://127.0.0.1:8089/v1');
    expect(reloaded.config.providers.llm.default.apiKey).toBe('');
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
