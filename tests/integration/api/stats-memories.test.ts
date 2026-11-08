/**
 * `GET /api/v1/stats/memories`（架构文档 §17.5）。
 *
 * 四件事要验证：
 *
 * 1. 数字正确：不同 `access_count` / `last_accessed_at` 的节点算出的冷热分档、
 *    分类分布、陈旧计数与最老年龄是对的；
 * 2. ACL：A 用户看不到 B 用户的记忆统计（跨用户统计是信息泄露）；
 * 3. 空库返回零值不报错；
 * 4. 非记忆节点（`context_type <> 'memory'`）不进统计。
 *
 * 直接写 `container.db`：要造精确的 `access_count` / `last_accessed_at` 组合，
 * 走检索命中路径既慢又算不准时间。统计是纯读取，插行即可。
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createHttpServer } from '../../../src/api/http/server.js';
import { createContainer, type Container } from '../../../src/bootstrap/container.js';
import { hotnessScore, hotnessTier } from '../../../src/domain/hotness.js';

let dataDir: string;
let container: Container;
let app: FastifyInstance;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'comem-stats-'));
  container = await createContainer({
    configPath: join(dataDir, 'config.yaml'),
    env: {
      ...process.env,
      COMEM_DATA_DIR: dataDir,
      COMEM_SUMMARY_GENERATOR: 'rule',
      COMEM_LOGGING_LEVEL: 'error',
    },
  });
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
  await rm(dataDir, { recursive: true, force: true });
});

interface NodeSeed {
  readonly uri: string;
  readonly contextType?: string;
  readonly memoryType: string | null;
  readonly accessCount: number;
  readonly lastAccessedAt: string | null;
  readonly updatedAt: string;
  readonly size?: number;
  readonly status?: string;
}

function seedNode(seed: NodeSeed): void {
  container.db
    .prepare(
      `INSERT INTO node
         (uri, parent_uri, scope, kind, context_type, memory_type, level, abstract,
          body_digest, size, updated_at, status, access_count, last_accessed_at)
       VALUES (?, ?, 'user', 'document', ?, ?, 'L1', NULL, 'd', ?, ?, ?, ?, ?)`,
    )
    .run(
      seed.uri,
      seed.uri.replace(/\/[^/]+$/, ''),
      seed.contextType ?? 'memory',
      seed.memoryType,
      seed.size ?? 100,
      seed.updatedAt,
      seed.status ?? 'active',
      seed.accessCount,
      seed.lastAccessedAt,
    );
}

/** 给某节点物化一条 allow 行（模拟 `setAcl` 的产物）。 */
function grant(uri: string, principal: string): void {
  container.db
    .prepare(
      `INSERT OR REPLACE INTO node_permission (node_uri, principal, level, effect)
       VALUES (?, ?, 7, 'allow')`,
    )
    .run(uri, principal);
}

/** 以指定身份挂上完整路由，用真实 container 的服务。
 *
 * v1 的 `resolveIdentity` 只认绑定主体；测「另一个用户」时给一份替身身份。
 */
async function appAs(subject: string): Promise<FastifyInstance> {
  return createHttpServer({
    config: container.config,
    logger: container.logger,
    observability: container.observability,
    routes: container.routes,
    mcp: container.mcp,
    resolveIdentity: async () => ({ subject, principals: [subject, 'user:*'] }),
  });
}

function resultOf(response: { readonly body: string }): Record<string, unknown> {
  const body = JSON.parse(response.body) as Record<string, unknown>;
  expect(body['status']).toBe('ok');
  return body['result'] as Record<string, unknown>;
}

