import { describe, expect, it } from 'vitest';

import { ComemError } from '../../../src/domain/errors.js';
import {
  assertValidVector,
  cosineSimilarity,
  dequantizeVector,
  normalizeVector,
  quantizeVector,
} from '../../../src/domain/embedding.js';

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

describe('cosineSimilarity', () => {
  it('正交向量返回 0', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
    expect(cosineSimilarity([1, 0, 0], [0, 1, 0])).toBe(0);
  });

  it('同向向量返回 1', () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 12);
    // 同一方向、不同长度：余弦只看方向。
    expect(cosineSimilarity([1, 2, 3], [2, 4, 6])).toBeCloseTo(1, 12);
  });

  it('反向向量返回 -1', () => {
    expect(cosineSimilarity([1, 2, 3], [-1, -2, -3])).toBeCloseTo(-1, 12);
  });

  it('全零向量返回 0 而不是 NaN', () => {
    expect(cosineSimilarity([0, 0, 0], [1, 2, 3])).toBe(0);
    expect(cosineSimilarity([0, 0], [0, 0])).toBe(0);
  });

  it('维度不匹配抛 INVALID_ARGUMENT', () => {
    expectInvalidArgument(() => cosineSimilarity([1, 2], [1, 2, 3]));
  });

  it('空向量抛 INVALID_ARGUMENT', () => {
    expectInvalidArgument(() => cosineSimilarity([], []));
  });
});

describe('quantizeVector / dequantizeVector', () => {
  it('量化往返误差小于 scale / 2', () => {
    const vector = [0.1, -0.5, 0.9, 0.004, -1];
    const maxAbs = Math.max(...vector.map((value) => Math.abs(value)));
    const scale = maxAbs / 127;

    const restored = dequantizeVector(quantizeVector(vector), scale);

    expect(restored).toHaveLength(vector.length);
    for (const [index, value] of vector.entries()) {
      expect(Math.abs((restored[index] ?? Number.NaN) - value)).toBeLessThanOrEqual(scale / 2);
    }
  });

  it('最大分量落在 ±127，不会被回绕成反号', () => {
    const quantized = quantizeVector([0.3, -0.3]);

    expect(quantized[0]).toBe(127);
    expect(quantized[1]).toBe(-127);
  });

  it('全零向量的 scale 为 0，往返不炸', () => {
    const quantized = quantizeVector([0, 0, 0]);

    expect(Array.from(quantized)).toEqual([0, 0, 0]);
    expect(dequantizeVector(quantized, 0)).toEqual([0, 0, 0]);
  });

  it('空向量往返为空', () => {
    expect(Array.from(quantizeVector([]))).toEqual([]);
    expect(dequantizeVector(quantizeVector([]), 0)).toEqual([]);
  });

  it('负 scale 抛 INVALID_ARGUMENT', () => {
    expectInvalidArgument(() => dequantizeVector(new Int8Array([1, 2]), -1));
  });

  it('非有限 scale 抛 INVALID_ARGUMENT', () => {
    expectInvalidArgument(() => dequantizeVector(new Int8Array([1, 2]), Number.NaN));
    expectInvalidArgument(() => dequantizeVector(new Int8Array([1, 2]), Number.POSITIVE_INFINITY));
  });
});

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
    expect(cosineSimilarity(normalized, [3, 4])).toBeCloseTo(1, 12);
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
