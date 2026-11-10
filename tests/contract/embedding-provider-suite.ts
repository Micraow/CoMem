/**
 * `EmbeddingProvider` 的跨实现契约（`domain/embedding.ts`）。
 *
 * 当前仓库里只有一个真实实现（`AiSdkEmbeddingProvider`）；关闭态不是另一个
 * provider 实现，而是 `EmbeddingService` 拿到 `provider: null`。套件仍然按端口契约
 * 写，第二个实现接进来时只需要注册一次，不必重新想一遍「哪些行为必须一致」。
 *
 * 传输层的义务（注册方负责）：对形如 `t<N>` 的文本返回首分量为 `N + 1`、其余分量
 * 为 0、长度为 `dimension` 的向量；并记录每次调用收到的文本批次。没有这条约定就
 * 无法在不绑定供应商协议的前提下断言「输出与入参同序」。
 */

import { describe, expect, it } from 'vitest';

import type { EmbeddingProvider } from '../../src/domain/embedding.js';
import {
  describeProviderFailureMapping,
  expectComemFailure,
  rejection,
  type ProviderFailure,
} from './conformance.js';

export type EmbeddingFailure =
  | ProviderFailure
  | { readonly kind: 'vector-dimension'; readonly actual: number };

export interface EmbeddingConformanceSubject {
  readonly name: string;
  /** 配置里的模型标识，成功结果不改变它。 */
  readonly model: string;
  /** 配置里的向量维度。 */
  readonly dimension: number;
  /** 用当前传输层实例构造 provider。 */
  readonly create: (options?: { readonly maxBatchSize?: number }) => EmbeddingProvider;
  /** 传输层收到的文本批次，按调用顺序。 */
  readonly batches: () => readonly (readonly string[])[];
  /** 重置传输层记录并安装「成功」实现。每个用例前调用。 */
  readonly reset: () => void;
  /** 触发一次必然失败的 `embed`。 */
  readonly fail: (failure: EmbeddingFailure) => Promise<unknown>;
}

/** 契约用例的输入：文本内容编码了期望的向量首分量。 */
const TEXTS = ['t0', 't1', 't2', 't3', 't4'] as const;

function expectedFirstComponents(count: number): number[] {
  return Array.from({ length: count }, (_value, index) => index + 1);
}

export function describeEmbeddingProviderConformance(
  subject: EmbeddingConformanceSubject,
): void {
  describe(`EmbeddingProvider 契约（${subject.name}）`, () => {
    it('model 与 dimension 是配置值，且是稳定的状态字段', () => {
      const provider = subject.create();

      expect(provider.model).toBe(subject.model);
      expect(provider.model.length).toBeGreaterThan(0);
      expect(provider.dimension).toBe(subject.dimension);
      expect(Number.isInteger(provider.dimension)).toBe(true);
      expect(provider.dimension).toBeGreaterThan(0);
    });

    it('空输入返回空向量与零 usage，且不产生任何传输调用', async () => {
      subject.reset();
      const provider = subject.create();

      const result = await provider.embed([]);

      expect(result).toEqual({
        vectors: [],
        usage: { promptTokens: 0, totalTokens: 0 },
      });
      expect(subject.batches()).toEqual([]);
    });

    it('单条输入返回一条同维度的有限数向量', async () => {
      subject.reset();
      const provider = subject.create();

      const result = await provider.embed(['t0']);

      expect(result.vectors).toHaveLength(1);
      const vector = result.vectors[0];
      expect(vector).toHaveLength(subject.dimension);
      for (const value of vector ?? []) {
        expect(Number.isFinite(value)).toBe(true);
      }
      expect(Number.isInteger(result.usage.promptTokens)).toBe(true);
      expect(Number.isInteger(result.usage.totalTokens)).toBe(true);
      expect(result.usage.promptTokens).toBeGreaterThanOrEqual(0);
      expect(result.usage.totalTokens).toBeGreaterThanOrEqual(result.usage.promptTokens);
    });

    it('按 maxBatchSize 分批，输出与入参同序同长', async () => {
      subject.reset();
      const provider = subject.create({ maxBatchSize: 2 });

      const result = await provider.embed(TEXTS);

      expect(subject.batches()).toEqual([['t0', 't1'], ['t2', 't3'], ['t4']]);
      expect(result.vectors).toHaveLength(TEXTS.length);
      expect(result.vectors.map((vector) => vector[0])).toEqual(
        expectedFirstComponents(TEXTS.length),
      );
      for (const vector of result.vectors) {
        expect(vector).toHaveLength(subject.dimension);
      }
    });

    it('维度不匹配是配置错误：INVALID_ARGUMENT、不可重试、带两边实际值', async () => {
      const actual = subject.dimension + 1;
      const caught = await rejection(subject.fail({ kind: 'vector-dimension', actual }));

      const error = expectComemFailure(caught, {
        code: 'INVALID_ARGUMENT',
        retryable: false,
      });
      expect(error.details).toMatchObject({
        expected: subject.dimension,
        actual,
        model: subject.model,
      });
      // 两个数字都要在消息里：只带 details 时，读日志的人不知道该改配置还是换模型。
      expect(error.message).toContain(String(subject.dimension));
      expect(error.message).toContain(String(actual));
    });
  });

  describeProviderFailureMapping({
    name: subject.name,
    fail: (failure) => subject.fail(failure),
  });
}
