/**
 * 检索面的跨引擎契约（`retrieval.engine` = `fts5` / `vector` / `hybrid`）。
 *
 * `RetrievalIndex` 在仓库里只有一个实现（`SqliteFtsIndex`），但「同一次检索」有三条
 * 执行分支：纯 FTS5、纯向量、两路融合。三条分支共用同一套可见性要求——权限、
 * `status = active`、`asOf` 有效期——任何一条漂移都会让用户看到「find 看得到、
 * grep 看不到」或「历史版本混进结果」。
 *
 * 套件在**服务层**断言：同一份数据、同一个查询，三个引擎给出的可见集合必须服从
 * 同一条规则。FTS5 特有的元字符、candidateMultiplier、`stat`、L0/L1 行等实现细节
 * 留在 `tests/integration/sqlite/retrieval-index.test.ts`。
 *
 * 权限由索引 SQL 的 `node_permission` 谓词携带。注册方用 `AllowAllAuthorizer` 让
 * 服务层的第二遍过滤不参与，这样失败能直接归因到索引可见集合，而不是「两遍都过
 * 或两遍都不过」。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Level } from '../../src/domain/level.js';
import type { ContextType, NodeStatus } from '../../src/domain/node.js';
import type { GrepHit, RetrievalEngine } from '../../src/domain/retrieval.js';
import { expectComemFailure, rejection } from './conformance.js';
import type { FindOptions, RankedScoredHit } from '../../src/services/search.js';

const ROOT = 'comem://user/alice';
const FAMILY = `${ROOT}/fam`;

/** 有效期边界的「现在」：模块加载时取一次，测试运行时它已经在过去。 */
const NOW = new Date().toISOString();

export const CONFORMANCE_URIS = {
  current: `${FAMILY}/current.md`,
  unbounded: `${FAMILY}/unbounded.md`,
  resource: `${FAMILY}/resource.md`,
  grep: `${FAMILY}/grep.md`,
  deep: `${FAMILY}/sub/deep.md`,
  startsNow: `${FAMILY}/starts-now.md`,
  endsNow: `${FAMILY}/ends-now.md`,
  expired: `${FAMILY}/expired.md`,
  future: `${FAMILY}/future.md`,
  archived: `${FAMILY}/archived.md`,
  denied: `${FAMILY}/denied.md`,
  noPermission: `${FAMILY}/no-permission.md`,
  denyOnly: `${FAMILY}/deny-only.md`,
  levelZero: `${FAMILY}/level-zero.md`,
} as const;

interface PermissionSeed {
  readonly principal: string;
  readonly level?: number;
  readonly effect?: 'allow' | 'deny';
}

export interface SeedRecord {
  readonly uri: string;
  readonly content: string;
  /** 落盘正文；省略 = `content`。`null` = 不落盘（`grep` 会跳过）。 */
  readonly body?: string | null;
  readonly contextType?: ContextType;
  readonly memoryType?: string | null;
  readonly level?: Level;
  readonly status?: NodeStatus;
  readonly validFrom?: string | null;
  readonly validUntil?: string | null;
  /** 省略 = 给 `user:alice` 一条 level 1 的 allow。空数组 = 一行权限都不写。 */
  readonly permissions?: readonly PermissionSeed[];
}

const CONTENT = '记忆 契约 可见性';

/** 一份覆盖所有可见性维度的数据：有效期、归档、权限、非记忆节点、深层路径。 */
const FIXTURE: readonly SeedRecord[] = [
  {
    uri: CONFORMANCE_URIS.current,
    content: CONTENT,
    memoryType: 'preferences',
    validFrom: '2020-01-01T00:00:00.000Z',
    validUntil: '2099-01-01T00:00:00.000Z',
  },
  { uri: CONFORMANCE_URIS.unbounded, content: CONTENT, memoryType: 'preferences' },
  {
    uri: CONFORMANCE_URIS.resource,
    content: CONTENT,
    contextType: 'resource',
    memoryType: null,
  },
  {
    uri: CONFORMANCE_URIS.grep,
    content: '第一行\n记忆 契约 可见性\n第三行',
    memoryType: 'preferences',
  },
  { uri: CONFORMANCE_URIS.deep, content: CONTENT, memoryType: 'preferences' },
  {
    uri: CONFORMANCE_URIS.startsNow,
    content: CONTENT,
    memoryType: 'preferences',
    validFrom: NOW,
  },
  {
    uri: CONFORMANCE_URIS.endsNow,
    content: CONTENT,
    memoryType: 'preferences',
    validUntil: NOW,
  },
  {
    uri: CONFORMANCE_URIS.expired,
    content: CONTENT,
    memoryType: 'preferences',
    validFrom: '2020-01-01T00:00:00.000Z',
    validUntil: '2020-12-31T00:00:00.000Z',
  },
  {
    uri: CONFORMANCE_URIS.future,
    content: CONTENT,
    memoryType: 'preferences',
    validFrom: '2099-01-01T00:00:00.000Z',
  },
  {
    uri: CONFORMANCE_URIS.archived,
    content: CONTENT,
    memoryType: 'preferences',
    status: 'archived',
  },
  {
    uri: CONFORMANCE_URIS.denied,
    content: CONTENT,
    memoryType: 'preferences',
    permissions: [
      { principal: 'user:*', level: 1, effect: 'allow' },
      { principal: 'user:alice', level: 1, effect: 'deny' },
    ],
  },
  {
    uri: CONFORMANCE_URIS.noPermission,
    content: CONTENT,
    memoryType: 'preferences',
    permissions: [],
  },
  {
    uri: CONFORMANCE_URIS.denyOnly,
    content: CONTENT,
    memoryType: 'preferences',
    permissions: [{ principal: 'user:alice', level: 1, effect: 'deny' }],
  },
  {
    uri: CONFORMANCE_URIS.levelZero,
    content: CONTENT,
    memoryType: 'preferences',
    permissions: [{ principal: 'user:alice', level: 0, effect: 'allow' }],
  },
];

