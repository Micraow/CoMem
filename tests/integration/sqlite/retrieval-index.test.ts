import type { DatabaseSync, SQLInputValue, SQLOutputValue } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { openDatabase, runMigrations } from '../../../src/adapters/sqlite/database.js';
import { SqliteFtsIndex } from '../../../src/adapters/sqlite/retrieval-index.js';
import type { Logger } from '../../../src/domain/log.js';
import type {
  GlobQuery,
  IndexRecord,
  SearchHit,
  SearchQuery,
} from '../../../src/domain/retrieval.js';

const SCOPE = 'comem://user/alice';
const DOC = 'comem://user/alice/mem/design.md';

let db: DatabaseSync;
let index: SqliteFtsIndex;

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

function record(uri: string, content: string, overrides: Partial<IndexRecord> = {}): IndexRecord {
  return {
    uri,
    parentUri: uri.slice(0, uri.lastIndexOf('/')),
    scope: uri.startsWith('comem://group/') ? 'group' : 'user',
    kind: 'document',
    contextType: 'memory',
    memoryType: null,
    level: 'L2',
    abstract: null,
    content,
    bodyDigest: '0000000000000000',
    size: Buffer.byteLength(content),
    updatedAt: '2026-11-08T00:00:00.000Z',
    status: 'active',
    ...overrides,
  };
}

function grant(
  uri: string,
  principal: string,
  level = 1,
  effect: 'allow' | 'deny' = 'allow',
): void {
  db.prepare(
    'INSERT INTO node_permission (node_uri, principal, level, effect) VALUES (?, ?, ?, ?)',
  ).run(uri, principal, level, effect);
}

async function seed(
  uri: string,
  content: string,
  overrides: Partial<IndexRecord> = {},
  principal = 'user:alice',
): Promise<void> {
  await index.upsert([record(uri, content, overrides)]);
  grant(uri, principal);
}

function search(text: string, overrides: Partial<SearchQuery> = {}): Promise<SearchHit[]> {
  return index.search({ text, scopes: [SCOPE], principals: ['user:alice'], limit: 10, ...overrides });
}

function glob(pattern: string, overrides: Partial<GlobQuery> = {}): Promise<string[]> {
  return index.glob({ pattern, scopes: [SCOPE], principals: ['user:alice'], limit: 100, ...overrides });
}

function uris(hits: readonly SearchHit[]): string[] {
  return hits.map((hit) => hit.uri);
}

function countRows(sql: string, ...params: SQLInputValue[]): number {
  return Number(db.prepare(sql).get(...params)?.['total'] ?? -1);
}

/**
 * 包一层 `db`，记录 `search` 传给 SQL 的 `LIMIT`（最后一个绑定参数）。
 *
 * `candidateMultiplier` 只影响 SQL 的 LIMIT，最终结果条数被 `limit` 截断，所以只能
 * 在语句层观察。用 Proxy 委托给真实语句，不做 SQL 解析。
 */
