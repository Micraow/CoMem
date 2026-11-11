import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createHttpServer } from '../../../src/api/http/server.js';
import { createContainer, type Container } from '../../../src/bootstrap/container.js';

const PASSWORD = 'correct-password';
const SESSION_SECRET = 'test-session-secret';

let dataDir: string;
let container: Container;
let app: FastifyInstance;

beforeEach(async () => {
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch disabled'));
  dataDir = await mkdtemp(join(tmpdir(), 'comem-auth-'));
  container = await createContainer({
    configPath: join(dataDir, 'config.yaml'),
    env: {
      ...process.env,
      COMEM_DATA_DIR: dataDir,
      COMEM_SUMMARY_GENERATOR: 'rule',
      COMEM_LOGGING_LEVEL: 'error',
      // 这组用例测的是「凭据怎么解析」：关掉回环信任，否则不带凭据的 inject
      // 会被当成 server.subject，测不出「缺凭据」与「凭据无效」。
      COMEM_AUTH_TRUST_LOOPBACK: 'false',
      COMEM_AUTH_SESSION_SECRET: SESSION_SECRET,
      // 这组用例测认证（token 是否有效），不是测谁能调管理面。绑定主体显式声明为
      // 系统管理员；跨主体端点没有这个配置就一律 403（默认空名单）。
      COMEM_AUTH_ADMIN_USER_IDS: JSON.stringify(['local']),
    },
  });
  // 启动时已经建好 `user:local` 与它的命名空间；这里只补密码。
  await container.services.identity.setPassword('local', PASSWORD);
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
  vi.restoreAllMocks();
  await rm(dataDir, { recursive: true, force: true });
});

function inject(options: InjectOptions) {
  return app.inject(options);
}

function json(response: { readonly body: string }): Record<string, unknown> {
  return JSON.parse(response.body) as Record<string, unknown>;
}

async function login(username = 'local', password = PASSWORD): Promise<string> {
  const response = await inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { username, password },
  });
  expect(response.statusCode).toBe(200);
  const result = json(response)['result'] as Record<string, unknown>;
  return String(result['token']);
}

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

