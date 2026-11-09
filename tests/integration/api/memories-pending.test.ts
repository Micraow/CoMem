/**
 * `GET /memories/pending`：逐条按记录自身的 URI 求 read（架构文档 §12.4）。
 *
 * 端点只对 `scope` 求一次 read，随后 `MemoryService.listPending` 用装配给它的
 * `rawFilesystem` 递归 `list` / `read`——这条路径不传 principals，也不再求权。于是
 * 「scope 根可读、某个子目录被 `restricted` 切断」时，子目录下的待复核记录会整条
 * 出现在响应里：URI、`fields`、`sources` 全都是内容。
 *
 * 用例用两个身份：A 是 scope 所有者，待复核记录都在 A 的 `memories/` 下；B 只有 A
 * 根目录的 read。两个子目录各放一条 pending——`memories/experiences/` 继承根的
 * read，B 读得到；`memories/rules/` 被设成 `restricted`（不带条目），B 读不到。
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { IdentityResolver } from '../../../src/api/http/middleware.js';
import { createHttpServer } from '../../../src/api/http/server.js';
import { createContainer, type Container } from '../../../src/bootstrap/container.js';
import type { AclEntry } from '../../../src/domain/acl.js';
import { experiencesMemoryType } from '../../../src/domain/memory-types/experiences.js';
import { rulesMemoryType } from '../../../src/domain/memory-types/rules.js';
import { Uri } from '../../../src/domain/uri.js';

const OWNER = 'user:a';
const OWNER_ROOT = 'comem://user/a';
const VIEWER = 'user:b';

/** 继承根的 read，B 读得到。 */
const EXPERIENCES_URI = `${OWNER_ROOT}/memories/experiences/release-check.md`;
/** `memories/rules` 被 restricted 切断，B 读不到。 */
const RULES_DIR = `${OWNER_ROOT}/memories/rules`;
const RULES_URI = `${RULES_DIR}/license-review/must-locate-license.md`;

/** 受限记录里的正文：响应体里出现它就说明整条记录漏了。 */
const RULES_CONTENT = '只在受限子目录里出现的结论。';

let dataDir: string;
let container: Container | undefined;
let app: FastifyInstance | undefined;

function principalsOf(subject: string): readonly string[] {
  return [subject, 'user:*'];
}

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

function encode(uri: string): string {
  return encodeURIComponent(uri);
}

/**
 * 身份从请求头来：这组用例要在同一个进程里区分所有者与受限调用方。
 *
 * 缺省是受限调用方 B——用例的唯一目的是「B 拿不到受限子目录」，静默回退到 owner
 * 会让断言失去意义。
 */
async function startServer(): Promise<FastifyInstance> {
  const started = requireContainer();
  const resolveIdentity: IdentityResolver = async (headers) => {
    const subject = headers['x-comem-subject'] ?? VIEWER;
    return { subject, principals: principalsOf(subject) };
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
  dataDir = await mkdtemp(join(tmpdir(), 'comem-pending-'));
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
  await started.services.acl.ensureRootPreset(Uri.parse(OWNER_ROOT));
  // B 只拿根目录的 read：子树的权限由 descendants 物化行决定。
  await started.services.acl.setAcl(
    Uri.parse(OWNER_ROOT),
    (current) => ({
      mode: current.mode,
      entries: [...current.entries, { principal: VIEWER, level: 1, effect: 'allow' }],
    }),
    OWNER,
    principalsOf(OWNER),
  );
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

/** 两个子目录各一条 pending（`experiences` / `rules` 都在默认的复核名单里）。 */
async function seedPendingMemories(): Promise<void> {
  const started = requireContainer();
  const experiences = await started.services.memory.upsertMemory(
    Uri.parse(OWNER_ROOT),
    experiencesMemoryType,
    { topic: 'release-check', content: '发版前先跑一遍 typecheck。' },
  );
  const rule = await started.services.memory.upsertMemory(
    Uri.parse(OWNER_ROOT),
    rulesMemoryType,
    { scenario: 'license-review', rule: 'must-locate-license', content: RULES_CONTENT },
  );

  // 两条都必须停在 pending；否则这个用例测的不是复核列表。
  expect(experiences.uri.toString()).toBe(EXPERIENCES_URI);
  expect(rule.uri.toString()).toBe(RULES_URI);
  expect((await started.services.memory.read(experiences.uri))?.status).toBe('pending');
  expect((await started.services.memory.read(rule.uri))?.status).toBe('pending');
  await started.services.indexObserver.drain();
}

/** 把 `memories/rules` 设成 `restricted`：切断从根继承下来的 read。 */
async function restrictRulesDirectory(entries: readonly AclEntry[] = []): Promise<void> {
  const started = requireContainer();
  await started.services.acl.setAcl(
    Uri.parse(RULES_DIR),
    { mode: 'restricted', entries },
    OWNER,
    principalsOf(OWNER),
  );
  await started.services.indexObserver.drain();
}

function pendingOf(subject: string): Promise<{ readonly body: string; readonly statusCode: number }> {
  return inject({
    method: 'GET',
    url: `/api/v1/memories/pending?scopeUri=${encode(OWNER_ROOT)}`,
    headers: { 'x-comem-subject': subject },
  });
}

describe('GET /memories/pending：逐条按记录 URI 求 read', () => {
  it('restricted 子目录下的 pending 整条不返回，可读的那条照常返回', async () => {
    await seedPendingMemories();
    await restrictRulesDirectory();

    const started = requireContainer();
    // 先钉住用例前提：B 读得到根、读不到 restricted 子树。
    expect(await started.services.acl.check(Uri.parse(OWNER_ROOT), 1, principalsOf(VIEWER))).toBe(
      true,
    );
    expect(await started.services.acl.check(Uri.parse(RULES_DIR), 1, principalsOf(VIEWER))).toBe(
      false,
    );

    const response = await pendingOf(VIEWER);
    expect(response.statusCode).toBe(200);

    // 受限 URI 与它的正文一个字符都不出现：变异（去掉逐条求权）时红的正是这两条。
    expect(response.body).not.toContain(RULES_URI);
    expect(response.body).not.toContain(RULES_DIR);
    expect(response.body).not.toContain(RULES_CONTENT);

    const result = resultOf(response);
    const memories = result['memories'] as Record<string, unknown>[];
    // 对照：没有把整批记录滤掉，可读的那条带完整字段返回。
    expect(memories).toHaveLength(1);
    expect(memories[0]).toMatchObject({
      uri: EXPERIENCES_URI,
      memoryType: 'experiences',
      status: 'pending',
    });
  });

  it('两条都可读时都返回（防止过度过滤）', async () => {
    await seedPendingMemories();
    // `restricted` 节点自己的直接授权仍然生效：给 B 一条 read。
    await restrictRulesDirectory([{ principal: VIEWER, level: 1, effect: 'allow' }]);

    const started = requireContainer();
    expect(await started.services.acl.check(Uri.parse(RULES_URI), 1, principalsOf(VIEWER))).toBe(
      true,
    );

    const response = await pendingOf(VIEWER);
    expect(response.statusCode).toBe(200);

    const result = resultOf(response);
    const memories = result['memories'] as Record<string, unknown>[];
    expect(memories).toHaveLength(2);
    expect(memories.map((record) => record['uri'])).toEqual(
      expect.arrayContaining([EXPERIENCES_URI, RULES_URI]),
    );
  });
});