const SORTED_NOW_VISIBLE: readonly string[] = [
  CONFORMANCE_URIS.current,
  CONFORMANCE_URIS.unbounded,
  CONFORMANCE_URIS.resource,
  CONFORMANCE_URIS.grep,
  CONFORMANCE_URIS.deep,
  CONFORMANCE_URIS.startsNow,
].sort();

/** `glob` / `grep` 是路径工具：含历史与未来版本，但不含归档、无权、level 0。 */
const SORTED_PATH_VISIBLE: readonly string[] = [
  ...SORTED_NOW_VISIBLE,
  CONFORMANCE_URIS.endsNow,
  CONFORMANCE_URIS.expired,
  CONFORMANCE_URIS.future,
].sort();

export interface RetrievalSurfaceHarness {
  readonly engine: RetrievalEngine;
  seed(records: readonly SeedRecord[]): Promise<void>;
  find(query: string, options?: Partial<FindOptions>): Promise<readonly RankedScoredHit[]>;
  glob(pattern: string, options?: Partial<FindOptions>): Promise<readonly string[]>;
  grep(
    pattern: string,
    options?: Partial<FindOptions & { readonly contextLines: number }>,
  ): Promise<readonly GrepHit[]>;
  dispose(): Promise<void>;
}

function sortedUris(hits: readonly { readonly uri: string }[]): string[] {
  return hits.map((hit) => hit.uri).sort();
}

function expectFindHitShape(hit: RankedScoredHit, engine: RetrievalEngine): void {
  expect(typeof hit.uri).toBe('string');
  expect(['L0', 'L1', 'L2']).toContain(hit.level);
  expect(['memory', 'resource', 'skill', 'session']).toContain(hit.contextType);
  expect(hit.memoryType === null || typeof hit.memoryType === 'string').toBe(true);
  expect(hit.abstract === null || typeof hit.abstract === 'string').toBe(true);
  expect(Number.isFinite(hit.score)).toBe(true);
  // `ranks` 的形状按引擎固定：单引擎只有自己那一位，融合两路都可能有。
  // 「两种都接受」会让「fts5 突然开始返回名次」这种漂移悄悄通过。
  if (engine === 'fts5') {
    expect(hit.ranks).toBeNull();
  } else if (engine === 'vector') {
    expect(hit.ranks).toMatchObject({ fts5: null, hybrid: null });
    expect(hit.ranks?.vector).toEqual(expect.any(Number));
  } else {
    expect(hit.ranks).not.toBeNull();
    expect(hit.ranks?.hybrid).toBeNull();
    const backendRanks = [hit.ranks?.fts5, hit.ranks?.vector].filter(
      (rank): rank is number => typeof rank === 'number',
    );
    expect(backendRanks.length).toBeGreaterThan(0);
    for (const rank of backendRanks) {
      expect(Number.isInteger(rank) && rank > 0).toBe(true);
    }
  }
  expect(hit.hotness).toBeNull();
}

