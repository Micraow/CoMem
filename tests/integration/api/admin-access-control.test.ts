/**
 * 管理面与任务队列的目标级授权（安全回归）。
 *
 * 缺陷形态：`assertManage(ownRoot)` 对「调用方自己的根」求 `manage`，而 user 根的
 * owner 恒为本人（`domain/acl.ts` 不变量 1）——任何登录用户都满足，等于任何登录
 * 用户都是管理员。这组用例断言的是**没有权限的人做不到**：
 *
 * 1. 用户 A 改 B 的密码 → 403，且 B 用旧密码仍能登录；
 * 2. 配了 `auth.adminUserIds: [A]` 后同一请求 → 成功（修复不是关死管理功能）；
 * 3. A 自助加入别人的组 → 403；组 owner 加人 → 成功；普通组员仍不能加人；
 * 4. `/tasks/{id}` 与 retry：非系统管理员 403、系统管理员 200；任务表没有归属列，
 *    只能按系统管理员收口。
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createHttpServer } from '../../../src/api/http/server.js';
import { createContainer, type Container } from '../../../src/bootstrap/container.js';
import { Uri } from '../../../src/domain/uri.js';

const PASSWORD = 'correct-password';
const SESSION_SECRET = 'test-session-secret';

interface Harness {
  readonly container: Container;
  readonly app: FastifyInstance;
  readonly dataDir: string;
}

async function start(adminUserIds: readonly string[]): Promise<Harness> {
  const dataDir = await mkdtemp(join(tmpdir(), 'comem-access-control-'));
  const container = await createContainer({
    configPath: join(dataDir, 'config.yaml'),
    env: {
      ...process.env,
      COMEM_DATA_DIR: dataDir,
      COMEM_SUMMARY_GENERATOR: 'rule',
      COMEM_LOGGING_LEVEL: 'error',
      COMEM_AUTH_ENABLED: 'true',
      COMEM_AUTH_SESSION_SECRET: SESSION_SECRET,
      COMEM_AUTH_ADMIN_USER_IDS: JSON.stringify(adminUserIds),
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
  return { container, app, dataDir };
}

async function stop(harness: Harness): Promise<void> {
  await harness.container.services.indexObserver.drain();
  await harness.app.close();
  await harness.container.close();
  await rm(harness.dataDir, { recursive: true, force: true });
}

/** 建一个能登录的用户：目录行 + 命名空间（根预置）+ 密码。 */
async function seedUser(harness: Harness, id: string): Promise<void> {
  harness.container.services.identity.createUser({ id, displayName: id });
  await harness.container.services.identity.ensureUserNamespace(id);
  await harness.container.services.identity.setPassword(id, PASSWORD);
}

function json(response: { readonly body: string }): Record<string, unknown> {
  return JSON.parse(response.body) as Record<string, unknown>;
}

function errorOf(response: { readonly body: string }): Record<string, unknown> {
  return json(response)['error'] as Record<string, unknown>;
}

async function login(
  harness: Harness,
  username: string,
  password: string = PASSWORD,
): Promise<string> {
  const response = await harness.app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { username, password },
  });
  expect(response.statusCode, response.body).toBe(200);
  const result = json(response)['result'] as Record<string, unknown>;
  return String(result['token']);
}

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

function inject(harness: Harness, options: InjectOptions) {
  return harness.app.inject(options);
}

beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch disabled'));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('改密码只能改自己的（或系统管理员）', () => {
  it('A 改 B 的密码 → 403，B 的密码没变', async () => {
    const harness = await start([]);
    try {
      await seedUser(harness, 'alice');
      await seedUser(harness, 'bob');
      const aliceToken = await login(harness, 'alice');

      const denied = await inject(harness, {
        method: 'POST',
        url: '/api/v1/admin/users/bob/password',
        headers: bearer(aliceToken),
        payload: { password: 'taken-over-by-alice' },
      });
      expect(denied.statusCode).toBe(403);
      expect(errorOf(denied)['code']).toBe('PERMISSION_DENIED');

      // 用真实登录验证「没有副作用」：旧密码仍然有效，攻击者的新密码无效。
      await expect(login(harness, 'bob', PASSWORD)).resolves.toEqual(expect.any(String));
      const withInjected = await inject(harness, {
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { username: 'bob', password: 'taken-over-by-alice' },
      });
      expect(withInjected.statusCode).toBe(401);

      // 正向对照 1：本人改自己的密码（目标就是自己的根）→ 成功。
      const bobToken = await login(harness, 'bob');
      const own = await inject(harness, {
        method: 'POST',
        url: '/api/v1/admin/users/bob/password',
        headers: bearer(bobToken),
        payload: { password: 'bob-new-password' },
      });
      expect(own.statusCode).toBe(200);
    } finally {
      await stop(harness);
    }
  });

  it('A 被配置为系统管理员后，同一请求成功', async () => {
    const harness = await start(['alice']);
    try {
      await seedUser(harness, 'alice');
      await seedUser(harness, 'bob');
      const aliceToken = await login(harness, 'alice');

      const changed = await inject(harness, {
        method: 'POST',
        url: '/api/v1/admin/users/bob/password',
        headers: bearer(aliceToken),
        payload: { password: 'rotated-by-admin' },
      });
      expect(changed.statusCode).toBe(200);

      const oldPassword = await inject(harness, {
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { username: 'bob', password: PASSWORD },
      });
      expect(oldPassword.statusCode).toBe(401);
      await expect(login(harness, 'bob', 'rotated-by-admin')).resolves.toEqual(
        expect.any(String),
      );
    } finally {
      await stop(harness);
    }
  });

  it('签 API key、禁用、删除、列 key 同样只能针对自己的根（系统管理员除外）', async () => {
    const harness = await start([]);
    try {
      await seedUser(harness, 'alice');
      await seedUser(harness, 'bob');
      const aliceToken = await login(harness, 'alice');

      const requests: readonly InjectOptions[] = [
        {
          method: 'POST',
          url: '/api/v1/admin/users/bob/api-keys',
          headers: bearer(aliceToken),
          payload: { name: 'ci' },
        },
        {
          method: 'GET',
          url: '/api/v1/admin/users/bob/api-keys',
          headers: bearer(aliceToken),
        },
        {
          method: 'PATCH',
          url: '/api/v1/admin/users/bob',
          headers: bearer(aliceToken),
          payload: { status: 'disabled' },
        },
        {
          method: 'DELETE',
          url: '/api/v1/admin/users/bob',
          headers: bearer(aliceToken),
        },
      ];
      for (const request of requests) {
        const response = await inject(harness, request);
        expect(response.statusCode, `${request.method} ${request.url}`).toBe(403);
        expect(errorOf(response)['code']).toBe('PERMISSION_DENIED');
      }

      // 没有副作用：bob 仍然是 active、仍然没有 key。
      expect(harness.container.services.identity.getUser('bob')?.status).toBe('active');
      expect(harness.container.services.identity.listApiKeys('bob')).toEqual([]);
    } finally {
      await stop(harness);
    }
  });

  it('吊销别人的 API Key → 403；吊销自己的 → 成功', async () => {
    const harness = await start([]);
    try {
      await seedUser(harness, 'alice');
      await seedUser(harness, 'bob');
      const bobKey = await harness.container.services.identity.createApiKey('bob', {
        name: 'ci',
      });

      const aliceToken = await login(harness, 'alice');
      const denied = await inject(harness, {
        method: 'DELETE',
        url: `/api/v1/admin/api-keys/${bobKey.record.id}`,
        headers: bearer(aliceToken),
      });
      expect(denied.statusCode).toBe(403);
      expect(harness.container.services.identity.listApiKeys('bob')[0]?.revokedAt).toBeNull();

      const bobToken = await login(harness, 'bob');
      const revoked = await inject(harness, {
        method: 'DELETE',
        url: `/api/v1/admin/api-keys/${bobKey.record.id}`,
        headers: bearer(bobToken),
      });
      expect(revoked.statusCode).toBe(200);
      expect(harness.container.services.identity.listApiKeys('bob')[0]?.revokedAt).not.toBeNull();
    } finally {
      await stop(harness);
    }
  });
});

