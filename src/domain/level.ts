/**
 * 渐进式披露的层级（架构文档 §8.5、§9.1）。
 *
 * 这个类型被摘要、检索、排序、组装四处共用，单独成文件是为了让 W1 的两个
 * 并行实现都只依赖一个冻结的契约，而不是互相 import。
 */

export type Level = 'L0' | 'L1' | 'L2';

/** 由粗到细的顺序。需要「降级」的调用方按这个顺序走。 */
export const LEVELS = ['L0', 'L1', 'L2'] as const satisfies readonly Level[];

/** 层级的数值序，用于比较「这条记录比那条更细」。 */
export const LEVEL_ORDER: Readonly<Record<Level, number>> = {
  L0: 0,
  L1: 1,
  L2: 2,
};