describe('GET /stats/memories', () => {
  it('空库返回零值，不报错', async () => {
    const result = resultOf(await app.inject({ method: 'GET', url: '/api/v1/stats/memories' }));
    expect(result['total']).toBe(0);
    expect(result['byCategory']).toEqual({});
    expect(result['hotness']).toEqual({ cold: 0, warm: 0, hot: 0 });
    expect(result['staleness']).toEqual({
      notAccessed7d: 0,
      notAccessed30d: 0,
      oldestMemoryAgeDays: null,
    });
    expect(result['avgSizeBytes']).toBe(0);
  });

  it('按 access_count / last_accessed_at 正确分档与统计陈旧', async () => {
    const subject = 'user:local';
    const now = Date.now();
    const hoursAgo = (h: number): string => new Date(now - h * 3600_000).toISOString();
    const daysAgo = (d: number): string => hoursAgo(d * 24);

    // hot：刚访问过、次数多 → 分档应为 hot（0.776 量级）。
    seedNode({ uri: 'comem://user/local/memories/preferences/a', memoryType: 'preferences', accessCount: 5, lastAccessedAt: hoursAgo(12), updatedAt: hoursAgo(1) });
    // warm：一周前访问几次。
    seedNode({ uri: 'comem://user/local/memories/entities/b', memoryType: 'entities', accessCount: 3, lastAccessedAt: daysAgo(7), updatedAt: daysAgo(7) });
    // cold：很久没碰。
    seedNode({ uri: 'comem://user/local/memories/rules/c', memoryType: 'rules', accessCount: 1, lastAccessedAt: daysAgo(60), updatedAt: daysAgo(90) });
    // 从没访问过：热 0（cold），陈旧两条都计。
    seedNode({ uri: 'comem://user/local/memories/events/d', memoryType: 'events', accessCount: 0, lastAccessedAt: null, updatedAt: daysAgo(40) });
    // 非记忆节点：不统计。
    seedNode({ uri: 'comem://user/local/projects/p/resources/r', contextType: 'resource', memoryType: null, accessCount: 99, lastAccessedAt: hoursAgo(1), updatedAt: hoursAgo(1) });

    for (const uri of [
      'comem://user/local/memories/preferences/a',
      'comem://user/local/memories/entities/b',
      'comem://user/local/memories/rules/c',
      'comem://user/local/memories/events/d',
      'comem://user/local/projects/p/resources/r',
    ]) {
      grant(uri, subject);
    }

    const result = resultOf(await app.inject({ method: 'GET', url: '/api/v1/stats/memories' }));

    // 只 4 条记忆，resource 不算。
    expect(result['total']).toBe(4);
    expect(result['byCategory']).toEqual({ preferences: 1, entities: 1, rules: 1, events: 1 });

    // 用同一套 domain 函数独立复算，确认端点的分档与 domain 一致（不另造标准）。
    const halfLifeDays = container.config.telemetry.hotness.halfLifeHours / 24;
    const scoreA = hotnessScore({ activeCount: 5, lastAccessedAt: hoursAgo(12), halfLifeDays });
    const scoreB = hotnessScore({ activeCount: 3, lastAccessedAt: daysAgo(7), halfLifeDays });
    // 端点保证三档齐全（空桶补 0），所以这三列一定有值——收窄到具体形状，
    // 避免在 `Record<string, number>` 上触发 noUncheckedIndexedAccess 的 undefined。
    const hotness = result['hotness'] as { cold: number; warm: number; hot: number };
    // a 应 hot，b 按公式分档，c/d 应 cold。总数守恒。
    expect(hotness.hot).toBe(1);
    expect(hotnessTier(scoreA)).toBe('hot');
    expect(hotnessTier(scoreB)).not.toBe('hot');
    expect(hotness.cold + hotness.warm + hotness.hot).toBe(4);

    const staleness = result['staleness'] as {
      notAccessed7d: number;
      notAccessed30d: number;
      oldestMemoryAgeDays: number | null;
    };
    // 7 天没碰：b(7d)、c(60d)、d(从没) = 3；a 刚访问过不算。
    expect(staleness.notAccessed7d).toBe(3);
    // 30 天没碰：c(60d)、d(从没) = 2；b 7 天不算。
    expect(staleness.notAccessed30d).toBe(2);
    // 最老 updated_at 是 c 的 90 天前。
    expect(staleness.oldestMemoryAgeDays).toBe(90);
  });

  it('ACL 隔离：A 用户看不到 B 用户的记忆统计', async () => {
    seedNode({ uri: 'comem://user/alice/memories/preferences/secret', memoryType: 'preferences', accessCount: 9, lastAccessedAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    grant('comem://user/alice/memories/preferences/secret', 'user:alice');

    const aliceApp = await appAs('user:alice');
    try {
      const aliceResult = resultOf(
        await aliceApp.inject({ method: 'GET', url: '/api/v1/stats/memories' }),
      );
      expect(aliceResult['total']).toBe(1);

      const bobApp = await appAs('user:bob');
      try {
        const bobResult = resultOf(
          await bobApp.inject({ method: 'GET', url: '/api/v1/stats/memories' }),
        );
        // bob 没有 alice 那条的权限行，统计里看不到。
        expect(bobResult['total']).toBe(0);
        expect(bobResult['byCategory']).toEqual({});
      } finally {
        await bobApp.close();
      }
    } finally {
      await aliceApp.close();
    }
  });

  it('deny 行覆盖 allow：被显式拒绝的主体不计入', async () => {
    const uri = 'comem://user/alice/memories/rules/x';
    seedNode({ uri, memoryType: 'rules', accessCount: 2, lastAccessedAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    grant(uri, 'user:alice');
    // 通配 allow + 对 alice 的 deny：deny 覆盖 allow（§12.3）。
    container.db
      .prepare(
        `INSERT OR REPLACE INTO node_permission (node_uri, principal, level, effect)
         VALUES (?, 'user:*', 7, 'allow')`,
      )
      .run(uri);
    container.db
      .prepare(
        `INSERT OR REPLACE INTO node_permission (node_uri, principal, level, effect)
         VALUES (?, 'user:alice', 1, 'deny')`,
      )
      .run(uri);

    const aliceApp = await appAs('user:alice');
    try {
      const result = resultOf(await aliceApp.inject({ method: 'GET', url: '/api/v1/stats/memories' }));
      expect(result['total']).toBe(0);
    } finally {
      await aliceApp.close();
    }
  });
});
