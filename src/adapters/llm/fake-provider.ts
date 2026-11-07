/**
 * `LlmProvider` 的测试替身（架构文档 §4.4 的实现 2）。
 *
 * 存在的理由和 `NullLogger` 一样：测试里不该起网络、也不该 mock 整个 AI SDK。
 * 它按顺序消费预置响应，并记录每次调用，让测试能断言「调了几次、传了什么」。
 *
 * 不做的事：不模拟重试、不模拟超时、不模拟供应商错误码。那些是
 * `services/llm.ts` 与 `ai-sdk-provider.ts` 的责任，测试要在它们各自的层断言。
 */

import type { ZodType } from 'zod';

import { ComemError } from '../../domain/errors.js';
import type { LlmOptions, LlmPrompt, LlmProvider, LlmResult, LlmUsage } from '../../domain/llm.js';

export interface FakeResponse {
  readonly text?: string;
  readonly json?: unknown;
  readonly finishReason?: 'stop' | 'length' | 'refusal';
  readonly usage?: Partial<LlmUsage>;
  /** 抛错代替返回。 */
  readonly error?: ComemError;
  /** 模拟耗时，毫秒。 */
  readonly delayMs?: number;
}

/** 一次被记录的调用。`options` 是可选的，因为 `LlmProvider` 的第二个参数就是可选的。 */
export interface FakeCall {
  readonly prompt: LlmPrompt;
  readonly options?: LlmOptions;
}

export class FakeLlmProvider implements LlmProvider {
  private readonly responses: FakeResponse[];
  private readonly callLog: FakeCall[] = [];

  constructor(responses: readonly FakeResponse[]) {
    // 复制一份：调用方在断言里可能继续持有原数组，就地 shift 会把它改掉。
    this.responses = [...responses];
  }

  async complete(prompt: LlmPrompt, options?: LlmOptions): Promise<LlmResult> {
    const response = await this.next(prompt, options);
    return {
      text: response.text ?? '',
      usage: {
        promptTokens: response.usage?.promptTokens ?? 0,
        completionTokens: response.usage?.completionTokens ?? 0,
      },
      finishReason: response.finishReason ?? 'stop',
    };
  }

  async completeJson<T>(prompt: LlmPrompt, schema: ZodType<T>, options?: LlmOptions): Promise<T> {
    const response = await this.next(prompt, options);
    if (response.json === undefined) {
      // 与真实适配器一致：没有可解析的 JSON 就是解析失败（INVALID_ARGUMENT），
      // 上层据此重试一次（§11.4）。
      throw new ComemError('INVALID_ARGUMENT', '模型没有返回结构化输出。');
    }
    const parsed = schema.safeParse(response.json);
    if (!parsed.success) {
      throw new ComemError('INVALID_ARGUMENT', '模型输出不符合 schema。', {
        issues: parsed.error.issues.length,
      });
    }
    return parsed.data;
  }

  /** 调用记录，测试断言用。 */
  get calls(): readonly FakeCall[] {
    return this.callLog;
  }

  get remaining(): number {
    return this.responses.length;
  }

  private async next(prompt: LlmPrompt, options?: LlmOptions): Promise<FakeResponse> {
    this.callLog.push(options === undefined ? { prompt } : { prompt, options });

    const response = this.responses.shift();
    if (response === undefined) {
      throw new ComemError('INTERNAL', 'FakeLlmProvider 的响应已用尽：出现了预期外的模型调用。');
    }

    if (response.delayMs !== undefined && response.delayMs > 0) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, response.delayMs);
      });
    }

    if (response.error !== undefined) {
      throw response.error;
    }
    return response;
  }
}
