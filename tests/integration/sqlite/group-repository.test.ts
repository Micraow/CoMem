import type { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { openDatabase, runMigrations } from '../../../src/adapters/sqlite/database.js';
import { GroupRepository } from '../../../src/adapters/sqlite/group-repository.js';
import { ComemError } from '../../../src/domain/errors.js';
import type { Group } from '../../../src/domain/identity.js';
import type { Logger } from '../../../src/domain/log.js';

const NOW = new Date('2026-11-08T00:00:00.000Z');
const LATER = new Date('2026-11-08T01:00:00.000Z');

type GroupInput = Omit<Group, 'createdAt' | 'updatedAt'>;

let db: DatabaseSync;
let repository: GroupRepository;

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

function input(overrides: Partial<GroupInput> = {}): GroupInput {
  return {
    id: 'eng',
    displayName: 'Engineering',
    description: '平台工程组',
    ownerUserId: null,
    ...overrides,
  };
}

/** 建组的简写：成员关系测试只关心组存在，不关心字段。 */
function createGroup(id: string): void {
  repository.create(input({ id, displayName: id }), NOW);
}

beforeEach(() => {
  db = openDatabase(':memory:');
  runMigrations(db);
  repository = new GroupRepository({ db, logger: createLogger() });
});

afterEach(() => {
  db.close();
});

describe('create / get', () => {
  it('写入后按 id 读回全部字段，时间来自入参', () => {
    const created = repository.create(input(), NOW);

    expect(created).toEqual({
      id: 'eng',
      displayName: 'Engineering',
      description: '平台工程组',
      ownerUserId: null,
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    });
    expect(repository.get('eng')).toEqual(created);
  });

  it('description 可以为空', () => {
    repository.create(input({ description: null }), NOW);
    expect(repository.get('eng')?.description).toBeNull();
  });

  it('不存在返回 null', () => {
    expect(repository.get('missing')).toBeNull();
  });

  it('同一 id 重复创建抛 CONFLICT', () => {
    repository.create(input(), NOW);
    try {
      repository.create(input(), LATER);
    } catch (error) {
      expect(error).toBeInstanceOf(ComemError);
      expect((error as ComemError).code).toBe('CONFLICT');
      return;
    }
    throw new Error('期望抛出 ComemError');
  });
});

describe('list / update / delete / count', () => {
  it('list 按 id 升序并支持分页', () => {
    for (const id of ['ops', 'eng', 'design']) {
      createGroup(id);
    }
    expect(repository.list().map((group) => group.id)).toEqual(['design', 'eng', 'ops']);
    expect(repository.list({ limit: 1, offset: 1 }).map((group) => group.id)).toEqual(['eng']);
  });

  it('update 只改传了的字段并推进 updated_at', () => {
    repository.create(input(), NOW);

    const updated = repository.update('eng', { description: null }, LATER);

    expect(updated?.description).toBeNull();
    expect(updated?.updatedAt).toBe(LATER.toISOString());
  });

  it('update 不存在返回 null', () => {
    expect(repository.update('missing', { displayName: 'X' }, NOW)).toBeNull();
  });

  it('setOwner 写 owner 并推进 updated_at；不存在的组返回 null', () => {
    repository.create(input(), NOW);

    const updated = repository.setOwner('eng', 'alice', LATER);

    expect(updated?.ownerUserId).toBe('alice');
    expect(updated?.updatedAt).toBe(LATER.toISOString());
    expect(repository.setOwner('missing', 'alice', NOW)).toBeNull();
  });

  it('delete 返回行数，count 反映当前行数', () => {
    createGroup('eng');
    createGroup('ops');
    expect(repository.count()).toBe(2);
    expect(repository.delete('eng')).toBe(1);
    expect(repository.delete('eng')).toBe(0);
    expect(repository.count()).toBe(1);
  });
});

describe('addMember', () => {
  beforeEach(() => {
    createGroup('eng');
    createGroup('ops');
  });

  it('写入成员关系', () => {
    const member = repository.addMember('eng', 'alice', 'owner', NOW);

    expect(member).toEqual({
      groupId: 'eng',
      userId: 'alice',
      role: 'owner',
      addedAt: NOW.toISOString(),
    });
  });

  it('幂等：同一个人加两次只有一行，role 更新，added_at 保持第一次', () => {
    repository.addMember('eng', 'alice', 'member', NOW);
    const second = repository.addMember('eng', 'alice', 'owner', LATER);

    expect(repository.listMembers('eng')).toHaveLength(1);
    expect(second.role).toBe('owner');
    expect(second.addedAt).toBe(NOW.toISOString());
  });

  it('listMembers 按 user_id 升序', () => {
    repository.addMember('eng', 'carol', 'member', NOW);
    repository.addMember('eng', 'alice', 'member', NOW);
    repository.addMember('eng', 'bob', 'member', NOW);

    expect(repository.listMembers('eng').map((member) => member.userId)).toEqual([
      'alice',
      'bob',
      'carol',
    ]);
  });

  it('listGroupIdsOfUser 返回用户加入的组，按组 ID 升序', () => {
    repository.addMember('eng', 'alice', 'member', NOW);
    repository.addMember('ops', 'alice', 'member', NOW);
    repository.addMember('ops', 'bob', 'member', NOW);

    expect(repository.listGroupIdsOfUser('alice')).toEqual(['eng', 'ops']);
    expect(repository.listGroupIdsOfUser('missing')).toEqual([]);
  });

  it('removeMember 返回行数，第二次返回 0', () => {
    repository.addMember('eng', 'alice', 'member', NOW);

    expect(repository.removeMember('eng', 'alice')).toBe(1);
    expect(repository.removeMember('eng', 'alice')).toBe(0);
    expect(repository.listMembers('eng')).toEqual([]);
  });
});

describe('批量删除成员关系', () => {
  beforeEach(() => {
    createGroup('eng');
    createGroup('ops');
    repository.addMember('eng', 'alice', 'member', NOW);
    repository.addMember('ops', 'alice', 'member', NOW);
    repository.addMember('ops', 'bob', 'member', NOW);
  });

  it('removeMembershipsOfUser 清掉该用户的全部行，不碰别人', () => {
    expect(repository.removeMembershipsOfUser('alice')).toBe(2);

    expect(repository.listGroupIdsOfUser('alice')).toEqual([]);
    expect(repository.listMembers('ops').map((member) => member.userId)).toEqual(['bob']);
  });

  it('removeMembershipsOfGroup 清掉该组的全部行，不碰别的组', () => {
    expect(repository.removeMembershipsOfGroup('ops')).toBe(2);

    expect(repository.listMembers('ops')).toEqual([]);
    expect(repository.listGroupIdsOfUser('alice')).toEqual(['eng']);
  });

  it('delete 不级联删成员关系（由服务层显式清理）', () => {
    expect(repository.delete('eng')).toBe(1);

    // 迁移 0008 不建外键：删组只删组本身，孤儿行由 IdentityService.deleteGroup 清。
    expect(repository.listMembers('eng')).toHaveLength(1);
  });
});
