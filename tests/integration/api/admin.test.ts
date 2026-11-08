import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Fastify, { type FastifyInstance, type InjectOptions } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AclFileStore } from '../../../src/adapters/fs/acl-file.js';
import { openDatabase, runMigrations } from '../../../src/adapters/sqlite/database.js';
import { ApiKeyRepository } from '../../../src/adapters/sqlite/api-key-repository.js';
import { GroupRepository } from '../../../src/adapters/sqlite/group-repository.js';
import { NodeRepository } from '../../../src/adapters/sqlite/node-repository.js';
import { PermissionRepository } from '../../../src/adapters/sqlite/permission-repository.js';
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
import { AclService } from '../../../src/services/acl.js';
import type { Authorizer } from '../../../src/services/authorizer.js';
import { IdentityService } from '../../../src/services/identity.js';

const AUTH_PRINCIPALS: readonly string[] = ['user:alice', 'user:*'];

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
    await container.services.acl.setAcl(child, { mode: 'inherit', entries: [] }, 'user:alice', AUTH_PRINCIPALS);

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

  it('删用户改写 .acl.json：重新物化也不会把授权算回来', async () => {
    await createUser('alice');
    await createUser('bob');
    const aliceRoot = Uri.parse('comem://user/alice');
    await container.services.acl.ensureRootPreset(aliceRoot);
    await container.services.acl.setAcl(
      aliceRoot,
      {
        mode: 'inherit',
        entries: [{ principal: 'user:bob', level: 1, effect: 'allow' }],
      },
      'user:alice', AUTH_PRINCIPALS,
    );

    const aclPath = join(dataDir, 'user', 'alice', '.acl.json');
    expect(await readFile(aclPath, 'utf8')).toContain('user:bob');

    resultOf(await inject({ method: 'DELETE', url: '/api/v1/admin/users/bob' }));

    const onDisk = JSON.parse(await readFile(aclPath, 'utf8')) as {
      readonly entries: readonly { readonly principal: string }[];
    };
    expect(onDisk.entries).toEqual([]);

    // `.acl.json` 是 ACL 的真相：再物化一次，已经撤掉的授权不能回来。
    await container.services.acl.materializeNode(aliceRoot.child('project'));
    expect(
      countRows('SELECT COUNT(*) AS total FROM node_permission WHERE principal = ?', 'user:bob'),
    ).toBe(0);
    expect(
      countRows('SELECT COUNT(*) AS total FROM acl_entry WHERE principal = ?', 'user:bob'),
    ).toBe(0);
  });

  it('删组改写 .acl.json：group 主体不再出现在授权文件里', async () => {
    await createUser('alice');
    await createGroup('eng');
    const aliceRoot = Uri.parse('comem://user/alice');
    await container.services.acl.ensureRootPreset(aliceRoot);
    await container.services.acl.setAcl(
      aliceRoot,
      {
        mode: 'inherit',
        entries: [{ principal: 'group:eng', level: 1, effect: 'allow' }],
      },
      'user:alice', AUTH_PRINCIPALS,
    );

    const aclPath = join(dataDir, 'user', 'alice', '.acl.json');
    expect(await readFile(aclPath, 'utf8')).toContain('group:eng');

    resultOf(await inject({ method: 'DELETE', url: '/api/v1/admin/groups/eng' }));

    const onDisk = JSON.parse(await readFile(aclPath, 'utf8')) as {
      readonly entries: readonly unknown[];
    };
    expect(onDisk.entries).toEqual([]);

    await container.services.acl.materializeNode(aliceRoot.child('project'));
    expect(
      countRows('SELECT COUNT(*) AS total FROM node_permission WHERE principal = ?', 'group:eng'),
    ).toBe(0);
  });

  it('重建同 ID 的用户不继承旧授权（提权回归）', async () => {
    await createUser('alice');
    await createUser('bob');
    const aliceRoot = Uri.parse('comem://user/alice');
    await container.services.acl.ensureRootPreset(aliceRoot);
    await container.services.acl.setAcl(
      aliceRoot,
      {
        mode: 'inherit',
        entries: [{ principal: 'user:bob', level: 3, effect: 'allow' }],
      },
      'user:alice', AUTH_PRINCIPALS,
    );

    await inject({ method: 'DELETE', url: '/api/v1/admin/users/bob' });
    // 同一个 ID 重新建号：如果 `.acl.json` 里那条授权还在，重建的账号会立刻拿回
    // write —— 删账号等于没删。
    await createUser('bob');
    await container.services.acl.materializeNode(aliceRoot.child('project'));

    const listed = resultOf(await inject({ method: 'GET', url: '/api/v1/admin/users' }));
    const bob = (listed['users'] as Record<string, unknown>[]).find((row) => row['id'] === 'bob');
    // 新账号只该拿到自己的命名空间（根 + 四个上下文目录各一行），alice 根下的
    // 那条 `write` 授权必须消失。
    expect(bob?.['permissionCount']).toBe(5);
    const aliceRootUri = aliceRoot.toString();
    expect(
      countRows(
        'SELECT COUNT(*) AS total FROM node_permission WHERE principal = ? AND node_uri = ?',
        'user:bob',
        aliceRootUri,
      ),
    ).toBe(0);
    expect(
      countRows(
        'SELECT COUNT(*) AS total FROM acl_entry WHERE principal = ? AND uri = ?',
        'user:bob',
        aliceRootUri,
      ),
    ).toBe(0);
  });

  /**
   * 提权回归：`mv` 之后删账号必须能撤掉文件里的授权。
   *
   * 修复前 `onNodeMoved` 只重建 `node_permission`，`acl_entry` 在源前缀被
   * `deleteSubtree` 删掉后没有按新 URI 写回。`purgePrincipal` 靠反查表找目录，
   * 找不到就不改 `.acl.json`——同 ID 重建的账号继承旧权限。
   */
  it('mv 之后删账号能撤掉 .acl.json 里的授权，重建同 ID 不继承', async () => {
    await createUser('alice');
    await createUser('bob');
    const from = Uri.parse('comem://user/alice/resources/spec');
    const to = Uri.parse('comem://user/alice/resources/spec-v2');
    await container.services.filesystem.mkdir(from, AUTH_PRINCIPALS);
    await container.services.acl.setAcl(
      from,
      {
        mode: 'inherit',
        entries: [{ principal: 'user:bob', level: 3, effect: 'allow' }],
      },
      'user:alice',
      AUTH_PRINCIPALS,
    );

    await container.services.filesystem.move(from, to, AUTH_PRINCIPALS);
    await container.services.indexObserver.drain();

    // 反查表跟着目录搬到新 URI。
    expect(
      countRows(
        'SELECT COUNT(*) AS total FROM acl_entry WHERE principal = ? AND uri = ?',
        'user:bob',
        to.toString(),
      ),
    ).toBe(1);

    resultOf(await inject({ method: 'DELETE', url: '/api/v1/admin/users/bob' }));
    await createUser('bob');
    // 再物化一次：文件里如果还有授权，物化会把它算回来。
    await container.services.acl.materializeNode(to);

    expect(
      await container.services.acl.check(to, 1, ['user:bob', 'user:*']),
    ).toBe(false);
    const onDisk = JSON.parse(
      await readFile(join(dataDir, 'user', 'alice', 'resources', 'spec-v2', '.acl.json'), 'utf8'),
    ) as { readonly entries: readonly unknown[] };
    expect(onDisk.entries).toEqual([]);
  });

  /**
   * 提权回归：手工改 `.acl.json` 的授权在反查表里没有行。
   *
   * §7 说「人可以直接改元数据文件」，但 `purgePrincipal` 修复前只按 `acl_entry`
   * 找目录。手工加的 `user:bob` 不在表里，删账号时不改文件，同 ID 重建就继承。
   */
  it('手工改 .acl.json 的授权，删账号时也能撤掉（扫描兜底）', async () => {
    await createUser('alice');
    await createUser('bob');
    const directory = Uri.parse('comem://user/alice/memories/manual');
    await container.services.filesystem.mkdir(directory, AUTH_PRINCIPALS);
    const aclPath = join(dataDir, 'user', 'alice', 'memories', 'manual', '.acl.json');
    await writeFile(
      aclPath,
      `${JSON.stringify(
        {
          mode: 'inherit',
          entries: [{ principal: 'user:bob', level: 'write', effect: 'allow' }],
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
    // 前提：反查表里确实没有这一行（否则测的是快路径，不是扫描）。
    expect(
      countRows('SELECT COUNT(*) AS total FROM acl_entry WHERE principal = ?', 'user:bob'),
    ).toBe(0);

    resultOf(await inject({ method: 'DELETE', url: '/api/v1/admin/users/bob' }));

    const onDisk = JSON.parse(await readFile(aclPath, 'utf8')) as {
      readonly entries: readonly unknown[];
    };
    expect(onDisk.entries).toEqual([]);

    await createUser('bob');
    await container.services.acl.materializeNode(directory);
    expect(await container.services.acl.check(directory, 1, ['user:bob', 'user:*'])).toBe(false);
  });

  it('不能删除当前登录用户', async () => {
    const response = await inject({ method: 'DELETE', url: '/api/v1/admin/users/local' });

    expect(response.statusCode).toBe(409);
    expect(errorOf(response)['code']).toBe('CONFLICT');

    // 主体还在：删掉它会让服务继续跑但每个请求 401。
    const listed = resultOf(await inject({ method: 'GET', url: '/api/v1/admin/users' }));
    expect((listed['users'] as Record<string, unknown>[]).map((row) => row['id'])).toContain(
      'local',
    );
  });

  it('不能删除当前主体所属的组', async () => {
    await createGroup('eng');
    await inject({
      method: 'POST',
      url: '/api/v1/admin/groups/eng/members',
      payload: { userId: 'local' },
    });

    const response = await inject({ method: 'DELETE', url: '/api/v1/admin/groups/eng' });

    expect(response.statusCode).toBe(409);
    expect(errorOf(response)['code']).toBe('CONFLICT');

    const listed = resultOf(await inject({ method: 'GET', url: '/api/v1/admin/groups' }));
    expect((listed['groups'] as Record<string, unknown>[]).map((row) => row['id'])).toContain('eng');
  });
});

describe('purgePrincipal 的事务边界', () => {
  it('写 .acl.json 失败时回滚数据库，物化行与反查行保持原样', async () => {
    await createUser('alice');
    await createUser('bob');
    const aliceRoot = Uri.parse('comem://user/alice');
    await container.services.acl.ensureRootPreset(aliceRoot);
    await container.services.acl.setAcl(
      aliceRoot,
      {
        mode: 'inherit',
        entries: [{ principal: 'user:bob', level: 1, effect: 'allow' }],
      },
      'user:alice', AUTH_PRINCIPALS,
    );
    const permissionsBefore = countRows(
      'SELECT COUNT(*) AS total FROM node_permission WHERE principal = ?',
      'user:bob',
    );
    expect(permissionsBefore).toBeGreaterThan(0);

    // 同一份数据库与数据根，只把 `.acl.json` 的写入换成必然失败。
    const aclFile = new AclFileStore({ dataDir, logger: container.logger });
    const acl = new AclService({
      dataDir,
      db: container.db,
      aclFile,
      permissions: new PermissionRepository({ db: container.db, logger: container.logger }),
      nodes: new NodeRepository({ db: container.db, logger: container.logger }),
      logger: container.logger,
    });
    vi.spyOn(aclFile, 'write').mockRejectedValue(new Error('磁盘满'));

    await expect(acl.purgePrincipal('user:bob')).rejects.toThrow('磁盘满');

    // 文件没写成功，数据库必须停在原值：半撤的授权比不撤更难排查。
    expect(
      countRows('SELECT COUNT(*) AS total FROM node_permission WHERE principal = ?', 'user:bob'),
    ).toBe(permissionsBefore);
    expect(
      countRows('SELECT COUNT(*) AS total FROM acl_entry WHERE principal = ?', 'user:bob'),
    ).toBe(1);
  });
});

describe('组的根预置', () => {
  it('建组后 comem://group/{gid}/ 有 ACL 根，创建者拿到 manage，成员有可读范围', async () => {
    await createGroup('eng');

    const aclPath = join(dataDir, 'group', 'eng', '.acl.json');
    expect(JSON.parse(await readFile(aclPath, 'utf8'))).toEqual({
      mode: 'inherit',
      entries: [
        { principal: 'group:eng', level: 'write', effect: 'allow' },
        { principal: 'user:local', level: 'manage', effect: 'allow' },
      ],
    });

    const groupRow = container.db
      .prepare('SELECT level, effect FROM node_permission WHERE node_uri = ? AND principal = ?')
      .get('comem://group/eng', 'group:eng');
    expect(groupRow?.['effect']).toBe('allow');
    expect(Number(groupRow?.['level'])).toBe(3);

    const ownerRow = container.db
      .prepare('SELECT level, effect FROM node_permission WHERE node_uri = ? AND principal = ?')
      .get('comem://group/eng', 'user:local');
    expect(ownerRow?.['effect']).toBe('allow');
    expect(Number(ownerRow?.['level'])).toBe(7);

    // 成员能读到的前提是「组主体在根上有授权」+「成员关系存在」。
    await inject({
      method: 'POST',
      url: '/api/v1/admin/groups/eng/members',
      payload: { userId: 'local' },
    });
    expect(
      countRows(
        'SELECT COUNT(*) AS total FROM group_member WHERE group_id = ? AND user_id = ?',
        'eng',
        'local',
      ),
    ).toBe(1);
  });

  /**
   * 回归：删组再建同 ID 不能留下空 ACL（架构文档 §12.6）。
   *
   * 删组时 `.acl.json` 会被保留（`restricted` 语义需要空文件），只清掉条目。
   * `ensureRootPreset` 修复前按「文件存在吗」判断，重建的组根不会再写
   * `group:{gid}`——组空间对所有人永久空 ACL。
   */
  it('删组再建同 ID：组根重新预置 group 授权', async () => {
    await createGroup('eng');
    resultOf(await inject({ method: 'DELETE', url: '/api/v1/admin/groups/eng' }));

    const aclPath = join(dataDir, 'group', 'eng', '.acl.json');
    const afterDelete = JSON.parse(await readFile(aclPath, 'utf8')) as {
      readonly entries: readonly { readonly principal: string }[];
    };
    // 文件还在，只是 `group:eng` 条目没了。
    expect(afterDelete.entries.some((entry) => entry.principal === 'group:eng')).toBe(false);

    await createGroup('eng');

    const onDisk = JSON.parse(await readFile(aclPath, 'utf8')) as {
      readonly entries: readonly { readonly principal: string; readonly level: string }[];
    };
    expect(onDisk.entries).toEqual(
      expect.arrayContaining([
        { principal: 'group:eng', level: 'write', effect: 'allow' },
        { principal: 'user:local', level: 'manage', effect: 'allow' },
      ]),
    );
    expect(
      countRows(
        'SELECT COUNT(*) AS total FROM node_permission WHERE node_uri = ? AND principal = ?',
        'comem://group/eng',
        'group:eng',
      ),
    ).toBe(1);
  });
});

/**
 * 回归：组根必须有一个 manage 持有者（架构文档 §12.2 不变量 3、§12.6）。
 *
 * 修复前组根只有 `group:{gid} = write`，`levelSatisfies(3, 7)` 为 false，
 * `setAcl` / `getAcl` 对组空间永远 403。
 */
describe('组 owner', () => {
  const GROUP_ROOT = Uri.parse('comem://group/eng');
  const LOCAL_PRINCIPALS = ['user:local', 'user:*'];

  it('创建者能 setAcl；同组普通成员 setAcl 得到 403', async () => {
    await createUser('alice');
    await createGroup('eng');

    expect(await container.services.acl.check(GROUP_ROOT, 7, LOCAL_PRINCIPALS)).toBe(true);
    await container.services.acl.setAcl(
      GROUP_ROOT,
      {
        mode: 'inherit',
        entries: [{ principal: 'group:eng', level: 3, effect: 'allow' }],
      },
      'user:local',
      LOCAL_PRINCIPALS,
    );

    await inject({
      method: 'POST',
      url: '/api/v1/admin/groups/eng/members',
      payload: { userId: 'alice' },
    });
    const alicePrincipals = ['user:alice', 'group:eng', 'user:*'];
    expect(await container.services.acl.check(GROUP_ROOT, 3, alicePrincipals)).toBe(true);
    expect(await container.services.acl.check(GROUP_ROOT, 7, alicePrincipals)).toBe(false);

    await expect(
      container.services.acl.setAcl(
        GROUP_ROOT,
        { mode: 'inherit', entries: [] },
        'user:alice',
        alicePrincipals,
      ),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });

  it('改 owner：当前 owner 可以改，改完之后原 owner 失去 manage', async () => {
    await createUser('alice');
    await createGroup('eng');

    const updated = resultOf(
      await inject({
        method: 'POST',
        url: '/api/v1/admin/groups/eng/owner',
        payload: { userId: 'alice' },
      }),
    );
    expect((updated['group'] as Record<string, unknown>)['ownerUserId']).toBe('alice');

    const aclPath = join(dataDir, 'group', 'eng', '.acl.json');
    const onDisk = JSON.parse(await readFile(aclPath, 'utf8')) as {
      readonly entries: readonly { readonly principal: string; readonly level: string }[];
    };
    expect(onDisk.entries).toEqual(
      expect.arrayContaining([
        { principal: 'user:alice', level: 'manage', effect: 'allow' },
        { principal: 'group:eng', level: 'write', effect: 'allow' },
      ]),
    );
    expect(onDisk.entries.some((entry) => entry.principal === 'user:local')).toBe(false);

    // local 已经不是 owner，组根也没有 manage 条目 → 不能再改回去。
    const denied = await inject({
      method: 'POST',
      url: '/api/v1/admin/groups/eng/owner',
      payload: { userId: 'local' },
    });
    expect(denied.statusCode).toBe(403);
    expect(errorOf(denied)['code']).toBe('PERMISSION_DENIED');
  });

  it('owner 指向不存在的用户返回 404', async () => {
    await createGroup('eng');
    const response = await inject({
      method: 'POST',
      url: '/api/v1/admin/groups/eng/owner',
      payload: { userId: 'missing' },
    });
    expect(response.statusCode).toBe(404);
    expect(errorOf(response)['code']).toBe('NOT_FOUND');
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
      apiKeys: new ApiKeyRepository({ db, logger }),
      namespace: { ensure: async () => {} },
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
    };
    const acl = {
      ensureRootPreset: async () => ({ entries: [], ownerMissing: false }),
      setGroupOwner: async () => {},
      purgePrincipal: async () => 0,
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
    denyingApp.register(createAdminRoutes({ identity, authorizer, adminAccess, acl }).register, {
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
