import type { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { openDatabase, runMigrations } from '../../../src/adapters/sqlite/database.js';
import { NodeRepository, type NodeRow } from '../../../src/adapters/sqlite/node-repository.js';
import type { Logger } from '../../../src/domain/log.js';

let db: DatabaseSync;
let repository: NodeRepository;

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

function parentOf(uri: string): string {
  return uri.slice(0, uri.lastIndexOf('/'));
}

function row(uri: string, overrides: Partial<NodeRow> = {}): NodeRow {
  return {
    uri,
    parentUri: parentOf(uri),
    scope: 'user',
    kind: 'document',
    contextType: 'memory',
    memoryType: null,
    level: 'L2',
    abstract: null,
    bodyDigest: '0000000000000000',
    size: 1,
    updatedAt: '2026-11-08T00:00:00.000Z',
    status: 'active',
    ...overrides,
  };
}

function uris(rows: readonly NodeRow[]): string[] {
  return rows.map((item) => item.uri);
}

beforeEach(() => {
  db = openDatabase(':memory:');
  runMigrations(db);
  repository = new NodeRepository({ db, logger: createLogger() });
});

afterEach(() => {
  db.close();
});

describe('upsert / get', () => {
  it('写入后按 uri 读回全部字段', () => {
    const input = row('comem://user/alice/mem/design.md', {
      contextType: 'memory',
      memoryType: 'entities',
      level: 'L1',
      abstract: '数据库设计',
      bodyDigest: 'abcdef0123456789',
      size: 42,
      status: 'pending',
    });

    repository.upsert([input]);

    expect(repository.get(input.uri)).toEqual(input);
  });

  it('同一 URI 写两次是覆盖，不是插入', () => {
    repository.upsert([row('comem://user/alice/a.md', { abstract: '第一版' })]);
    repository.upsert([row('comem://user/alice/a.md', { abstract: '第二版', status: 'archived' })]);

    expect(repository.count()).toBe(1);
    expect(repository.get('comem://user/alice/a.md')).toMatchObject({
      abstract: '第二版',
      status: 'archived',
    });
  });

  it('空数组是合法的空操作', () => {
    repository.upsert([]);

    expect(repository.count()).toBe(0);
  });

  it('不存在的 URI 返回 null', () => {
    expect(repository.get('comem://user/alice/missing.md')).toBeNull();
  });

  it('批量写入在一个事务里：中途失败整批回滚', () => {
    // `level` 是 NOT NULL 列。故意传 null 让第二条写入失败，验证第一条也被回滚。
    const failing = row('comem://user/alice/b.md', {
      level: null as unknown as NodeRow['level'],
    });

    expect(() => {
      repository.upsert([row('comem://user/alice/a.md'), failing]);
    }).toThrow();

    expect(repository.count()).toBe(0);
  });
});

describe('children', () => {
  it('只返回直接子节点，按 name 升序', () => {
    repository.upsert([
      row('comem://user/alice/dir/b.md'),
      row('comem://user/alice/dir/a.md'),
      row('comem://user/alice/dir/c.md'),
      row('comem://user/alice/dir/nested/d.md'),
      row('comem://user/alice/other.md'),
    ]);

    expect(uris(repository.children('comem://user/alice/dir'))).toEqual([
      'comem://user/alice/dir/a.md',
      'comem://user/alice/dir/b.md',
      'comem://user/alice/dir/c.md',
    ]);
  });

  it('没有子节点返回空数组', () => {
    expect(repository.children('comem://user/alice/empty')).toEqual([]);
  });
});

describe('descendants', () => {
  it('返回整棵子树，不含自身，按 uri 升序', () => {
    repository.upsert([
      row('comem://user/alice/dir/nested/deep/d.md'),
      row('comem://user/alice/dir/b.md'),
      row('comem://user/alice/dir/a.md'),
    ]);

    expect(uris(repository.descendants('comem://user/alice/dir'))).toEqual([
      'comem://user/alice/dir/a.md',
      'comem://user/alice/dir/b.md',
      'comem://user/alice/dir/nested/deep/d.md',
    ]);
  });

  it('按段边界匹配：alice 不包含 alice2', () => {
    repository.upsert([
      row('comem://user/alice/dir/a.md'),
      row('comem://user/alice/dir2/b.md'),
      row('comem://user/alice/dir.x/c.md'),
    ]);

    expect(uris(repository.descendants('comem://user/alice/dir'))).toEqual([
      'comem://user/alice/dir/a.md',
    ]);
  });

  it('下划线是字面量而不是通配', () => {
    repository.upsert([
      row('comem://user/alice/my_dir/a.md'),
      row('comem://user/alice/myXdir/b.md'),
    ]);

    expect(uris(repository.descendants('comem://user/alice/my_dir'))).toEqual([
      'comem://user/alice/my_dir/a.md',
    ]);
  });

  it('百分号是字面量而不是通配', () => {
    repository.upsert([
      row('comem://user/alice/50%off/a.md'),
      row('comem://user/alice/50Xoff/b.md'),
    ]);

    expect(uris(repository.descendants('comem://user/alice/50%off'))).toEqual([
      'comem://user/alice/50%off/a.md',
    ]);
  });

  it('大小写敏感：Alice 不包含 alice', () => {
    repository.upsert([
      row('comem://user/alice/a.md'),
      row('comem://user/Alice/b.md'),
    ]);

    expect(uris(repository.descendants('comem://user/alice'))).toEqual([
      'comem://user/alice/a.md',
    ]);
    expect(uris(repository.descendants('comem://user/Alice'))).toEqual([
      'comem://user/Alice/b.md',
    ]);
  });
});

describe('deleteTree', () => {
  it('删除自身与子树，返回删除行数', () => {
    repository.upsert([
      row('comem://user/alice/dir/a.md'),
      row('comem://user/alice/dir/nested/b.md'),
      row('comem://user/alice/other.md'),
    ]);

    expect(repository.deleteTree('comem://user/alice/dir')).toBe(2);
    expect(repository.get('comem://user/alice/dir/a.md')).toBeNull();
    expect(repository.get('comem://user/alice/other.md')).not.toBeNull();
    expect(repository.count()).toBe(1);
  });

  it('不存在的子树返回 0', () => {
    expect(repository.deleteTree('comem://user/alice/missing')).toBe(0);
  });

  it('段边界：alice 不删 alice2', () => {
    repository.upsert([
      row('comem://user/alice/a.md'),
      row('comem://user/alice2/b.md'),
    ]);

    expect(repository.deleteTree('comem://user/alice')).toBe(1);
    expect(repository.get('comem://user/alice2/b.md')).not.toBeNull();
  });
});

describe('listByScope', () => {
  it('命中自身与子树', () => {
    repository.upsert([
      row('comem://user/alice/a.md'),
      row('comem://user/alice/dir/b.md'),
      row('comem://user/alice2/c.md'),
    ]);

    expect(uris(repository.listByScope('comem://user/alice'))).toEqual([
      'comem://user/alice/a.md',
      'comem://user/alice/dir/b.md',
    ]);
  });

  it('limit 生效', () => {
    repository.upsert([
      row('comem://user/alice/a.md'),
      row('comem://user/alice/b.md'),
      row('comem://user/alice/c.md'),
    ]);

    expect(repository.listByScope('comem://user/alice', { limit: 2 })).toHaveLength(2);
  });
});

describe('count', () => {
  it('空库返回 0，写入后返回行数', () => {
    expect(repository.count()).toBe(0);

    repository.upsert([row('comem://user/alice/a.md'), row('comem://user/alice/b.md')]);

    expect(repository.count()).toBe(2);
  });
});
