/**
 * `POST /memories/{uri}/approve` 的编辑审批合同（架构文档 §11.6、§14）。
 *
 * 无 body 的旧审批必须保持幂等；带正文时必须核对 pending 版本标记，在同一把 exact
 * 锁内只替换 schema 的 `content` 字段并转 active。失败路径不能把旧 pending 错误通过，
 * 也不能覆盖已经 active 的正文。
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { IdentityResolver } from '../../../src/api/http/middleware.js';
import { createHttpServer } from '../../../src/api/http/server.js';
import { createContainer, type Container } from '../../../src/bootstrap/container.js';
import { experiencesMemoryType } from '../../../src/domain/memory-types/experiences.js';
import { Uri } from '../../../src/domain/uri.js';

const OWNER = 'user:local';
const VIEWER = 'user:viewer';
const READER = 'user:reader';
const ROOT = 'comem://user/local';
const MEMORY_URI = `${ROOT}/memories/experiences/monorepo.md`;
const PRINCIPALS = [OWNER, 'user:*'] as const;
const ARCHIVE_1 = `${ROOT}/sessions/s1/history/archive_001`;
const ARCHIVE_2 = `${ROOT}/sessions/s1/history/archive_002`;

let dataDir: string;
let container: Container | undefined;
let app: FastifyInstance | undefined;

function requireContainer(): Container {
  if (container === undefined) {
    throw new Error('容器没有启动。');
  }
  return container;
}

function inject(options: InjectOptions): Promise<{ readonly body: string; readonly statusCode: number }> {
  if (app === undefined) {
    throw new Error('HTTP 服务没有启动。');
  }
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

function approve(
  uri: string,
  payload?: Record<string, unknown>,
  subject = OWNER,
): Promise<{ readonly body: string; readonly statusCode: number }> {
  const request: InjectOptions = {
    method: 'POST',
    url: `/api/v1/memories/${encodeURIComponent(uri)}/approve`,
    headers: { 'x-test-subject': subject },
  };
  if (payload !== undefined) {
    request.payload = payload;
  }
  return inject(request);
}

async function pendingRecord(uri: string): Promise<Record<string, unknown>> {
  const result = resultOf(
    await inject({
      method: 'GET',
      url: `/api/v1/memories/pending?scopeUri=${encodeURIComponent(ROOT)}`,
      headers: { 'x-test-subject': OWNER },
    }),
  );
  const record = (result['memories'] as Record<string, unknown>[]).find(
    (candidate) => candidate['uri'] === uri,
  );
  expect(record).toBeDefined();
  return record as Record<string, unknown>;
}

async function startPending(): Promise<Uri> {
  const result = await requireContainer().services.memory.upsertMemory(
    Uri.parse(ROOT),
    experiencesMemoryType,
    {
      uri: Uri.parse(MEMORY_URI),
      update: () => ({ topic: 'monorepo', content: '原始待复核正文。' }),
      provenance: { sources: [Uri.parse(ARCHIVE_1)] },
    },
  );
  expect(result.uri.toString()).toBe(MEMORY_URI);
  return result.uri;
}

async function startServer(): Promise<FastifyInstance> {
  const started = requireContainer();
  const resolveIdentity: IdentityResolver = async (headers) => {
    const subject = headers['x-test-subject'] ?? OWNER;
    return { subject, principals: [subject, 'user:*'] };
  };
  return createHttpServer({
    config: started.config,
    logger: started.logger,
    observability: started.observability,
    routes: started.routes,
    mcp: started.mcp,
    resolveIdentity,
  });
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'comem-approve-edit-'));
  container = await createContainer({
    configPath: join(dataDir, 'config.yaml'),
    env: {
      ...process.env,
      COMEM_DATA_DIR: dataDir,
      COMEM_SUMMARY_GENERATOR: 'rule',
      COMEM_RETRIEVAL_ENGINE: 'fts5',
      COMEM_LOGGING_LEVEL: 'error',
      COMEM_PROVIDERS_LLM_DEFAULT_BASE_URL: 'http://127.0.0.1:1/v1',
    },
  });
  const started = requireContainer();
  await started.services.acl.ensureRootPreset(Uri.parse(ROOT));
  app = await startServer();
});

afterEach(async () => {
  if (container !== undefined) {
    await container.services.indexObserver.drain();
  }
  await app?.close();
  await container?.close();
  container = undefined;
  app = undefined;
  await rm(dataDir, { recursive: true, force: true });
});

describe('POST /memories/{uri}/approve：编辑后通过', () => {
  it('旧审批无 body 仍可用，重复通过 active 仍幂等', async () => {
    const uri = await startPending();

    expect((await approve(uri.toString())).statusCode).toBe(200);
    const once = await requireContainer().services.memory.read(uri);
    expect((await approve(uri.toString(), {})).statusCode).toBe(200);

    const active = await requireContainer().services.memory.read(uri);
    expect(active?.status).toBe('active');
    expect(active?.fields['content']).toBe('原始待复核正文。');
    expect(active?.updatedAt).toBe(once?.updatedAt);
  });

  it('编辑正文后 active、可检索，并保留来源与版本链', async () => {
    const started = requireContainer();
    const first = await started.services.memory.upsertMemory(
      Uri.parse(ROOT),
      experiencesMemoryType,
      {
        uri: Uri.parse(MEMORY_URI),
        update: () => ({ topic: 'monorepo', content: '已经生效的旧正文。' }),
        provenance: { sources: [Uri.parse(ARCHIVE_1)] },
      },
    );
    await started.services.memory.approve(first.uri);
    const pending = await started.services.memory.upsertMemory(
      Uri.parse(ROOT),
      experiencesMemoryType,
      {
        uri: first.uri,
        update: () => ({ content: '等待复核的新正文。' }),
        provenance: { sources: [Uri.parse(ARCHIVE_2)] },
      },
    );
    const before = await pendingRecord(pending.uri.toString());
    const supersedes = before['supersedes'];
    expect(supersedes).toEqual(expect.any(String));
    const experiencesDirectory = pending.uri.parent();
    if (experiencesDirectory === null) {
      throw new Error('测试记忆没有 experiences 父目录。');
    }
    await started.services.acl.setAcl(
      experiencesDirectory,
      (current) => ({
        mode: current.mode,
        entries: [
          ...current.entries,
          { principal: READER, level: 1, effect: 'allow' },
        ],
      }),
      OWNER,
      PRINCIPALS,
    );

    const response = await approve(pending.uri.toString(), {
      content: '编辑后可以检索的正文。',
      expectedUpdatedAt: before['updatedAt'],
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(resultOf(response)['status']).toBe('active');

    const active = await started.services.memory.read(pending.uri);
    expect(active).toMatchObject({
      memoryType: 'experiences',
      status: 'active',
      supersedes,
      sources: [ARCHIVE_1, ARCHIVE_2],
      validFrom: before['validFrom'],
      validUntil: null,
    });
    expect(active?.fields['content']).toBe('编辑后可以检索的正文。');
    expect(active?.fields['topic']).toBe('monorepo');
    expect(await started.services.acl.check(pending.uri, 1, [READER, 'user:*'])).toBe(true);

    await started.services.indexObserver.drain();
    const hits = await started.services.search.find('编辑后可以检索的正文', {
      scopes: [`${ROOT}/memories`],
      subject: OWNER,
      principals: PRINCIPALS,
    });
    expect(hits.map((hit) => hit.uri)).toContain(pending.uri.toString());
  });

  it('空白正文和缺失版本标记返回 400，且不把 pending 错误通过', async () => {
    const uri = await startPending();
    const before = await pendingRecord(uri.toString());

    const blank = await approve(uri.toString(), {
      content: ' \n\t ',
      expectedUpdatedAt: before['updatedAt'],
    });
    expect(blank.statusCode).toBe(400);
    expect(errorOf(blank)['code']).toBe('INVALID_ARGUMENT');

    const missing = await approve(uri.toString(), { content: '缺少版本标记。' });
    expect(missing.statusCode).toBe(400);
    expect(errorOf(missing)['details']).toMatchObject({ field: 'expectedUpdatedAt' });

    expect((await requireContainer().services.memory.read(uri))?.status).toBe('pending');
    expect((await pendingRecord(uri.toString()))['fields']).toMatchObject({
      content: '原始待复核正文。',
    });
  });

  it('版本标记过期时返回 409，保留后来写入的 pending 正文', async () => {
    const started = requireContainer();
    const uri = await startPending();
    const stale = await pendingRecord(uri.toString());

    await started.services.memory.upsertMemory(Uri.parse(ROOT), experiencesMemoryType, {
      uri,
      update: () => ({ content: '并发写入后的 pending 正文。' }),
    });

    const response = await approve(uri.toString(), {
      content: '不应该覆盖并发的正文。',
      expectedUpdatedAt: stale['updatedAt'],
    });
    expect(response.statusCode).toBe(409);
    expect(errorOf(response)['details']).toMatchObject({ reason: 'stale_pending' });

    const current = await started.services.memory.read(uri);
    expect(current?.status).toBe('pending');
    expect(current?.fields['content']).toBe('并发写入后的 pending 正文。');
  });

  it('active 记录拒绝编辑审批，不能改写已生效正文', async () => {
    const uri = await startPending();
    const before = await pendingRecord(uri.toString());
    expect((await approve(uri.toString())).statusCode).toBe(200);

    const response = await approve(uri.toString(), {
      content: '试图改写已经生效的正文。',
      expectedUpdatedAt: before['updatedAt'],
    });
    expect(response.statusCode).toBe(409);
    expect(errorOf(response)['details']).toMatchObject({ reason: 'not_pending' });
    expect((await requireContainer().services.memory.read(uri))?.fields['content']).toBe(
      '原始待复核正文。',
    );
  });

  it('无 WRITE 权限返回 403，正文仍保持 pending', async () => {
    const uri = await startPending();
    const before = await pendingRecord(uri.toString());

    const response = await approve(
      uri.toString(),
      {
        content: '无权限调用不能写入。',
        expectedUpdatedAt: before['updatedAt'],
      },
      VIEWER,
    );
    expect(response.statusCode).toBe(403);
    expect((await requireContainer().services.memory.read(uri))).toMatchObject({
      status: 'pending',
      fields: expect.objectContaining({ content: '原始待复核正文。' }),
    });
  });

  it('两个编辑审批并发时只有一个生效，另一个冲突', async () => {
    const uri = await startPending();
    const before = await pendingRecord(uri.toString());

    const [left, right] = await Promise.all([
      approve(uri.toString(), {
        content: '并发候选甲。',
        expectedUpdatedAt: before['updatedAt'],
      }),
      approve(uri.toString(), {
        content: '并发候选乙。',
        expectedUpdatedAt: before['updatedAt'],
      }),
    ]);
    expect([left.statusCode, right.statusCode].sort()).toEqual([200, 409]);

    const active = await requireContainer().services.memory.read(uri);
    expect(active?.status).toBe('active');
    expect(['并发候选甲。', '并发候选乙。']).toContain(active?.fields['content']);
  });
});
