import type { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiKeyRepository } from '../../../src/adapters/sqlite/api-key-repository.js';
import { openDatabase, runMigrations } from '../../../src/adapters/sqlite/database.js';
import { GroupRepository } from '../../../src/adapters/sqlite/group-repository.js';
import { UserRepository } from '../../../src/adapters/sqlite/user-repository.js';
import type { Logger } from '../../../src/domain/log.js';

const NOW = new Date('2026-11-08T00:00:00.000Z');

let db: DatabaseSync;
let users: UserRepository;
let groups: GroupRepository;
let apiKeys: ApiKeyRepository;

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

function count(sql: string, ...params: readonly string[]): number {
  return Number(db.prepare(sql).get(...params)?.['total'] ?? 0);
}

beforeEach(() => {
  db = openDatabase(':memory:');
  runMigrations(db);
  const logger = createLogger();
  users = new UserRepository({ db, logger });
  groups = new GroupRepository({ db, logger });
  apiKeys = new ApiKeyRepository({ db, logger });
});

afterEach(() => {
  db.close();
});

/** 一个用户、一个组、一条成员关系、一把 API Key。 */
function seed(): void {
  users.create({ id: 'alice', displayName: 'Alice', email: null, status: 'active' }, NOW);
  groups.create({ id: 'eng', displayName: 'eng', description: null, ownerUserId: 'alice' }, NOW);
  groups.addMember('eng', 'alice', 'member', NOW);
  apiKeys.create(
    { id: 'key_abcd1234', userId: 'alice', keyHash: 'hash', prefix: 'abcd1234', name: 'ci', expiresAt: null },
    NOW,
  );
}

/**
 * 回归：`group_member` / `api_key` 的 `user_id` / `group_id` 没有外键（迁移 0017
 * 之前）。仓储是公开入口，任何调用方都能直接 `DELETE FROM app_user` 绕过
 * `IdentityService.deleteUser` 的清理；孤儿行的后果是同 ID 重建的用户**立刻**
 * 获得 `group:{gid}` 主体，继承那个组的全部 ACL（架构文档 §12.2）。
 */
describe('group_member / api_key 的外键', () => {
  it('连接级 PRAGMA 已打开，迁移后 foreign_key_check 为空', () => {
    seed();

    expect(db.prepare('PRAGMA foreign_keys').get()).toMatchObject({ foreign_keys: 1 });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('直接删用户行时级联清掉成员关系与 API Key，重建同 ID 不再继承', () => {
    seed();
    expect(
      count('SELECT COUNT(*) AS total FROM group_member WHERE user_id = ?', 'alice'),
    ).toBe(1);
    expect(count('SELECT COUNT(*) AS total FROM api_key WHERE user_id = ?', 'alice')).toBe(1);

    // 绕过 `IdentityService.deleteUser`，直接用仓储删行。
    users.delete('alice');

    expect(
      count('SELECT COUNT(*) AS total FROM group_member WHERE user_id = ?', 'alice'),
    ).toBe(0);
    expect(count('SELECT COUNT(*) AS total FROM api_key WHERE user_id = ?', 'alice')).toBe(0);

    // 同 ID 重建：没有成员关系可继承，也没有可用的旧 key。
    users.create({ id: 'alice', displayName: 'Alice', email: null, status: 'active' }, NOW);
    expect(groups.listGroupIdsOfUser('alice')).toEqual([]);
    expect(apiKeys.listByUser('alice')).toEqual([]);
  });

  it('直接删组行时级联清掉成员关系', () => {
    seed();

    groups.delete('eng');

    expect(count('SELECT COUNT(*) AS total FROM group_member WHERE group_id = ?', 'eng')).toBe(0);
  });

  it('写入不存在的用户或组被外键拒绝', () => {
    users.create({ id: 'alice', displayName: 'Alice', email: null, status: 'active' }, NOW);
    groups.create({ id: 'eng', displayName: 'eng', description: null, ownerUserId: null }, NOW);

    expect(() => groups.addMember('missing', 'alice', 'member', NOW)).toThrow(
      /FOREIGN KEY constraint failed/u,
    );
    expect(() => groups.addMember('eng', 'missing', 'member', NOW)).toThrow(
      /FOREIGN KEY constraint failed/u,
    );
    expect(() =>
      apiKeys.create(
        {
          id: 'key_missing0',
          userId: 'missing',
          keyHash: 'hash',
          prefix: 'missing0',
          name: 'ci',
          expiresAt: null,
        },
        NOW,
      ),
    ).toThrow(/FOREIGN KEY constraint failed/u);
  });
});
