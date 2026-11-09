import { describe, expect, it } from 'vitest';

import { ComemError } from '../../../src/domain/errors.js';
import {
  canonicalInstant,
  reciprocalRankFusion,
  validateGlobQuery,
  validateGrepQuery,
  validateSearchQuery,
  type GlobQuery,
  type GrepQuery,
  type SearchHit,
  type SearchQuery,
} from '../../../src/domain/retrieval.js';

function expectInvalidArgument(run: () => void): ComemError {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ComemError);
  const error = caught as ComemError;
  expect(error.code).toBe('INVALID_ARGUMENT');
  return error;
}

const SEARCH: SearchQuery = {
  text: 'TypeScript 严格模式',
  scopes: ['comem://user/alice'],
  principals: ['user:alice', 'group:eng'],
  contextTypes: ['memory'],
  levels: ['L0', 'L1'],
  limit: 10,
  scoreThreshold: 0.5,
};

const GREP: GrepQuery = {
  pattern: 'strict',
  scopes: ['comem://user/alice'],
  principals: ['user:alice'],
  limit: 10,
  contextLines: 2,
};

const GLOB: GlobQuery = {
  pattern: '**/*.md',
  scopes: ['comem://user/alice'],
  principals: ['user:alice'],
  limit: 100,
};

describe('validateSearchQuery', () => {
  it('合法查询通过', () => {
    expect(() => {
      validateSearchQuery(SEARCH);
    }).not.toThrow();
  });

  it('limit 必须是正整数', () => {
    for (const limit of [0, -1, 1.5, Number.NaN]) {
      expectInvalidArgument(() => {
        validateSearchQuery({ ...SEARCH, limit });
      });
    }
  });

  it('scopes 不能为空，也不能有空字符串', () => {
    expectInvalidArgument(() => {
      validateSearchQuery({ ...SEARCH, scopes: [] });
    });
    expectInvalidArgument(() => {
      validateSearchQuery({ ...SEARCH, scopes: ['comem://user/alice', ''] });
    });
  });

  it('principals 不能为空，也不能有空字符串', () => {
    expectInvalidArgument(() => {
      validateSearchQuery({ ...SEARCH, principals: [] });
    });
    expectInvalidArgument(() => {
      validateSearchQuery({ ...SEARCH, principals: [''] });
    });
  });

  it('text 不能为空', () => {
    expectInvalidArgument(() => {
      validateSearchQuery({ ...SEARCH, text: '' });
    });
  });
});

describe('validateSearchQuery：记忆类型与更新时间过滤', () => {
  it('memoryTypes 可省略，空数组与省略同义', () => {
    for (const memoryTypes of [undefined, []]) {
      expect(() => {
        validateSearchQuery({ ...SEARCH, memoryTypes });
      }).not.toThrow();
    }
  });

  it('memoryTypes 里不能有空字符串', () => {
    expectInvalidArgument(() => {
      validateSearchQuery({ ...SEARCH, memoryTypes: ['rules', ''] });
    });
  });

  it('更新时间的上下界必须是 ISO 8601', () => {
    for (const field of ['updatedAfter', 'updatedBefore'] as const) {
      expectInvalidArgument(() => {
        validateSearchQuery({ ...SEARCH, [field]: '昨天' });
      });
    }
  });

  it('updatedAfter 晚于 updatedBefore 报错；相等合法（闭区间退化成单个时刻）', () => {
    expectInvalidArgument(() => {
      validateSearchQuery({
        ...SEARCH,
        updatedAfter: '2026-11-09T00:00:00.000Z',
        updatedBefore: '2026-11-08T00:00:00.000Z',
      });
    });
    expect(() => {
      validateSearchQuery({
        ...SEARCH,
        updatedAfter: '2026-11-08T00:00:00.000Z',
        updatedBefore: '2026-11-08T00:00:00.000Z',
      });
    }).not.toThrow();
  });

  it('glob 的候选集过滤共享同一套元数据校验', () => {
    expectInvalidArgument(() => {
      validateGlobQuery({ ...GLOB, updatedAfter: '不是时间' });
    });
    expectInvalidArgument(() => {
      validateGlobQuery({ ...GLOB, memoryTypes: [''] });
    });
  });
});

