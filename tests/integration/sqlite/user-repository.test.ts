import type { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { openDatabase, runMigrations } from '../../../src/adapters/sqlite/database.js';
import { UserRepository } from '../../../src/adapters/sqlite/user-repository.js';
import { ComemError } from '../../../src/domain/errors.js';
import type { User } from '../../../src/domain/identity.js';
import type { Logger } from '../../../src/domain/log.js';

const NOW = new Date('2026-11-08T00:00:00.000Z');

/** 一小时后。用于断言 `updated_at` 真的被写新，而不是复用了 `created_at`。 */
const LATER = new Date('2026-11-08T01:00:00.000Z');

type UserInput = Omit<User, 'createdAt' | 'updatedAt'>;

let db: DatabaseSync;
let repository: UserRepository;

function createLogger(): Logger {
  const logger: Logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return logger;
}

function input(overrides: Partial<UserInput> = {}): UserInput {
  return {
    id: 'alice',
    displayName: 'Alice',
    email: 'alice@example.com',
    status: 'active',
    ...overrides,
  };
}

beforeEach(() => {
  db = openDatabase(':memory:');
  runMigrations(db);
  repository = new UserRepository({ db, logger: createLogger() });
});

afterEach(() => {
  db.close();
});

describe('create / get', () => {
  it('写入后按 id 读回全部字段，时间来自入参', () => {
    const created = repository.create(input(), NOW);

    expect(created).toEqual({
      id: 'alice',
      displayName: 'Alice',
      email: 'alice@example.com',
      status: 'active',
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    });
    expect(repository.get('alice')).toEqual(created);
  });

  it('email 可以为空', () => {
    repository.create(input({ email: null }), NOW);
    expect(repository.get('alice')?.email).toBeNull();
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

describe('list', () => {
  beforeEach(() => {
    for (const id of ['alice', 'bob', 'carol']) {
      repository.create(input({ id, displayName: id }), NOW);
    }
    repository.create(input({ id: 'dave', status: 'disabled' }), NOW);
  });

  it('默认按 id 升序返回全部', () => {
    expect(repository.list().map((user) => user.id)).toEqual(['alice', 'bob', 'carol', 'dave']);
  });

  it('limit / offset 分页', () => {
    expect(repository.list({ limit: 2, offset: 1 }).map((user) => user.id)).toEqual([
      'bob',
      'carol',
    ]);
  });

  it('按状态过滤', () => {
    expect(repository.list({ status: 'disabled' }).map((user) => user.id)).toEqual(['dave']);
  });
});

describe('update', () => {
  it('只改传了的字段并推进 updated_at', () => {
    repository.create(input(), NOW);

    const updated = repository.update('alice', { displayName: 'Alice Zhang' }, LATER);

    expect(updated).toEqual({
      id: 'alice',
      displayName: 'Alice Zhang',
      email: 'alice@example.com',
      status: 'active',
      createdAt: NOW.toISOString(),
      updatedAt: LATER.toISOString(),
    });
  });

  it('可以把 email 清成 null、把状态改成 disabled', () => {
    repository.create(input(), NOW);

    const updated = repository.update('alice', { email: null, status: 'disabled' }, LATER);

    expect(updated?.email).toBeNull();
    expect(updated?.status).toBe('disabled');
  });

  it('空补丁不写库，updated_at 不变', () => {
    repository.create(input(), NOW);

    expect(repository.update('alice', {}, LATER)?.updatedAt).toBe(NOW.toISOString());
  });

  it('不存在返回 null', () => {
    expect(repository.update('missing', { displayName: 'X' }, NOW)).toBeNull();
  });
});

describe('delete / count', () => {
  it('硬删返回行数，第二次删除返回 0', () => {
    repository.create(input(), NOW);

    expect(repository.delete('alice')).toBe(1);
    expect(repository.get('alice')).toBeNull();
    expect(repository.delete('alice')).toBe(0);
  });

  it('count 反映当前行数', () => {
    expect(repository.count()).toBe(0);
    repository.create(input({ id: 'alice' }), NOW);
    repository.create(input({ id: 'bob' }), NOW);
    expect(repository.count()).toBe(2);
    repository.delete('bob');
    expect(repository.count()).toBe(1);
  });
});
