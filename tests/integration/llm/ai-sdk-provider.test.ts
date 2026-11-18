import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { ComemError } from '../../../src/domain/errors.js';
import type { Logger } from '../../../src/domain/log.js';

/**
 * `ai` 与两个 provider 包都打桩：测试不调网络。
 *
 * `importOriginal` 保留真实的错误类（`TypeValidationError` 等），只替换
 * `generateText` / `generateObject`——错误映射要用真类断言，不能自己造一个同形对象。
 */
const mocks = vi.hoisted(() => {
  const generateText = vi.fn();
  const generateObject = vi.fn();
  const openaiModel = vi.fn((modelId: string) => ({ provider: 'openai-compatible', modelId }));
  const anthropicModel = vi.fn((modelId: string) => ({ provider: 'anthropic', modelId }));
  const createOpenAICompatible = vi.fn(() =>
    Object.assign(openaiModel, { chatModel: openaiModel }),
  );
  const createAnthropic = vi.fn(() => Object.assign(anthropicModel, { chatModel: anthropicModel }));
  return {
    generateText,
    generateObject,
    openaiModel,
    anthropicModel,
    createOpenAICompatible,
    createAnthropic,
  };
});

vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return { ...actual, generateText: mocks.generateText, generateObject: mocks.generateObject };
});

vi.mock('@ai-sdk/openai-compatible', () => ({
  createOpenAICompatible: mocks.createOpenAICompatible,
}));

vi.mock('@ai-sdk/anthropic', () => ({ createAnthropic: mocks.createAnthropic }));

const { AiSdkLlmProvider } = await import('../../../src/adapters/llm/ai-sdk-provider.js');

const PROMPT = {
  system: '你是抽取器。',
  messages: [
    { role: 'user' as const, content: '你好' },
    { role: 'assistant' as const, content: '你好，有什么可以帮你？' },
  ],
};

function createLogger(): Logger & {
  readonly warnCalls: { message: string; fields: Record<string, unknown> | undefined }[];
} {
  const warnCalls: { message: string; fields: Record<string, unknown> | undefined }[] = [];
  const logger: Logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: (message, fields) => {
      warnCalls.push({ message, fields });
    },
    error: vi.fn(),
  };
  return Object.assign(logger, { warnCalls });
}

function createProvider(
  type: 'openai-compatible' | 'anthropic' = 'openai-compatible',
  overrides: Partial<ConstructorParameters<typeof AiSdkLlmProvider>[0]> = {},
): {
  provider: InstanceType<typeof AiSdkLlmProvider>;
  logger: ReturnType<typeof createLogger>;
} {
  const logger = createLogger();
  const provider = new AiSdkLlmProvider({
    type,
    baseUrl: 'https://example.test/v1',
    model: 'test-model',
    apiKey: 'sk-test',
    maxTokens: 2048,
    timeoutSeconds: 5,
    ...overrides,
    logger,
  });
  return { provider, logger };
}

/** 一次成功的 `generateText` 返回值。 */
function textResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    text: 'ok',
    usage: { inputTokens: 10, outputTokens: 4 },
    finishReason: 'stop',
    response: { id: 'response-1', modelId: 'test-model', timestamp: new Date(0) },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.generateText.mockResolvedValue(textResult());
  mocks.generateObject.mockResolvedValue({ object: { ok: true } });
});

describe('供应商选择', () => {
  it('type=openai-compatible 走 createOpenAICompatible', async () => {
    const { provider } = createProvider('openai-compatible');

    await provider.complete(PROMPT);

    expect(mocks.createOpenAICompatible).toHaveBeenCalledWith(
      expect.objectContaining({
        baseURL: 'https://example.test/v1',
        apiKey: 'sk-test',
      }),
    );
    expect(mocks.createAnthropic).not.toHaveBeenCalled();
    expect(mocks.openaiModel).toHaveBeenCalledWith('test-model');
    expect(mocks.anthropicModel).not.toHaveBeenCalled();
  });

  it('没配 baseUrl 时兜底到 OpenAI 官方地址', async () => {
    const { provider } = createProvider('openai-compatible', { baseUrl: undefined });

    await provider.complete(PROMPT);

    expect(mocks.createOpenAICompatible).toHaveBeenCalledWith(
      expect.objectContaining({ baseURL: 'https://api.openai.com/v1' }),
    );
  });

  it('type=anthropic 走 createAnthropic', async () => {
    const { provider } = createProvider('anthropic');

    await provider.complete(PROMPT);

    expect(mocks.createAnthropic).toHaveBeenCalledWith(
      expect.objectContaining({ baseURL: 'https://example.test/v1', apiKey: 'sk-test' }),
    );
    expect(mocks.createOpenAICompatible).not.toHaveBeenCalled();
    expect(mocks.anthropicModel).toHaveBeenCalledWith('test-model');
  });
});