export function describeRetrievalSurfaceConformance(
  engine: RetrievalEngine,
  createHarness: () => Promise<RetrievalSurfaceHarness>,
): void {
  describe(`检索面跨引擎契约（engine: ${engine}）`, () => {
    let harness: RetrievalSurfaceHarness;

    async function fresh(): Promise<void> {
      harness = await createHarness();
      expect(harness.engine).toBe(engine);
      await harness.seed(FIXTURE);
    }

    // 每个用例一份新库：可见性用例会断言「全集」，共享状态会让失败互相掩盖。
    beforeEach(fresh);

    afterEach(async () => {
      await harness.dispose();
    });

    it('find 的可见集合只含无界 / 当前有效、active 且可读的节点', async () => {
      const hits = await harness.find('记忆');

      expect(sortedUris(hits)).toEqual(SORTED_NOW_VISIBLE);
      expect(new Set(hits.map((hit) => hit.uri)).size).toBe(hits.length);
      for (const hit of hits) {
        expectFindHitShape(hit, engine);
        expect(hit.abstract).toBeNull();
        // 非记忆节点的 `memory_type` 是 NULL；记忆节点必须带回自己的类型
        // （§8.6 的分层投放靠它决定起始层级）。
        if (hit.uri === CONFORMANCE_URIS.resource) {
          expect(hit.memoryType).toBeNull();
          expect(hit.contextType).toBe('resource');
        } else {
          expect(hit.memoryType).toBe('preferences');
          expect(hit.contextType).toBe('memory');
        }
      }
    });

    it('find 里的有效期边界：valid_from == now 仍有效，valid_until == now 已失效', async () => {
      const uris = sortedUris(await harness.find('记忆'));

      expect(uris).toContain(CONFORMANCE_URIS.startsNow);
      expect(uris).not.toContain(CONFORMANCE_URIS.endsNow);
    });

    it('find 不返回归档、无权、level 0 与保外节点', async () => {
      const uris = sortedUris(await harness.find('记忆'));

      expect(uris).not.toContain(CONFORMANCE_URIS.archived);
      expect(uris).not.toContain(CONFORMANCE_URIS.denied);
      expect(uris).not.toContain(CONFORMANCE_URIS.noPermission);
      expect(uris).not.toContain(CONFORMANCE_URIS.denyOnly);
      expect(uris).not.toContain(CONFORMANCE_URIS.levelZero);
      expect(uris).not.toContain(CONFORMANCE_URIS.expired);
      expect(uris).not.toContain(CONFORMANCE_URIS.future);
    });

    it('glob 是路径工具：含历史 / 未来版本，但不含归档、无权、level 0', async () => {
      const uris = await harness.glob('**/*.md');

      expect([...uris].sort()).toEqual(SORTED_PATH_VISIBLE);
      for (const uri of uris) {
        expect(uri.startsWith(`${ROOT}/`)).toBe(true);
      }
      // 显式钉住「路径工具与 find 的差异」：这不是遗漏，是契约。
      expect(uris).toContain(CONFORMANCE_URIS.expired);
      expect(uris).toContain(CONFORMANCE_URIS.future);
      expect(uris).toContain(CONFORMANCE_URIS.endsNow);
      expect(uris).not.toContain(CONFORMANCE_URIS.archived);
      expect(uris).not.toContain(CONFORMANCE_URIS.denied);
      expect(uris).not.toContain(CONFORMANCE_URIS.noPermission);
      expect(uris).not.toContain(CONFORMANCE_URIS.denyOnly);
      expect(uris).not.toContain(CONFORMANCE_URIS.levelZero);
    });

    it('grep 与 glob 的可见集合一致，且行号 / 前后文形状正确', async () => {
      const globbed = [...(await harness.glob('**/*.md'))].sort();
      const hits = await harness.grep('记忆');

      expect(sortedUris(hits)).toEqual(globbed);
      for (const hit of hits) {
        expect(Number.isInteger(hit.line)).toBe(true);
        expect(hit.line).toBeGreaterThanOrEqual(1);
        expect(typeof hit.text).toBe('string');
        expect(Array.isArray(hit.before)).toBe(true);
        expect(Array.isArray(hit.after)).toBe(true);
      }

      const grepLine = hits.find((hit) => hit.uri === CONFORMANCE_URIS.grep);
      expect(grepLine).toMatchObject({
        line: 2,
        text: '记忆 契约 可见性',
        before: ['第一行'],
        after: ['第三行'],
      });
    });

    it('find 的可见集合是 glob 的子集（find 只额外做有效期收窄）', async () => {
      const findUris = sortedUris(await harness.find('记忆'));
      const globUris = new Set(await harness.glob('**/*.md'));

      for (const uri of findUris) {
        expect(globUris.has(uri)).toBe(true);
      }
    });

    it('limit 在 find / glob 上都生效', async () => {
      expect(await harness.find('记忆', { limit: 2 })).toHaveLength(2);
      expect(await harness.glob('**/*.md', { limit: 2 })).toHaveLength(2);
    });

    it('非法入参在三个引擎上给出同一个错误码', async () => {
      expectComemFailure(await rejection(harness.find('记忆', { limit: 0 })), {
        code: 'INVALID_ARGUMENT',
        retryable: false,
      });
      expectComemFailure(await rejection(harness.glob('**/*.md', { limit: 0 })), {
        code: 'INVALID_ARGUMENT',
        retryable: false,
      });
      expectComemFailure(await rejection(harness.glob('**/*.md', { scopes: [] })), {
        code: 'INVALID_ARGUMENT',
        retryable: false,
      });
      // 正则不合法时消息末尾会带 V8 的解释（英文、无句号）；那是这一条特有的
      // 形态，不按「中文完整句子」要求句号，但错误码与可重试结论仍然必须一致。
      expectComemFailure(await rejection(harness.grep('(')), {
        code: 'INVALID_ARGUMENT',
        retryable: false,
        endsWithPeriod: false,
      });
    });
  });
}