describe('系统管理员默认空名单', () => {
  it('auth.enabled: true 且 adminUserIds 为空：已登录用户调用户 / 组目录都 403', async () => {
    const harness = await start([]);
    try {
      await seedUser(harness, 'alice');
      const aliceToken = await login(harness, 'alice');

      // 默认值 `[]` 本身不构成安全保障：真正的含义是这些跨主体端点全部 403。
      for (const request of [
        { method: 'GET' as const, url: '/api/v1/admin/users' },
        {
          method: 'POST' as const,
          url: '/api/v1/admin/users',
          payload: { id: 'mallory', displayName: 'Mallory' },
        },
        { method: 'GET' as const, url: '/api/v1/admin/groups' },
        {
          method: 'POST' as const,
          url: '/api/v1/admin/groups',
          payload: { id: 'shadow', displayName: 'shadow' },
        },
      ]) {
        const response = await inject(harness, { ...request, headers: bearer(aliceToken) });
        expect(response.statusCode, `${request.method} ${request.url}`).toBe(403);
        expect(errorOf(response)['code']).toBe('PERMISSION_DENIED');
      }

      // 没有副作用：没建出账号，也没建出组。
      expect(harness.container.services.identity.getUser('mallory')).toBeNull();
      expect(harness.container.services.identity.getGroup('shadow')).toBeNull();
    } finally {
      await stop(harness);
    }
  });

  it('名单里有 A：用户目录的读写成功（不是把所有管理功能关死）', async () => {
    const harness = await start(['alice']);
    try {
      await seedUser(harness, 'alice');
      const aliceToken = await login(harness, 'alice');

      const listed = await inject(harness, {
        method: 'GET',
        url: '/api/v1/admin/users',
        headers: bearer(aliceToken),
      });
      expect(listed.statusCode).toBe(200);

      const created = await inject(harness, {
        method: 'POST',
        url: '/api/v1/admin/users',
        headers: bearer(aliceToken),
        payload: { id: 'mallory', displayName: 'Mallory' },
      });
      expect(created.statusCode).toBe(200);
      expect(harness.container.services.identity.getUser('mallory')?.displayName).toBe(
        'Mallory',
      );
    } finally {
      await stop(harness);
    }
  });
});