describe('complete', () => {
  it('把 prompt 翻译成 generateText 参数，并禁用 SDK 内部重试', async () => {
    const { provider } = createProvider();

    await provider.complete(PROMPT, { maxTokens: 128, temperature: 0.2 });

    expect(mocks.generateText).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [
          { role: 'user', content: '你好' },
          { role: 'assistant', content: '你好，有什么可以帮你？' },
        ],
        instructions: '你是抽取器。',
        maxOutputTokens: 128,
        temperature: 0.2,
        maxRetries: 0,
        abortSignal: expect.any(AbortSignal),
      }),
    );
  });

  it('没传 maxTokens 时用配置里的默认值', async () => {
    const { provider } = createProvider();

    await provider.complete(PROMPT);

    expect(mocks.generateText).toHaveBeenCalledWith(
      expect.objectContaining({ maxOutputTokens: 2048 }),
    );
  });

  it.each([
    ['stop', 'stop'],
    ['length', 'length'],
    ['content-filter', 'refusal'],
  ])('finishReason %s 映射成 %s', async (sdkReason, expected) => {
    const { provider, logger } = createProvider();
    mocks.generateText.mockResolvedValue(textResult({ finishReason: sdkReason }));

    const result = await provider.complete(PROMPT);

    expect(result.finishReason).toBe(expected);
    expect(logger.warnCalls).toHaveLength(0);
  });

  it.each(['tool-calls', 'error', 'interrupted', 'other'])(
    '契约外的 finishReason %s 按 stop 处理并记 warn',
    async (sdkReason) => {
      const { provider, logger } = createProvider();
      mocks.generateText.mockResolvedValue(textResult({ finishReason: sdkReason }));

      const result = await provider.complete(PROMPT);

      expect(result.finishReason).toBe('stop');
      expect(logger.warnCalls).toHaveLength(1);
      expect(logger.warnCalls[0]?.fields).toMatchObject({ finishReason: sdkReason });
    },
  );

  it('usage 取 inputTokens / outputTokens', async () => {
    const { provider } = createProvider();
    mocks.generateText.mockResolvedValue(
      textResult({ usage: { inputTokens: 11, outputTokens: 7 } }),
    );

    const result = await provider.complete(PROMPT);

    expect(result.usage).toEqual({ promptTokens: 11, completionTokens: 7 });
  });

  it('usage 兼容 promptTokens / completionTokens', async () => {
    const { provider } = createProvider();
    mocks.generateText.mockResolvedValue(
      textResult({ usage: { promptTokens: 3, completionTokens: 4 } }),
    );

    const result = await provider.complete(PROMPT);

    expect(result.usage).toEqual({ promptTokens: 3, completionTokens: 4 });
  });

  it('timeoutMs 只能收紧配置，不能放宽：配置 1 秒 + timeoutMs 12000 实际按 1000 超时', async () => {
    const { provider } = createProvider('openai-compatible', { timeoutSeconds: 1 });
    // 永远不返回，等超时定时器 abort。
    mocks.generateText.mockImplementation(
      ({ abortSignal }: { abortSignal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          abortSignal.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          });
        }),
    );

    const startedAt = Date.now();
    const error = await provider
      .complete(PROMPT, { timeoutMs: 12_000 })
      .catch((caught: unknown) => caught);
    const elapsedMs = Date.now() - startedAt;

    // 错误里带的就是**实际生效**的预算：1000 而不是 12000。
    expect(error).toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
      details: { timeoutMs: 1000 },
    });
    expect(elapsedMs).toBeGreaterThanOrEqual(900);
    expect(elapsedMs).toBeLessThan(4_000);
  });

  it('调用方取消时透传 abortSignal 给 SDK', async () => {
    const { provider } = createProvider();
    const controller = new AbortController();

    await provider.complete(PROMPT, { abortSignal: controller.signal });

    const call = mocks.generateText.mock.calls[0]?.[0] as { abortSignal: AbortSignal };
    expect(call.abortSignal).toBeInstanceOf(AbortSignal);
  });

  it('调用方以 ComemError 取消时保留原始原因', async () => {
    const { provider } = createProvider();
    const controller = new AbortController();
    const timeout = new ComemError('PROVIDER_UNAVAILABLE', '调用预算到点。', {
      timeout: true,
      timeoutMs: 25,
    });
    mocks.generateText.mockImplementation(
      ({ abortSignal }: { abortSignal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          abortSignal.addEventListener(
            'abort',
            () => reject(new DOMException('aborted', 'AbortError')),
            { once: true },
          );
          controller.abort(timeout);
        }),
    );

    const error = await provider
      .complete(PROMPT, { abortSignal: controller.signal })
      .catch((caught: unknown) => caught);

    expect(error).toBe(timeout);
  });
});