describe('登录', () => {
  it('正确密码换到可用的 session token', async () => {
    const response = await inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'local', password: PASSWORD },
    });
    expect(response.statusCode).toBe(200);
    const result = json(response)['result'] as Record<string, unknown>;
    expect(typeof result['token']).toBe('string');
    expect(result['subject']).toBe('user:local');
    expect(result['principals']).toEqual(['user:local', 'user:*']);

    const protectedResponse = await inject({
      method: 'GET',
      url: '/api/v1/admin/users',
      headers: bearer(String(result['token'])),
    });
    expect(protectedResponse.statusCode).toBe(200);
  });

  it('密码错误、用户不存在都是 401', async () => {
    for (const payload of [
      { username: 'local', password: 'wrong' },
      { username: 'missing', password: PASSWORD },
    ]) {
      const response = await inject({ method: 'POST', url: '/api/v1/auth/login', payload });
      expect(response.statusCode, JSON.stringify(payload)).toBe(401);
      expect(json(response)['error']).toMatchObject({ code: 'UNAUTHENTICATED' });
    }
  });

  it('缺少 Authorization 头是 401，x-comem-subject 不是凭据', async () => {
    for (const headers of [{}, { 'x-comem-subject': 'user:local' }]) {
      const response = await inject({ method: 'GET', url: '/api/v1/admin/users', headers });
      expect(response.statusCode).toBe(401);
    }
  });

  it('伪造签名的 token 是 401', async () => {
    const response = await inject({
      method: 'GET',
      url: '/api/v1/admin/users',
      headers: bearer('v1.eyJzdWIiOiJsb2NhbCJ9.forged'),
    });
    expect(response.statusCode).toBe(401);
  });

  it('登出是幂等的空操作', async () => {
    const response = await inject({ method: 'POST', url: '/api/v1/auth/logout' });
    expect(response.statusCode).toBe(200);
    expect(json(response)['result']).toEqual({ loggedOut: true });
  });

  it('GET /auth/config 不存在：认证恒开，没有开关要探测', async () => {
    const token = await login();
    const response = await inject({
      method: 'GET',
      url: '/api/v1/auth/config',
      headers: bearer(token),
    });

    expect(response.statusCode).toBe(404);
    expect(json(response)['error']).toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('删账号与改密码撤销访问', () => {
  /**
   * 回归：token 载荷只有用户 ID 时，「删账号」不撤销访问——同 ID 重建后旧 token
   * 在整个 `exp` 窗口内继续有效，而且没有任何日志或错误提示（架构文档 §12.7）。
   */
  it('删账号重建同 ID 后旧 token 401', async () => {
    const adminToken = await login();
    const created = await inject({
      method: 'POST',
      url: '/api/v1/admin/users',
      headers: bearer(adminToken),
      payload: { id: 'alice', displayName: 'Alice' },
    });
    expect(created.statusCode).toBe(200);
    await container.services.identity.setPassword('alice', PASSWORD);

    const aliceToken = await login('alice', PASSWORD);
    // 身份有效但 alice 不是系统管理员：跨主体端点是 403（不是 401）。这个差异
    // 正是「token 还在不在」的判据——删账号后同一请求必须掉到 401。
    const aliceValid = await inject({
      method: 'GET',
      url: '/api/v1/admin/users',
      headers: bearer(aliceToken),
    });
    expect(aliceValid.statusCode).toBe(403);
    expect(json(aliceValid)['error']).toMatchObject({ code: 'PERMISSION_DENIED' });

    expect(
      (
        await inject({
          method: 'DELETE',
          url: '/api/v1/admin/users/alice',
          headers: bearer(adminToken),
        })
      ).statusCode,
    ).toBe(200);
    // 同 ID 重建：`sub` 又存在且 active，只有身份版本变了。
    expect(
      (
        await inject({
          method: 'POST',
          url: '/api/v1/admin/users',
          headers: bearer(adminToken),
          payload: { id: 'alice', displayName: 'Alice' },
        })
      ).statusCode,
    ).toBe(200);

    const stale = await inject({
      method: 'GET',
      url: '/api/v1/admin/users',
      headers: bearer(aliceToken),
    });
    expect(stale.statusCode).toBe(401);
    expect(json(stale)['error']).toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('改密码后旧 token 401，新密码可以登录', async () => {
    const token = await login();
    const changed = await inject({
      method: 'POST',
      url: '/api/v1/admin/users/local/password',
      headers: bearer(token),
      payload: { password: 'rotated-password' },
    });
    expect(changed.statusCode).toBe(200);

    const stale = await inject({
      method: 'GET',
      url: '/api/v1/admin/users',
      headers: bearer(token),
    });
    expect(stale.statusCode).toBe(401);

    const fresh = await login('local', 'rotated-password');
    expect(fresh).not.toBe(token);
    expect(
      (
        await inject({
          method: 'GET',
          url: '/api/v1/admin/users',
          headers: bearer(fresh),
        })
      ).statusCode,
    ).toBe(200);
  });
});

describe('API Key', () => {
  it('创建、使用、撤销一条链路；列表不返回明文', async () => {
    const token = await login();
    const created = await inject({
      method: 'POST',
      url: '/api/v1/admin/users/local/api-keys',
      headers: bearer(token),
      payload: { name: 'ci' },
    });
    expect(created.statusCode).toBe(200);
    const key = json(created)['result'] as Record<string, unknown>;
    expect(String(key['key']).startsWith('comem_')).toBe(true);

    const withKey = await inject({
      method: 'GET',
      url: '/api/v1/admin/users',
      headers: bearer(String(key['key'])),
    });
    expect(withKey.statusCode).toBe(200);

    const listed = await inject({
      method: 'GET',
      url: '/api/v1/admin/users/local/api-keys',
      headers: bearer(token),
    });
    expect(listed.statusCode).toBe(200);
    const keys = json(listed)['result'] as Record<string, unknown>;
    expect(JSON.stringify(keys)).not.toContain(String(key['key']));
    expect(JSON.stringify(keys)).not.toContain('keyHash');

    const revoked = await inject({
      method: 'DELETE',
      url: `/api/v1/admin/api-keys/${String(key['id'])}`,
      headers: bearer(token),
    });
    expect(revoked.statusCode).toBe(200);

    const afterRevoke = await inject({
      method: 'GET',
      url: '/api/v1/admin/users',
      headers: bearer(String(key['key'])),
    });
    expect(afterRevoke.statusCode).toBe(401);
  });

  it('过期的 key 是 401', async () => {
    const token = await login();
    const created = await inject({
      method: 'POST',
      url: '/api/v1/admin/users/local/api-keys',
      headers: bearer(token),
      payload: { name: 'expired', expiresAt: new Date(Date.now() - 60_000).toISOString() },
    });
    const key = json(created)['result'] as Record<string, unknown>;

    const response = await inject({
      method: 'GET',
      url: '/api/v1/admin/users',
      headers: bearer(String(key['key'])),
    });
    expect(response.statusCode).toBe(401);
  });

  it('撤销不存在的 key 是 404', async () => {
    const token = await login();
    const response = await inject({
      method: 'DELETE',
      url: '/api/v1/admin/api-keys/key_missing',
      headers: bearer(token),
    });
    expect(response.statusCode).toBe(404);
  });
});

describe('回环信任（auth.trustLoopback）', () => {
  interface TrustHarness {
    readonly container: Container;
    readonly app: FastifyInstance;
    readonly dir: string;
  }

  async function startTrust(trustLoopback: boolean): Promise<TrustHarness> {
    const dir = await mkdtemp(join(tmpdir(), 'comem-auth-loopback-'));
    const created = await createContainer({
      configPath: join(dir, 'config.yaml'),
      env: {
        ...process.env,
        COMEM_DATA_DIR: dir,
        COMEM_SUMMARY_GENERATOR: 'rule',
        COMEM_LOGGING_LEVEL: 'error',
        COMEM_AUTH_SESSION_SECRET: SESSION_SECRET,
        COMEM_AUTH_ADMIN_USER_IDS: JSON.stringify(['local']),
        COMEM_AUTH_TRUST_LOOPBACK: trustLoopback ? 'true' : 'false',
      },
    });
    await created.services.identity.setPassword('local', PASSWORD);
    const trustApp = await createHttpServer({
      config: created.config,
      logger: created.logger,
      observability: created.observability,
      routes: created.routes,
      mcp: created.mcp,
      resolveIdentity: created.resolveIdentity,
    });
    return { container: created, app: trustApp, dir };
  }

  async function stopTrust(harness: TrustHarness): Promise<void> {
    await harness.container.services.indexObserver.drain();
    await harness.app.close();
    await harness.container.close();
    await rm(harness.dir, { recursive: true, force: true });
  }

  it('回环来源没有凭据时认证为 server.subject', async () => {
    const harness = await startTrust(true);
    try {
      const response = await harness.app.inject({
        method: 'GET',
        url: '/api/v1/admin/users',
      });
      expect(response.statusCode, response.body).toBe(200);
    } finally {
      await stopTrust(harness);
    }
  });

  it('非回环来源没有凭据 → 401', async () => {
    const harness = await startTrust(true);
    try {
      const response = await harness.app.inject({
        method: 'GET',
        url: '/api/v1/admin/users',
        remoteAddress: '203.0.113.7',
      });
      expect(response.statusCode).toBe(401);
      expect(json(response)['error']).toMatchObject({ code: 'UNAUTHENTICATED' });
    } finally {
      await stopTrust(harness);
    }
  });

  it('Host 指向别的域名时不信回环来源（DNS rebinding 防线）', async () => {
    const harness = await startTrust(true);
    try {
      const response = await harness.app.inject({
        method: 'GET',
        url: '/api/v1/admin/users',
        headers: { host: 'evil.example.com' },
      });
      expect(response.statusCode).toBe(401);
    } finally {
      await stopTrust(harness);
    }
  });

  it('带凭据时凭据优先，回环信任不覆盖它', async () => {
    const harness = await startTrust(true);
    try {
      harness.container.services.identity.createUser({ id: 'alice', displayName: 'Alice' });
      await harness.container.services.identity.ensureUserNamespace('alice');
      await harness.container.services.identity.setPassword('alice', PASSWORD);
      const loginResponse = await harness.app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { username: 'alice', password: PASSWORD },
      });
      expect(loginResponse.statusCode, loginResponse.body).toBe(200);
      const token = String((json(loginResponse)['result'] as Record<string, unknown>)['token']);

      // 自己的根可读；绑定主体（local）的根不可读 —— 证明身份是 alice 而不是
      // 回环信任给出的 local。
      const own = await harness.app.inject({
        method: 'GET',
        url: `/api/v1/fs/ls?uri=${encodeURIComponent('comem://user/alice')}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(own.statusCode, own.body).toBe(200);

      const bound = await harness.app.inject({
        method: 'GET',
        url: `/api/v1/fs/ls?uri=${encodeURIComponent('comem://user/local')}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(bound.statusCode).toBe(403);
    } finally {
      await stopTrust(harness);
    }
  });

  it('关掉回环信任后，回环来源没有凭据也是 401', async () => {
    const harness = await startTrust(false);
    try {
      const response = await harness.app.inject({
        method: 'GET',
        url: '/api/v1/admin/users',
      });
      expect(response.statusCode).toBe(401);
    } finally {
      await stopTrust(harness);
    }
  });
});
