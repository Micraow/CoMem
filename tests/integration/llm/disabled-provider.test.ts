import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { DisabledLlmProvider } from '../../../src/adapters/llm/disabled-provider.js';
import { ComemError, isRetryable } from '../../../src/domain/errors.js';
import type { LlmPrompt, LlmProvider } from '../../../src/domain/llm.js';

const PROMPT: LlmPrompt = { messages: [{ role: 'user', content: '你好' }] };

/**
 * 回归（W59）：`providers.llm.default.type: disabled` 必须**不产生任何网络调用**。
 *
 * 它不是曾经删掉的那个「返回空结果」的假提供者：每个方法都抛 `INVALID_ARGUMENT`
 * （不可重试），调用方据此知道「没有模型」。选桩而不是 `null` 的理由见
 * `adapters/llm/disabled-provider.ts` 的文件头。
 */
describe('DisabledLlmProvider', () => {
  it('complete 抛 INVALID_ARGUMENT，且不发网络请求', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const provider: LlmProvider = new DisabledLlmProvider();

    await expect(provider.complete(PROMPT)).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
      details: { field: 'providers.llm.default.type' },
    });
    expect(fetchSpy).not.toHaveBeenCalled();

    fetchSpy.mockRestore();
  });

  it('completeJson 同样抛 INVALID_ARGUMENT', async () => {
    const provider: LlmProvider = new DisabledLlmProvider();

    await expect(
      provider.completeJson(PROMPT, z.object({ ok: z.boolean() })),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('INVALID_ARGUMENT 不在可重试集合里（不会白等退避）', async () => {
    const provider: LlmProvider = new DisabledLlmProvider();
    const error = await provider.complete(PROMPT).catch((caught: unknown) => caught);

    // `LlmService` 按 `isRetryable` 决定要不要重试；配置错误重试多少次都一样。
    expect(error).toBeInstanceOf(ComemError);
    expect(isRetryable(error as ComemError)).toBe(false);
  });
});
