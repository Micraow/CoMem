/**
 * `LlmProvider` 契约套件的注册处。
 *
 * 三个实现共用 `tests/contract/llm-provider-suite.ts` 里的同一组断言：
 * - `AiSdkLlmProvider`：真实适配器，传输层用 SDK 的方法打桩；
 * - `FakeLlmProvider`：测试替身，按设计不映射供应商传输错误；
 * - `DisabledLlmProvider`：关闭态桩，只注册「关闭时该抛什么」的契约。
 */

import { TypeValidationError } from 'ai';
import { vi } from 'vitest';

import { ComemError } from '../../src/domain/errors.js';
import type { Logger } from '../../src/domain/log.js';
import type { LlmConformanceSubject } from './llm-provider-suite.js';

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

const { AiSdkLlmProvider } = await import('../../src/adapters/llm/ai-sdk-provider.js');
const { FakeLlmProvider } = await import('../helpers/fake-llm-provider.js');
const { DisabledLlmProvider } = await import('../../src/adapters/llm/disabled-provider.js');
const {
  CONFORMANCE_PROMPT,
  CONFORMANCE_SCHEMA,
  describeDisabledLlmConformance,
  describeLlmProviderConformance,
} = await import('./llm-provider-suite.js');
const { PASS_THROUGH_MESSAGE } = await import('./conformance.js');

function createLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function chatProvider(): InstanceType<typeof AiSdkLlmProvider> {
  return new AiSdkLlmProvider({
    type: 'openai-compatible',
    baseUrl: 'https://example.test/v1',
    model: 'contract-model',
    apiKey: 'sk-test',
    maxTokens: 1024,
    timeoutSeconds: 5,
    logger: createLogger(),
  });
}

function textResult(): Record<string, unknown> {
  return {
    text: 'ok',
    usage: { inputTokens: 10, outputTokens: 4 },
    finishReason: 'stop',
  };
}

function providerApiError(status: number): Error {
  return Object.assign(new Error(`HTTP ${String(status)}`), { statusCode: status });
}

function hangUntilAbort({ abortSignal }: { abortSignal: AbortSignal }): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (abortSignal.aborted) {
      reject(new DOMException('aborted', 'AbortError'));
      return;
    }
    abortSignal.addEventListener('abort', () => {
      reject(new DOMException('aborted', 'AbortError'));
    });
  });
}

const aiSdkSubject: LlmConformanceSubject = {
  name: 'AiSdkLlmProvider',
  create: () => {
    mocks.generateText.mockResolvedValue(textResult());
    return chatProvider();
  },
  createJson: () => {
    mocks.generateObject.mockResolvedValue({ object: { ok: true } });
    return chatProvider();
  },
  failUnknown: () => {
    mocks.generateText.mockRejectedValue(new Error('boom'));
    return chatProvider().complete(CONFORMANCE_PROMPT);
  },
  failWithComem: (error) => {
    mocks.generateText.mockRejectedValue(error);
    return chatProvider().complete(CONFORMANCE_PROMPT);
  },
  failJsonSchema: () => {
    mocks.generateObject.mockRejectedValue(
      new TypeValidationError({ value: 'not-json', cause: new Error('bad schema') }),
    );
    return chatProvider().completeJson(CONFORMANCE_PROMPT, CONFORMANCE_SCHEMA);
  },
  providerFailure: (failure) => {
    switch (failure.kind) {
      case 'status':
        mocks.generateText.mockRejectedValue(providerApiError(failure.status));
        break;
      case 'timeout':
        mocks.generateText.mockImplementation(hangUntilAbort);
        return chatProvider().complete(CONFORMANCE_PROMPT, { timeoutMs: 5 });
      case 'network':
        mocks.generateText.mockRejectedValue(new TypeError('fetch failed'));
        break;
      case 'unknown':
        mocks.generateText.mockRejectedValue(new Error('boom'));
        break;
      case 'comem':
        mocks.generateText.mockRejectedValue(
          new ComemError('RESOURCE_EXHAUSTED', PASS_THROUGH_MESSAGE),
        );
        break;
    }
    return chatProvider().complete(CONFORMANCE_PROMPT);
  },
};

const fakeSubject: LlmConformanceSubject = {
  name: 'FakeLlmProvider',
  create: () => new FakeLlmProvider([{ text: 'ok' }]),
  createJson: () => new FakeLlmProvider([{ json: { ok: true } }]),
  failUnknown: () => new FakeLlmProvider([]).complete(CONFORMANCE_PROMPT),
  failWithComem: (error) => new FakeLlmProvider([{ error }]).complete(CONFORMANCE_PROMPT),
  failJsonSchema: () =>
    new FakeLlmProvider([{ json: { ok: 1 } }]).completeJson(CONFORMANCE_PROMPT, CONFORMANCE_SCHEMA),
};

describeLlmProviderConformance(aiSdkSubject);
describeLlmProviderConformance(fakeSubject);
describeDisabledLlmConformance({
  name: 'DisabledLlmProvider',
  create: () => new DisabledLlmProvider(),
});