describe('自助加组不能拿到组子树', () => {
  async function seedGroup(harness: Harness, ownerUserId: string): Promise<void> {
    harness.container.services.identity.createGroup({
      id: 'eng',
      displayName: 'eng',
      ownerUserId,
    });
    await harness.container.services.acl.ensureRootPreset(
      Uri.parse('comem://group/eng'),
      ownerUserId,
    );
  }

  it('A 加自己 → 403；组 owner 加人 → 成功；普通组员仍不能加人', async () => {
    const harness = await start([]);
    try {
      await seedUser(harness, 'alice');
      await seedUser(harness, 'bob');
      await seedUser(harness, 'carol');
      await seedGroup(harness, 'bob');

      const aliceToken = await login(harness, 'alice');
      const selfAdd = await inject(harness, {
        method: 'POST',
        url: '/api/v1/admin/groups/eng/members',
        headers: bearer(aliceToken),
        payload: { userId: 'alice' },
      });
      expect(selfAdd.statusCode).toBe(403);
      expect(errorOf(selfAdd)['code']).toBe('PERMISSION_DENIED');
      // 没加上：alice 没有 `group:eng` 主体，读不到组空间。
      expect(harness.container.services.identity.listMembers('eng')).toEqual([]);

      // 对照组：组 owner（组根的 `user:{owner} = manage`）加人成功。
      const bobToken = await login(harness, 'bob');
      const ownerAdd = await inject(harness, {
        method: 'POST',
        url: '/api/v1/admin/groups/eng/members',
        headers: bearer(bobToken),
        payload: { userId: 'alice' },
      });
      expect(ownerAdd.statusCode).toBe(200);
      expect(
        harness.container.services.identity.listMembers('eng').map((member) => member.userId),
      ).toEqual(['alice']);

      // 组员拿到的只是根预置的 `group:eng = write`：write 不是 manage，
      // 不能给第三个人开门。
      // 组关系每请求查库，所以 alice 的旧 token 立即带上 group:eng。
      const memberAdd = await inject(harness, {
        method: 'POST',
        url: '/api/v1/admin/groups/eng/members',
        headers: bearer(aliceToken),
        payload: { userId: 'carol' },
      });
      expect(memberAdd.statusCode).toBe(403);
      expect(
        harness.container.services.identity.listMembers('eng').map((member) => member.userId),
      ).toEqual(['alice']);
    } finally {
      await stop(harness);
    }
  });

  it('成员 role 是派生的：加人是 member，转移 owner 后同一成员变 owner', async () => {
    const harness = await start([]);
    try {
      await seedUser(harness, 'alice');
      await seedUser(harness, 'bob');
      await seedGroup(harness, 'bob');
      const bobToken = await login(harness, 'bob');

      const added = await inject(harness, {
        method: 'POST',
        url: '/api/v1/admin/groups/eng/members',
        headers: bearer(bobToken),
        payload: { userId: 'alice' },
      });
      expect(added.statusCode).toBe(200);
      const addedMember = json(added)['result'] as Record<string, unknown>;
      expect(addedMember['member']).toMatchObject({ userId: 'alice', role: 'member' });

      const transferred = await inject(harness, {
        method: 'POST',
        url: '/api/v1/admin/groups/eng/owner',
        headers: bearer(bobToken),
        payload: { userId: 'alice' },
      });
      expect(transferred.statusCode).toBe(200);

      // 同一条成员行没有重写，role 从 `app_group.owner_user_id` 派生。
      const listed = await inject(harness, {
        method: 'GET',
        url: '/api/v1/admin/groups/eng/members',
        headers: bearer(bobToken),
      });
      // bob 已经失去组根 manage，连成员列表都读不了；用服务层看派生结果。
      expect(listed.statusCode).toBe(403);
      const members = harness.container.services.identity.listMembers('eng');
      expect(members).toEqual([
        expect.objectContaining({ userId: 'alice', role: 'owner' }),
      ]);
    } finally {
      await stop(harness);
    }
  });

  it('显式写 role → INVALID_ARGUMENT，不落成员行', async () => {
    const harness = await start([]);
    try {
      await seedUser(harness, 'alice');
      await seedUser(harness, 'bob');
      await seedGroup(harness, 'bob');
      const bobToken = await login(harness, 'bob');

      const rejected = await inject(harness, {
        method: 'POST',
        url: '/api/v1/admin/groups/eng/members',
        headers: bearer(bobToken),
        payload: { userId: 'alice', role: 'owner' },
      });
      expect(rejected.statusCode).toBe(400);
      expect(errorOf(rejected)['code']).toBe('INVALID_ARGUMENT');
      expect(harness.container.services.identity.listMembers('eng')).toEqual([]);
    } finally {
      await stop(harness);
    }
  });

  it('非 owner 改别人的组资料 / 删组 → 403', async () => {
    const harness = await start([]);
    try {
      await seedUser(harness, 'alice');
      await seedUser(harness, 'bob');
      await seedGroup(harness, 'bob');
      const aliceToken = await login(harness, 'alice');

      for (const request of [
        {
          method: 'PATCH' as const,
          url: '/api/v1/admin/groups/eng',
          headers: bearer(aliceToken),
          payload: { displayName: 'hijacked' },
        },
        {
          method: 'DELETE' as const,
          url: '/api/v1/admin/groups/eng',
          headers: bearer(aliceToken),
        },
        {
          method: 'POST' as const,
          url: '/api/v1/admin/groups/eng/owner',
          headers: bearer(aliceToken),
          payload: { userId: 'alice' },
        },
      ]) {
        const response = await inject(harness, request);
        expect(response.statusCode, `${request.method} ${request.url}`).toBe(403);
      }

      const group = harness.container.services.identity.getGroup('eng');
      expect(group?.displayName).toBe('eng');
      expect(group?.ownerUserId).toBe('bob');
    } finally {
      await stop(harness);
    }
  });
});

