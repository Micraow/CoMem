/**
 * `POST /memories/{uri}/reject` 的报告（架构文档 §11.11「`reject` 先回退，回退不了才删」）。
 *
 * 拒绝有两种终态，响应必须说清是哪种：
 *
 * - **恢复**：把 `supersedes` 指向的版本写回规范 URI。这条路径**没有删除任何东西**，
 *   所以响应必须给出 `restoredFrom`，并且不能出现 `removed: true`。
 * - **删除**：没有可回退的版本（首条写入、版本文件已被 TTL 清理或截断），规范文件被删。
 *
 * 这不是纯文档问题：旧的响应固定是 `{ uri, removed: true, reason }`，恢复时也在说
 * 「我删了一条记忆」。前端不读这个字段，所以界面上没有症状；但任何人照着响应写脚本，
 * 都会把一次回退当成删除。
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
const ROOT = 'comem://user/local';
const MEMORY_DIR = `${ROOT}/memories/experiences`;
const MEMORY_URI = `${MEMORY_DIR}/code-style.md`;

/** 覆盖写产生的版本文件：`.history/{name}--{stamp}.md`（§11.11 的文件名形态）。 */
const VERSION_URI = /^comem:\/\/user\/local\/memories\/experiences\/\.history\/code-style\.md--\d{8}T\d{9}Z\.md$/u;

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

function reject(uri: string, reason: string): Promise<{ readonly body: string; readonly statusCode: number }> {
  return inject({
    method: 'POST',
    url: `/api/v1/memories/${encodeURIComponent(uri)}/reject`,
    headers: { 'x-test-subject': OWNER, 'content-type': 'application/json' },
    payload: { reason },
  });
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
  dataDir = await mkdtemp(join(tmpdir(), 'comem-reject-'));
  container = await createContainer({
    configPath: join(dataDir, 'config.yaml'),
    env: {
      ...process.env,
      COMEM_DATA_DIR: dataDir,
      COMEM_SUMMARY_GENERATOR: 'rule',
      COMEM_LOGGING_LEVEL: 'error',
      // 不连外网：任何意外的模型请求都打向必然失败的回环端口。
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

describe('POST /memories/{uri}/reject：报告发生了什么', () => {
  it('有版本可回退时报告恢复，并给出恢复自哪个版本 URI', async () => {
    const started = requireContainer();
    // 先通过一次，让磁盘上是一份 active 的旧值；再覆盖才会产生版本快照并写 `supersedes`。
    const first = await started.services.memory.upsertMemory(
      Uri.parse(ROOT),
      experiencesMemoryType,
      { topic: 'code-style', content: '第一版。' },
    );
    expect(first.uri.toString()).toBe(MEMORY_URI);
    await started.services.memory.approve(first.uri);
    const second = await started.services.memory.upsertMemory(
      Uri.parse(ROOT),
      experiencesMemoryType,
      { uri: first.uri, update: () => ({ content: '第二版。' }) },
    );
    expect(second.uri.toString()).toBe(MEMORY_URI);

    const pending = await started.services.memory.read(first.uri);
    expect(pending?.status).toBe('pending');
    const superseded = pending?.supersedes ?? '';
    expect(superseded).toMatch(VERSION_URI);

    const response = await reject(MEMORY_URI, '第二版写错了');
    expect(response.statusCode).toBe(200);
    const result = resultOf(response);

    expect(result['outcome']).toBe('restored');
    expect(result['restoredFrom']).toBe(superseded);
    // 恢复没有删除任何东西：旧字段名不能又出现在响应里，否则脚本会继续把它当删除。
    expect(result).not.toHaveProperty('removed');

    // 规范文件回到了写入前的那份：正文、状态、有效期都取自版本文件。
    const restored = await started.services.memory.read(first.uri);
    expect(restored?.fields['content']).toBe('第一版。');
    expect(restored?.status).toBe('active');
    expect(restored?.validUntil).toBeNull();
  });

  it('没有可回退的版本时报告删除，响应里没有恢复来源', async () => {
    const started = requireContainer();
    // 首条写入没有 `supersedes`：没有旧值可回，拒绝只能删掉。
    const written = await started.services.memory.upsertMemory(
      Uri.parse(ROOT),
      experiencesMemoryType,
      { topic: 'code-style', content: '只有一个版本。' },
    );
    expect((await started.services.memory.read(written.uri))?.supersedes).toBeNull();

    const response = await reject(MEMORY_URI, '这条本就不该写');
    expect(response.statusCode).toBe(200);
    const result = resultOf(response);

    expect(result['outcome']).toBe('removed');
    // 删除时没有恢复来源：这个键不出现（不是 `null`，也不是空串）。
    expect(result).not.toHaveProperty('restoredFrom');
    expect(await started.services.memory.read(written.uri)).toBeNull();
  });
});
