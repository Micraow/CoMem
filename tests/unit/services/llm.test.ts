import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { FakeLlmProvider, type FakeResponse } from '../../../src/adapters/llm/fake-provider.js';
import { ComemError } from '../../../src/domain/errors.js';
import type { LlmPrompt } from '../../../src/domain/llm.js';
import type { Logger } from '../../../src/domain/log.js';
import { LlmService } from '../../../src/services/llm.js';
import { buildExtractPrompt, buildSummaryPrompt } from '../../../src/services/prompts/index.js';
import { BUILTIN_MEMORY_TYPES } from '../../../src/domain/memory-types/index.js';
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
    trace: vi.fn(),
    debug: vi.fn(),
    info: (message, fields) => {
      infoCalls.push({ message, fields });
    },
    warn: vi.fn(),
    error: vi.fn(),
    child: () => logger,
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
    // 测试里退避取 1ms：重试路径要快，指数本身不是这里要断言的东西。
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
    // 关键断言：不是「重试 3 次又失败」，而是压根没重试。
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

  it('resetStats 清零', async () => {
    const { service } = createService([
      { text: 'x', usage: { promptTokens: 1, completionTokens: 1 } },
    ]);
    await service.generate(PROMPT);

    service.resetStats();

    expect(service.stats).toEqual({
      calls: 0,
      promptTokens: 0,
      completionTokens: 0,
      costUsd: null,
      truncated: 0,
      failed: 0,
    });
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
      // 第三次不该被调用：解析失败只重试一次。
    ]);

    await expect(service.generateJson(PROMPT, schema)).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
    expect(provider.calls).toHaveLength(2);
    expect(service.stats.failed).toBe(1);
  });

  it('UNAUTHENTICATED 不重试', async () => {
    const { service, provider } = createService([
      { error: new ComemError('UNAUTHENTICATED', 'API Key 无效。') },
    ]);

    await expect(service.generateJson(PROMPT, schema)).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
    expect(provider.calls).toHaveLength(1);
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
});

describe('提示词模板', () => {
  const memoryTypes = Object.values(BUILTIN_MEMORY_TYPES);

  it('抽取 prompt 写清 page_id 编号规则与 JSON 输出', () => {
    const prompt = buildExtractPrompt({
      messages: [{ role: 'user', content: '我更喜欢 2 空格缩进。' }],
      memoryTypes,
      pages: [{ pageId: 1, uri: 'comem://user/alice/memories/profile.md', content: 'alice' }],
      previousOverview: '上次聊到代码风格。',
    });

    const rendered = `${prompt.system ?? ''}\n${prompt.messages.map((message) => message.content).join('\n')}`;

    expect(rendered).toContain('page_id');
    expect(rendered).toContain('≥ 100');
    expect(rendered).toContain('JSON');
    expect(rendered).toContain('preferences');
    expect(rendered).toContain('我更喜欢 2 空格缩进。');
    expect(rendered).toContain('上次聊到代码风格。');
    expect(rendered).toContain('comem://user/alice/memories/profile.md');
  });

  it('没有已读记忆与上一次概览时也给出明确说明', () => {
    const prompt = buildExtractPrompt({ messages: [], memoryTypes, pages: [] });
    const rendered = `${prompt.system ?? ''}\n${prompt.messages.map((message) => message.content).join('\n')}`;

    expect(rendered).toContain('没有预取到已读记忆');
    expect(rendered).toContain('没有会话消息');
    expect(rendered).not.toContain('上一次归档的概览');
  });

  it('摘要 prompt 写清四段结构且要求不输出 frontmatter', () => {
    const prompt = buildSummaryPrompt({
      uri: Uri.parse('comem://user/alice/memories'),
      children: [
        {
          uri: Uri.parse('comem://user/alice/memories/profile.md'),
          name: 'profile.md',
          kind: 'document',
          abstract: 'alice，后端工程师。',
        },
      ],
    });

    const rendered = `${prompt.system ?? ''}\n${prompt.messages.map((message) => message.content).join('\n')}`;

    expect(rendered).toContain('快速导航');
    expect(rendered).toContain('详细说明');
    expect(rendered).toContain('frontmatter');
    expect(rendered).toContain('profile.md');
    expect(rendered).toContain('alice，后端工程师。');
  });
});
