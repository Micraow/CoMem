import type { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiKeyRepository } from '../../../src/adapters/sqlite/api-key-repository.js';
import { openDatabase, runMigrations } from '../../../src/adapters/sqlite/database.js';
import { GroupRepository } from '../../../src/adapters/sqlite/group-repository.js';
import { UserRepository } from '../../../src/adapters/sqlite/user-repository.js';
import { ComemError } from '../../../src/domain/errors.js';
import type { Logger } from '../../../src/domain/log.js';
import { IdentityService } from '../../../src/services/identity.js';

const NOW = new Date('2026-11-08T00:00:00.000Z');
const LATER = new Date('2026-11-08T01:00:00.000Z');

let db: DatabaseSync;
let users: UserRepository;
let groups: GroupRepository;
let service: IdentityService;

function createLogger(): Logger {
  const logger: Logger = {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => logger,
  };
  return logger;
}

function expectCode(code: string, run: () => unknown): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ComemError);
    expect((error as ComemError).code).toBe(code);
    return;
  }
  throw new Error(`期望抛出 ${code}`);
}

function createUser(id: string): void {
  service.createUser({ id, displayName: id }, NOW);
}

function createGroup(id: string): void {
  service.createGroup({ id, displayName: id }, NOW);
}

beforeEach(() => {
  db = openDatabase(':memory:');
  runMigrations(db);
  const logger = createLogger();
  users = new UserRepository({ db, logger });
  groups = new GroupRepository({ db, logger });
  const apiKeys = new ApiKeyRepository({ db, logger });
  service = new IdentityService({
    users,
    groups,
    apiKeys,
    namespace: { ensure: async () => {} },
    logger,
  });
});

afterEach(() => {
  db.close();
});

describe('createUser / resolve', () => {
  it('创建后 resolve 返回只有 user principal 的身份', () => {
    const created = service.createUser({ id: 'alice', displayName: 'Alice' }, NOW);

    expect(created.createdAt).toBe(NOW.toISOString());
    expect(created.email).toBeNull();
    expect(created.status).toBe('active');
    expect(service.resolveSubject('user:alice')).toEqual({
      userId: 'alice',
      principals: ['user:alice'],
    });
  });

  it('createUser 不写 ACL 条目（根预置归 bootstrap，§12.6）', () => {
    service.createUser({ id: 'alice', displayName: 'Alice' }, NOW);

    const row = db.prepare('SELECT COUNT(*) AS total FROM acl_entry').get();
    expect(Number(row?.['total'] ?? -1)).toBe(0);
  });

  it('加入两个组后 principals 含两个 group 前缀项且排序稳定', () => {
    createUser('alice');
    createGroup('ops');
    createGroup('eng');
    service.addMember('ops', 'alice', 'member', NOW);
    service.addMember('eng', 'alice', 'member', NOW);

    const identity = service.resolveSubject('user:alice');
    expect(identity?.principals).toEqual(['group:eng', 'group:ops', 'user:alice']);
    // 同一份成员关系重复展开得到同一个数组（可重放）。
    expect(service.resolveSubject('user:alice')?.principals).toEqual(identity?.principals);
  });

  it('resolve 不存在的用户返回 null', () => {
    expect(service.resolveSubject('user:missing')).toBeNull();
  });

  it('resolve 对 disabled 用户返回 null', () => {
    createUser('alice');
    service.updateUser('alice', { status: 'disabled' }, LATER);

    expect(service.resolveSubject('user:alice')).toBeNull();

    service.updateUser('alice', { status: 'active' }, LATER);
    expect(service.resolveSubject('user:alice')).not.toBeNull();
  });

  it('resolve 对畸形主体返回 null 而不是抛错', () => {
    for (const subject of ['bad subject', 'alice', '', 'user:', 'user:alice:extra', 'admin:alice']) {
      expect(service.resolveSubject(subject), subject).toBeNull();
    }
  });

  it('resolve 只接受 user 主体，user:* 不是真实用户', () => {
    createGroup('eng');

    expect(service.resolveSubject('group:eng')).toBeNull();
    expect(service.resolveSubject('user:*')).toBeNull();
  });
});

