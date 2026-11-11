import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Fastify, { type FastifyInstance, type InjectOptions } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { toErrorEnvelope } from '../../../src/api/http/error-mapper.js';
import {
  createIdentityMiddleware,
  createRequestIdMiddleware,
} from '../../../src/api/http/middleware.js';
import { createConfigRoutes } from '../../../src/api/http/routes/config.js';
import type { ConfigRouteServices } from '../../../src/api/http/routes/config-probes.js';
import { loadConfigSnapshot } from '../../../src/config/index.js';
import { ComemError } from '../../../src/domain/errors.js';
import type { EmbedOutcome } from '../../../src/services/embedding.js';
import type { LlmResult } from '../../../src/domain/llm.js';

let tempDir: string;
let configPath: string;
let app: FastifyInstance | null = null;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'comem-config-probe-'));
  configPath = join(tempDir, 'config.yaml');
  writeFileSync(
    configPath,
    [
      `dataDir: "${tempDir}"`,
      'providers:',
      '  embedding:',
      '    type: openai-compatible',
      '    dimension: 2',
      '  rerank:',
      '    type: http',
      '    baseUrl: http://rerank.test/v1',
      '    apiKey: rerank-key',
    ].join('\n'),
    'utf8',
  );
});

afterEach(async () => {
  vi.unstubAllGlobals();
  if (app !== null) {
    await app.close();
    app = null;
  }
  rmSync(tempDir, { recursive: true, force: true });
});

function snapshot(extra = '') {
  if (extra !== '') {
    writeFileSync(configPath, `${extra}\n`, 'utf8');
  }
  return loadConfigSnapshot({
    path: configPath,
    env: { XDG_DATA_HOME: join(tempDir, 'xdg') },
  });
}

async function createApp(services: ConfigRouteServices): Promise<FastifyInstance> {
  const instance = Fastify({ logger: false });
  instance.addHook('onRequest', createRequestIdMiddleware());
  instance.addHook(
    'onRequest',
    createIdentityMiddleware(async () => ({
      subject: 'user:local',
      principals: ['user:local', 'user:*'],
    })),
  );
  instance.setErrorHandler((error, _request, reply) => {
    const mapped = toErrorEnvelope(error);
    reply.code(mapped.statusCode).send(mapped.body);
  });
  instance.register(createConfigRoutes(services).register);
  await instance.ready();
  app = instance;
  return instance;
}

function servicesWith(
  generate: ConfigRouteServices['llm']['generate'],
  embed: ConfigRouteServices['embedding']['embed'],
  loaded = snapshot(),
): ConfigRouteServices {
  return {
    config: loaded.config,
    configSnapshot: loaded,
    llm: { generate },
    embedding: { embed },
    systemAdmin: { adminUserIds: ['local'], isBootstrapAdmin: () => false },
  };
}

function inject(instance: FastifyInstance, options: InjectOptions) {
  return instance.inject(options);
}

function resultOf(response: { readonly body: string }): Record<string, unknown> {
  const body = JSON.parse(response.body) as Record<string, unknown>;
  expect(body['status']).toBe('ok');
  return body['result'] as Record<string, unknown>;
}

describe('POST /config/test：LLM', () => {
  it('成功时 ok:true，发的是 maxTokens: 1 的普通 completion', async () => {
    const generate: ConfigRouteServices['llm']['generate'] = vi.fn(async (): Promise<LlmResult> => ({
      text: 'pong',
      usage: { promptTokens: 1, completionTokens: 1 },
      finishReason: 'stop',
    }));
    const embed = vi.fn(async (): Promise<EmbedOutcome> => ({ vectors: [], degraded: false, reason: null }));
    const instance = await createApp(servicesWith(generate, embed));

    const result = resultOf(
      await inject(instance, { method: 'POST', url: '/config/test', payload: { target: 'llm' } }),
    );

    expect(result['ok']).toBe(true);
    expect(String(result['detail'])).toContain('gpt-4o-mini');
    expect(generate).toHaveBeenCalledWith(expect.anything(), { maxTokens: 1 });
  });

  it('PROVIDER_UNAVAILABLE 时 ok:false', async () => {
    const generate: ConfigRouteServices['llm']['generate'] = vi.fn(async () => {
      throw new ComemError('PROVIDER_UNAVAILABLE', '网关不可达');
    });
    const embed = vi.fn(async (): Promise<EmbedOutcome> => ({ vectors: [], degraded: false, reason: null }));
    const instance = await createApp(servicesWith(generate, embed));

    const result = resultOf(
      await inject(instance, { method: 'POST', url: '/config/test', payload: { target: 'llm' } }),
    );

    expect(result['ok']).toBe(false);
    expect(String(result['detail'])).toContain('PROVIDER_UNAVAILABLE');
  });
});

