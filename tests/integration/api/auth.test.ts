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
      COMEM_AUTH_ENABLED: 'true',
      COMEM_AUTH_SESSION_SECRET: SESSION_SECRET,
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

  it('缺少 Authorization 头是 401，x-comem-subject 被忽略', async () => {
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
    expect(
      (
        await inject({
          method: 'GET',
          url: '/api/v1/admin/users',
          headers: bearer(aliceToken),
        })
      ).statusCode,
    ).toBe(200);

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

describe('auth.enabled = false', () => {
  it('登录端点 404，x-comem-subject 仍是身份来源', async () => {
    const disabledDir = await mkdtemp(join(tmpdir(), 'comem-auth-disabled-'));
    const disabled = await createContainer({
      configPath: join(disabledDir, 'config.yaml'),
      env: {
        ...process.env,
        COMEM_DATA_DIR: disabledDir,
        COMEM_SUMMARY_GENERATOR: 'rule',
        COMEM_LOGGING_LEVEL: 'error',
        COMEM_AUTH_ENABLED: 'false',
      },
    });
    const disabledApp = await createHttpServer({
      config: disabled.config,
      logger: disabled.logger,
      observability: disabled.observability,
      routes: disabled.routes,
      mcp: disabled.mcp,
      resolveIdentity: disabled.resolveIdentity,
    });

    try {
      const loginResponse = await disabledApp.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { username: 'local', password: PASSWORD },
      });
      expect(loginResponse.statusCode).toBe(404);

      // v1 行为不变：不带认证头时用服务图绑定的主体。
      const health = await disabledApp.inject({ method: 'GET', url: '/health' });
      expect(health.statusCode).toBe(200);

      const users = await disabledApp.inject({
        method: 'GET',
        url: '/api/v1/admin/users',
        headers: { 'x-comem-subject': 'user:local' },
      });
      expect(users.statusCode).toBe(200);
    } finally {
      await disabledApp.close();
      await disabled.close();
      await rm(disabledDir, { recursive: true, force: true });
    }
  });
});
