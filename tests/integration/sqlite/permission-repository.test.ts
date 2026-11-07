import type { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { currentVersion, openDatabase, runMigrations } from '../../../src/adapters/sqlite/database.js';
import type { Logger } from '../../../src/domain/log.js';
import {
  PermissionRepository,
  type AclEntryRow,
  type PermissionRow,
} from '../../../src/adapters/sqlite/permission-repository.js';

let db: DatabaseSync;
let repository: PermissionRepository;

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

function permission(
  nodeUri: string,
  principal: string,
  level: 1 | 3 | 7,
  effect: 'allow' | 'deny' = 'allow',
): PermissionRow {
  return { nodeUri, principal, level, effect };
}

function entry(uri: string, principal: string, level: 1 | 3 | 7, effect: 'allow' | 'deny'): AclEntryRow {
  return { uri, principal, level, effect };
}

beforeEach(() => {
  db = openDatabase(':memory:');
  runMigrations(db);
  repository = new PermissionRepository({ db, logger: createLogger() });
});

afterEach(() => {
  db.close();
});

describe('replaceEntries / entriesOf / entriesByPrincipal', () => {
  it('写入后能按节点与主体两个方向反查', () => {
    repository.replaceEntries('comem://user/alice/mem', [
      entry('comem://user/alice/mem', 'user:bob', 1, 'allow'),
      entry('comem://user/alice/mem', 'group:eng', 7, 'allow'),
    ]);

    expect(repository.entriesOf('comem://user/alice/mem')).toEqual([
      { uri: 'comem://user/alice/mem', principal: 'group:eng', level: 7, effect: 'allow' },
      { uri: 'comem://user/alice/mem', principal: 'user:bob', level: 1, effect: 'allow' },
    ]);
    expect(repository.entriesByPrincipal('user:bob')).toEqual([
      { uri: 'comem://user/alice/mem', principal: 'user:bob', level: 1, effect: 'allow' },
    ]);
  });

  it('替换是幂等的：第二次写入不累积', () => {
    const uri = 'comem://user/alice/mem';
    repository.replaceEntries(uri, [entry(uri, 'user:bob', 1, 'allow')]);
    repository.replaceEntries(uri, [entry(uri, 'user:bob', 3, 'allow')]);

    expect(repository.entriesOf(uri)).toEqual([
      { uri, principal: 'user:bob', level: 3, effect: 'allow' },
    ]);
  });

  it('只替换目标节点，不碰其它节点', () => {
    repository.replaceEntries('comem://user/alice/a', [entry('comem://user/alice/a', 'user:bob', 1, 'allow')]);
    repository.replaceEntries('comem://user/alice/b', [entry('comem://user/alice/b', 'user:bob', 1, 'allow')]);
    repository.replaceEntries('comem://user/alice/a', []);

    expect(repository.entriesOf('comem://user/alice/a')).toEqual([]);
    expect(repository.entriesOf('comem://user/alice/b')).toHaveLength(1);
  });

  it('deny 条目也按原样保存', () => {
    repository.replaceEntries('comem://user/alice/a', [
      entry('comem://user/alice/a', 'user:bob', 1, 'deny'),
    ]);

    expect(repository.entriesByPrincipal('user:bob')).toEqual([
      { uri: 'comem://user/alice/a', principal: 'user:bob', level: 1, effect: 'deny' },
    ]);
  });

  it('没有记录时返回空数组', () => {
    expect(repository.entriesOf('comem://user/alice/none')).toEqual([]);
    expect(repository.entriesByPrincipal('user:nobody')).toEqual([]);
  });
});

describe('replaceSubtree', () => {
  it('整棵子树重算：旧行清空，新行写入', () => {
    repository.replaceSubtree('comem://user/alice/dir', [
      permission('comem://user/alice/dir', 'user:alice', 7),
      permission('comem://user/alice/dir/a.md', 'user:alice', 7),
    ]);

    repository.replaceSubtree('comem://user/alice/dir', [
      permission('comem://user/alice/dir', 'group:eng', 3),
      permission('comem://user/alice/dir/b.md', 'group:eng', 3),
    ]);

    expect(
      repository.readableUris(
        ['comem://user/alice/dir', 'comem://user/alice/dir/a.md', 'comem://user/alice/dir/b.md'],
        ['user:alice', 'group:eng'],
      ),
    ).toEqual(new Set(['comem://user/alice/dir', 'comem://user/alice/dir/b.md']));
  });

  it('幂等：同一批写入两次结果相同', () => {
    const rows = [
      permission('comem://user/alice/dir', 'user:alice', 7),
      permission('comem://user/alice/dir/a.md', 'user:alice', 7),
    ];

    repository.replaceSubtree('comem://user/alice/dir', rows);
    repository.replaceSubtree('comem://user/alice/dir', rows);

    const total = db.prepare('SELECT COUNT(*) AS total FROM node_permission').get();
    expect(Number(total?.['total'])).toBe(2);
  });

  it('段边界：重算 alice 不影响 alice2', () => {
    repository.replaceSubtree('comem://user/alice2', [
      permission('comem://user/alice2/a.md', 'user:bob', 1),
    ]);

    repository.replaceSubtree('comem://user/alice', [
      permission('comem://user/alice/a.md', 'user:bob', 1),
    ]);

    expect(repository.readableUris(['comem://user/alice2/a.md'], ['user:bob'])).toEqual(
      new Set(['comem://user/alice2/a.md']),
    );
  });
});

describe('readableUris', () => {
  it('只返回主体命中且 level >= read 的 URI', () => {
    repository.replaceSubtree('comem://user/alice', [
      permission('comem://user/alice/read.md', 'user:alice', 1),
      permission('comem://user/alice/write.md', 'user:alice', 3),
      permission('comem://user/alice/other.md', 'user:bob', 1),
    ]);
    // level 0 不是合法 ACL 级别（§12.1 只有 1 / 3 / 7），直接写库验证 SQL 的
    // `level >= 1` 谓词：物化表里出现 0 时不能被当成 read。
    db.prepare('INSERT INTO node_permission (node_uri, principal, level) VALUES (?, ?, ?)').run(
      'comem://user/alice/zero.md',
      'user:alice',
      0,
    );

    expect(
      repository.readableUris(
        [
          'comem://user/alice/read.md',
          'comem://user/alice/write.md',
          'comem://user/alice/other.md',
          'comem://user/alice/zero.md',
          'comem://user/alice/missing.md',
        ],
        ['user:alice'],
      ),
    ).toEqual(new Set(['comem://user/alice/read.md', 'comem://user/alice/write.md']));
  });

  it('user:* 只匹配调用方显式列入的主体集合', () => {
    repository.replaceSubtree('comem://user/alice', [
      permission('comem://user/alice/a.md', 'user:*', 1),
    ]);

    expect(repository.readableUris(['comem://user/alice/a.md'], ['user:alice'])).toEqual(
      new Set(),
    );
    expect(repository.readableUris(['comem://user/alice/a.md'], ['user:alice', 'user:*'])).toEqual(
      new Set(['comem://user/alice/a.md']),
    );
  });

  it('空输入返回空集合，不产生全表扫描', () => {
    repository.replaceSubtree('comem://user/alice', [
      permission('comem://user/alice/a.md', 'user:alice', 1),
    ]);

    expect(repository.readableUris([], ['user:alice'])).toEqual(new Set());
    expect(repository.readableUris(['comem://user/alice/a.md'], [])).toEqual(new Set());
  });
});

describe('deleteSubtree', () => {
  it('删除子树的两张表，返回物化权限的行数', () => {
    repository.replaceEntries('comem://user/alice/dir/a.md', [
      entry('comem://user/alice/dir/a.md', 'user:bob', 1, 'allow'),
    ]);
    repository.replaceSubtree('comem://user/alice/dir', [
      permission('comem://user/alice/dir', 'user:bob', 1),
      permission('comem://user/alice/dir/a.md', 'user:bob', 1),
    ]);
    repository.replaceSubtree('comem://user/alice/other', [
      permission('comem://user/alice/other/b.md', 'user:bob', 1),
    ]);

    expect(repository.deleteSubtree('comem://user/alice/dir')).toBe(2);
    expect(repository.entriesOf('comem://user/alice/dir/a.md')).toEqual([]);
    expect(repository.readableUris(['comem://user/alice/other/b.md'], ['user:bob'])).toEqual(
      new Set(['comem://user/alice/other/b.md']),
    );
  });

  it('不存在的子树返回 0', () => {
    expect(repository.deleteSubtree('comem://user/alice/missing')).toBe(0);
  });
});

describe('readableUris：deny 优先（§12.2 不变量 2）', () => {
  const DIR = 'comem://user/alice/dir';
  const PUBLIC = `${DIR}/public.md`;
  const BLOCKED = `${DIR}/blocked.md`;
  const DENIED = `${DIR}/denied.md`;

  it('deny 行压掉 user:* 的 allow', () => {
    repository.replaceSubtree(DIR, [
      permission(PUBLIC, 'user:*', 1, 'allow'),
      permission(BLOCKED, 'user:*', 1, 'allow'),
      permission(BLOCKED, 'user:alice', 1, 'deny'),
      // 同一节点同一主体只有一行（主键），deny 行就是「被清空」的表达。
      permission(DENIED, 'user:alice', 1, 'deny'),
    ]);

    expect(repository.readableUris([PUBLIC, BLOCKED, DENIED], ['user:alice', 'user:*'])).toEqual(
      new Set([PUBLIC]),
    );
    // 通配主体本身没有被 deny：bob 通过 user:* 仍然可读这两个节点。
    expect(repository.readableUris([PUBLIC, BLOCKED, DENIED], ['user:bob', 'user:*'])).toEqual(
      new Set([PUBLIC, BLOCKED]),
    );
  });

  it('只有 deny 行、没有 allow 时不可读', () => {
    repository.replaceSubtree(DIR, [permission(DENIED, 'user:alice', 1, 'deny')]);

    expect(repository.readableUris([DENIED], ['user:alice', 'user:*'])).toEqual(new Set());
  });

  it('deny 不跨节点：同一主体的其它节点不受影响', () => {
    repository.replaceSubtree(DIR, [
      permission(PUBLIC, 'user:alice', 1, 'allow'),
      permission(DENIED, 'user:alice', 1, 'deny'),
    ]);

    expect(repository.readableUris([PUBLIC, DENIED], ['user:alice'])).toEqual(new Set([PUBLIC]));
  });
});

describe('迁移 0004：effect 列', () => {
  it('老行（不带 effect 的 INSERT）默认为 allow', () => {
    db.prepare('INSERT INTO node_permission (node_uri, principal, level) VALUES (?, ?, ?)').run(
      'comem://user/alice/legacy.md',
      'user:alice',
      1,
    );

    const row = db
      .prepare('SELECT effect FROM node_permission WHERE node_uri = ?')
      .get('comem://user/alice/legacy.md');
    expect(row?.['effect']).toBe('allow');
    expect(
      repository.readableUris(['comem://user/alice/legacy.md'], ['user:alice']),
    ).toEqual(new Set(['comem://user/alice/legacy.md']));
  });

  it('重复运行迁移不炸，版本号不再前进', () => {
    const applied = runMigrations(db);

    expect(applied).toBeGreaterThanOrEqual(4);
    expect(runMigrations(db)).toBe(applied);
    expect(currentVersion(db)).toBe(applied);
  });
});