describe('canonicalInstant', () => {
  it('把带时区偏移的时刻归一化成 UTC（否则 TEXT 比较会漂）', () => {
    expect(canonicalInstant('2026-11-08T08:00:00+08:00', 'updatedAfter')).toBe(
      '2026-11-08T00:00:00.000Z',
    );
  });

  it('非法输入抛 INVALID_ARGUMENT', () => {
    expectInvalidArgument(() => {
      canonicalInstant('2026-13-40', 'updatedAfter');
    });
  });
});

describe('validateGrepQuery', () => {
  it('合法查询通过', () => {
    expect(() => {
      validateGrepQuery(GREP);
    }).not.toThrow();
  });

  it('pattern 不能为空', () => {
    expectInvalidArgument(() => {
      validateGrepQuery({ ...GREP, pattern: '' });
    });
  });

  it('pattern 必须能编译成正则', () => {
    expectInvalidArgument(() => {
      validateGrepQuery({ ...GREP, pattern: '(' });
    });
  });

  it('contextLines 必须是非负整数', () => {
    for (const contextLines of [-1, 1.5, Number.NaN]) {
      expectInvalidArgument(() => {
        validateGrepQuery({ ...GREP, contextLines });
      });
    }
  });

  it('共享的 scope / principal / limit 校验同样生效', () => {
    expectInvalidArgument(() => {
      validateGrepQuery({ ...GREP, limit: 0 });
    });
    expectInvalidArgument(() => {
      validateGrepQuery({ ...GREP, scopes: [] });
    });
    expectInvalidArgument(() => {
      validateGrepQuery({ ...GREP, principals: [] });
    });
  });
});

describe('validateGlobQuery', () => {
  it('合法查询通过', () => {
    expect(() => {
      validateGlobQuery(GLOB);
    }).not.toThrow();
  });

  it('pattern 不能为空', () => {
    expectInvalidArgument(() => {
      validateGlobQuery({ ...GLOB, pattern: '' });
    });
  });

  it('limit 必须为正整数', () => {
    expectInvalidArgument(() => {
      validateGlobQuery({ ...GLOB, limit: 0 });
    });
  });
});

function hit(uri: string, score = 1, overrides: Partial<SearchHit> = {}): SearchHit {
  return {
    uri,
    level: 'L2',
    abstract: null,
    score,
    contextType: 'memory',
    memoryType: null,
    ...overrides,
  };
}