describe('提示词：读开放，写只给系统管理员', () => {
  const PROMPT_ID = 'extract-system';

  function resultOf(response: { readonly body: string }): Record<string, unknown> {
    return json(response)['result'] as Record<string, unknown>;
  }

  it('非管理员读 200，改 / 删 / 预览 403 且没有覆盖', async () => {
    const harness = await start([]);
    try {
      await seedUser(harness, 'alice');
      const aliceToken = await login(harness, 'alice');
      const defaultBody = harness.container.services.prompts.get(PROMPT_ID).defaultBody;

      for (const request of [
        { method: 'GET' as const, url: '/api/v1/prompts' },
        { method: 'GET' as const, url: `/api/v1/prompts/${PROMPT_ID}` },
      ]) {
        const response = await inject(harness, { ...request, headers: bearer(aliceToken) });
        expect(response.statusCode, request.url).toBe(200);
      }

      const put = await inject(harness, {
        method: 'PUT',
        url: `/api/v1/prompts/${PROMPT_ID}`,
        headers: bearer(aliceToken),
        payload: { body: defaultBody },
      });
      expect(put.statusCode).toBe(403);
      expect(errorOf(put)['code']).toBe('PERMISSION_DENIED');

      const deleted = await inject(harness, {
        method: 'DELETE',
        url: `/api/v1/prompts/${PROMPT_ID}`,
        headers: bearer(aliceToken),
      });
      expect(deleted.statusCode).toBe(403);

      const preview = await inject(harness, {
        method: 'POST',
        url: `/api/v1/prompts/${PROMPT_ID}/preview`,
        headers: bearer(aliceToken),
        payload: {},
      });
      expect(preview.statusCode).toBe(403);

      expect(harness.container.services.prompts.get(PROMPT_ID).overridden).toBe(false);
    } finally {
      await stop(harness);
    }
  });

  it('系统管理员改 / 预览 / 删除都成功', async () => {
    const harness = await start(['alice']);
    try {
      await seedUser(harness, 'alice');
      const aliceToken = await login(harness, 'alice');
      const defaultBody = harness.container.services.prompts.get(PROMPT_ID).defaultBody;

      const put = await inject(harness, {
        method: 'PUT',
        url: `/api/v1/prompts/${PROMPT_ID}`,
        headers: bearer(aliceToken),
        payload: { body: defaultBody },
      });
      expect(put.statusCode).toBe(200);
      expect(harness.container.services.prompts.get(PROMPT_ID).overridden).toBe(true);

      const preview = await inject(harness, {
        method: 'POST',
        url: `/api/v1/prompts/${PROMPT_ID}/preview`,
        headers: bearer(aliceToken),
        payload: {},
      });
      expect(preview.statusCode).toBe(200);
      expect(typeof resultOf(preview)['text']).toBe('string');

      const deleted = await inject(harness, {
        method: 'DELETE',
        url: `/api/v1/prompts/${PROMPT_ID}`,
        headers: bearer(aliceToken),
      });
      expect(deleted.statusCode).toBe(200);
      expect(harness.container.services.prompts.get(PROMPT_ID).overridden).toBe(false);
    } finally {
      await stop(harness);
    }
  });
});

describe('任务端点只对系统管理员开放', () => {
  it('非管理员读 / retry 都是 403；系统管理员能读、能 retry', async () => {
    const harness = await start(['local']);
    try {
      await seedUser(harness, 'alice');
      const task = harness.container.services.task.create('archive', {
        sessionUri: 'comem://user/local/sessions/sess_1',
        archiveUri: 'comem://user/local/history/0001',
        archiveId: '0001',
      });
      harness.container.services.taskStore.finish(task.id, 'failed', 'boom', new Date());

      const aliceToken = await login(harness, 'alice');
      const aliceRead = await inject(harness, {
        method: 'GET',
        url: `/api/v1/tasks/${task.id}`,
        headers: bearer(aliceToken),
      });
      expect(aliceRead.statusCode).toBe(403);
      const aliceRetry = await inject(harness, {
        method: 'POST',
        url: `/api/v1/tasks/${task.id}/retry`,
        headers: bearer(aliceToken),
      });
      expect(aliceRetry.statusCode).toBe(403);
      const aliceList = await inject(harness, {
        method: 'GET',
        url: '/api/v1/tasks',
        headers: bearer(aliceToken),
      });
      expect(aliceList.statusCode).toBe(403);
      // 任务没有被 requeue。
      expect(harness.container.services.taskStore.get(task.id)?.status).toBe('failed');

      // 任务承载的是会话归档（payload 里有 sessionUri/archiveUri），只有显式配置的
      // 系统管理员能读。绑定主体 local 是启动时预置的用户，补一个密码即可登录。
      await harness.container.services.identity.setPassword('local', PASSWORD);
      const adminToken = await login(harness, 'local');
      const adminRead = await inject(harness, {
        method: 'GET',
        url: `/api/v1/tasks/${task.id}`,
        headers: bearer(adminToken),
      });
      expect(adminRead.statusCode).toBe(200);

      const adminRetry = await inject(harness, {
        method: 'POST',
        url: `/api/v1/tasks/${task.id}/retry`,
        headers: bearer(adminToken),
      });
      expect(adminRetry.statusCode).toBe(200);
      expect(harness.container.services.taskStore.get(task.id)?.status).toBe('pending');
    } finally {
      await stop(harness);
    }
  });
});
