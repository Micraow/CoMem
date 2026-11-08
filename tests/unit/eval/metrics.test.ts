import { describe, expect, it } from 'vitest';

import { ComemError } from '../../../src/domain/errors.js';
import {
  aggregateMetrics,
  ndcgAtK,
  recallAtK,
  reciprocalRank,
  type QueryMetrics,
} from '../../../src/eval/metrics.js';

/**
 * 指标是纯函数，测试用**手算值**对比，不复制实现。
 *
 * nDCG 的三组手算值都写在用例注释里：公式里有 `log2` 与指数增益，不把中间结果
 * 写出来，「为什么是这个数」就只能靠读实现——那就不是测试，是把实现抄一遍。
 */

function expectInvalidArgument(run: () => unknown): void {
  let thrown: unknown;
  try {
    run();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(ComemError);
  if (thrown instanceof ComemError) {
    expect(thrown.code).toBe('INVALID_ARGUMENT');
  }
}

describe('recallAtK', () => {
  it('top-k 命中数与相关文档数之比', () => {
    const relevant = new Set(['a', 'c']);

    expect(recallAtK(['a', 'b', 'c'], relevant, 3)).toBe(1);
    expect(recallAtK(['a', 'b', 'c'], relevant, 1)).toBe(0.5);
    expect(recallAtK(['b', 'a', 'c'], relevant, 1)).toBe(0);
  });

  it('k 大于结果长度时按实际长度算', () => {
    const relevant = new Set(['a', 'b']);

    expect(recallAtK(['a'], relevant, 100)).toBe(0.5);
  });

  it('relevant 为空时返回 1：没有该找的不算失败', () => {
    expect(recallAtK(['a', 'b'], new Set(), 10)).toBe(1);
    expect(recallAtK([], new Set(), 10)).toBe(1);
  });

  it('retrieved 为空且 relevant 非空时返回 0', () => {
    expect(recallAtK([], new Set(['a']), 10)).toBe(0);
  });

  it('重复 URI 只算一次，召回率不会超过 1', () => {
    expect(recallAtK(['a', 'a', 'a'], new Set(['a', 'b']), 10)).toBe(0.5);
  });

  it('k 不是正整数时抛 INVALID_ARGUMENT', () => {
    expectInvalidArgument(() => recallAtK(['a'], new Set(['a']), 0));
    expectInvalidArgument(() => recallAtK(['a'], new Set(['a']), -1));
    expectInvalidArgument(() => recallAtK(['a'], new Set(['a']), 1.5));
    expectInvalidArgument(() => recallAtK(['a'], new Set(['a']), Number.NaN));
  });
});

describe('reciprocalRank', () => {
  it('第一个结果就命中时是 1', () => {
    expect(reciprocalRank(['a', 'b'], new Set(['a']))).toBe(1);
  });

  it('第一个命中排在第三位时是 1/3', () => {
    expect(reciprocalRank(['x', 'y', 'a'], new Set(['a', 'b']))).toBeCloseTo(1 / 3, 10);
  });

  it('只看第一个命中，后面的命中不影响分数', () => {
    expect(reciprocalRank(['x', 'a', 'b'], new Set(['a', 'b']))).toBe(0.5);
  });

  it('没有命中返回 0', () => {
    expect(reciprocalRank(['x', 'y'], new Set(['a']))).toBe(0);
    expect(reciprocalRank([], new Set(['a']))).toBe(0);
  });
});

describe('ndcgAtK', () => {
  it('二值相关性：手算 DCG / IDCG', () => {
    // 检索 [d2, d1, d3]，相关度 d1=1、d3=1、d2=0。
    //   DCG  = 0/log2(2) + 1/log2(3) + 1/log2(4) = 0.6309298 + 0.5 = 1.1309298
    //   IDCG = 1/log2(2) + 1/log2(3) + 0/log2(4) = 1 + 0.6309298 = 1.6309298
    //   nDCG = 1.1309298 / 1.6309298 = 0.693426
    const graded = new Map([
      ['d1', 1],
      ['d2', 0],
      ['d3', 1],
    ]);

    expect(ndcgAtK(['d2', 'd1', 'd3'], graded, 3)).toBeCloseTo(0.693426, 5);
  });

  it('分级相关性：理想排序时 nDCG 为 1', () => {
    const graded = new Map([
      ['a', 3],
      ['b', 2],
      ['c', 1],
    ]);

    expect(ndcgAtK(['a', 'b', 'c'], graded, 3)).toBeCloseTo(1, 10);
  });

  it('分级相关性：完全反序时按指数增益折损', () => {
    //   DCG  = 1/log2(2) + 3/log2(3) + 7/log2(4) = 1 + 1.892789 + 3.5 = 6.392789
    //   IDCG = 7 + 3/log2(3) + 1/log2(4) = 9.392789
    //   nDCG = 6.392789 / 9.392789 = 0.680602
    const graded = new Map([
      ['a', 3],
      ['b', 2],
      ['c', 1],
    ]);

    expect(ndcgAtK(['c', 'b', 'a'], graded, 3)).toBeCloseTo(0.680602, 5);
  });

  it('graded 里没有的文档按 rel = 0 处理', () => {
    //   DCG  = 0/log2(2) + 3/log2(3) = 1.892789
    //   IDCG = 3/log2(2) = 3
    //   nDCG = 1.892789 / 3 = 0.6309298
    const graded = new Map([['a', 2]]);

    expect(ndcgAtK(['x', 'a'], graded, 2)).toBeCloseTo(0.6309298, 6);
  });

  it('k 截断：只算前 k 位', () => {
    const graded = new Map([
      ['a', 1],
      ['b', 1],
    ]);

    expect(ndcgAtK(['a', 'b'], graded, 1)).toBe(1);
  });

  it('graded 为空或全为 0 时返回 0', () => {
    expect(ndcgAtK(['a'], new Map(), 10)).toBe(0);
    expect(ndcgAtK(['a'], new Map([['a', 0]]), 10)).toBe(0);
  });

  it('k 不是正整数时抛 INVALID_ARGUMENT', () => {
    expectInvalidArgument(() => ndcgAtK(['a'], new Map([['a', 1]]), 0));
    expectInvalidArgument(() => ndcgAtK(['a'], new Map([['a', 1]]), -3));
  });
});

describe('aggregateMetrics', () => {
  const first: QueryMetrics = { recallAtK: 1, reciprocalRank: 1, ndcgAtK: 0.8, hits: 2 };
  const second: QueryMetrics = { recallAtK: 0.5, reciprocalRank: 0.25, ndcgAtK: 0.4, hits: 1 };

  it('各指标取算术平均，并记录查询条数', () => {
    const aggregate = aggregateMetrics([first, second]);

    expect(aggregate.queryCount).toBe(2);
    expect(aggregate.recallAtK).toBeCloseTo(0.75, 10);
    expect(aggregate.mrr).toBeCloseTo(0.625, 10);
    expect(aggregate.ndcgAtK).toBeCloseTo(0.6, 10);
    expect(aggregate.meanHits).toBeCloseTo(1.5, 10);
  });

  it('空输入返回全 0，不产生 NaN', () => {
    const aggregate = aggregateMetrics([]);

    expect(aggregate.queryCount).toBe(0);
    expect(aggregate.recallAtK).toBe(0);
    expect(aggregate.mrr).toBe(0);
    expect(aggregate.ndcgAtK).toBe(0);
    expect(aggregate.meanHits).toBe(0);
    expect(Number.isNaN(aggregate.recallAtK)).toBe(false);
  });
});
