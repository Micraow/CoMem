import { describe, expect, it } from 'vitest';

import {
  DEFAULT_LEVEL_WEIGHTS,
  applyLevelWeight,
  dedupeByRenderedText,
  perItemTokenCap,
  rankCandidates,
  truncateByTokenBudget,
} from '../../../src/domain/ranking.js';
import type { RankedCandidate } from '../../../src/domain/ranking.js';

function candidate(
  uri: string,
  level: RankedCandidate['level'],
  score: number,
  rendered = uri,
): RankedCandidate {
  return { uri, level, score, rendered };
}

describe('DEFAULT_LEVEL_WEIGHTS', () => {
  it('采用架构文档 §8.5 的经验权重', () => {
    expect(DEFAULT_LEVEL_WEIGHTS).toEqual({ l0: 1.15, l1: 1.05, l2: 1.0 });
  });
});

describe('applyLevelWeight', () => {
  it('按层级乘以默认权重', () => {
    expect(applyLevelWeight(1, 'L0', DEFAULT_LEVEL_WEIGHTS)).toBeCloseTo(1.15);
    expect(applyLevelWeight(1, 'L1', DEFAULT_LEVEL_WEIGHTS)).toBeCloseTo(1.05);
    expect(applyLevelWeight(1, 'L2', DEFAULT_LEVEL_WEIGHTS)).toBe(1);
    expect(applyLevelWeight(0, 'L0', DEFAULT_LEVEL_WEIGHTS)).toBe(0);
  });

  it('使用调用方注入的权重', () => {
    const weights = { l0: 2, l1: 1.5, l2: 1 };

    expect(applyLevelWeight(3, 'L0', weights)).toBe(6);
    expect(applyLevelWeight(3, 'L1', weights)).toBe(4.5);
    expect(applyLevelWeight(3, 'L2', weights)).toBe(3);
  });
});

describe('rankCandidates', () => {
  it('L0 词频略低时能反超 L2', () => {
    const ranked = rankCandidates(
      [candidate('l0', 'L0', 0.9), candidate('l2', 'L2', 1.0)],
      10,
    );

    expect(ranked.map((entry) => entry.uri)).toEqual(['l0', 'l2']);
    expect(ranked[0]?.score).toBeCloseTo(1.035);
    expect(ranked[1]?.score).toBe(1);
  });

  it('L2 词频明显更高时仍然赢', () => {
    const ranked = rankCandidates(
      [candidate('l0', 'L0', 0.5), candidate('l2', 'L2', 1.0)],
      10,
    );

    expect(ranked.map((entry) => entry.uri)).toEqual(['l2', 'l0']);
  });

  it('按加权分降序排列', () => {
    const ranked = rankCandidates(
      [
        candidate('a', 'L2', 0.5),
        candidate('b', 'L1', 0.8),
        candidate('c', 'L0', 1.0),
        candidate('d', 'L2', 2.0),
      ],
      10,
    );

    expect(ranked.map((entry) => entry.uri)).toEqual(['d', 'c', 'b', 'a']);
  });

  it('同分时先按层级由粗到细，再按 URI 字典序', () => {
    const weights = { l0: 1, l1: 1, l2: 1 };
    const ranked = rankCandidates(
      [
        candidate('b', 'L2', 1),
        candidate('a', 'L2', 1),
        candidate('c', 'L1', 1),
        candidate('d', 'L0', 1),
      ],
      10,
      weights,
    );

    expect(ranked.map((entry) => entry.uri)).toEqual(['d', 'c', 'a', 'b']);
  });

  it('截断到 limit 条', () => {
    const ranked = rankCandidates(
      [candidate('a', 'L2', 3), candidate('b', 'L2', 2), candidate('c', 'L2', 1)],
      2,
    );

    expect(ranked.map((entry) => entry.uri)).toEqual(['a', 'b']);
  });

  it('limit 为 0 时返回空数组', () => {
    expect(rankCandidates([candidate('a', 'L2', 3)], 0)).toEqual([]);
  });

  it('limit 大于候选数时返回全部', () => {
    expect(rankCandidates([candidate('a', 'L2', 3)], 10)).toHaveLength(1);
  });

  it('空候选返回空数组', () => {
    expect(rankCandidates([], 10)).toEqual([]);
  });

  it('使用调用方注入的权重', () => {
    const weights = { l0: 2, l1: 1, l2: 1 };
    const ranked = rankCandidates(
      [candidate('l2', 'L2', 1.0), candidate('l0', 'L0', 0.6)],
      10,
      weights,
    );

    expect(ranked.map((entry) => entry.uri)).toEqual(['l0', 'l2']);
  });

  it('不修改输入候选的分数', () => {
    const candidates = [candidate('a', 'L0', 1)];

    rankCandidates(candidates, 10);

    expect(candidates[0]?.score).toBe(1);
  });
});

