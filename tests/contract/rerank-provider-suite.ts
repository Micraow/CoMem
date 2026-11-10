/**
 * `RerankProvider` 的跨实现契约（`domain/rerank.ts`）。
 *
 * 当前只有一个实现（`HttpRerankProvider`），关闭态是 `undefined` 而不是另一个
 * provider。套件仍然按端口契约写：第二个实现接进来时只需注册一次。
 *
 * 关键契约是「返回值与入参同序同长、缺失位置是 `null`」。按结果顺序回填会把第 3
 * 条文档的分数写到第 1 条上，而且不报错——这正是套件要拦的。
 */

import { describe, expect, it } from 'vitest';

import type { RerankProvider } from '../../src/domain/rerank.js';
import {
  describeProviderFailureMapping,
  expectComemFailure,
  rejection,
  type ProviderFailure,
} from './conformance.js';

/** 供应商返回的一条结果：`score` 故意是 `unknown`，用来喂字符串 / NaN / 缺失。 */
export interface RerankWireResult {
  readonly index: number | string;
  readonly score: unknown;
}

export type RerankInvalidResponse =
  | { readonly kind: 'missing-results' }
  | { readonly kind: 'non-json' };

export interface RerankConformanceSubject {
  readonly name: string;
  /** 配置里的模型标识。 */
  readonly model: string;
  /** 用「按 `index` 回填」的传输层构造 provider。 */
  readonly create: (results: readonly RerankWireResult[]) => RerankProvider;
  /** 用非法响应构造 provider（缺 results / 非 JSON）。 */
  readonly createInvalid: (response: RerankInvalidResponse) => RerankProvider;
  /** 传输层收到的请求次数。 */
  readonly requests: () => number;
  readonly reset: () => void;
  /** 触发一次必然失败的 `score` 调用。 */
  readonly fail: (failure: ProviderFailure) => Promise<unknown>;
}

export function describeRerankProviderConformance(subject: RerankConformanceSubject): void {
  describe(`RerankProvider 契约（${subject.name}）`, () => {
    it('model 是配置值，且非空', () => {
      subject.reset();
      const provider = subject.create([]);

      expect(provider.model).toBe(subject.model);
      expect(provider.model.length).toBeGreaterThan(0);
    });

    it('空 documents 返回 []，且不发请求', async () => {
      subject.reset();
      const provider = subject.create([]);

      const scores = await provider.score('查询', []);

      expect(scores).toEqual([]);
      expect(subject.requests()).toBe(0);
    });

    it('按 index 回填，不按结果顺序', async () => {
      subject.reset();
      const provider = subject.create([
        { index: 2, score: 0.2 },
        { index: 0, score: 0.9 },
        { index: 1, score: 0.5 },
      ]);

      const scores = await provider.score('查询', ['文档一', '文档二', '文档三']);

      expect(scores).toEqual([0.9, 0.5, 0.2]);
    });

    it('只返回部分 index 时，缺失位置是 null', async () => {
      subject.reset();
      const provider = subject.create([
        { index: 0, score: 0.9 },
        { index: 2, score: 0.7 },
      ]);

      const scores = await provider.score('查询', ['文档一', '文档二', '文档三']);

      expect(scores).toEqual([0.9, null, 0.7]);
    });

    it('越界、非整数 index 与不可用分数都读作 null', async () => {
      subject.reset();
      const provider = subject.create([
        { index: 9, score: 0.9 },
        { index: -1, score: 0.8 },
        { index: '0', score: 0.7 },
        { index: 0, score: Number.NaN },
        { index: 1, score: Number.POSITIVE_INFINITY },
      ]);

      const scores = await provider.score('查询', ['文档一', '文档二']);

      expect(scores).toEqual([null, null]);
    });

    it('返回值与入参同长（多出来的分数不写进结果）', async () => {
      subject.reset();
      const provider = subject.create([
        { index: 0, score: 0.9 },
        { index: 1, score: 0.8 },
        { index: 2, score: 0.7 },
      ]);

      const scores = await provider.score('查询', ['文档一', '文档二']);

      expect(scores).toHaveLength(2);
    });

    it.each([
      ['缺 results 数组', { kind: 'missing-results' } as const],
      ['非 JSON 响应', { kind: 'non-json' } as const],
    ])('非法响应（%s）→ INVALID_ARGUMENT', async (_label, response) => {
      subject.reset();
      const caught = await rejection(subject.createInvalid(response).score('查询', ['文档一']));

      expectComemFailure(caught, { code: 'INVALID_ARGUMENT', retryable: false });
    });
  });

  describeProviderFailureMapping({
    name: subject.name,
    fail: (failure) => subject.fail(failure),
  });
}
