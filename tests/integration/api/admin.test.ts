import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Fastify, { type FastifyInstance, type InjectOptions } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDatabase, runMigrations } from '../../../src/adapters/sqlite/database.js';
import { GroupRepository } from '../../../src/adapters/sqlite/group-repository.js';
import { UserRepository } from '../../../src/adapters/sqlite/user-repository.js';
import { toErrorEnvelope } from '../../../src/api/http/error-mapper.js';
import {
  createIdentityMiddleware,
  createRequestIdMiddleware,
} from '../../../src/api/http/middleware.js';
import { createAdminRoutes, type AdminAccess } from '../../../src/api/http/routes/admin.js';
import { createHttpServer } from '../../../src/api/http/server.js';
import { createContainer, type Container } from '../../../src/bootstrap/container.js';
import { ComemError } from '../../../src/domain/errors.js';
import type { Logger } from '../../../src/domain/log.js';
import { Uri } from '../../../src/domain/uri.js';
import type { Authorizer } from '../../../src/services/authorizer.js';
import { IdentityService } from '../../../src/services/identity.js';

let dataDir: string;
let container: Container;
let app: FastifyInstance;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'comem-admin-'));
  container = await createContainer({
    // 配置从临时目录读，不是仓库根：仓库根的 `config.yaml` 可能指向真实模型网关。
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

function inject(options: InjectOptions) {
  return app.inject(options);
}

function json(response: { readonly body: string }): Record<string, unknown> {
  return JSON.parse(response.body) as Record<string, unknown>;
}

function errorOf(response: { readonly body: string }): Record<string, unknown> {
  const body = json(response);
  expect(body['status']).toBe('error');
  return body['error'] as Record<string, unknown>;
}

function resultOf(response: { readonly body: string }): Record<string, unknown> {
  const body = json(response);
  expect(body['status']).toBe('ok');
  return body['result'] as Record<string, unknown>;
}

function countRows(sql: string, ...params: readonly string[]): number {
  const row = container.db.prepare(sql).get(...params);
  return Number(row?.['total'] ?? 0);
}

function createUser(id: string): Promise<unknown> {
  return inject({
    method: 'POST',
    url: '/api/v1/admin/users',
    payload: { id, displayName: id },
  });
}

function createGroup(id: string): Promise<unknown> {
  return inject({
    method: 'POST',
    url: '/api/v1/admin/groups',
    payload: { id, displayName: id },
  });
}

describe('用户管理', () => {
  it('创建 → 列表 → 更新 → 删除', async () => {
    const created = resultOf(
      await inject({
        method: 'POST',
        url: '/api/v1/admin/users',
        payload: { id: 'alice', displayName: 'Alice', email: 'alice@example.com' },
      }),
    );
    const user = created['user'] as Record<string, unknown>;
    expect(user['id']).toBe('alice');
    expect(user['email']).toBe('alice@example.com');
    expect(user['status']).toBe('active');

    const listed = resultOf(await inject({ method: 'GET', url: '/api/v1/admin/users' }));
    expect((listed['users'] as Record<string, unknown>[]).map((row) => row['id'])).toContain(
      'alice',
    );
    // 启动预置的 `user:local` 也在目录里：列表不是「只包含新建的」。
    expect(listed['total']).toBe(2);

    const updated = resultOf(
      await inject({
        method: 'PATCH',
        url: '/api/v1/admin/users/alice',
        payload: { displayName: 'Alice Zhang', status: 'disabled' },
      }),
    );
    expect((updated['user'] as Record<string, unknown>)['displayName']).toBe('Alice Zhang');
    expect((updated['user'] as Record<string, unknown>)['status']).toBe('disabled');

    const deleted = resultOf(
      await inject({ method: 'DELETE', url: '/api/v1/admin/users/alice' }),
    );
    expect(deleted['deleted']).toBe(true);

    const after = resultOf(await inject({ method: 'GET', url: '/api/v1/admin/users' }));
    expect((after['users'] as Record<string, unknown>[]).map((row) => row['id'])).not.toContain(
      'alice',
    );
  });

  it('ID 非法返回 400', async () => {
    for (const payload of [
      { id: 'Alice', displayName: 'Alice' },
      { id: '_meta', displayName: 'Meta' },
    ]) {
      const response = await inject({
        method: 'POST',
        url: '/api/v1/admin/users',
        payload,
      });
      expect(response.statusCode, String(payload.id)).toBe(400);
      expect(errorOf(response)['code']).toBe('INVALID_ARGUMENT');
    }

    const deleted = await inject({ method: 'DELETE', url: '/api/v1/admin/users/Alice' });
    expect(deleted.statusCode).toBe(400);
    expect(errorOf(deleted)['code']).toBe('INVALID_ARGUMENT');
  });

  it('重复创建返回 409', async () => {
    await createUser('alice');
    const response = await inject({
      method: 'POST',
      url: '/api/v1/admin/users',
      payload: { id: 'alice', displayName: 'Alice' },
    });
    expect(response.statusCode).toBe(409);
    expect(errorOf(response)['code']).toBe('CONFLICT');
  });

  it('更新或删除不存在的用户返回 404', async () => {
    const updated = await inject({
      method: 'PATCH',
      url: '/api/v1/admin/users/missing',
      payload: { displayName: 'X' },
    });
    expect(updated.statusCode).toBe(404);
    expect(errorOf(updated)['code']).toBe('NOT_FOUND');

    const deleted = await inject({ method: 'DELETE', url: '/api/v1/admin/users/missing' });
    expect(deleted.statusCode).toBe(404);
    expect(errorOf(deleted)['code']).toBe('NOT_FOUND');
  });

  it('分页按 id 升序，total 是整张目录的行数', async () => {
    for (const id of ['a1', 'a2', 'a3']) {
      await createUser(id);
    }

    const first = resultOf(
      await inject({ method: 'GET', url: '/api/v1/admin/users?limit=2&offset=0' }),
    );
    expect((first['users'] as Record<string, unknown>[]).map((row) => row['id'])).toEqual([
      'a1',
      'a2',
    ]);
    expect(first['total']).toBe(4);

    const second = resultOf(
      await inject({ method: 'GET', url: '/api/v1/admin/users?limit=2&offset=2' }),
    );
    expect((second['users'] as Record<string, unknown>[]).map((row) => row['id'])).toEqual([
      'a3',
      'local',
    ]);
  });

  it('非法分页参数返回 400', async () => {
    const response = await inject({ method: 'GET', url: '/api/v1/admin/users?limit=0' });
    expect(response.statusCode).toBe(400);
    expect(errorOf(response)['code']).toBe('INVALID_ARGUMENT');
  });
});

describe('组管理', () => {
  it('创建 → 列表 → 更新 → 成员 → 删除', async () => {
    const created = resultOf(
      await inject({
        method: 'POST',
        url: '/api/v1/admin/groups',
        payload: { id: 'eng', displayName: '工程', description: '平台组' },
      }),
    );
    const group = created['group'] as Record<string, unknown>;
    expect(group['id']).toBe('eng');
    expect(group['description']).toBe('平台组');

    const listed = resultOf(await inject({ method: 'GET', url: '/api/v1/admin/groups' }));
    expect(listed['total']).toBe(1);
    expect((listed['groups'] as Record<string, unknown>[])[0]?.['memberCount']).toBe(0);

    const updated = resultOf(
      await inject({
        method: 'PATCH',
        url: '/api/v1/admin/groups/eng',
        payload: { description: null },
      }),
    );
    expect((updated['group'] as Record<string, unknown>)['description']).toBeNull();

    await createUser('alice');
    const added = resultOf(
      await inject({
        method: 'POST',
        url: '/api/v1/admin/groups/eng/members',
        payload: { userId: 'alice' },
      }),
    );
    expect((added['member'] as Record<string, unknown>)['role']).toBe('member');

    const members = resultOf(
      await inject({ method: 'GET', url: '/api/v1/admin/groups/eng/members' }),
    );
    expect((members['members'] as Record<string, unknown>[]).map((row) => row['userId'])).toEqual([
      'alice',
    ]);
    expect(members['total']).toBe(1);

    // 重复添加是幂等的：同一行，角色被更新（`GroupRepository.addMember` 的语义）。
    const again = resultOf(
      await inject({
        method: 'POST',
        url: '/api/v1/admin/groups/eng/members',
        payload: { userId: 'alice', role: 'owner' },
      }),
    );
    expect((again['member'] as Record<string, unknown>)['role']).toBe('owner');
    const afterAdd = resultOf(
      await inject({ method: 'GET', url: '/api/v1/admin/groups/eng/members' }),
    );
    expect((afterAdd['members'] as unknown[]).length).toBe(1);

    const withCounts = resultOf(await inject({ method: 'GET', url: '/api/v1/admin/groups' }));
    expect((withCounts['groups'] as Record<string, unknown>[])[0]?.['memberCount']).toBe(1);

    const removed = resultOf(
      await inject({ method: 'DELETE', url: '/api/v1/admin/groups/eng/members/alice' }),
    );
    expect(removed['removed']).toBe(true);
    const empty = resultOf(
      await inject({ method: 'GET', url: '/api/v1/admin/groups/eng/members' }),
    );
    expect(empty['members']).toEqual([]);

    await inject({ method: 'DELETE', url: '/api/v1/admin/groups/eng' });
    const gone = await inject({ method: 'GET', url: '/api/v1/admin/groups/eng/members' });
    expect(gone.statusCode).toBe(404);
  });

  it('ID 非法、重复创建、更新不存在的组', async () => {
    const invalid = await inject({
      method: 'POST',
      url: '/api/v1/admin/groups',
      payload: { id: 'Eng', displayName: 'Eng' },
    });
    expect(invalid.statusCode).toBe(400);
    expect(errorOf(invalid)['code']).toBe('INVALID_ARGUMENT');

    await createGroup('eng');
    const duplicate = await inject({
      method: 'POST',
      url: '/api/v1/admin/groups',
      payload: { id: 'eng', displayName: 'Eng' },
    });
    expect(duplicate.statusCode).toBe(409);
    expect(errorOf(duplicate)['code']).toBe('CONFLICT');

    const missing = await inject({
      method: 'PATCH',
      url: '/api/v1/admin/groups/missing',
      payload: { displayName: 'X' },
    });
    expect(missing.statusCode).toBe(404);
    expect(errorOf(missing)['code']).toBe('NOT_FOUND');
  });

  it('成员不存在、不是成员、组不存在都返回 404', async () => {
    await createGroup('eng');
    await createUser('alice');

    const missingUser = await inject({
      method: 'POST',
      url: '/api/v1/admin/groups/eng/members',
      payload: { userId: 'missing' },
    });
    expect(missingUser.statusCode).toBe(404);
    expect(errorOf(missingUser)['code']).toBe('NOT_FOUND');

    const notMember = await inject({
      method: 'DELETE',
      url: '/api/v1/admin/groups/eng/members/alice',
    });
    expect(notMember.statusCode).toBe(404);
    expect(errorOf(notMember)['code']).toBe('NOT_FOUND');

    const missingGroup = await inject({
      method: 'GET',
      url: '/api/v1/admin/groups/missing/members',
    });
    expect(missingGroup.statusCode).toBe(404);
    expect(errorOf(missingGroup)['code']).toBe('NOT_FOUND');
  });

  it('组 ID 非法返回 400', async () => {
    const response = await inject({ method: 'GET', url: '/api/v1/admin/groups/Eng/members' });
    expect(response.statusCode).toBe(400);
    expect(errorOf(response)['code']).toBe('INVALID_ARGUMENT');
  });
});

describe('删除账号的授权清理', () => {
  it('删除用户返回 revokedPermissions，并清空该主体的 node_permission 与 acl_entry', async () => {
    await createUser('alice');
    const aliceRoot = Uri.parse('comem://user/alice');
    await container.services.acl.ensureRootPreset(aliceRoot);
    const child = aliceRoot.child('project');
    await container.services.acl.materializeNode(child);
    await container.services.acl.setAcl(child, { mode: 'inherit', entries: [] }, 'user:alice');

    const before = countRows(
      'SELECT COUNT(*) AS total FROM node_permission WHERE principal = ?',
      'user:alice',
    );
    expect(before).toBeGreaterThanOrEqual(2);

    const deleted = resultOf(
      await inject({ method: 'DELETE', url: '/api/v1/admin/users/alice' }),
    );
    expect(deleted['revokedPermissions']).toBe(before);

    expect(
      countRows(
        'SELECT COUNT(*) AS total FROM node_permission WHERE principal = ?',
        'user:alice',
      ),
    ).toBe(0);
    expect(
      countRows('SELECT COUNT(*) AS total FROM acl_entry WHERE principal = ?', 'user:alice'),
    ).toBe(0);
  });

  it('删除组返回 revokedPermissions，并清空该主体的 node_permission 与 acl_entry', async () => {
    await createGroup('eng');
    await container.services.acl.ensureRootPreset(Uri.parse('comem://group/eng'));

    const before = countRows(
      'SELECT COUNT(*) AS total FROM node_permission WHERE principal = ?',
      'group:eng',
    );
    expect(before).toBeGreaterThanOrEqual(1);

    const deleted = resultOf(
      await inject({ method: 'DELETE', url: '/api/v1/admin/groups/eng' }),
    );
    expect(deleted['revokedPermissions']).toBe(before);

    expect(
      countRows(
        'SELECT COUNT(*) AS total FROM node_permission WHERE principal = ?',
        'group:eng',
      ),
    ).toBe(0);
    expect(
      countRows('SELECT COUNT(*) AS total FROM acl_entry WHERE principal = ?', 'group:eng'),
    ).toBe(0);
  });

  it('删除用户同时清掉它的组成员关系', async () => {
    await createUser('alice');
    await createGroup('eng');
    await inject({
      method: 'POST',
      url: '/api/v1/admin/groups/eng/members',
      payload: { userId: 'alice' },
    });

    await inject({ method: 'DELETE', url: '/api/v1/admin/users/alice' });

    const members = resultOf(
      await inject({ method: 'GET', url: '/api/v1/admin/groups/eng/members' }),
    );
    expect(members['members']).toEqual([]);
  });
});

describe('授权', () => {
  it('没有 manage 权限时 403', async () => {
    // 路由的授权在 owner 恒 manage 的规则下对「自身根」总是成立，所以这里用
    // 一个明确拒绝的 Authorizer 验证出口清单确实被求值——真实部署里它挡住的是
    // 「请求身份与绑定身份不一致」被误判成放行的情况。
    const db = openDatabase(':memory:');
    runMigrations(db);
    const logger: Logger = {
      trace: () => {},
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      child: () => logger,
    };
    const identity = new IdentityService({
      users: new UserRepository({ db, logger }),
      groups: new GroupRepository({ db, logger }),
      logger,
    });
    const authorizer: Authorizer = {
      check: async () => false,
      filterReadable: async () => new Set<string>(),
      assert: async () => {
        throw new ComemError('PERMISSION_DENIED', '没有权限。', {
          uri: 'comem://user/local',
          action: 7,
        });
      },
    };
    const adminAccess: AdminAccess = {
      permissionCounts: () => new Map(),
      memberCounts: () => new Map(),
      userCount: () => 0,
      groupCount: () => 0,
      revoke: () => 0,
    };

    const denyingApp = Fastify({ logger: false });
    denyingApp.addHook('onRequest', createRequestIdMiddleware());
    denyingApp.addHook(
      'onRequest',
      createIdentityMiddleware(async () => ({
        subject: 'user:local',
        principals: ['user:local', 'user:*'],
      })),
    );
    denyingApp.setErrorHandler((error, _request, reply) => {
      const mapped = toErrorEnvelope(error);
      reply.code(mapped.statusCode).send(mapped.body);
    });
    denyingApp.register(createAdminRoutes({ identity, authorizer, adminAccess }).register, {
      prefix: '/admin',
    });
    await denyingApp.ready();

    try {
      const response = await denyingApp.inject({ method: 'GET', url: '/admin/users' });
      expect(response.statusCode).toBe(403);
      expect(errorOf(response)['code']).toBe('PERMISSION_DENIED');
    } finally {
      await denyingApp.close();
      db.close();
    }
  });
});
