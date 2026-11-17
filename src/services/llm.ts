/**
 * LLM 应用封装（架构文档 §4.4、§11.4、§17.4）。
 *
 * 重试、结构化输出解析和 token 统计仍在应用层；供应商调用只在
 * `domain/llm.ts` 的接口后面。每次逻辑调用都可由 `llm-call-log.ts` 持久化，
 * 供控制台按用途、模型、token、耗时和结果排查。
 */

import type { ZodType } from 'zod';

import type { LlmOptions, LlmPrompt, LlmProvider, LlmResult } from '../domain/llm.js';
import type { Logger } from '../domain/log.js';

import {
  listLlmCalls,
  type ListLlmCallsOptions,
  type LlmCallLogPort,
  type LlmCallPage,
} from './llm-call-log.js';
import type { LlmPricing } from './llm-cost.js';
import { executeJsonCall } from './llm-json.js';
import type { LlmRuntimeState, LlmStatsState } from './llm-runtime.js';
import { executeTextCall } from './llm-text.js';

export type { LlmPricing } from './llm-cost.js';
export type {
  ListLlmCallsOptions,
  LlmCallPage,
  LlmCallPageItem,
} from './llm-call-log.js';

export interface LlmServiceOptions {
  readonly provider: LlmProvider;
  readonly logger: Logger;
  readonly pricing?: LlmPricing;
  /** 默认 3（含首次）。 */
  readonly maxAttempts?: number;
  /** 默认 500ms 起步，指数退避，上限 8s。 */
  readonly retryBaseDelayMs?: number;
  /** 模型名只用于审计与日志；供应商接口不暴露它。 */
  readonly model?: string;
  /** 持久化调用记录；省略时查询返回空页。 */
  readonly callLog?: LlmCallLogPort;
}

export interface LlmCallStats {
  readonly calls: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly costUsd: number | null;
  readonly truncated: number;
  readonly failed: number;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_BASE_DELAY_MS = 500;
const UNKNOWN_MODEL = 'unknown';

export class LlmService {
  readonly #runtime: LlmRuntimeState;

  constructor(options: LlmServiceOptions) {
    const pricing = options.pricing;
    this.#runtime = {
      provider: options.provider,
      logger: options.logger,
      pricing,
      maxAttempts: Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS),
      retryBaseDelayMs: Math.max(
        0,
        options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS,
      ),
      modelName: options.model ?? UNKNOWN_MODEL,
      callLog: options.callLog,
      totals: emptyStats(pricing),
    };
  }

  generate(prompt: LlmPrompt, options?: LlmOptions): Promise<LlmResult> {
    return executeTextCall(this.#runtime, prompt, options);
  }

  generateJson<T>(
    prompt: LlmPrompt,
    schema: ZodType<T>,
    options?: LlmOptions,
  ): Promise<T> {
    return executeJsonCall(this.#runtime, prompt, schema, options);
  }

  listCalls(options: ListLlmCallsOptions): LlmCallPage {
    return listLlmCalls(this.#runtime.callLog, options);
  }

  get stats(): LlmCallStats {
    return { ...this.#runtime.totals };
  }
}

function emptyStats(pricing: LlmPricing | undefined): LlmStatsState {
  return {
    calls: 0,
    promptTokens: 0,
    completionTokens: 0,
    costUsd: pricing === undefined ? null : 0,
    truncated: 0,
    failed: 0,
  };
}
