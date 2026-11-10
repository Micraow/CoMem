import type { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { openDatabase, runMigrations } from '../../../src/adapters/sqlite/database.js';
import {
  MemoryLinkRepository,
  type MemoryLinkRowInput,
} from '../../../src/adapters/sqlite/memory-link-repository.js';
import type { Logger } from '../../../src/domain/log.js';

let db: DatabaseSync;
let repository: MemoryLinkRepository;

function createLogger(): Logger {
  const logger: Logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return logger;
}

function row(overrides: Partial<MemoryLinkRowInput> = {}): MemoryLinkRowInput {
  return {
    fromUri: 'comem://user/alice/memories/entities/a.md',
    toUri: 'comem://user/alice/memories/entities/b.md',
    linkType: 'references',
    weight: 1,
    matchText: 'see b',
    description: '',
    ...overrides,
  };
}

beforeEach(() => {
  db = openDatabase(':memory:');
  runMigrations(db);
  repository = new MemoryLinkRepository({ db, logger: createLogger() });
});

afterEach(() => {
  db.close();
});

describe('MemoryLinkRepository', () => {
  it('写入一条边后可正向查到', () => {
    const result = repository.upsertMany([row()]);
    expect(result).toEqual({ inserted: 1, merged: 0 });

    const links = repository.linksFrom('comem://user/alice/memories/entities/a.md');
    expect(links).toHaveLength(1);
    expect(links[0]?.toUri.toString()).toBe('comem://user/alice/memories/entities/b.md');
    expect(links[0]?.linkType).toBe('references');
    expect(links[0]?.matchText).toBe('see b');
  });

  it('反查 backlinks：按终点列出所有指向它的边', () => {
    repository.upsertMany([
      row({ fromUri: 'comem://user/alice/memories/entities/a.md' }),
      row({ fromUri: 'comem://user/alice/memories/entities/c.md', matchText: 'also b' }),
    ]);

    const backlinks = repository.backlinksOf('comem://user/alice/memories/entities/b.md');
    expect(backlinks).toHaveLength(2);
    expect(backlinks.map((link) => link.fromUri.toString()).sort()).toEqual([
      'comem://user/alice/memories/entities/a.md',
      'comem://user/alice/memories/entities/c.md',
    ]);
  });

  it('去重键命中时 weight 取 max，不累加', () => {
    repository.upsertMany([row({ weight: 3 })]);
    const second = repository.upsertMany([row({ weight: 5 })]);
    expect(second).toEqual({ inserted: 0, merged: 1 });

    // 更高的再写一次
    repository.upsertMany([row({ weight: 4 })]);
    const links = repository.linksFrom('comem://user/alice/memories/entities/a.md');
    expect(links).toHaveLength(1);
    expect(links[0]?.weight).toBe(5);
  });

  it('同一终点不同 matchText 是两条边', () => {
    repository.upsertMany([row()]);
    repository.upsertMany([row({ matchText: 'different source' })]);
    const links = repository.linksFrom('comem://user/alice/memories/entities/a.md');
    expect(links).toHaveLength(2);
  });

  /**
   * 表的唯一键是三列：`(from_uri, to_uri, match_text)`。
   *
   * `reindex` 重建 `derived_from` 时直接整批 INSERT，去重键必须与这三列一致
   * （`commands/reindex.ts` 的 `derivedEdgeKey`）。今天没有产生端给 `derived_from`
   * 填非空 `match_text`，所以这一格只能在仓储层构造——它是「键少一维会吞边」的地基。
   */
  it('replaceByLinkType：同一 from→to、不同 match_text 的两条边都保留', () => {
    const result = repository.replaceByLinkType('derived_from', [
      row({ linkType: 'derived_from', matchText: '' }),
      row({ linkType: 'derived_from', matchText: 'see b' }),
    ]);

    expect(result).toEqual({ inserted: 2, deleted: 0 });
    expect(repository.linksFrom('comem://user/alice/memories/entities/a.md')).toHaveLength(2);
  });

  it('空批次不改表', () => {
    expect(repository.upsertMany([])).toEqual({ inserted: 0, merged: 0 });
    expect(repository.linksFrom('comem://user/alice/memories/entities/a.md')).toHaveLength(0);
  });
});
