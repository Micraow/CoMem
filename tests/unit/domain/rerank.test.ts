import { describe, expect, it } from 'vitest';

import { applyRerank, isFiniteScore, type RerankCandidate } from '../../../src/domain/rerank.js';

function candidate(uri: string, fallbackScore: number, text = `${uri} 的正文`): RerankCandidate {
  return { uri, text, fallbackScore };
}

describe('isFiniteScore', () => {
  it('有限数是可用分数', () => {
    for (const value of [0, 0.5, -1, 1e-9, Number.MAX_SAFE_INTEGER]) {
      expect(isFiniteScore(value)).toBe(true);
    }
  });

  it('NaN / Infinity 不可用', () => {
    expect(isFiniteScore(Number.NaN)).toBe(false);
    expect(isFiniteScore(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isFiniteScore(Number.NEGATIVE_INFINITY)).toBe(false);
  });

  it('字符串不做隐式转换：`"0.5"` 是 false', () => {
    // `Number('0.5')` 能转成 0.5，但供应商返回字符串说明它没按契约实现；
    // 静默转换会把 `''`（→ 0）和 `'abc'`（→ NaN）也一起放进来。
    expect(isFiniteScore('0.5')).toBe(false);
    expect(isFiniteScore('')).toBe(false);
  });

  it('null / undefined / 对象 / 布尔值都不可用', () => {
    for (const value of [null, undefined, {}, [0.5], true]) {
      expect(isFiniteScore(value)).toBe(false);
    }
  });
});

describe('applyRerank 正常合并', () => {
  it('模型分数覆盖兜底分，逐条标记来源', () => {
    const candidates = [candidate('a', 0.1), candidate('b', 0.2), candidate('c', 0.3)];

    const result = applyRerank(candidates, [0.9, 0.5, 0.4]);

    expect(result.scores).toEqual([0.9, 0.5, 0.4]);
    expect(result.reranked).toEqual([true, true, true]);
  });

  it('保持入参顺序与长度', () => {
    const candidates = [candidate('a', 0), candidate('b', 0)];

    const result = applyRerank(candidates, [0.2, 0.8]);

    expect(result.scores).toHaveLength(candidates.length);
    expect(result.reranked).toHaveLength(candidates.length);
  });

  it('空候选返回空结果', () => {
    expect(applyRerank([], [0.9])).toEqual({ scores: [], reranked: [] });
  });

  it('不修改入参', () => {
    const candidates = Object.freeze([candidate('a', 0.1), candidate('b', 0.2)]);
    const modelScores = Object.freeze([0.9]);

    const result = applyRerank(candidates, modelScores);

    expect(result.scores).toEqual([0.9, 0.2]);
  });
});

describe('applyRerank 兜底', () => {
  it('modelScores 为 null 时全部用兜底分', () => {
    const candidates = [candidate('a', 0.11), candidate('b', 0.22)];

    const result = applyRerank(candidates, null);

    expect(result.scores).toEqual([0.11, 0.22]);
    expect(result.reranked).toEqual([false, false]);
  });

  it('模型返回的比候选短：尾部用兜底分', () => {
    const candidates = [candidate('a', 0.1), candidate('b', 0.2), candidate('c', 0.3)];

    const result = applyRerank(candidates, [0.9]);

    expect(result.scores).toEqual([0.9, 0.2, 0.3]);
    expect(result.reranked).toEqual([true, false, false]);
  });

  it('模型返回的比候选长：多出来的分数丢弃，不错位', () => {
    const candidates = [candidate('a', 0.1)];

    const result = applyRerank(candidates, [0.9, 0.5, 0.4]);

    expect(result.scores).toEqual([0.9]);
    expect(result.reranked).toEqual([true]);
  });

  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ['undefined', undefined],
    ['null', null],
  ])('单项是 %s 时只兜底那一条，其余保留模型分数', (_label, bad) => {
    const candidates = [candidate('a', 0.1), candidate('b', 0.2), candidate('c', 0.3)];

    const result = applyRerank(candidates, [0.9, bad, 0.4]);

    expect(result.scores).toEqual([0.9, 0.2, 0.4]);
    expect(result.reranked).toEqual([true, false, true]);
  });

  it('兜底分原样返回，包括 0', () => {
    const result = applyRerank([candidate('a', 0)], [null]);

    expect(result.scores).toEqual([0]);
    expect(result.reranked).toEqual([false]);
  });
});

describe('applyRerank 的空文本候选', () => {
  it('text 为空串时不送模型，reranked 是 false', () => {
    const candidates = [candidate('a', 0.5, ''), candidate('b', 0.5, '正文')];

    const result = applyRerank(candidates, [0.9, 0.8]);

    expect(result.scores).toEqual([0.5, 0.8]);
    expect(result.reranked).toEqual([false, true]);
  });

  it('只有空白的文本同样跳过（trim 之后是空串）', () => {
    const candidates = [candidate('a', 0.5, '  \n\t ')];

    const result = applyRerank(candidates, [0.9]);

    expect(result.scores).toEqual([0.5]);
    expect(result.reranked).toEqual([false]);
  });
});
