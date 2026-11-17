import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { FakeLlmProvider, type FakeResponse } from '../../helpers/fake-llm-provider.js';
import { ComemError } from '../../../src/domain/errors.js';
import type { LlmPrompt } from '../../../src/domain/llm.js';
import type { Logger } from '../../../src/domain/log.js';
import { LlmService } from '../../../src/services/llm.js';
import { buildSummaryPrompt } from '../../../src/services/prompts/summarize.js';
import { Uri } from '../../../src/domain/uri.js';

const PROMPT: LlmPrompt = {
  system: 'system',
  messages: [{ role: 'user', content: '你好' }],
};

interface LoggedCall {
  readonly message: string;
  readonly fields: Record<string, unknown> | undefined;
}

function createLogger(): Logger & { readonly infoCalls: LoggedCall[] } {
  const infoCalls: LoggedCall[] = [];
  const logger: Logger = {
    debug: vi.fn(),
    info: (message, fields) => {
      infoCalls.push({ message, fields });
    },
    warn: vi.fn(),
    error: vi.fn(),
  };
  return Object.assign(logger, { infoCalls });
}

function createService(
  responses: readonly FakeResponse[],
  overrides: Partial<{ pricing: { inputPerMillion: number; outputPerMillion: number }; maxAttempts: number }> = {},
): { service: LlmService; provider: FakeLlmProvider; logger: ReturnType<typeof createLogger> } {
  const provider = new FakeLlmProvider(responses);
  const logger = createLogger();
  const service = new LlmService({
    provider,
    logger,
    retryBaseDelayMs: 1,
    ...overrides,
  });
  return { service, provider, logger };
}