describe('completeJson', () => {
  it('OpenAI 兼容路径把 schema 写进 instructions，用文本调用后本地校验', async () => {
    const { provider } = createProvider();
    const schema = z.object({ ok: z.boolean() });
    mocks.generateText.mockResolvedValue(textResult({
      text: '{"ok":true}',
      usage: { inputTokens: 2, outputTokens: 1 },
    }));

    const value = await provider.completeJson(PROMPT, schema);

    expect(value.value).toEqual({ ok: true });
    expect(value.usage).toEqual({ promptTokens: 2, completionTokens: 1 });
    expect(value.finishReason).toBe('stop');
    expect(mocks.generateObject).not.toHaveBeenCalled();
    expect(mocks.generateText).toHaveBeenCalledWith(
      expect.objectContaining({
        maxRetries: 0,
        instructions: expect.stringContaining('"additionalProperties":false'),
        abortSignal: expect.any(AbortSignal),
      }),
    );
    expect(
      (mocks.generateText.mock.calls[0]?.[0] as { instructions: string }).instructions,
    ).toContain('你是抽取器。');
  });

  it('OpenAI 兼容路径从代码块或说明文字中提取唯一 JSON 对象', async () => {
    const { provider } = createProvider();
    mocks.generateText.mockResolvedValue(textResult({
      text: '结果如下：\n```json\n{"ok":true}\n```\n请查收。',
    }));

    const value = await provider.completeJson(PROMPT, z.object({ ok: z.boolean() }));

    expect(value.value).toEqual({ ok: true });
  });

  it('schema transform 无法转成 JSON Schema 时仍按提示词返回并执行本地转换', async () => {
    const { provider } = createProvider();
    mocks.generateText.mockResolvedValue(textResult({ text: '{"value":" trimmed "}' }));
    const schema = z.object({ value: z.string() }).transform(({ value }) => ({
      value: value.trim(),
    }));

    const value = await provider.completeJson(PROMPT, schema);

    expect(value.value).toEqual({ value: 'trimmed' });
    expect(
      (mocks.generateText.mock.calls[0]?.[0] as { instructions: string }).instructions,
    ).toContain('遵循系统提示词中已经声明的 JSON 结构');
  });

  it('Anthropic 继续使用原生 generateObject', async () => {
    const { provider } = createProvider('anthropic');
    const schema = z.object({ ok: z.boolean() });
    mocks.generateObject.mockResolvedValue({
      object: { ok: true },
      usage: { inputTokens: 2, outputTokens: 1 },
      finishReason: 'stop',
    });

    const value = await provider.completeJson(PROMPT, schema);

    expect(value.value).toEqual({ ok: true });
    expect(mocks.generateText).not.toHaveBeenCalled();
    expect(mocks.generateObject).toHaveBeenCalledWith(
      expect.objectContaining({
        schema,
        maxRetries: 0,
        instructions: '你是抽取器。',
        abortSignal: expect.any(AbortSignal),
      }),
    );
  });

  it('OpenAI 兼容文本被截断时映射成 PROVIDER_UNAVAILABLE 并带 truncated 标记', async () => {
    const { provider } = createProvider();
    mocks.generateText.mockResolvedValue(textResult({
      text: '{"ok":',
      usage: { inputTokens: 1, outputTokens: 1 },
      finishReason: 'length',
    }));

    const error = await provider
      .completeJson(PROMPT, z.object({ ok: z.boolean() }))
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ComemError);
    expect((error as ComemError).code).toBe('PROVIDER_UNAVAILABLE');
    expect((error as ComemError).details?.['truncated']).toBe(true);
    expect((error as ComemError).details?.['usage']).toEqual({
      promptTokens: 1,
      completionTokens: 1,
    });
  });
});