function createCapturingIndex(candidateMultiplier?: number): {
  readonly index: SqliteFtsIndex;
  readonly limits: number[];
} {
  const limits: number[] = [];
  const dbProxy = new Proxy(db, {
    get(target, property, receiver) {
      if (property === 'prepare') {
        return (sql: string) => {
          const statement = target.prepare(sql);
          if (!sql.includes('MATCH')) {
            return statement;
          }
          return new Proxy(statement, {
            get(statementTarget, statementProperty, statementReceiver) {
              if (statementProperty === 'all') {
                return (...params: SQLInputValue[]): Record<string, SQLOutputValue>[] => {
                  limits.push(Number(params.at(-1)));
                  return statementTarget.all(...params);
                };
              }
              return Reflect.get(statementTarget, statementProperty, statementReceiver) as unknown;
            },
          });
        };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return {
    index: new SqliteFtsIndex({ db: dbProxy, logger: createLogger(), candidateMultiplier }),
    limits,
  };
}

beforeEach(() => {
  db = openDatabase(':memory:');
  runMigrations(db);
  index = new SqliteFtsIndex({ db, logger: createLogger() });
});

afterEach(() => {
  db.close();
});

describe('search：中文', () => {
  const OTHER = 'comem://user/alice/mem/other.md';

  beforeEach(async () => {
    await seed(DOC, '上下文记忆数据库的设计');
  });

  it('双字与多字中文词都能命中', async () => {
    for (const text of ['记忆', '记忆数', '数据库', '设计', '上下文']) {
      expect(uris(await search(text))).toContain(DOC);
    }
  });

  it('英文文档能被英文词命中', async () => {
    await seed(OTHER, 'TypeScript strict mode design');

    expect(uris(await search('TypeScript'))).toContain(OTHER);
    expect(uris(await search('strict'))).toContain(OTHER);
    expect(uris(await search('TypeScript 中文'))).not.toContain(OTHER);
  });

  it('短语要求字符相邻：「记忆」不命中「记录的回忆」', async () => {
    await seed(OTHER, '记录的回忆');

    expect(uris(await search('记忆'))).not.toContain(OTHER);
    expect(uris(await search('回忆'))).toContain(OTHER);
  });

  it('返回的 abstract 是原文而不是切分后的文本', async () => {
    await seed(OTHER, '数据库', { abstract: '上 下 文 摘 要' });

    const hit = (await search('数据库')).find((candidate) => candidate.uri === OTHER);
    expect(hit?.abstract).toBe('上 下 文 摘 要');
  });

  it('返回记忆类型：§8.6 的 events 起始层级靠它', async () => {
    // 少了这一列，事件类记忆只能从 L0 一句话摘要起投，永远升不到 L1 概览。
    // 这条曾经被并发重写覆盖过一次，留着防回归。
    await seed(OTHER, '数据库', { memoryType: 'events' });

    const hit = (await search('数据库')).find((candidate) => candidate.uri === OTHER);
    expect(hit?.memoryType).toBe('events');
  });

  it('非记忆文件的记忆类型是 null', async () => {
    await seed(OTHER, '数据库', { contextType: 'resource', memoryType: null });

    const hit = (await search('数据库')).find((candidate) => candidate.uri === OTHER);
    expect(hit?.memoryType).toBeNull();
  });
});

describe('search：FTS5 元字符', () => {
  it('引号、通配、布尔关键字与括号都按字面量匹配', async () => {
    await seed('comem://user/alice/meta.md', 'a"b a*b AND OR (x) -x ^x');

    for (const text of ['a"b', 'a*b', 'AND', 'OR', '(x)', '-x', '^x', 'a b']) {
      await expect(search(text)).resolves.toHaveLength(1);
    }
  });

  it('纯元字符与纯空白查询返回空集，不抛异常', async () => {
    await seed('comem://user/alice/meta.md', 'a"b');

    for (const text of ['"', '""', '*', '(', ')', '-', '^', '+', ':', ' ']) {
      await expect(search(text)).resolves.toEqual([]);
    }
  });

  it('空 scope / 空 principals / 空 text 在进 SQL 之前就被拒绝', async () => {
    await expect(search('记忆', { scopes: [] })).rejects.toThrow();
    await expect(search('记忆', { principals: [] })).rejects.toThrow();
    await expect(search('')).rejects.toThrow();
  });
});

describe('search：范围与权限', () => {
  it('路径 scope 按段边界：alice 不命中 alice2', async () => {
    const sibling = 'comem://user/alice2/x.md';
    await seed('comem://user/alice/x.md', '记忆');
    await seed(sibling, '记忆');

    expect(uris(await search('记忆', { scopes: [SCOPE] }))).not.toContain(sibling);
    expect(uris(await search('记忆', { scopes: ['comem://user/alice2'] }))).toContain(sibling);
  });

  it('没有 node_permission 行的节点不出现', async () => {
    const uri = 'comem://user/alice/noperm.md';
    await index.upsert([record(uri, '记忆')]);

    expect(uris(await search('记忆'))).not.toContain(uri);
  });

  it('level 不足（0）不出现', async () => {
    const uri = 'comem://user/alice/zero.md';
    await index.upsert([record(uri, '记忆')]);
    grant(uri, 'user:alice', 0);

    expect(uris(await search('记忆'))).not.toContain(uri);
  });

  it('user:* 通配：调用方把通配主体放进 principals 时才可见', async () => {
    const uri = 'comem://user/alice/wild.md';
    await seed(uri, '记忆', {}, 'user:*');

    expect(uris(await search('记忆', { principals: ['user:alice'] }))).not.toContain(uri);
    expect(uris(await search('记忆', { principals: ['user:alice', 'user:*'] }))).toContain(uri);
  });

  it('contextTypes / levels / status 过滤', async () => {
    const memory = 'comem://user/alice/memory.md';
    const resource = 'comem://user/alice/resource.md';
    const archived = 'comem://user/alice/archived.md';
    await seed(memory, '记忆', { contextType: 'memory', level: 'L0' });
    await seed(resource, '记忆', { contextType: 'resource', level: 'L2' });
    await seed(archived, '记忆', { status: 'archived' });

    expect(uris(await search('记忆', { contextTypes: ['resource'] }))).toEqual([resource]);
    expect(uris(await search('记忆', { levels: ['L0'] }))).toEqual([memory]);
    expect(uris(await search('记忆'))).not.toContain(archived);
  });

  it('deny 压掉 user:* 的 allow：命中被排除', async () => {
    const publicDoc = 'comem://user/alice/public.md';
    const blocked = 'comem://user/alice/blocked.md';
    await seed(publicDoc, '记忆', {}, 'user:*');
    await seed(blocked, '记忆', {}, 'user:*');
    grant(blocked, 'user:alice', 1, 'deny');

    expect(uris(await search('记忆', { principals: ['user:alice', 'user:*'] }))).toEqual([
      publicDoc,
    ]);
    // deny 行只压 alice：bob 通过 user:* 仍然可读。
    expect(uris(await search('记忆', { principals: ['user:bob', 'user:*'] }))).toContain(blocked);
  });

  it('只有 deny 行、没有 allow 时不可读', async () => {
    const uri = 'comem://user/alice/deny-only.md';
    await index.upsert([record(uri, '记忆')]);
    grant(uri, 'user:alice', 1, 'deny');

    expect(uris(await search('记忆'))).not.toContain(uri);
  });
});

describe('search：分数', () => {
  const MANY = 'comem://user/alice/many.md';
  const ONCE = 'comem://user/alice/once.md';

  beforeEach(async () => {
    await seed(MANY, '设计 设计 设计 设计 设计');
    await seed(ONCE, '设计 其 它 内 容 在 这 里');
  });

  it('bm25 取负：分数为正，词频高者更大', async () => {
    const hits = await search('设计');
    const [first, second] = hits;

    expect(hits).toHaveLength(2);
    expect(first?.uri).toBe(MANY);
    expect(first?.score ?? 0).toBeGreaterThan(0);
    expect(first?.score ?? 0).toBeGreaterThan(second?.score ?? 0);
  });

  it('scoreThreshold 在取负之后比较', async () => {
    const [best, worst] = await search('设计');
    const midpoint = ((best?.score ?? 0) + (worst?.score ?? 0)) / 2;

    expect(uris(await search('设计', { scoreThreshold: midpoint }))).toEqual([best?.uri]);
    expect(await search('设计', { scoreThreshold: (best?.score ?? 0) + 1 })).toEqual([]);
  });
});

describe('search：candidateMultiplier', () => {
  beforeEach(async () => {
    for (let position = 0; position < 6; position += 1) {
      await seed(`comem://user/alice/doc${position}.md`, '记忆');
    }
  });

  it('默认取 limit × 4 条候选，最终返回 limit 条', async () => {
    const capturing = createCapturingIndex();

    const hits = await capturing.index.search({
      text: '记忆',
      scopes: [SCOPE],
      principals: ['user:alice'],
      limit: 2,
    });

    expect(hits).toHaveLength(2);
    expect(capturing.limits).toEqual([8]);
  });

  it('自定义系数 1 时 SQL 只取 limit 条', async () => {
    const capturing = createCapturingIndex(1);

    const hits = await capturing.index.search({
      text: '记忆',
      scopes: [SCOPE],
      principals: ['user:alice'],
      limit: 2,
    });

    expect(hits).toHaveLength(2);
    expect(capturing.limits).toEqual([2]);
  });
});

describe('upsert / deleteByUri', () => {
  it('upsert 幂等：同一 URI 写两次，FTS 只有一行', async () => {
    const uri = 'comem://user/alice/idem.md';
    await seed(uri, '记忆');
    await index.upsert([record(uri, '数据库')]);

    expect(countRows('SELECT COUNT(*) AS total FROM node_fts WHERE uri = ?', uri)).toBe(1);
    expect(countRows('SELECT COUNT(*) AS total FROM node')).toBe(1);
    expect(uris(await search('数据库'))).toContain(uri);
    expect(uris(await search('记忆'))).not.toContain(uri);
  });

  it('deleteByUri 递归：删子树后 stat 为 null，FTS 无残留', async () => {
    await seed('comem://user/alice/sub/a.md', '记忆');
    await seed('comem://user/alice/sub/deep/b.md', '记忆');
    await seed('comem://user/alice/other/c.md', '记忆');

    await index.deleteByUri('comem://user/alice/sub', { recursive: true });

    expect(await index.stat('comem://user/alice/sub/a.md')).toBeNull();
    expect(await index.stat('comem://user/alice/sub/deep/b.md')).toBeNull();
    expect(
      countRows("SELECT COUNT(*) AS total FROM node_fts WHERE uri GLOB 'comem://user/alice/sub/*'"),
    ).toBe(0);
    expect(uris(await search('记忆'))).toEqual(['comem://user/alice/other/c.md']);
  });

  it('deleteByUri 非递归只删自身', async () => {
    await seed('comem://user/alice/sub/a.md', '记忆');

    await index.deleteByUri('comem://user/alice/sub');

    expect(await index.stat('comem://user/alice/sub')).toBeNull();
    expect(await index.stat('comem://user/alice/sub/a.md')).not.toBeNull();
  });
});

describe('glob', () => {
  beforeEach(async () => {
    await seed('comem://user/alice/a.md', 'a');
    await seed('comem://user/alice/sub/b.md', 'b');
    await seed('comem://user/alice/sub/deep/c.md', 'c');
    await seed('comem://user/alice/sub/d.txt', 'd');
    await seed('comem://user/alice2/e.md', 'e');
  });

  it('单个 * 不跨 /', async () => {
    expect(await glob('*.md')).toEqual(['comem://user/alice/a.md']);
  });

  it('** 跨 /，且能匹配零层目录', async () => {
    // globstar 的标准语义是「零个或更多目录」：直接子文件 a.md 必须命中。
    expect(await glob('**/*.md')).toEqual([
      'comem://user/alice/a.md',
      'comem://user/alice/sub/b.md',
      'comem://user/alice/sub/deep/c.md',
    ]);
  });

  it('** 在中间时两侧都展开', async () => {
    expect(await glob('sub/**/*.md')).toEqual([
      'comem://user/alice/sub/b.md',
      'comem://user/alice/sub/deep/c.md',
    ]);
  });

  it('多处 ** 仍然零层可选', async () => {
    await seed('comem://user/alice/x/y.md', 'y');

    expect(await glob('**/sub/**/*.md')).toEqual([
      'comem://user/alice/sub/b.md',
      'comem://user/alice/sub/deep/c.md',
    ]);
  });

  it('? 匹配单个字符', async () => {
    expect(await glob('?.md')).toEqual(['comem://user/alice/a.md']);
  });

  it('绝对 pattern 只受 scope 约束', async () => {
    expect(await glob('comem://user/alice/**/*.txt')).toEqual(['comem://user/alice/sub/d.txt']);
  });

  it('scope 按段边界：alice2 不出现', async () => {
    expect(await glob('**/*.md')).not.toContain('comem://user/alice2/e.md');
  });

  it('权限过滤：没有权限的节点不出现', async () => {
    db.prepare('DELETE FROM node_permission WHERE node_uri = ?').run(
      'comem://user/alice/sub/b.md',
    );

    expect(await glob('**/*.md')).toEqual([
      'comem://user/alice/a.md',
      'comem://user/alice/sub/deep/c.md',
    ]);
  });

  it('limit 生效', async () => {
    expect(await glob('**', { limit: 1 })).toEqual(['comem://user/alice/a.md']);
  });

  it('deny 压掉 user:* 的 allow：路径被排除', async () => {
    const uri = 'comem://user/alice/a.md';
    db.prepare('DELETE FROM node_permission WHERE node_uri = ?').run(uri);
    grant(uri, 'user:*', 1, 'allow');
    grant(uri, 'user:alice', 1, 'deny');

    expect(await glob('*.md', { principals: ['user:alice', 'user:*'] })).toEqual([]);
    expect(await glob('*.md', { principals: ['user:bob', 'user:*'] })).toEqual([uri]);
  });

  it('空 scope 在进 SQL 之前就被拒绝', async () => {
    await expect(glob('*.md', { scopes: [] })).rejects.toThrow();
  });
});

describe('stat', () => {
  it('返回索引行，缺失返回 null', async () => {
    await seed(DOC, '上下文记忆数据库的设计', { abstract: '架构', size: 12 });

    expect(await index.stat(DOC)).toEqual({
      uri: DOC,
      kind: 'document',
      contextType: 'memory',
      memoryType: null,
      size: 12,
      updatedAt: '2026-11-08T00:00:00.000Z',
      status: 'active',
      abstract: '架构',
    });
    expect(await index.stat('comem://user/alice/missing.md')).toBeNull();
  });
});
