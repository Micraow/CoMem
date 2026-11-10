/**
 * `LlmProvider` 的跨实现契约（`domain/llm.ts`）。
 *
 * 注册的实现（`tests/contract/llm-providers.test.ts`）：
 * - `AiSdkLlmProvider`（真实适配器，两个供应商分支）
 * - `FakeLlmProvider`（测试替身）
 * - `DisabledLlmProvider`（关闭态桩，单独一组用例）
 *
 * 这里只断言「换一个实现，调用方看到的形状与失败码不变」。供应商选择、prompt 翻译、
 * `finishReason` 的具体映射表都不在契约里——那是实现特有的协议细节。
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { ComemError } from '../../src/domain/errors.js';
import type { LlmPrompt, LlmProvider } from '../../src/domain/llm.js';
import {
  describeProviderFailureMapping,
  expectComemFailure,
  PASS_THROUGH_MESSAGE,
  rejection,
  type ProviderFailure,
} from './conformance.js';

/** 契约用例统一使用的提示词：不假设任何供应商格式。 */
export const CONFORMANCE_PROMPT: LlmPrompt = {
  messages: [{ role: 'user', content: '用一句话说明这个接口的返回值形状。' }],
};

/** 契约用例统一使用的结构化输出 schema。 */
export const CONFORMANCE_SCHEMA = z.object({ ok: z.boolean() });

export interface LlmConformanceSubject {
  readonly name: string;
  /** 每次调用都成功的实例。 */
  readonly create: () => LlmProvider;
  /** `completeJson` 每次调用都成功的实例。 */
  readonly createJson: () => LlmProvider;
  /** 让一次 `complete` 以未知异常失败。 */
  readonly failUnknown: () => Promise<unknown>;
  /** 让一次 `complete` 透传调用方给定的 `ComemError`。 */
  readonly failWithComem: (error: ComemError) => Promise<unknown>;
  /** 让一次 `completeJson` 因输出不符合 schema 而失败。 */
  readonly failJsonSchema: () => Promise<unknown>;
  /**
   * 会与供应商传输层打交道的实现才提供它。测试替身按设计不映射传输错误。
   */
  readonly providerFailure?: (failure: ProviderFailure) => Promise<unknown>;
}

/** `finishReason` 是契约的一部分：调用方靠它区分「说完了」与「被截断」。 */
const FINISH_REASONS: readonly string[] = ['stop', 'length', 'refusal'];

function expectLlmResultShape(result: Awaited<ReturnType<LlmProvider['complete']>>): void {
  expect(typeof result.text).toBe('string');
  expect(result.usage).toEqual({
    promptTokens: expect.any(Number),
    completionTokens: expect.any(Number),
  });
  expect(Number.isInteger(result.usage.promptTokens)).toBe(true);
  expect(Number.isInteger(result.usage.completionTokens)).toBe(true);
  expect(result.usage.promptTokens).toBeGreaterThanOrEqual(0);
  expect(result.usage.completionTokens).toBeGreaterThanOrEqual(0);
  expect(FINISH_REASONS).toContain(result.finishReason);
}

export function describeLlmProviderConformance(subject: LlmConformanceSubject): void {
  describe(`LlmProvider 契约（${subject.name}）`, () => {
    it('complete 成功时返回完整、类型正确的 LlmResult', async () => {
      const result = await subject.create().complete(CONFORMANCE_PROMPT);

      expectLlmResultShape(result);
    });

    it('completeJson 成功时返回经过 schema 校验的值', async () => {
      const value = await subject
        .createJson()
        .completeJson(CONFORMANCE_PROMPT, CONFORMANCE_SCHEMA);

      expect(value).toEqual({ ok: true });
    });

    it('completeJson 输出不符合 schema 时抛 INVALID_ARGUMENT', async () => {
      const caught = await rejection(subject.failJsonSchema());

      expectComemFailure(caught, { code: 'INVALID_ARGUMENT', retryable: false });
    });

    it('已经是 ComemError 的失败原样透传（同一实例）', async () => {
      const original = new ComemError('RESOURCE_EXHAUSTED', PASS_THROUGH_MESSAGE);
      const caught = await rejection(subject.failWithComem(original));

      expect(caught).toBe(original);
      expectComemFailure(caught, { code: 'RESOURCE_EXHAUSTED', retryable: true });
    });

    it('未知异常收敛成 ComemError(INTERNAL)', async () => {
      const caught = await rejection(subject.failUnknown());

      expectComemFailure(caught, {
        code: 'INTERNAL',
        retryable: false,
        endsWithPeriod: false,
      });
    });
  });

  if (subject.providerFailure !== undefined) {
    describeProviderFailureMapping({
      name: subject.name,
      fail: subject.providerFailure,
    });
  }
}

/**
 * 关闭态（`providers.llm.default.type: disabled`）的契约。
 *
 * 关闭态不是「成功但返回空」：它必须让每个方法都以 `INVALID_ARGUMENT` 失败，
 * 且该码不在可重试集合里。否则调用方会把「没配模型」当成一次可重试的供应商抖动，
 * 在退避里白等。
 */
export function describeDisabledLlmConformance(subject: {
  readonly name: string;
  readonly create: () => LlmProvider;
}): void {
  describe(`LlmProvider 关闭态契约（${subject.name}）`, () => {
    it('complete 与 completeJson 都抛 INVALID_ARGUMENT（不可重试）', async () => {
      const provider = subject.create();

      const completeCaught = await rejection(provider.complete(CONFORMANCE_PROMPT));
      expectComemFailure(completeCaught, { code: 'INVALID_ARGUMENT', retryable: false });

      const jsonCaught = await rejection(
        provider.completeJson(CONFORMANCE_PROMPT, CONFORMANCE_SCHEMA),
      );
      expectComemFailure(jsonCaught, { code: 'INVALID_ARGUMENT', retryable: false });
    });

    it('两个方法的失败消息一致（同一件事只有一种说法）', async () => {
      const provider = subject.create();

      const completeCaught = await rejection(provider.complete(CONFORMANCE_PROMPT));
      const jsonCaught = await rejection(
        provider.completeJson(CONFORMANCE_PROMPT, CONFORMANCE_SCHEMA),
      );

      expect((completeCaught as Error).message).toBe((jsonCaught as Error).message);
    });
  });
}
