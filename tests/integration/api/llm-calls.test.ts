import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createHttpServer } from '../../../src/api/http/server.js';
import type { IdentityResolver } from '../../../src/api/http/middleware.js';
import { createContainer, type Container } from '../../../src/bootstrap/container.js';
import { ComemError } from '../../../src/domain/errors.js';
import type { LlmCallRecord } from '../../../src/domain/llm.js';
import { Uri } from '../../../src/domain/uri.js';
import { startFakeLlmHttp, type FakeLlmHttp } from '../../helpers/fake-llm-http.js';

let dataDir: string;
let container: Container;
let app: FastifyInstance;
let model: FakeLlmHttp;

function record(
  id: string,
  subject: string | null,
  startedAt: string,
  purpose: LlmCallRecord['purpose'] = 'query_rewrite',
): LlmCallRecord {
  return {
    id,
    requestId: `req_${id}`,
    sessionId: `sess_${id}`,
    subject,
    purpose,
    kind: 'json',
    model: 'test-model',
    status: 'success',
    startedAt,
    endedAt: startedAt,
    durationMs: 12,
    promptTokens: 10,
    completionTokens: 5,
    costUsd: 0.0001,
    errorCode: null,
    attempts: 1,
  };
}

function insert(recordValue: LlmCallRecord): void {
  container.db
    .prepare(
      `INSERT INTO llm_call_log
       (id, request_id, session_id, subject, purpose, call_kind, model, status,
        started_at, ended_at, duration_ms, prompt_tokens, completion_tokens,
        cost_usd, error_code, attempts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      recordValue.id,
      recordValue.requestId,
      recordValue.sessionId,
      recordValue.subject,
      recordValue.purpose,
      recordValue.kind,
      recordValue.model,
      recordValue.status,
      recordValue.startedAt,
      recordValue.endedAt,
      recordValue.durationMs,
      recordValue.promptTokens,
      recordValue.completionTokens,
      recordValue.costUsd,
      recordValue.errorCode,
      recordValue.attempts,
    );
}

async function identity(
  headers: Readonly<Record<string, string | undefined>>,
): Promise<{ subject: string; principals: readonly string[] }> {
  if (headers.authorization === 'Bearer alice') {
    return { subject: 'user:alice', principals: ['user:alice', 'user:*'] };
  }
  if (headers.authorization === 'Bearer bob') {
    return { subject: 'user:bob', principals: ['user:bob', 'user:*'] };
  }
  throw new ComemError('UNAUTHENTICATED', '需要测试凭据。');
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'comem-llm-calls-api-'));
  model = await startFakeLlmHttp(() => JSON.stringify({ queries: [] }));
  const configPath = join(dataDir, 'config.yaml');
  await writeFile(
    configPath,
    [
      'providers:',
      '  llm:',
      '    default:',
      `      baseUrl: ${model.baseUrl}`,
      '      model: fake',
      '      apiKey: synthetic',
      'summary:',
      '  generator: rule',
    ].join('\n'),
  );
  container = await createContainer({
    configPath,
    env: {
      ...process.env,
      COMEM_DATA_DIR: dataDir,
      COMEM_LOGGING_LEVEL: 'error',
    },
  });
  await container.services.acl.ensureRootPreset(Uri.parse('comem://user/alice'));
  const resolveIdentity: IdentityResolver = (headers) => identity(headers);
  app = await createHttpServer({
    config: container.config,
    logger: container.logger,
    observability: container.observability,
    routes: container.routes,
    mcp: container.mcp,
    resolveIdentity,
  });

  insert(record('alice-new', 'user:alice', '2026-11-17T00:00:03.000Z'));
  insert(record('alice-old', 'user:alice', '2026-11-17T00:00:02.000Z'));
  insert(record('alice-middle', 'user:alice', '2026-11-17T00:00:02.500Z'));
  insert(record('bob-only', 'user:bob', '2026-11-17T00:00:04.000Z'));
  insert(record('orphan', null, '2026-11-17T00:00:05.000Z'));
});

afterEach(async () => {
  await app.close();
  await container.close();
  await model.close();
  vi.restoreAllMocks();
  await rm(dataDir, { recursive: true, force: true });
});

function resultOf(response: { readonly body: string }): Record<string, unknown> {
  return (JSON.parse(response.body) as { result: Record<string, unknown> }).result;
}

describe('GET /telemetry/llm-calls', () => {
  it('普通认证用户只看到自己的调用，不含主体或 prompt 字段', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/telemetry/llm-calls',
      headers: { authorization: 'Bearer alice' },
    });

    expect(response.statusCode).toBe(200);
    const result = resultOf(response);
    const items = result['items'] as Record<string, unknown>[];
    expect(items.map((item) => item['id'])).toEqual([
      'alice-new',
      'alice-middle',
      'alice-old',
    ]);
    expect(items.every((item) => item['totalTokens'] === 15)).toBe(true);
    expect(items.every((item) => !Object.hasOwn(item, 'subject'))).toBe(true);
    expect(items.every((item) => !Object.hasOwn(item, 'prompt'))).toBe(true);
  });

  it('limit + nextCursor 稳定翻页，末页 nextCursor 为 null', async () => {
    const first = await app.inject({
      method: 'GET',
      url: '/api/v1/telemetry/llm-calls?limit=2',
      headers: { authorization: 'Bearer alice' },
    });
    expect(first.statusCode).toBe(200);
    const firstResult = resultOf(first);
    expect((firstResult['items'] as unknown[]).length).toBe(2);
    const cursor = firstResult['nextCursor'];
    expect(typeof cursor).toBe('string');

    const second = await app.inject({
      method: 'GET',
      url: `/api/v1/telemetry/llm-calls?limit=2&cursor=${encodeURIComponent(String(cursor))}`,
      headers: { authorization: 'Bearer alice' },
    });
    expect(second.statusCode).toBe(200);
    const secondResult = resultOf(second);
    expect((secondResult['items'] as { id: string }[]).map((item) => item.id)).toEqual([
      'alice-old',
    ]);
    expect(secondResult['nextCursor']).toBeNull();
  });

  it('未认证 401，非法 limit/cursor 400', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/v1/telemetry/llm-calls' })).statusCode).toBe(
      401,
    );
    for (const query of ['limit=0', 'limit=101', 'cursor=not-a-cursor']) {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/telemetry/llm-calls?${query}`,
        headers: { authorization: 'Bearer alice' },
      });
      expect(response.statusCode, query).toBe(400);
    }
  });

  it('真实 HTTP 请求内的模型调用带 requestId/sessionId，并能从同一身份查询', async () => {
    container.db.exec('DELETE FROM llm_call_log');
    const search = await app.inject({
      method: 'POST',
      url: '/api/v1/search/search',
      headers: {
        authorization: 'Bearer alice',
        'x-request-id': 'req_real_llm',
      },
      payload: {
        query: 'needle',
        sessionId: 'sess_real',
        scopes: ['comem://user/alice'],
      },
    });
    expect(search.statusCode, search.body).toBe(200);

    const listed = await app.inject({
      method: 'GET',
      url: '/api/v1/telemetry/llm-calls',
      headers: { authorization: 'Bearer alice' },
    });
    expect(listed.statusCode).toBe(200);
    const items = resultOf(listed)['items'] as Record<string, unknown>[];
    expect(items).toEqual([
      expect.objectContaining({
        purpose: 'query_rewrite',
        model: 'fake',
        status: 'success',
        requestId: 'req_real_llm',
        sessionId: 'sess_real',
        promptTokens: 1,
        completionTokens: 1,
        totalTokens: 2,
      }),
    ]);
  });

  it('调度器按现有 requestLog 保留窗口裁剪持久化记录', async () => {
    insert(record('expired-call', 'user:alice', '2000-01-01T00:00:00.000Z'));

    await container.scheduler.tick();

    expect(
      container.db
        .prepare("SELECT id FROM llm_call_log WHERE id = 'expired-call'")
        .get(),
    ).toBeUndefined();
  });
});