describe('reciprocalRankFusion', () => {
  it('单个后端的分数就是 1 / (k + rank)', () => {
    const [first, second] = reciprocalRankFusion([
      { engine: 'fts5', hits: [hit('comem://user/alice/a'), hit('comem://user/alice/b')] },
    ]);

    expect(first?.uri).toBe('comem://user/alice/a');
    expect(first?.score).toBeCloseTo(1 / 61, 12);
    expect(second?.score).toBeCloseTo(1 / 62, 12);
  });

  it('两个后端都命中的 URI 分数更高', () => {
    const fused = reciprocalRankFusion([
      { engine: 'fts5', hits: [hit('comem://user/alice/a'), hit('comem://user/alice/b')] },
      { engine: 'vector', hits: [hit('comem://user/alice/b'), hit('comem://user/alice/c')] },
    ]);

    // a: 1/61，b: 1/62 + 1/61，c: 1/62
    expect(fused.map((fusedHit) => fusedHit.uri)).toEqual([
      'comem://user/alice/b',
      'comem://user/alice/a',
      'comem://user/alice/c',
    ]);
    expect(fused[0]?.score).toBeCloseTo(1 / 61 + 1 / 62, 12);
  });

  it('ranks 记每个后端的名次，没出现的记 null', () => {
    const fused = reciprocalRankFusion([
      { engine: 'fts5', hits: [hit('comem://user/alice/a')] },
      { engine: 'vector', hits: [hit('comem://user/alice/b')] },
    ]);
    const byUri = new Map(fused.map((fusedHit) => [fusedHit.uri, fusedHit]));

    expect(byUri.get('comem://user/alice/a')?.ranks).toEqual({
      fts5: 1,
      vector: null,
      hybrid: null,
    });
    expect(byUri.get('comem://user/alice/b')?.ranks).toEqual({
      fts5: null,
      vector: 1,
      hybrid: null,
    });
  });

  it('同一 URI 在多个结果集里出现只算一条，名次取最靠前的', () => {
    const fused = reciprocalRankFusion([
      { engine: 'fts5', hits: [hit('comem://user/alice/a'), hit('comem://user/alice/b')] },
      { engine: 'fts5', hits: [hit('comem://user/alice/b'), hit('comem://user/alice/a')] },
    ]);
    const target = fused.find((fusedHit) => fusedHit.uri === 'comem://user/alice/a');

    expect(fused).toHaveLength(2);
    expect(target?.ranks.fts5).toBe(1);
    expect(target?.score).toBeCloseTo(1 / 61, 12);
  });

  it('同分按 URI 升序，与输入顺序无关', () => {
    const forward = reciprocalRankFusion([
      { engine: 'fts5', hits: [hit('comem://user/alice/b')] },
      { engine: 'vector', hits: [hit('comem://user/alice/a')] },
    ]);
    const backward = reciprocalRankFusion([
      { engine: 'vector', hits: [hit('comem://user/alice/a')] },
      { engine: 'fts5', hits: [hit('comem://user/alice/b')] },
    ]);

    expect(forward.map((fusedHit) => fusedHit.uri)).toEqual([
      'comem://user/alice/a',
      'comem://user/alice/b',
    ]);
    expect(backward.map((fusedHit) => fusedHit.uri)).toEqual(
      forward.map((fusedHit) => fusedHit.uri),
    );
  });

  it('limit 截断', () => {
    const fused = reciprocalRankFusion(
      [{ engine: 'fts5', hits: [hit('a'), hit('b'), hit('c')] }],
      { limit: 2 },
    );

    expect(fused).toHaveLength(2);
  });

  it('k 可覆盖，且必须是正数', () => {
    const [fusedHit] = reciprocalRankFusion([{ engine: 'fts5', hits: [hit('a')] }], { k: 1 });

    expect(fusedHit?.score).toBeCloseTo(0.5, 12);
    expectInvalidArgument(() => reciprocalRankFusion([], { k: 0 }));
    expectInvalidArgument(() => reciprocalRankFusion([], { k: Number.NaN }));
  });

  it('limit 必须是正整数', () => {
    expectInvalidArgument(() => reciprocalRankFusion([], { limit: 0 }));
    expectInvalidArgument(() => reciprocalRankFusion([], { limit: 1.5 }));
  });

  it('空输入返回空数组', () => {
    expect(reciprocalRankFusion([])).toEqual([]);
    expect(reciprocalRankFusion([{ engine: 'fts5', hits: [] }])).toEqual([]);
  });

  it('保留命中自带的元数据，分数换成融合分', () => {
    const [fusedHit] = reciprocalRankFusion([
      {
        engine: 'fts5',
        hits: [hit('comem://user/alice/a', 12.5, { level: 'L0', abstract: '摘要' })],
      },
    ]);

    expect(fusedHit).toMatchObject({
      uri: 'comem://user/alice/a',
      level: 'L0',
      abstract: '摘要',
    });
    expect(fusedHit?.score).toBeCloseTo(1 / 61, 12);
  });
});
