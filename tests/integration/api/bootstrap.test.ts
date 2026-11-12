/**
 * 引导端点（§12.7 的引导循环）。
 *
 * 覆盖：`needsSetup` 的三种真值状态、第一个管理员的创建与永久关闭、非回环请求的
 * 一次性令牌、重启后标记仍有效。认证恒开，所以「没有任何密码」是控制台唯一一条
 * 首跑路径。
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConsoleLogger } from '../../../src/adapters/log/console.js';
import { createHttpServer } from '../../../src/api/http/server.js';
import { createContainer, type Container } from '../../../src/bootstrap/container.js';

const PASSWORD = 'correct-password';
const SESSION_SECRET = 'test-session-secret';
const SETUP_TOKEN_PREFIX = '初始化令牌：';
const NON_LOOPBACK = '203.0.113.7';

interface Harness {
  readonly container: Container;
  readonly app: FastifyInstance;
  readonly dataDir: string;
}

const cleanups: Array<() => Promise<void>> = [];

async function stop(harness: Harness): Promise<void> {
  await harness.container.services.indexObserver.drain();
  await harness.app.close();
  await harness.container.close();
}

async function startAt(dataDir: string, registerCleanup = true): Promise<Harness> {
  const container = await createContainer({
    configPath: join(dataDir, 'config.yaml'),
    env: {
      ...process.env,
      COMEM_DATA_DIR: dataDir,
      COMEM_SUMMARY_GENERATOR: 'rule',
      COMEM_LOGGING_LEVEL: 'error',
      COMEM_AUTH_SESSION_SECRET: SESSION_SECRET,
    },
  });
  const app = await createHttpServer({
    config: container.config,
    logger: container.logger,
    observability: container.observability,
    routes: container.routes,
    mcp: container.mcp,
    resolveIdentity: container.resolveIdentity,
  });
  if (registerCleanup) {
    cleanups.push(async () => {
      await stop({ container, app, dataDir });
      await rm(dataDir, { recursive: true, force: true });
    });
  }
  return { container, app, dataDir };
}

async function start(): Promise<Harness> {
  return startAt(await mkdtemp(join(tmpdir(), 'comem-bootstrap-')));
}

/** 从启动日志里取出一次性初始化令牌（部署者做的也是这件事）。 */
async function startWithToken(): Promise<Harness & { readonly token: string }> {
  const info = vi.spyOn(ConsoleLogger.prototype, 'info');
  const harness = await start();
  const line = info.mock.calls
    .map(([message]) => String(message))
    .find((message) => message.startsWith(SETUP_TOKEN_PREFIX));
  if (line === undefined) {
    throw new Error('还没有任何密码时必须打印初始化令牌');
  }
  const token = line.slice(SETUP_TOKEN_PREFIX.length, line.indexOf('（'));
  return { ...harness, token };
}

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
  vi.restoreAllMocks();
});

function json(response: { readonly body: string }): Record<string, unknown> {
  return JSON.parse(response.body) as Record<string, unknown>;
}

function resultOf(response: { readonly body: string }): Record<string, unknown> {
  return json(response)['result'] as Record<string, unknown>;
}

function errorOf(response: { readonly body: string }): Record<string, unknown> {
  return json(response)['error'] as Record<string, unknown>;
}

function inject(harness: Harness, options: InjectOptions) {
  return harness.app.inject(options);
}

async function login(harness: Harness, username: string, password = PASSWORD): Promise<string> {
  const response = await inject(harness, {
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { username, password },
  });
  expect(response.statusCode, response.body).toBe(200);
  return String(resultOf(response)['token']);
}

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

function body(userId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { userId, password: PASSWORD, displayName: userId, ...overrides };
}

