import type { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
  service = new IdentityService({ users, groups, logger });
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
    expect(service.resolve('user:alice')).toEqual({
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

    const identity = service.resolve('user:alice');
    expect(identity?.principals).toEqual(['group:eng', 'group:ops', 'user:alice']);
    // 同一份成员关系重复展开得到同一个数组（可重放）。
    expect(service.resolve('user:alice')?.principals).toEqual(identity?.principals);
  });

  it('resolve 不存在的用户返回 null', () => {
    expect(service.resolve('user:missing')).toBeNull();
  });

  it('resolve 对 disabled 用户返回 null', () => {
    createUser('alice');
    service.updateUser('alice', { status: 'disabled' }, LATER);

    expect(service.resolve('user:alice')).toBeNull();

    service.updateUser('alice', { status: 'active' }, LATER);
    expect(service.resolve('user:alice')).not.toBeNull();
  });

  it('resolve 对畸形主体返回 null 而不是抛错', () => {
    for (const subject of ['bad subject', 'alice', '', 'user:', 'user:alice:extra', 'admin:alice']) {
      expect(service.resolve(subject), subject).toBeNull();
    }
  });

  it('resolve 只接受 user 主体，user:* 不是真实用户', () => {
    createGroup('eng');

    expect(service.resolve('group:eng')).toBeNull();
    expect(service.resolve('user:*')).toBeNull();
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
    expect(service.resolve('user:alice')?.principals).toEqual(['group:eng', 'user:alice']);
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