describe('用户管理', () => {
  it('ID 非法抛 INVALID_ARGUMENT', () => {
    expectCode('INVALID_ARGUMENT', () =>
      service.createUser({ id: 'Alice', displayName: 'Alice' }, NOW),
    );
    expectCode('INVALID_ARGUMENT', () =>
      service.createUser({ id: '_meta', displayName: 'Meta' }, NOW),
    );
  });

  it('重复创建抛 CONFLICT', () => {
    createUser('alice');
    expectCode('CONFLICT', () => service.createUser({ id: 'alice', displayName: 'Alice' }, NOW));
  });

  it('getUser 对 disabled 用户返回 null，listUsers 仍然列出来', () => {
    createUser('alice');
    createUser('bob');
    service.updateUser('bob', { status: 'disabled' }, LATER);

    expect(service.getUser('bob')).toBeNull();
    expect(service.listUsers().map((user) => user.id)).toEqual(['alice', 'bob']);
  });

  it('updateUser 不存在抛 NOT_FOUND', () => {
    expectCode('NOT_FOUND', () => service.updateUser('missing', { displayName: 'X' }, NOW));
  });

  it('deleteUser 不存在抛 NOT_FOUND', () => {
    expectCode('NOT_FOUND', () => service.deleteUser('missing'));
  });

  it('deleteUser 清掉组成员关系，listMembers 里没有该用户', () => {
    createUser('alice');
    createUser('bob');
    createGroup('eng');
    service.addMember('eng', 'alice', 'member', NOW);
    service.addMember('eng', 'bob', 'member', NOW);

    service.deleteUser('alice');

    expect(service.getUser('alice')).toBeNull();
    expect(service.listMembers('eng').map((member) => member.userId)).toEqual(['bob']);
  });

  /**
   * 回归：`app_group.owner_user_id` 是元数据，不是授权（架构文档 §12.2）。
   *
   * 残留的 owner ID 在账号重建后会让 `POST /groups/{id}/owner` 把它当成「当前
   * owner」，跳过组根求权——重建的账号拿到组的管理权，尽管它从未被授予任何东西。
   */
  it('deleteUser 清掉它持有的组 owner，重建同 ID 不会变成当前 owner', () => {
    createUser('alice');
    service.createGroup({ id: 'eng', displayName: 'eng', ownerUserId: 'alice' }, NOW);
    expect(service.getGroup('eng')?.ownerUserId).toBe('alice');

    service.deleteUser('alice');

    expect(service.getGroup('eng')?.ownerUserId).toBeNull();

    // 同 ID 重建：目录行是新的，owner 元数据不能跟着回来。
    createUser('alice');
    expect(service.getGroup('eng')?.ownerUserId).toBeNull();
  });
});

describe('组管理', () => {
  it('ID 非法抛 INVALID_ARGUMENT，重复创建抛 CONFLICT', () => {
    expectCode('INVALID_ARGUMENT', () =>
      service.createGroup({ id: 'Eng', displayName: 'Eng' }, NOW),
    );

    createGroup('eng');
    expectCode('CONFLICT', () => service.createGroup({ id: 'eng', displayName: 'Eng' }, NOW));
  });

  it('getGroup / listGroups / updateGroup', () => {
    createGroup('eng');
    createGroup('ops');

    expect(service.getGroup('missing')).toBeNull();
    expect(service.listGroups().map((group) => group.id)).toEqual(['eng', 'ops']);
    expect(service.updateGroup('eng', { description: '平台' }, LATER)?.description).toBe('平台');
    expectCode('NOT_FOUND', () => service.updateGroup('missing', { description: 'x' }, NOW));
  });

  it('deleteGroup 清掉成员关系，resolve 不再包含该组', () => {
    createUser('alice');
    createGroup('eng');
    createGroup('ops');
    service.addMember('eng', 'alice', 'member', NOW);
    service.addMember('ops', 'alice', 'member', NOW);

    service.deleteGroup('ops');

    expect(service.getGroup('ops')).toBeNull();
    expect(service.resolveSubject('user:alice')?.principals).toEqual(['group:eng', 'user:alice']);
    expectCode('NOT_FOUND', () => service.deleteGroup('ops'));
  });
});