describe('generate', () => {
  it('正常调用累加 calls / tokens / cost', async () => {
    const { service } = createService(
      [{ text: '好的', usage: { promptTokens: 10, completionTokens: 5 } }],
      { pricing: { inputPerMillion: 2, outputPerMillion: 4 } },
    );

    const result = await service.generate(PROMPT);

    expect(result.text).toBe('好的');
    expect(result.finishReason).toBe('stop');
    // (10 × 2 + 5 × 4) / 1_000_000
    expect(service.stats).toEqual({
      calls: 1,
      promptTokens: 10,
      completionTokens: 5,
      costUsd: 40 / 1_000_000,
      truncated: 0,
      failed: 0,
    });
  });

  it('每次调用记 info 日志，带模型名、token、finishReason 与耗时', async () => {
    const { service, logger } = createService([
      { text: 'x', usage: { promptTokens: 3, completionTokens: 4 } },
    ]);

    await service.generate(PROMPT);

    expect(logger.infoCalls).toHaveLength(1);
    const fields = logger.infoCalls[0]?.fields ?? {};
    expect(fields.model).toBe('unknown');
    expect(fields.promptTokens).toBe(3);
    expect(fields.completionTokens).toBe(4);
    expect(fields.finishReason).toBe('stop');
    expect(fields.durationMs).toBeTypeOf('number');
  });

  it('截断（length）抛 PROVIDER_UNAVAILABLE，且只调 1 次', async () => {
    const { service, provider } = createService([{ text: '半句', finishReason: 'length' }]);

    const error = await service.generate(PROMPT).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ComemError);
    expect((error as ComemError).code).toBe('PROVIDER_UNAVAILABLE');
    expect((error as ComemError).message).toContain('maxTokens');
    expect(provider.calls).toHaveLength(1);
    expect(service.stats.truncated).toBe(1);
    expect(service.stats.failed).toBe(0);
  });

  it('拒绝（refusal）抛 PROVIDER_UNAVAILABLE，且只调 1 次', async () => {
    const { service, provider } = createService([{ text: '', finishReason: 'refusal' }]);

    await expect(service.generate(PROMPT)).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    expect(provider.calls).toHaveLength(1);
    expect(service.stats.failed).toBe(1);
  });

  it('UNAUTHENTICATED 不重试', async () => {
    const { service, provider } = createService([
      { error: new ComemError('UNAUTHENTICATED', 'API Key 无效。') },
    ]);

    await expect(service.generate(PROMPT)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(provider.calls).toHaveLength(1);
    expect(service.stats.failed).toBe(1);
  });

  it('INVALID_ARGUMENT 不重试', async () => {
    const { service, provider } = createService([
      { error: new ComemError('INVALID_ARGUMENT', '参数不合法。') },
    ]);

    await expect(service.generate(PROMPT)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(provider.calls).toHaveLength(1);
  });

  it('PROVIDER_UNAVAILABLE 重试到上限（3 次）', async () => {
    const { service, provider } = createService([
      { error: new ComemError('PROVIDER_UNAVAILABLE', '供应商不可用。') },
      { error: new ComemError('PROVIDER_UNAVAILABLE', '供应商不可用。') },
      { error: new ComemError('PROVIDER_UNAVAILABLE', '供应商不可用。') },
    ]);

    await expect(service.generate(PROMPT)).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    expect(provider.calls).toHaveLength(3);
    expect(service.stats.failed).toBe(1);
    expect(service.stats.calls).toBe(0);
  });

  it('第二次成功时返回结果并正确统计', async () => {
    const { service, provider } = createService([
      { error: new ComemError('PROVIDER_UNAVAILABLE', '供应商不可用。') },
      { text: '恢复了', usage: { promptTokens: 6, completionTokens: 7 } },
    ]);

    const result = await service.generate(PROMPT);

    expect(result.text).toBe('恢复了');
    expect(provider.calls).toHaveLength(2);
    expect(service.stats).toMatchObject({
      calls: 1,
      promptTokens: 6,
      completionTokens: 7,
      failed: 0,
    });
  });

  it('没配 pricing 时 costUsd 为 null', async () => {
    const { service } = createService([{ text: 'x', usage: { promptTokens: 1, completionTokens: 1 } }]);

    await service.generate(PROMPT);

    expect(service.stats.costUsd).toBeNull();
  });

});

describe('generateJson', () => {
  const schema = z.object({ ok: z.boolean() });

  it('解析失败重试一次后成功', async () => {
    const { service, provider } = createService([{ json: 'not-an-object' }, { json: { ok: true } }]);

    const value = await service.generateJson(PROMPT, schema);

    expect(value).toEqual({ ok: true });
    expect(provider.calls).toHaveLength(2);
    expect(service.stats.calls).toBe(1);
  });

  it('两次都解析失败抛 INVALID_ARGUMENT', async () => {
    const { service, provider } = createService([
      { json: { ok: '不是布尔' } },
      { json: { ok: 1 } },
    ]);

    await expect(service.generateJson(PROMPT, schema)).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
    expect(provider.calls).toHaveLength(2);
    expect(service.stats.failed).toBe(1);
  });

  it('结构化输出被截断时不重试', async () => {
    // 截断的响应同样抛 `NoObjectGeneratedError`，靠适配层的 `truncated` 标记跳过重试。
    const { service, provider } = createService([
      {
        error: new ComemError('PROVIDER_UNAVAILABLE', '模型输出被截断。', { truncated: true }),
      },
      { json: { ok: true } },
    ]);

    await expect(service.generateJson(PROMPT, schema)).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
    });
    expect(provider.calls).toHaveLength(1);
    expect(service.stats.truncated).toBe(1);
  });

  it('PROVIDER_UNAVAILABLE 重试到上限', async () => {
    const { service, provider } = createService([
      { error: new ComemError('PROVIDER_UNAVAILABLE', '供应商不可用。') },
      { error: new ComemError('PROVIDER_UNAVAILABLE', '供应商不可用。') },
      { error: new ComemError('PROVIDER_UNAVAILABLE', '供应商不可用。') },
    ]);

    await expect(service.generateJson(PROMPT, schema)).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
    });
    expect(provider.calls).toHaveLength(3);
  });

  it('retry=false 时结构化调用只尝试一次', async () => {
    const { service, provider } = createService([
      { error: new ComemError('PROVIDER_UNAVAILABLE', '供应商不可用。') },
      { json: { ok: true } },
    ]);

    await expect(
      service.generateJson(PROMPT, schema, { retry: false }),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    expect(provider.calls).toHaveLength(1);
  });

  it('retry=false 时结构化解析失败也不重试', async () => {
    const { service, provider } = createService([
      { json: { ok: '不是布尔' } },
      { json: { ok: true } },
    ]);

    await expect(
      service.generateJson(PROMPT, schema, { retry: false }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(provider.calls).toHaveLength(1);
  });
});

describe('提示词模板', () => {
  it('归档摘要把本批对话事实作为明确输入，不从 messages.jsonl 生成 L0', () => {
    const prompt = buildSummaryPrompt({
      uri: Uri.parse('comem://user/alice/sessions/s1/history/archive_001'),
      children: [
        {
          uri: Uri.parse('comem://user/alice/sessions/s1/history/archive_001/messages.jsonl'),
          name: 'messages.jsonl',
          kind: 'document',
          abstract: '',
        },
      ],
      sourceText: '### user\n我们决定保留原始归档消息。\n\n### assistant\n摘要应直接概括这次决定。',
    });
    const rendered = `${prompt.system ?? ''}\n${prompt.messages.map((message) => message.content).join('\n')}`;

    expect(rendered).toContain('本批对话事实');
    expect(rendered).toContain('我们决定保留原始归档消息。');
    expect(rendered).toContain('摘要应直接概括这次决定。');
  });
});
