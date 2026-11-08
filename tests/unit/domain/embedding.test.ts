import { describe, expect, it } from 'vitest';

import { ComemError } from '../../../src/domain/errors.js';
import { assertValidVector, normalizeVector } from '../../../src/domain/embedding.js';

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

function norm(vector: readonly number[]): number {
  return Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
}

describe('normalizeVector', () => {
  it('归一化后模长为 1', () => {
    for (const vector of [
      [3, 4],
      [0.1, -0.2, 0.3, -0.4],
      [1],
    ]) {
      expect(norm(normalizeVector(vector))).toBeCloseTo(1, 9);
    }
  });

  it('归一化不改变方向', () => {
    const normalized = normalizeVector([3, 4]);

    expect(normalized[0]).toBeCloseTo(0.6, 12);
    expect(normalized[1]).toBeCloseTo(0.8, 12);
    // 方向不变 = 分量之间的比值不变。
    expect((normalized[1] ?? 0) / (normalized[0] ?? 1)).toBeCloseTo(4 / 3, 12);
  });

  it('全零向量原样返回（模长 0，不是 NaN）', () => {
    expect(normalizeVector([0, 0, 0])).toEqual([0, 0, 0]);
    expect(norm(normalizeVector([0, 0, 0]))).toBe(0);
  });

  it('返回新数组，不共享入参引用', () => {
    const vector = [1, 0];
    const normalized = normalizeVector(vector);

    expect(normalized).not.toBe(vector);
  });
});

describe('assertValidVector', () => {
  it('合法向量通过', () => {
    expect(() => {
      assertValidVector([1, 0, -2], 3);
    }).not.toThrow();
  });

  it('含 NaN 拒绝', () => {
    expectInvalidArgument(() => {
      assertValidVector([1, Number.NaN, 0], 3);
    });
  });

  it('含 Infinity 拒绝', () => {
    expectInvalidArgument(() => {
      assertValidVector([1, Number.POSITIVE_INFINITY], 2);
    });
    expectInvalidArgument(() => {
      assertValidVector([Number.NEGATIVE_INFINITY, 1], 2);
    });
  });

  it('维度不匹配拒绝，并带 expected / actual', () => {
    const error = expectInvalidArgument(() => {
      assertValidVector([1, 2], 3);
    });

    expect(error.details).toMatchObject({ expected: 3, actual: 2 });
  });

  it('全零向量拒绝', () => {
    expectInvalidArgument(() => {
      assertValidVector([0, 0, 0], 3);
    });
  });

  it('维度不是正整数拒绝', () => {
    expectInvalidArgument(() => {
      assertValidVector([1], 0);
    });
    expectInvalidArgument(() => {
      assertValidVector([1], 1.5);
    });
  });
});