describe('成员管理', () => {
  beforeEach(() => {
    createUser('alice');
    createGroup('eng');
  });

  it('默认角色是 member', () => {
    expect(service.addMember('eng', 'alice', undefined, NOW).role).toBe('member');
  });

  it('addMember 幂等', () => {
    service.addMember('eng', 'alice', 'member', NOW);
    const member = service.addMember('eng', 'alice', 'owner', LATER);

    expect(member.role).toBe('owner');
    expect(service.listMembers('eng')).toHaveLength(1);
  });

  it('组或用户不存在抛 NOT_FOUND', () => {
    expectCode('NOT_FOUND', () => service.addMember('missing', 'alice', 'member', NOW));
    expectCode('NOT_FOUND', () => service.addMember('eng', 'missing', 'member', NOW));
  });

  it('removeMember 对非成员抛 NOT_FOUND', () => {
    expectCode('NOT_FOUND', () => service.removeMember('eng', 'alice'));

    service.addMember('eng', 'alice', 'member', NOW);
    service.removeMember('eng', 'alice');
    expect(service.listMembers('eng')).toEqual([]);
  });

  it('listMembers 对不存在的组抛 NOT_FOUND', () => {
    expectCode('NOT_FOUND', () => service.listMembers('missing'));
  });
});

describe('认证', () => {
  beforeEach(() => {
    createUser('alice');
  });

  it('密码登录展开 user:{uid} 与 group 主体，末尾带通配符', async () => {
    createGroup('eng');
    service.addMember('eng', 'alice', 'member', NOW);
    await service.setPassword('alice', 'correct-password');

    await expect(
      service.resolve({ kind: 'password', username: 'alice', password: 'correct-password' }),
    ).resolves.toEqual({
      subject: 'user:alice',
      principals: ['group:eng', 'user:alice', 'user:*'],
      apiKeyId: null,
    });
  });

  it('密码错误、账号不存在、未设密码都是 UNAUTHENTICATED', async () => {
    await service.setPassword('alice', 'correct-password');
    for (const credential of [
      { kind: 'password' as const, username: 'alice', password: 'wrong' },
      { kind: 'password' as const, username: 'missing', password: 'correct-password' },
      { kind: 'password' as const, username: 'alice', password: '' },
    ]) {
      await expect(service.resolve(credential)).rejects.toMatchObject({
        code: 'UNAUTHENTICATED',
      });
    }
  });

  it('禁用账号即使密码正确也不通过', async () => {
    await service.setPassword('alice', 'correct-password');
    service.updateUser('alice', { status: 'disabled' }, NOW);

    await expect(
      service.resolve({ kind: 'password', username: 'alice', password: 'correct-password' }),
    ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('API Key 认证带出 keyId；撤销后立即失效', async () => {
    const { raw, record } = await service.createApiKey('alice', { name: 'ci' });

    await expect(service.resolve({ kind: 'api-key', apiKey: raw })).resolves.toEqual({
      subject: 'user:alice',
      principals: ['user:alice', 'user:*'],
      apiKeyId: record.id,
    });

    service.revokeApiKey(record.id);
    await expect(service.resolve({ kind: 'api-key', apiKey: raw })).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
  });

  it('过期的 API Key 不通过', async () => {
    const { raw } = await service.createApiKey('alice', {
      name: 'expired',
      expiresAt: new Date(NOW.getTime() - 1000).toISOString(),
    });

    await expect(service.resolve({ kind: 'api-key', apiKey: raw })).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
  });

  it('格式不合法、前缀不存在的 API Key 都是 UNAUTHENTICATED', async () => {
    for (const apiKey of ['comem_bad', 'comem_abcd1234_missing', 'not-a-key']) {
      await expect(service.resolve({ kind: 'api-key', apiKey })).rejects.toMatchObject({
        code: 'UNAUTHENTICATED',
      });
    }
  });

  it('列表不返回明文与哈希', async () => {
    const { raw } = await service.createApiKey('alice', { name: 'ci' });
    const keys = service.listApiKeys('alice');

    expect(keys).toHaveLength(1);
    expect(JSON.stringify(keys)).not.toContain(raw);
    expect(JSON.stringify(keys)).not.toContain('keyHash');
  });

  it('退组立即生效：下一次 resolve 不再包含 group 主体', async () => {
    createGroup('eng');
    service.addMember('eng', 'alice', 'member', NOW);

    const before = await service.resolve({ kind: 'session', userId: 'alice' });
    expect(before.principals).toContain('group:eng');

    service.removeMember('eng', 'alice');
    const after = await service.resolve({ kind: 'session', userId: 'alice' });
    expect(after.principals).not.toContain('group:eng');
  });

  it('删除用户时一并清掉它的 API Key', async () => {
    const { raw } = await service.createApiKey('alice', { name: 'ci' });
    service.deleteUser('alice');

    await expect(service.resolve({ kind: 'api-key', apiKey: raw })).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
  });
});
