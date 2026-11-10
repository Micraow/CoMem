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
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
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

describe('search：多词查询', () => {
  const PAY = 'comem://user/alice/mem/pay.md';
  const GATEWAY = 'comem://user/alice/mem/gateway.md';

  beforeEach(async () => {
    await seed(PAY, '支付网关层实现重试时，必须用幂等键去重，避免重复扣款。');
    await seed(GATEWAY, '网关层的超时应该小于上游的重试总预算。');
  });

  it('空白分隔的多个词分别命中（修复前整串是一个短语，要求字符连续）', async () => {
    // 三个词在 PAY 里被其它字隔开，整串短语「重 试 网 关 层 支 付」必然落空。
    expect(uris(await search('重试 网关层 支付'))).toContain(PAY);
  });

  it('词与词之间是合取：少一个词就不命中', async () => {
    // GATEWAY 有「重试」「网关层」，没有「支付」——AND 语义下不出现。
    expect(uris(await search('重试 网关层 支付'))).not.toContain(GATEWAY);
    expect(uris(await search('重试 网关层'))).toContain(GATEWAY);
  });

  it('词内部仍然要求字符相邻：多词不会退化成字符级 OR', async () => {
    const REORDER = 'comem://user/alice/mem/reorder.md';
    await seed(REORDER, '记录的回忆');

    // 「记」「忆」都在文档里，但中间隔着「录的回忆」。短语语义下「记忆」不命中。
    expect(uris(await search('记忆 记录'))).not.toContain(REORDER);
    expect(uris(await search('记录'))).toContain(REORDER);
  });

  it('含双引号与布尔关键字的多词查询按字面量匹配，不抛语法错误', async () => {
    const META = 'comem://user/alice/mem/meta.md';
    await seed(META, 'a"b AND (x)');

    for (const text of ['a"b AND', 'a"b AND (x)', 'AND "', '"(x)" a*b', 'x" OR "y']) {
      await expect(search(text)).resolves.toBeInstanceOf(Array);
    }
    // 引号被双写转义、AND 被包进短语：命中的是字面量，不是布尔运算。
    expect(uris(await search('a"b AND'))).toContain(META);
    // 注入形态只会被切成词，不扩大命中集合。
    expect(uris(await search('" OR 1=1 --'))).toEqual([]);
  });

  it('全空白查询返回空集，不报错也不返回全部', async () => {
    for (const text of [' ', '\t', '\n', '  \t\n ']) {
      await expect(search(text)).resolves.toEqual([]);
    }
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

});

describe('search：记忆类型与更新时间（SQL 下推）', () => {
  it('memoryTypes 在 LIMIT 之前下推：前几条命中全是偏好时规则仍返回', async () => {
    // 12 条偏好，每条把查询短语写 3 遍，bm25 严格高于规则。
    // 若实现是「先取 limit × candidateMultiplier 条再按类型筛」，limit=2 时
    // 候选集（8 条）会全是偏好，规则一条都回不来——这正是 rule_search 的缺陷。
    const preferences = Array.from(
      { length: 12 },
      (_, index) => `comem://user/alice/mem/preferences/${index}.md`,
    );
    for (const uri of preferences) {
      await seed(uri, '许可证 许可证 许可证', { memoryType: 'preferences' });
    }
    const rule = 'comem://user/alice/mem/rules/license.md';
    await seed(rule, '许可证', { memoryType: 'rules' });

    // 先钉住场景：不带类型过滤时前两条确实是偏好。
    const unfiltered = await search('许可证', { limit: 2 });
    expect(unfiltered).toHaveLength(2);
    expect(unfiltered.every((hit) => hit.memoryType === 'preferences')).toBe(true);

    expect(uris(await search('许可证', { limit: 2, memoryTypes: ['rules'] }))).toEqual([rule]);
  });

  it('memoryTypes 排除非记忆节点（memory_type 为 NULL）', async () => {
    const memory = 'comem://user/alice/mem/rules/rule.md';
    const plain = 'comem://user/alice/plain.md';
    await seed(memory, '记忆', { memoryType: 'rules' });
    await seed(plain, '记忆');

    expect(uris(await search('记忆', { memoryTypes: ['rules'] }))).toEqual([memory]);
    // 空数组与省略同义。
    expect(uris(await search('记忆', { memoryTypes: [] })).sort()).toEqual([memory, plain].sort());
  });

  describe('更新时间闭区间', () => {
    const T0 = '2026-11-01T00:00:00.000Z';
    const T1 = '2026-11-05T12:00:00.000Z';
    const T2 = '2026-11-09T00:00:00.000Z';
    const OLD = 'comem://user/alice/old.md';
    const MIDDLE = 'comem://user/alice/middle.md';
    const NEW = 'comem://user/alice/new.md';

    beforeEach(async () => {
      await seed(OLD, '记忆', { updatedAt: T0 });
      await seed(MIDDLE, '记忆', { updatedAt: T1 });
      await seed(NEW, '记忆', { updatedAt: T2 });
    });

    it('updatedAfter 是闭区间：等于边界的节点命中', async () => {
      expect(uris(await search('记忆', { updatedAfter: T1 })).sort()).toEqual(
        [MIDDLE, NEW].sort(),
      );
    });

    it('updatedBefore 是闭区间：等于边界的节点命中', async () => {
      expect(uris(await search('记忆', { updatedBefore: T1 })).sort()).toEqual([OLD, MIDDLE].sort());
    });

    it('两端相等时只命中恰好这个时刻的节点', async () => {
      expect(
        uris(await search('记忆', { updatedAfter: T1, updatedBefore: T1 })),
      ).toEqual([MIDDLE]);
    });

    it('带时区偏移的边界先归一化，再按同一形态比较', async () => {
      // `2026-11-05T20:00:00+08:00` 就是 `T1`；不归一化会按字符串比较出错。
      expect(
        uris(await search('记忆', { updatedAfter: '2026-11-05T20:00:00+08:00' })).sort(),
      ).toEqual([MIDDLE, NEW].sort());
    });

    it('区间为空（after 晚于 before）在进 SQL 之前被拒绝', async () => {
      await expect(
        index.search({
          text: '记忆',
          scopes: [SCOPE],
          principals: ['user:alice'],
          limit: 10,
          updatedAfter: T2,
          updatedBefore: T0,
        }),
      ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    });
  });
});

/**
 * 有效区间（W98 数据基座）。
 *
 * 记忆有「从何时到何时有效」两列，NULL = 无界。检索默认只看「现在有效」的节点：
 * `find` / `search` / `rule_search` 与抽取预取都不该看到被顶替的历史版本。条件是
 * `(valid_from IS NULL OR valid_from <= asOf)` 与
 * `(valid_until IS NULL OR valid_until > asOf)`，**两列都是 NULL 时放行**——旧数据
 * 与非记忆节点正是这个形态，它们不能被这次改动过滤掉。
 *
 * 四条记忆 + 一条非记忆文件全部命中同一个词，唯一差别是有效期。
 */
describe('检索的有效期过滤（asOf）', () => {
  const NOW = '2026-11-10T00:00:00.000Z';
  const UNBOUNDED = 'comem://user/alice/mem/unbounded.md';
  const CURRENT = 'comem://user/alice/mem/current.md';
  const EXPIRED = 'comem://user/alice/mem/expired.md';
  const FUTURE = 'comem://user/alice/mem/future.md';
  const RESOURCE = 'comem://user/alice/notes/plain.md';
  const ALL = [UNBOUNDED, CURRENT, EXPIRED, FUTURE, RESOURCE];

  beforeEach(async () => {
    // 两列显式写 null：这是「带 valid_until 但为 NULL」的普通节点，必须放行。
    await seed(UNBOUNDED, '有效区间', {
      memoryType: 'preferences',
      validFrom: null,
      validUntil: null,
    });
    await seed(CURRENT, '有效区间', {
      memoryType: 'preferences',
      validFrom: '2026-11-09T00:00:00.000Z',
    });
    await seed(EXPIRED, '有效区间', {
      memoryType: 'preferences',
      validFrom: '2026-11-01T00:00:00.000Z',
      validUntil: '2026-11-05T00:00:00.000Z',
    });
    await seed(FUTURE, '有效区间', {
      memoryType: 'preferences',
      validFrom: '2027-01-01T00:00:00.000Z',
    });
    // 非记忆节点：`valid_*` 恒为 NULL，不属于任何有效区间。
    await seed(RESOURCE, '有效区间', { contextType: 'resource', memoryType: null });
  });

  it('glob 用同一套条件：历史版本与未来版本都不出现', async () => {
    // `glob` 同时是向量检索与 `grep` 的候选集来源；两处 SQL 分家会出现
    // 「find 看不到历史版本、glob 能看到」。
    expect((await glob('mem/*.md', { asOf: NOW })).sort()).toEqual(
      [UNBOUNDED, CURRENT].sort(),
    );
    expect((await glob('**/*.md', { asOf: NOW })).sort()).toEqual(
      [UNBOUNDED, CURRENT, RESOURCE].sort(),
    );
  });

  it('省略 asOf 时不过滤，行为与接入有效期之前逐字相同', async () => {
    expect(uris(await search('有效区间')).sort()).toEqual([...ALL].sort());
    expect((await glob('**/*.md')).sort()).toEqual([...ALL].sort());
  });

  it('边界：valid_from 等于 asOf 仍有效，valid_until 等于 asOf 已失效', async () => {
    const STARTS_NOW = 'comem://user/alice/mem/starts-now.md';
    const ENDS_NOW = 'comem://user/alice/mem/ends-now.md';
    await seed(STARTS_NOW, '有效区间', { memoryType: 'preferences', validFrom: NOW });
    await seed(ENDS_NOW, '有效区间', { memoryType: 'preferences', validUntil: NOW });

    const hits = uris(await search('有效区间', { asOf: NOW }));
    expect(hits).toContain(STARTS_NOW);
    expect(hits).not.toContain(ENDS_NOW);
  });

  it('asOf 归一化后再比较：带时区偏移的边界与 UTC 同一结果', async () => {
    // `2026-11-10T08:00:00+08:00` 就是 NOW。不归一化会按字符串比较出错。
    expect(uris(await search('有效区间', { asOf: '2026-11-10T08:00:00+08:00' })).sort()).toEqual(
      [UNBOUNDED, CURRENT, RESOURCE].sort(),
    );
  });

  it('asOf 不是时间串时在进 SQL 之前被拒绝', async () => {
    await expect(search('有效区间', { asOf: '明天' })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
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

  it('已归档节点不出现（归档只影响检索面，§11.7）', async () => {
    const archived = 'comem://user/alice/archived.md';
    await seed(archived, 'a', { status: 'archived' });

    expect(await glob('**/*.md')).toEqual([
      'comem://user/alice/a.md',
      'comem://user/alice/sub/b.md',
      'comem://user/alice/sub/deep/c.md',
    ]);
    // 归档只影响检索面：内容还在，`stat` 读得到，`read` / `download` 按路径仍可用。
    expect((await index.stat(archived))?.status).toBe('archived');
  });

  it('limit 生效', async () => {
    expect(await glob('**', { limit: 1 })).toEqual(['comem://user/alice/a.md']);
  });

  it('记忆类型与更新时间过滤在 SQL 里生效（向量检索的候选集来源）', async () => {
    const rule = 'comem://user/alice/mem/rules/rule.md';
    const preference = 'comem://user/alice/mem/preferences/tone.md';
    await seed(rule, '规则', {
      memoryType: 'rules',
      updatedAt: '2026-11-05T12:00:00.000Z',
    });
    await seed(preference, '偏好', {
      memoryType: 'preferences',
      updatedAt: '2026-11-09T00:00:00.000Z',
    });

    expect(await glob('**/mem/**', { memoryTypes: ['rules'] })).toEqual([rule]);
    // 闭区间：等于边界的节点命中。
    expect(
      await glob('**/mem/**', { updatedAfter: '2026-11-05T12:00:00.000Z' }),
    ).toEqual([preference, rule]);
    expect(
      await glob('**/mem/**', { updatedBefore: '2026-11-05T12:00:00.000Z' }),
    ).toEqual([rule]);
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

/**
 * 目录的两行索引（L0 摘要行 + L1 概览行，`0004_node_level_rows.sql`）。
 *
 * 这两行的 URI 相同、只有 `level` 不同，所以 `node` 与 `node_fts` 的 join 必须带上
 * `level`：只按 uri 关联时一次匹配会被报成两条（其中一条的 level / abstract 是另一
 * 层的），而按 URI 读节点的路径（`stat` / `glob`）也不能把两行当成两个节点。
 */
describe('同一 URI 的 L0 与 L1 行', () => {
  const DIR = 'comem://user/alice/mem';
  const OVERVIEW = '团队约定的详细说明：提交前跑完整测试';

  async function seedTwoRows(): Promise<void> {
    await seed(DIR, '', { kind: 'directory', level: 'L0', abstract: '团队约定' });
    await index.upsert([
      record(DIR, OVERVIEW, { kind: 'directory', level: 'L1', abstract: '团队约定' }),
    ]);
  }

  it('各自的文本各成一条检索行，命中时 level 与文本对得上', async () => {
    await seedTwoRows();

    // 概览独有 → 只有 L1 行命中。
    const overviewHits = await search('提交前跑完整测试');
    expect(overviewHits.map((hit) => hit.level)).toEqual(['L1']);

    // L0 摘要 → 两行都命中：L1 行的概览正文包含 L0 摘要（L0 是从概览里提取的，
    // §9.1）。两行返回的 `abstract` 相同，这正是 §8.6 去重面对的输入。
    const abstractHits = await search('团队约定');
    expect(abstractHits.map((hit) => hit.level).sort()).toEqual(['L0', 'L1']);
    expect(new Set(abstractHits.map((hit) => hit.abstract))).toEqual(new Set(['团队约定']));
  });

  it('levels 过滤作用在检索行上', async () => {
    await seedTwoRows();

    expect((await search('团队约定', { levels: ['L1'] })).map((hit) => hit.abstract)).toEqual([
      '团队约定',
    ]);
    expect(await search('提交前跑完整测试', { levels: ['L0'] })).toEqual([]);
  });

  it('stat 只返回节点自身那一行（L0 摘要），不是概览行', async () => {
    await seedTwoRows();

    const stat = await index.stat(DIR);
    expect(stat?.abstract).toBe('团队约定');
    expect(stat?.kind).toBe('directory');
  });

  it('glob 对同一个目录只返回一次', async () => {
    await seedTwoRows();

    expect(await glob('comem://user/alice/*')).toEqual([DIR]);
  });

  it('deleteByUri 删掉两行', async () => {
    await seedTwoRows();

    await index.deleteByUri(DIR);

    expect(countRows('SELECT COUNT(*) AS total FROM node WHERE uri = ?', DIR)).toBe(0);
    expect(countRows('SELECT COUNT(*) AS total FROM node_fts WHERE uri = ?', DIR)).toBe(0);
  });
});
