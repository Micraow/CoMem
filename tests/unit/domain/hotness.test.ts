import { describe, expect, it } from 'vitest';

import { ComemError } from '../../../src/domain/errors.js';
import {
  DEFAULT_HALF_LIFE_DAYS,
  hotnessScore,
} from '../../../src/domain/hotness.js';

/** 固定「现在」，让所有采样点的年龄是精确的整数天。 */
const NOW = new Date('2026-11-08T12:00:00.000Z');

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * MILLISECONDS_PER_DAY).toISOString();
}

function score(activeCount: number, ageDays = 0, halfLifeDays = DEFAULT_HALF_LIFE_DAYS): number {
  return hotnessScore({
    activeCount,
    lastAccessedAt: daysAgo(ageDays),
    now: NOW,
    halfLifeDays,
  });
}

const INVALID_ARGUMENT = expect.objectContaining({ code: 'INVALID_ARGUMENT' });

describe('hotnessScore 的频率项', () => {
  it('访问次数越多分数越高，且都落在 [0, 1]', () => {
    const counts = [0, 1, 10, 1000];
    const scores = counts.map((count) => score(count));

    for (const [index, value] of scores.entries()) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
      if (index > 0) {
        expect(value).toBeGreaterThan(scores[index - 1] ?? 0);
      }
    }
  });

  it('次数取对数再 sigmoid：1 → 10 的增幅大于 10 → 1000 的增幅', () => {
    const one = score(1);
    const ten = score(10);
    const thousand = score(1000);

    expect(ten - one).toBeGreaterThan(thousand - ten);
  });

  it('次数为 0 但访问时间存在时是 sigmoid(0) = 0.5（不是 0，也不是 1）', () => {
    expect(score(0)).toBeCloseTo(0.5, 12);
  });
});

describe('hotnessScore 的衰减项', () => {
  it('同样的访问次数，越旧分数越低', () => {
    const ages = [0, 1, 7, 30];
    const scores = ages.map((age) => score(5, age));

    for (const [index, value] of scores.entries()) {
      if (index > 0) {
        expect(value).toBeLessThan(scores[index - 1] ?? Number.POSITIVE_INFINITY);
      }
    }
  });

  it('恰好一个半衰期后分数减半（容差 1e-9）', () => {
    const fresh = score(4);
    const afterHalfLife = score(4, DEFAULT_HALF_LIFE_DAYS);

    expect(Math.abs(afterHalfLife - fresh / 2)).toBeLessThan(1e-9);
  });

  it('半衰期可变：3 天半衰期下第 3 天减半', () => {
    const fresh = score(4, 0, 3);
    const after = score(4, 3, 3);

    expect(Math.abs(after - fresh / 2)).toBeLessThan(1e-9);
  });

  it('两个半衰期后是四分之一', () => {
    const fresh = score(4);
    const after = score(4, DEFAULT_HALF_LIFE_DAYS * 2);

    expect(Math.abs(after - fresh / 4)).toBeLessThan(1e-9);
  });

  it('未来时间戳（时钟不同步）按 0 天算，分数不超过 1', () => {
    const future = hotnessScore({
      activeCount: 1000,
      lastAccessedAt: new Date(NOW.getTime() + 3 * MILLISECONDS_PER_DAY).toISOString(),
      now: NOW,
      halfLifeDays: DEFAULT_HALF_LIFE_DAYS,
    });

    expect(future).toBe(score(1000, 0));
    expect(future).toBeLessThanOrEqual(1);
  });
});

describe('hotnessScore 的边界与校验', () => {
  it('lastAccessedAt 为 null 时返回 0', () => {
    for (const activeCount of [0, 1, 100]) {
      expect(
        hotnessScore({
          activeCount,
          lastAccessedAt: null,
          now: NOW,
          halfLifeDays: DEFAULT_HALF_LIFE_DAYS,
        }),
      ).toBe(0);
    }
  });

  it('非法时间串抛 INVALID_ARGUMENT，不当 0 处理', () => {
    expect(() =>
      hotnessScore({
        activeCount: 3,
        lastAccessedAt: 'not-a-date',
        now: NOW,
        halfLifeDays: DEFAULT_HALF_LIFE_DAYS,
      }),
    ).toThrowError(INVALID_ARGUMENT);
  });

  it('activeCount 为负数抛 INVALID_ARGUMENT', () => {
    expect(() => score(-1)).toThrowError(INVALID_ARGUMENT);
  });

  it('activeCount 为 NaN 抛 INVALID_ARGUMENT', () => {
    expect(() => score(Number.NaN)).toThrowError(INVALID_ARGUMENT);
  });

  it('halfLifeDays <= 0 抛 INVALID_ARGUMENT（0 是除数）', () => {
    for (const halfLifeDays of [0, -7]) {
      expect(() => score(1, 1, halfLifeDays)).toThrowError(INVALID_ARGUMENT);
    }
  });

  it('halfLifeDays 非有限数抛 INVALID_ARGUMENT', () => {
    expect(() => score(1, 1, Number.POSITIVE_INFINITY)).toThrowError(INVALID_ARGUMENT);
  });

  it('参数校验先于 null 短路：数据没访问过也挡掉坏配置', () => {
    expect(() =>
      hotnessScore({ activeCount: 1, lastAccessedAt: null, now: NOW, halfLifeDays: 0 }),
    ).toThrowError(INVALID_ARGUMENT);
  });

  it('now 是非法 Date 时抛 INVALID_ARGUMENT', () => {
    expect(() =>
      hotnessScore({
        activeCount: 1,
        lastAccessedAt: daysAgo(1),
        now: new Date(Number.NaN),
        halfLifeDays: DEFAULT_HALF_LIFE_DAYS,
      }),
    ).toThrowError(INVALID_ARGUMENT);
  });

  it('默认半衰期是 7 天', () => {
    expect(DEFAULT_HALF_LIFE_DAYS).toBe(7);
  });

  it('抛出的错误是 ComemError 且带字段上下文', () => {
    try {
      score(-1);
      throw new Error('期望抛出');
    } catch (error) {
      expect(error).toBeInstanceOf(ComemError);
      expect((error as ComemError).details).toMatchObject({ activeCount: -1 });
    }
  });
});
