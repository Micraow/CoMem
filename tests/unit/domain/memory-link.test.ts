import { describe, expect, it } from 'vitest';

import { mergeWeight } from '../../../src/domain/memory-link.js';

describe('mergeWeight', () => {
  it('取较大的权重', () => {
    expect(mergeWeight(1, 5)).toBe(5);
    expect(mergeWeight(5, 1)).toBe(5);
  });

  it('相等时保持原值（不是相加）', () => {
    expect(mergeWeight(3, 3)).toBe(3);
  });

  it('不会因为重复写入而累加', () => {
    let weight = 2;
    for (let index = 0; index < 10; index += 1) {
      weight = mergeWeight(weight, 2);
    }
    expect(weight).toBe(2);
  });
});
