import type { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { openDatabase, runMigrations } from '../../../src/adapters/sqlite/database.js';
import { NodeRepository, type NodeAccessStats, type NodeRow } from '../../../src/adapters/sqlite/node-repository.js';
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

function urisOf(stats: readonly NodeAccessStats[]): string[] {
  return stats.map((item) => item.uri);
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

describe('recordAccess', () => {
  const A = 'comem://user/alice/a.md';
  const B = 'comem://user/alice/b.md';
  const C = 'comem://user/alice/c.md';
  const AT = new Date('2026-11-08T12:00:00.000Z');

  beforeEach(() => {
    repository.upsert([row(A), row(B), row(C)]);
  });

  it('批量累加访问计数并写入最近访问时间', () => {
    expect(repository.recordAccess([A, B], AT)).toBe(2);

    expect(repository.readAccessStats([A, B])).toEqual([
      { uri: A, accessCount: 1, lastAccessedAt: AT.toISOString() },
      { uri: B, accessCount: 1, lastAccessedAt: AT.toISOString() },
    ]);
  });

  it('重复调用是累加，不是覆盖', () => {
    const later = new Date('2026-11-09T12:00:00.000Z');

    repository.recordAccess([A], AT);
    repository.recordAccess([A], AT);
    repository.recordAccess([A], later);

    expect(repository.readAccessStats([A])).toEqual([
      { uri: A, accessCount: 3, lastAccessedAt: later.toISOString() },
    ]);
  });

  it('一批只开一个写事务', () => {
    const exec = vi.spyOn(db, 'exec');

    repository.recordAccess([A, B, C], AT);

    const begins = exec.mock.calls.filter(([sql]) => String(sql).startsWith('BEGIN'));
    expect(begins).toHaveLength(1);
    // 50 条命中是 50 次 UPDATE、1 次事务；逐个 UPDATE 各自开事务是它要避免的。
    expect(exec.mock.calls.some(([sql]) => String(sql).startsWith('COMMIT'))).toBe(true);

    exec.mockRestore();
  });

  it('不修改 updated_at：访问不是内容变更', () => {
    const before = repository.get(A)?.updatedAt;

    repository.recordAccess([A], AT);

    expect(repository.get(A)?.updatedAt).toBe(before);
  });

  it('不存在的 URI 静默跳过，返回实际命中行数', () => {
    expect(repository.recordAccess([A, 'comem://user/alice/missing.md'], AT)).toBe(1);

    expect(repository.readAccessStats([A])[0]?.accessCount).toBe(1);
  });

  it('空数组是合法的空操作', () => {
    expect(repository.recordAccess([], AT)).toBe(0);
  });

  it('非法 Date 抛 INVALID_ARGUMENT', () => {
    expect(() => repository.recordAccess([A], new Date(Number.NaN))).toThrowError(
      expect.objectContaining({ code: 'INVALID_ARGUMENT' }),
    );
    expect(repository.readAccessStats([A])[0]?.accessCount).toBe(0);
  });
});

describe('readAccessStats', () => {
  const A = 'comem://user/alice/a.md';
  const B = 'comem://user/alice/b.md';
  const AT = new Date('2026-11-08T12:00:00.000Z');

  beforeEach(() => {
    repository.upsert([row(A), row(B)]);
  });

  it('从没访问过时 accessCount 是 0，lastAccessedAt 是 null', () => {
    expect(repository.readAccessStats([A])).toEqual([
      { uri: A, accessCount: 0, lastAccessedAt: null },
    ]);
  });

  it('按入参顺序返回', () => {
    repository.recordAccess([A], AT);

    expect(urisOf(repository.readAccessStats([B, A]))).toEqual([B, A]);
  });

  it('不在索引里的 URI 不返回（不补一条 0）', () => {
    expect(repository.readAccessStats([A, 'comem://user/alice/missing.md'])).toHaveLength(1);
  });

  it('空数组返回空结果，不查库', () => {
    const prepare = vi.spyOn(db, 'prepare');

    expect(repository.readAccessStats([])).toEqual([]);
    // 空 IN () 是语法错误；空入参必须在拼 SQL 之前返回。
    expect(prepare).not.toHaveBeenCalled();

    prepare.mockRestore();
  });
});

/**
 * 一个目录在 `node` 里最多两行：L0 摘要行（节点自身）与 L1 概览行
 * （`0004_node_level_rows.sql`）。按 URI 读节点的路径必须只看到节点自身那一行，
 * 否则「一个目录」会变成两条节点。
 */
describe('目录的 L1 概览行不是独立节点', () => {
  const DIR = 'comem://user/alice/mem';
  const CHILD = `${DIR}/a.md`;
  const AT = new Date('2026-11-08T12:00:00.000Z');

  function directoryRow(level: 'L0' | 'L1', abstract: string | null): NodeRow {
    return row(DIR, { kind: 'directory', level, abstract });
  }

  beforeEach(() => {
    repository.upsert([
      directoryRow('L0', '团队约定'),
      directoryRow('L1', '团队约定'),
      row(CHILD),
    ]);
  });

  it('两行同时存在：conflict 键是 (uri, level)，写一行不覆盖另一行', () => {
    const levels = db
      .prepare('SELECT level FROM node WHERE uri = ? ORDER BY level ASC')
      .all(DIR)
      .map((item) => String(item['level']));
    expect(levels).toEqual(['L0', 'L1']);
  });

  it('get 返回节点自身那一行（L0）', () => {
    expect(repository.get(DIR)?.level).toBe('L0');
    expect(repository.get(DIR)?.abstract).toBe('团队约定');
  });

  it('children / descendants / listByScope / count 都只算一个节点', () => {
    expect(uris(repository.children(DIR))).toEqual([CHILD]);
    expect(uris(repository.descendants('comem://user/alice'))).toEqual([CHILD, DIR].sort());
    expect(uris(repository.listByScope('comem://user/alice'))).toEqual([CHILD, DIR].sort());
    expect(repository.count()).toBe(2);
  });

  it('recordAccess 只累加节点自身那一行', () => {
    repository.recordAccess([DIR], AT);

    const counts = db
      .prepare('SELECT level, access_count FROM node WHERE uri = ? ORDER BY level ASC')
      .all(DIR)
      .map((item) => [String(item['level']), Number(item['access_count'])]);
    expect(counts).toEqual([
      ['L0', 1],
      ['L1', 0],
    ]);
    expect(repository.readAccessStats([DIR])).toEqual([
      { uri: DIR, accessCount: 1, lastAccessedAt: AT.toISOString() },
    ]);
  });

  it('setExpiry 写两行，sweepExpired 只按 URI 返回一次、归档两行', () => {
    repository.setExpiry([DIR], new Date('2026-11-07T00:00:00.000Z'));

    expect(repository.sweepExpired(AT, 10)).toEqual([DIR]);
    const statuses = db
      .prepare('SELECT status FROM node WHERE uri = ? ORDER BY level ASC')
      .all(DIR)
      .map((item) => String(item['status']));
    // 只归档 L0 会让目录继续从概览正文里被检索到。
    expect(statuses).toEqual(['archived', 'archived']);
  });

  it('deleteTree 连子项一起删，目录的两行都在其中', () => {
    // 2 行目录 + 1 个子文件
    expect(repository.deleteTree(DIR)).toBe(3);
    expect(repository.get(DIR)).toBeNull();
    expect(repository.get(CHILD)).toBeNull();
  });
});