describe('POST /config/test：Embedding', () => {
  it('维度与配置一致时 ok:true', async () => {
    const generate: ConfigRouteServices['llm']['generate'] = vi.fn(async (): Promise<LlmResult> => ({
      text: '',
      usage: { promptTokens: 0, completionTokens: 0 },
      finishReason: 'stop',
    }));
    const embed = vi.fn(async (): Promise<EmbedOutcome> => ({
      vectors: [[0.1, 0.2]],
      degraded: false,
      reason: null,
    }));
    const instance = await createApp(servicesWith(generate, embed));

    const result = resultOf(
      await inject(instance, {
        method: 'POST',
        url: '/config/test',
        payload: { target: 'embedding' },
      }),
    );

    expect(result['ok']).toBe(true);
    expect(String(result['detail'])).toContain('2 维');
  });

  it('degraded 时 ok:false 并带原因', async () => {
    const generate: ConfigRouteServices['llm']['generate'] = vi.fn(async (): Promise<LlmResult> => ({
      text: '',
      usage: { promptTokens: 0, completionTokens: 0 },
      finishReason: 'stop',
    }));
    const embed = vi.fn(async () => ({
      vectors: [],
      degraded: true,
      reason: '没有配置 providers.embedding',
    }));
    const instance = await createApp(servicesWith(generate, embed));

    const result = resultOf(
      await inject(instance, {
        method: 'POST',
        url: '/config/test',
        payload: { target: 'embedding' },
      }),
    );

    expect(result['ok']).toBe(false);
    expect(String(result['detail'])).toContain('没有配置 providers.embedding');
  });

  it('维度不一致时 ok:false', async () => {
    const generate: ConfigRouteServices['llm']['generate'] = vi.fn(async (): Promise<LlmResult> => ({
      text: '',
      usage: { promptTokens: 0, completionTokens: 0 },
      finishReason: 'stop',
    }));
    const embed = vi.fn(async (): Promise<EmbedOutcome> => ({
      vectors: [[0.1]],
      degraded: false,
      reason: null,
    }));
    const instance = await createApp(servicesWith(generate, embed));

    const result = resultOf(
      await inject(instance, {
        method: 'POST',
        url: '/config/test',
        payload: { target: 'embedding' },
      }),
    );

    expect(result['ok']).toBe(false);
    expect(String(result['detail'])).toContain('维度不一致');
  });
});

describe('POST /config/test：Rerank', () => {
  const generate: ConfigRouteServices['llm']['generate'] = vi.fn(async (): Promise<LlmResult> => ({
    text: '',
    usage: { promptTokens: 0, completionTokens: 0 },
    finishReason: 'stop',
  }));
  const embed = vi.fn(async (): Promise<EmbedOutcome> => ({
    vectors: [],
    degraded: false,
    reason: null,
  }));

  it('成功时 POST <baseUrl>/rerank 并 ok:true', async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ results: [{ index: 0, relevance_score: 0.9 }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const instance = await createApp(servicesWith(generate, embed));

    const result = resultOf(
      await inject(instance, {
        method: 'POST',
        url: '/config/test',
        payload: { target: 'rerank' },
      }),
    );

    expect(result['ok']).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0];
    if (call === undefined) {
      throw new Error('fetch 没有被调用');
    }
    const [url, init] = call;
    expect(url).toBe('http://rerank.test/v1/rerank');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toMatchObject({
      model: 'BAAI/bge-reranker-v2-m3',
      documents: ['pong'],
      top_n: 1,
    });
  });

  it('未配置供应商时 ok:false', async () => {
    const loaded = snapshot(
      [
        `dataDir: "${tempDir}"`,
        'providers:',
        '  rerank:',
        '    type: disabled',
      ].join('\n'),
    );
    const instance = await createApp(servicesWith(generate, embed, loaded));

    const result = resultOf(
      await inject(instance, {
        method: 'POST',
        url: '/config/test',
        payload: { target: 'rerank' },
      }),
    );

    expect(result['ok']).toBe(false);
    expect(String(result['detail'])).toContain('未配置重排供应商');
  });

  it('HTTP 非 2xx 时 ok:false', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('down', { status: 503 })),
    );
    const instance = await createApp(servicesWith(generate, embed));

    const result = resultOf(
      await inject(instance, {
        method: 'POST',
        url: '/config/test',
        payload: { target: 'rerank' },
      }),
    );

    expect(result['ok']).toBe(false);
    expect(String(result['detail'])).toContain('HTTP 503');
  });

  it('响应不是 JSON 时 ok:false', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<html>' , { status: 200 })),
    );
    const instance = await createApp(servicesWith(generate, embed));

    const result = resultOf(
      await inject(instance, {
        method: 'POST',
        url: '/config/test',
        payload: { target: 'rerank' },
      }),
    );

    expect(result['ok']).toBe(false);
    expect(String(result['detail'])).toContain('不是 JSON');
  });

  it('target 非法返回 400', async () => {
    const instance = await createApp(servicesWith(generate, embed));

    const response = await inject(instance, {
      method: 'POST',
      url: '/config/test',
      payload: { target: 'image' },
    });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body) as Record<string, unknown>;
    expect((body['error'] as Record<string, unknown>)['code']).toBe('INVALID_ARGUMENT');
  });
});