describe('GET /bootstrap', () => {
  it('新装：没有任何密码时 needsSetup 为 true，建好第一个账号后为 false', async () => {
    const harness = await start();

    const before = await inject(harness, { method: 'GET', url: '/api/v1/bootstrap' });
    expect(before.statusCode).toBe(200);
    expect(resultOf(before)).toEqual({
      needsSetup: true,
      boundSubject: 'user:local',
      adminConfigured: false,
    });
    // 只读、不泄露用户列表。
    expect(resultOf(before)).not.toHaveProperty('users');

    const created = await inject(harness, {
      method: 'POST',
      url: '/api/v1/bootstrap/admin',
      payload: body('local'),
    });
    expect(created.statusCode, created.body).toBe(200);

    const after = await inject(harness, { method: 'GET', url: '/api/v1/bootstrap' });
    expect(resultOf(after)).toMatchObject({ needsSetup: false, adminConfigured: true });
  });
});

describe('POST /bootstrap/admin', () => {
  it('回环地址：设密码 + 引导管理员，第二次调用永久关闭', async () => {
    const harness = await start();

    const first = await inject(harness, {
      method: 'POST',
      url: '/api/v1/bootstrap/admin',
      payload: body('local'),
    });
    expect(first.statusCode, first.body).toBe(200);
    expect(resultOf(first)).toEqual({ userId: 'local', created: false, passwordSet: true });

    // 能登录，且引导管理员能调跨主体端点（adminUserIds 是空的）。
    const token = await login(harness, 'local');
    const users = await inject(harness, {
      method: 'GET',
      url: '/api/v1/admin/users',
      headers: bearer(token),
    });
    expect(users.statusCode, users.body).toBe(200);

    const second = await inject(harness, {
      method: 'POST',
      url: '/api/v1/bootstrap/admin',
      payload: body('other'),
    });
    expect(second.statusCode).toBe(403);
    expect(errorOf(second)['code']).toBe('BOOTSTRAP_CLOSED');
  });

  it('用户不存在时创建账号（created: true）', async () => {
    const harness = await start();

    const response = await inject(harness, {
      method: 'POST',
      url: '/api/v1/bootstrap/admin',
      payload: body('alice', { displayName: 'Alice' }),
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(resultOf(response)['created']).toBe(true);
    expect(harness.container.services.identity.getUser('alice')).toMatchObject({
      id: 'alice',
      displayName: 'Alice',
    });
    await login(harness, 'alice');
  });

  it('普通用户调管理面 403（引导标记只给那一个用户）', async () => {
    const harness = await start();
    await inject(harness, {
      method: 'POST',
      url: '/api/v1/bootstrap/admin',
      payload: body('local'),
    });
    harness.container.services.identity.createUser({ id: 'bob', displayName: 'Bob' });
    await harness.container.services.identity.ensureUserNamespace('bob');
    await harness.container.services.identity.setPassword('bob', PASSWORD);

    const token = await login(harness, 'bob');
    const response = await inject(harness, {
      method: 'GET',
      url: '/api/v1/admin/users',
      headers: bearer(token),
    });

    expect(response.statusCode).toBe(403);
    expect(errorOf(response)['code']).toBe('PERMISSION_DENIED');
  });

  it('空 id / 弱口令是 400，且不消耗初始化', async () => {
    const harness = await start();

    for (const payload of [
      body('', { password: PASSWORD }),
      body('local', { password: 'short' }),
    ]) {
      const response = await inject(harness, {
        method: 'POST',
        url: '/api/v1/bootstrap/admin',
        payload,
      });
      expect(response.statusCode, response.body).toBe(400);
      expect(errorOf(response)['code']).toBe('INVALID_ARGUMENT');
    }

    const ok = await inject(harness, {
      method: 'POST',
      url: '/api/v1/bootstrap/admin',
      payload: body('local'),
    });
    expect(ok.statusCode, ok.body).toBe(200);
  });
});

describe('非回环请求的一次性令牌', () => {
  it('缺令牌 NOT_LOOPBACK；错令牌 INVALID_SETUP_TOKEN；对令牌 200', async () => {
    const harness = await startWithToken();

    const missing = await inject(harness, {
      method: 'POST',
      url: '/api/v1/bootstrap/admin',
      remoteAddress: NON_LOOPBACK,
      payload: body('local'),
    });
    expect(missing.statusCode).toBe(403);
    expect(errorOf(missing)['code']).toBe('NOT_LOOPBACK');

    const wrong = await inject(harness, {
      method: 'POST',
      url: '/api/v1/bootstrap/admin',
      remoteAddress: NON_LOOPBACK,
      payload: body('local', { setupToken: 'not-the-token' }),
    });
    expect(wrong.statusCode).toBe(403);
    expect(errorOf(wrong)['code']).toBe('INVALID_SETUP_TOKEN');

    const correct = await inject(harness, {
      method: 'POST',
      url: '/api/v1/bootstrap/admin',
      remoteAddress: NON_LOOPBACK,
      payload: body('local', { setupToken: harness.token }),
    });
    expect(correct.statusCode, correct.body).toBe(200);
    expect(resultOf(correct)['userId']).toBe('local');
  });

  it('初始化完成后再带令牌也是 BOOTSTRAP_CLOSED', async () => {
    const harness = await startWithToken();
    await inject(harness, {
      method: 'POST',
      url: '/api/v1/bootstrap/admin',
      payload: body('local'),
    });

    const response = await inject(harness, {
      method: 'POST',
      url: '/api/v1/bootstrap/admin',
      remoteAddress: NON_LOOPBACK,
      payload: body('other', { setupToken: harness.token }),
    });

    expect(response.statusCode).toBe(403);
    expect(errorOf(response)['code']).toBe('BOOTSTRAP_CLOSED');
  });
});

describe('重启后引导管理员仍有效', () => {
  it('同一数据根再 createContainer 一次，登录后仍能调管理面', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'comem-bootstrap-restart-'));
    try {
      const first = await startAt(dataDir, false);
      const created = await inject(first, {
        method: 'POST',
        url: '/api/v1/bootstrap/admin',
        payload: body('local'),
      });
      expect(created.statusCode, created.body).toBe(200);
      // 只关实例，不删数据根：第二个实例要复用同一份库。
      await stop(first);

      const second = await startAt(dataDir, false);
      try {
        expect(
          (await inject(second, { method: 'GET', url: '/api/v1/bootstrap' })).statusCode,
        ).toBe(200);
        const token = await login(second, 'local');
        const response = await inject(second, {
          method: 'GET',
          url: '/api/v1/admin/users',
          headers: bearer(token),
        });

        expect(response.statusCode, response.body).toBe(200);
      } finally {
        await stop(second);
      }
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});

/**
 * 回归：引导管理员用 MCP `write` 写全新路径。
 *
 * `create` / `append` 要先判断目标是否存在、读现有正文，而全新路径在
 * `node_permission` 里没有行。读路径的 `InheritingAuthorizer` 只给**磁盘上已存在**
 * 的节点补物化，于是写操作在自己的 write 求权之前先撞上一个 read 求权，被误报成
 * `需要 read（1）级别`。写操作必须先按 write 求权（顺带物化新节点），与 HTTP
 * `POST /content/write` 的顺序一致。
 */
describe('引导管理员通过 MCP write 写新路径', () => {
  it('create / append 写全新路径都成功', async () => {
    const harness = await start();
    const created = await inject(harness, {
      method: 'POST',
      url: '/api/v1/bootstrap/admin',
      payload: body('local'),
    });
    expect(created.statusCode, created.body).toBe(200);
    const token = await login(harness, 'local');

    const cases = [
      { uri: 'comem://user/local/memories/agent-note.md', mode: 'create' },
      { uri: 'comem://user/local/resources/agent-doc.md', mode: 'append' },
      { uri: 'comem://user/local/skills/agent-skill.md', mode: 'create' },
    ] as const;
    for (const item of cases) {
      const response = await inject(harness, {
        method: 'POST',
        url: '/mcp',
        headers: {
          ...bearer(token),
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        payload: {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'write',
            arguments: { uri: item.uri, content: 'hello\n', mode: item.mode },
          },
        },
      });

      // MCP 的工具失败也是 HTTP 200（`isError: true`），所以只断言状态码不够。
      expect(response.statusCode, response.body).toBe(200);
      const result = json(response)['result'] as {
        readonly isError?: boolean;
        readonly content: readonly { readonly text?: string }[];
      };
      expect(result.isError, response.body).not.toBe(true);
      expect(result.content[0]?.text ?? '', response.body).toContain('Wrote');
    }
  });
});