describe('dedupeByRenderedText', () => {
  it('渲染后正文相同的只保留分数最高的一条', () => {
    const deduped = dedupeByRenderedText([
      candidate('a', 'L0', 2, 'same'),
      candidate('b', 'L2', 1, 'same'),
      candidate('c', 'L1', 0.5, 'other'),
    ]);

    expect(deduped.map((entry) => entry.uri)).toEqual(['a', 'c']);
  });

  it('分数更高的重复项在后面时替换前面的', () => {
    const deduped = dedupeByRenderedText([
      candidate('a', 'L0', 1, 'same'),
      candidate('b', 'L2', 2, 'same'),
    ]);

    expect(deduped.map((entry) => entry.uri)).toEqual(['b']);
  });

  it('保持输入顺序', () => {
    const deduped = dedupeByRenderedText([
      candidate('a', 'L0', 1, 'first'),
      candidate('b', 'L0', 2, 'second'),
      candidate('c', 'L0', 3, 'first'),
    ]);

    expect(deduped.map((entry) => entry.uri)).toEqual(['b', 'c']);
  });

  it('同分时保留先出现的一条', () => {
    const deduped = dedupeByRenderedText([
      candidate('a', 'L0', 1, 'same'),
      candidate('b', 'L0', 1, 'same'),
    ]);

    expect(deduped.map((entry) => entry.uri)).toEqual(['a']);
  });

  it('正文不同时全部保留', () => {
    const deduped = dedupeByRenderedText([
      candidate('a', 'L0', 1, 'a'),
      candidate('b', 'L0', 1, 'b'),
    ]);

    expect(deduped.map((entry) => entry.uri)).toEqual(['a', 'b']);
  });

  it('空输入返回空数组', () => {
    expect(dedupeByRenderedText([])).toEqual([]);
  });

  it('不修改输入数组', () => {
    const candidates = [candidate('a', 'L0', 1, 'same'), candidate('b', 'L0', 2, 'same')];

    dedupeByRenderedText(candidates);

    expect(candidates).toHaveLength(2);
  });
});

describe('truncateByTokenBudget', () => {
  const estimate = (text: string): number => text.length;

  it('预算正好够时全部保留', () => {
    const kept = truncateByTokenBudget(
      [candidate('a', 'L0', 2, 'abc'), candidate('b', 'L2', 1, '12345')],
      8,
      estimate,
    );

    expect(kept.map((entry) => entry.uri)).toEqual(['a', 'b']);
  });

  it('差一个 token 时丢掉放不下的那条', () => {
    const kept = truncateByTokenBudget(
      [candidate('a', 'L0', 2, 'abc'), candidate('b', 'L2', 1, '12345')],
      7,
      estimate,
    );

    expect(kept.map((entry) => entry.uri)).toEqual(['a']);
  });

  it('放不下的候选被跳过，后面的短候选仍可装入', () => {
    const kept = truncateByTokenBudget(
      [
        candidate('a', 'L0', 3, 'abc'),
        candidate('b', 'L2', 2, '1234567890'),
        candidate('c', 'L1', 1, '12'),
      ],
      8,
      estimate,
    );

    expect(kept.map((entry) => entry.uri)).toEqual(['a', 'c']);
  });

  it('预算为 0 时返回空数组', () => {
    expect(truncateByTokenBudget([candidate('a', 'L0', 1, 'abc')], 0, estimate)).toEqual([]);
  });

  it('预算为负数或 NaN 时返回空数组', () => {
    expect(truncateByTokenBudget([candidate('a', 'L0', 1, 'abc')], -1, estimate)).toEqual([]);
    expect(truncateByTokenBudget([candidate('a', 'L0', 1, 'abc')], Number.NaN, estimate)).toEqual(
      [],
    );
  });

  it('保持输入顺序', () => {
    const kept = truncateByTokenBudget(
      [candidate('a', 'L0', 1, 'a'), candidate('b', 'L0', 1, 'b'), candidate('c', 'L0', 1, 'c')],
      3,
      estimate,
    );

    expect(kept.map((entry) => entry.uri)).toEqual(['a', 'b', 'c']);
  });

  it('把渲染后的正文交给估算函数', () => {
    const seen: string[] = [];
    const estimator = (text: string): number => {
      seen.push(text);
      return text.length;
    };

    truncateByTokenBudget([candidate('a', 'L0', 1, 'rendered-a')], 100, estimator);

    expect(seen).toEqual(['rendered-a']);
  });

  it('空候选返回空数组', () => {
    expect(truncateByTokenBudget([], 100, estimate)).toEqual([]);
  });

  it('不修改输入数组', () => {
    const candidates = [candidate('a', 'L0', 1, 'abc')];

    truncateByTokenBudget(candidates, 1, estimate);

    expect(candidates).toHaveLength(1);
  });
});

describe('perItemTokenCap', () => {
  it('按 maxTokens / 条目数 × 2 计算', () => {
    expect(perItemTokenCap(1600, 5)).toBe(640);
    expect(perItemTokenCap(1000, 3)).toBe(666);
    expect(perItemTokenCap(1000, 7)).toBe(285);
  });

  it('token 数向下取整', () => {
    expect(perItemTokenCap(1, 3)).toBe(0);
  });

  it('条目数为 0 时返回 0，避免除零得到 Infinity', () => {
    expect(perItemTokenCap(1600, 0)).toBe(0);
  });

  it('条目数为负数时返回 0', () => {
    expect(perItemTokenCap(1600, -1)).toBe(0);
  });

  it('预算为 0 时返回 0', () => {
    expect(perItemTokenCap(0, 5)).toBe(0);
  });
});
