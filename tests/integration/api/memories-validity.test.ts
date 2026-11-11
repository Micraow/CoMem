/**
 * `GET /memories/pending` 的有效期三键（架构文档 §11.6、§6.6）。
 *
 * 复核界面要能回答「这条记忆从哪一刻开始有效、被谁顶替、拒绝会回到哪一版」，
 * 所以 `serializeRecord` 必须带出 `validFrom` / `validUntil` / `supersedes`。
 *
 * 这条契约有两条容易回归的形状：
 *
 * - **键必须始终存在。** `null` 表示「这条记忆没有这个值」；省略键会让控制台把
 *   「旧数据缺字段」与「无有效期」混成同一种状态。
 * - **时间串格式必须与 `updatedAt` 相同。** 三键原样带出 frontmatter 里的
 *   ISO 8601 UTC 串，不在序列化层换一种格式。
 *
 * pending 是这三个键唯一的 HTTP 出口（没有单条记忆读取端点），所以两条用例都从
 * 这个端点断。`validUntil` 非空的 pending 记录只能来自手改的文件：写路径对规范
 * 文件一律写 `valid_until: null`，版本文件在 `.history/` 下、不进复核队列。这条
 * 用例固定的是「序列化层遇到非空值不丢、不换格式」，与写入路径无关。
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { IdentityResolver } from '../../../src/api/http/middleware.js';
import { createHttpServer } from '../../../src/api/http/server.js';
import { createContainer, type Container } from '../../../src/bootstrap/container.js';
import { experiencesMemoryType } from '../../../src/domain/memory-types/experiences.js';
import { Uri } from '../../../src/domain/uri.js';
import { toDiskPath } from '../../../src/adapters/fs/path.js';

const OWNER = 'user:local';
const ROOT = 'comem://user/local';
const MEMORY_DIR = `${ROOT}/memories/experiences`;

/** `updatedAt` 与 `validFrom` 必须同形：ISO 8601 UTC，毫秒三位。 */
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

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

function pendingOf(): Promise<{ readonly body: string; readonly statusCode: number }> {
  return inject({
    method: 'GET',
    url: `/api/v1/memories/pending?scopeUri=${encodeURIComponent(ROOT)}`,
    headers: { 'x-test-subject': OWNER },
  });
}

function listedOf(response: { readonly body: string }, uri: string): Record<string, unknown> {
  const result = resultOf(response);
  const memories = result['memories'] as Record<string, unknown>[];
  const listed = memories.find((entry) => entry['uri'] === uri);
  expect(listed, `响应里没有 ${uri}`).toBeDefined();
  return listed as Record<string, unknown>;
}

/** 手写一份记忆文件：绕过写路径，才能造出 `valid_until` 非空的 pending。 */
async function writeMemoryFile(name: string, lines: readonly string[], body: string): Promise<string> {
  const uri = `${MEMORY_DIR}/${name}`;
  const absolute = toDiskPath(dataDir, Uri.parse(uri));
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(
    absolute,
    [
      '---',
      'memory_type: experiences',
      'status: pending',
      'created_at: 2026-11-01T00:00:00.000Z',
      'updated_at: 2026-11-02T03:04:05.006Z',
      ...lines,
      '---',
      '',
      '## content',
      '',
      body,
    ].join('\n'),
    'utf8',
  );
  // 绕过写路径的文件没有索引行，`filterReadable`（纯 SQL）会把它当成无权限而过滤掉。
  // 先按写路径的通知把它索引一次，复核端点才看得到它——这不是被测行为。
  const started = requireContainer();
  await started.services.indexObserver.onNodeWritten(Uri.parse(uri), 'file');
  await started.services.indexObserver.drain();
  return uri;
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'comem-validity-'));
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

describe('GET /memories/pending：有效期三键', () => {
  it('覆盖写产生版本后，`supersedes` 指向版本文件，`validUntil` 为 null', async () => {
    const started = requireContainer();
    const uri = `${MEMORY_DIR}/code-style.md`;
    const first = await started.services.memory.upsertMemory(
      Uri.parse(ROOT),
      experiencesMemoryType,
      { topic: 'code-style', content: '第一版。' },
    );
    expect(first.uri.toString()).toBe(uri);
    // 先通过一次，让磁盘上是一份 active 的旧值；再覆盖才会产生版本快照。
    await started.services.memory.approve(first.uri);
    await started.services.memory.upsertMemory(Uri.parse(ROOT), experiencesMemoryType, {
      uri: first.uri,
      update: () => ({ content: '第二版。' }),
    });
    expect((await started.services.memory.read(first.uri))?.status).toBe('pending');

    const response = await pendingOf();
    expect(response.statusCode).toBe(200);
    const listed = listedOf(response, uri);

    // 键始终存在；`null` 是「没有这个值」，不是「响应里没有这个字段」。
    expect(Object.prototype.hasOwnProperty.call(listed, 'validFrom')).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(listed, 'validUntil')).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(listed, 'supersedes')).toBe(true);

    expect(listed['validFrom']).toMatch(ISO_UTC);
    expect(listed['validFrom']).toBe(new Date(listed['validFrom'] as string).toISOString());
    // 与既有时间字段同形：`updatedAt` 也是同一个 frontmatter 值的原样带出。
    expect(listed['updatedAt']).toMatch(ISO_UTC);
    expect(listed['validUntil']).toBeNull();
    expect(listed['supersedes']).toMatch(
      /^comem:\/\/user\/local\/memories\/experiences\/\.history\/code-style\.md--\d{8}T\d{9}Z\.md$/u,
    );
  });

  it('`valid_until` 非空的记录照样输出该值，不换成别的格式', async () => {
    const uri = await writeMemoryFile(
      'legacy-window.md',
      [
        'valid_from: 2026-11-01T00:00:00.000Z',
        'valid_until: 2026-12-01T00:00:00.000Z',
        'topic: legacy-window',
      ],
      '手改过的记忆文件。',
    );

    const response = await pendingOf();
    expect(response.statusCode).toBe(200);
    const listed = listedOf(response, uri);

    expect(listed['validFrom']).toBe('2026-11-01T00:00:00.000Z');
    expect(listed['validUntil']).toBe('2026-12-01T00:00:00.000Z');
    expect(listed['supersedes']).toBeNull();
  });

  it('旧文件没有这三个键时输出 `null`，键不省略', async () => {
    const uri = await writeMemoryFile('legacy-none.md', ['topic: legacy-none'], '旧格式的记忆文件。');

    const response = await pendingOf();
    expect(response.statusCode).toBe(200);
    const listed = listedOf(response, uri);

    expect(listed['validFrom']).toBeNull();
    expect(listed['validUntil']).toBeNull();
    expect(listed['supersedes']).toBeNull();
  });
});
