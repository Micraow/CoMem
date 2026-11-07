import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { FakeLlmProvider } from '../../../src/adapters/llm/fake-provider.js';
import { ComemError } from '../../../src/domain/errors.js';
import type { LlmPrompt } from '../../../src/domain/llm.js';

const PROMPT: LlmPrompt = { messages: [{ role: 'user', content: '你好' }] };

describe('FakeLlmProvider', () => {
  it('按顺序消费响应', async () => {
    const provider = new FakeLlmProvider([{ text: '第一句' }, { text: '第二句' }]);

    expect(await provider.complete(PROMPT)).toMatchObject({ text: '第一句' });
    expect(await provider.complete(PROMPT)).toMatchObject({ text: '第二句' });
    expect(provider.remaining).toBe(0);
  });

  it('用尽后抛 INTERNAL（测试里出现了预期外的调用）', async () => {
    const provider = new FakeLlmProvider([{ text: '只有一次' }]);
    await provider.complete(PROMPT);

    expect(provider.remaining).toBe(0);
    await expect(provider.complete(PROMPT)).rejects.toMatchObject({ code: 'INTERNAL' });
  });

  it('透传 finishReason 与 usage，缺省值补 0 / stop', async () => {
    const provider = new FakeLlmProvider([
      { text: 'x', finishReason: 'length', usage: { promptTokens: 3 } },
    ]);

    const result = await provider.complete(PROMPT);

    expect(result.finishReason).toBe('length');
    expect(result.usage).toEqual({ promptTokens: 3, completionTokens: 0 });
  });

  it('error 透传', async () => {
    const error = new ComemError('RESOURCE_EXHAUSTED', '配额不足。');
    const provider = new FakeLlmProvider([{ error }]);

    await expect(provider.complete(PROMPT)).rejects.toBe(error);
  });

  it('delayMs 模拟耗时', async () => {
    const provider = new FakeLlmProvider([{ text: '慢', delayMs: 20 }]);
    const startedAt = Date.now();

    await provider.complete(PROMPT);

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(15);
  });

  it('记录每次调用的 prompt 与 options', async () => {
    const provider = new FakeLlmProvider([{ text: 'a' }, { text: 'b' }]);
    const options = { maxTokens: 64 };

    await provider.complete(PROMPT, options);
    await provider.completeJson(PROMPT, z.object({ ok: z.boolean() })).catch(() => undefined);

    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[0]).toEqual({ prompt: PROMPT, options });
    expect(provider.calls[1]).toEqual({ prompt: PROMPT });
  });

  it('completeJson 返回 json 并按 schema 校验', async () => {
    const schema = z.object({ ok: z.boolean() });
    const provider = new FakeLlmProvider([{ json: { ok: true } }]);

    await expect(provider.completeJson(PROMPT, schema)).resolves.toEqual({ ok: true });
  });

  it('completeJson 的 json 缺失或不合 schema 时抛 INVALID_ARGUMENT', async () => {
    const schema = z.object({ ok: z.boolean() });
    const provider = new FakeLlmProvider([{ text: '没有 json' }, { json: { ok: 1 } }]);

    await expect(provider.completeJson(PROMPT, schema)).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
    await expect(provider.completeJson(PROMPT, schema)).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
  });
});
