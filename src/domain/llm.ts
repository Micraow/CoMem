/**
 * 模型提供方接口（架构文档 §4.4）。
 *
 * 这层存在的理由不是「以后可能换模型」，是上层不该知道自己用的哪家 SDK。
 * 实现放在 `adapters/llm/`，`services/` 永远不 import `ai`。
 *
 * `finishReason` 是契约的一部分，不是实现细节：抽取管线靠它区分「模型说完了」
 * 和「被截断了」。截断时重试同样的 `maxTokens` 只会再截断一次，必须报错让人调大。
 */

import type { ZodType } from 'zod';

export interface LlmMessage {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
}

/**
 * 一次模型调用的输入。
 *
 * `system` 单独拿出来，因为所有厂商的 system 消息都不是普通消息：它有独立的
 * 缓存与优先级语义，混在 `messages` 里会让适配器每次都要猜哪个是 system。
 */
export interface LlmPrompt {
  readonly system?: string;
  readonly messages: readonly LlmMessage[];
}

export interface LlmOptions {
  /** 输出 token 上限 */
  readonly maxTokens?: number;
  readonly temperature?: number;
  /** 单次调用超时，毫秒 */
  readonly timeoutMs?: number;
  /** 上游取消信号；HTTP 请求断开时用它中止模型调用 */
  readonly abortSignal?: AbortSignal;
}

export interface LlmUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
}

export interface LlmResult {
  readonly text: string;
  readonly usage: LlmUsage;
  /** `length` 表示被 maxTokens 截断，调用方不应重试（§11.4） */
  readonly finishReason: 'stop' | 'length' | 'refusal';
}

export interface LlmProvider {
  complete(prompt: LlmPrompt, options?: LlmOptions): Promise<LlmResult>;

  /**
   * 结构化输出：`schema` 由适配器翻译成厂商的 JSON Schema 或 function calling，
   * 返回值已经过 zod 校验。
   */
  completeJson<T>(prompt: LlmPrompt, schema: ZodType<T>, options?: LlmOptions): Promise<T>;
}
