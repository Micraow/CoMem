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
  /**
   * 这次调用回答的问题。调用日志按它分组；供应商适配器忽略该字段。
   *
   * 生产调用点必须显式给出。`unspecified` 只用于兼容没有用途信息的历史测试和
   * 一次性脚本，不用于新增功能。
   */
  readonly purpose?: LlmCallPurpose;
  /** 已存在的会话 ID，只用于把调用记录关联回会话；没有时省略。 */
  readonly sessionId?: string;
  /**
   * 单次调用超时，毫秒。**只能是上限**：适配器取
   * `min(配置的 timeoutSeconds * 1000, timeoutMs)`，内部预算不能放宽用户配置的
   * `providers.llm.*.timeoutSeconds`。省略时用配置值。
   */
  readonly timeoutMs?: number;
  /** 上游取消信号；HTTP 请求断开时用它中止模型调用 */
  readonly abortSignal?: AbortSignal;
  /**
   * 是否允许应用层在同一次逻辑调用内自动重试，默认允许。
   *
   * 已有单一硬 deadline、到点后必须立即降级的调用设为 `false`，避免供应商标注
   * 可重试的失败在预算耗尽后继续进入退避。
   */
  readonly retry?: boolean;
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

export interface LlmJsonResult<T> {
  readonly value: T;
  readonly usage: LlmUsage;
  readonly finishReason: 'stop' | 'length' | 'refusal';
}

export type LlmCallPurpose =
  | 'query_rewrite'
  | 'recall_compression'
  | 'directory_summary'
  | 'archive_summary'
  | 'working_memory'
  | 'memory_extract'
  | 'dreamer'
  | 'config_probe'
  | 'unspecified';

export type LlmCallKind = 'text' | 'json';

export type LlmCallStatus = 'success' | 'error';

/** 一次逻辑调用（包括重试）的持久化诊断记录。正文、prompt 与原始错误不进入这里。 */
export interface LlmCallRecord {
  readonly id: string;
  readonly targetUri?: string | null;
  readonly errorReason?: string | null;
  readonly requestId: string | null;
  readonly sessionId: string | null;
  readonly subject: string | null;
  readonly purpose: LlmCallPurpose;
  readonly kind: LlmCallKind;
  readonly model: string;
  readonly status: LlmCallStatus;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly durationMs: number;
  readonly promptTokens: number | null;
  readonly completionTokens: number | null;
  readonly costUsd: number | null;
  readonly errorCode: string | null;
  readonly attempts: number;
}

export interface LlmProvider {
  complete(prompt: LlmPrompt, options?: LlmOptions): Promise<LlmResult>;

  /**
   * 结构化输出：`schema` 由适配器翻译成厂商的 JSON Schema 或 function calling，
   * 返回值已经过 zod 校验。
   */
  completeJson<T>(
    prompt: LlmPrompt,
    schema: ZodType<T>,
    options?: LlmOptions,
  ): Promise<LlmJsonResult<T>>;
}
