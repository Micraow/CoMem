import { randomUUID } from 'node:crypto';

import type { LlmCallRepository, LlmCallCursor } from '../adapters/sqlite/llm-call-repository.js';
import { ComemError } from '../domain/errors.js';
import type {
  LlmCallKind,
  LlmCallPurpose,
  LlmCallRecord,
  LlmCallStatus,
  LlmOptions,
  LlmUsage,
} from '../domain/llm.js';
import type { Logger } from '../domain/log.js';

import { llmCostUsd, type LlmPricing } from './llm-cost.js';
import { currentLlmCallContext } from './observability/call-context.js';

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;

export type LlmCallLogPort = Pick<LlmCallRepository, 'insert' | 'list'>;

export interface LlmCallPageItem {
  readonly id: string;
  readonly requestId: string | null;
  readonly sessionId: string | null;
  readonly purpose: LlmCallPurpose;
  readonly kind: LlmCallKind;
  readonly model: string;
  readonly status: LlmCallStatus;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly durationMs: number;
  readonly promptTokens: number | null;
  readonly completionTokens: number | null;
  readonly totalTokens: number | null;
  readonly costUsd: number | null;
  readonly attempts: number;
  readonly errorCode: string | null;
}

export interface LlmCallPage {
  readonly items: readonly LlmCallPageItem[];
  readonly nextCursor: string | null;
}

export interface ListLlmCallsOptions {
  readonly subject: string;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface PersistLlmCallPorts {
  readonly callLog: LlmCallLogPort | undefined;
  readonly logger: Logger;
  readonly modelName: string;
  readonly pricing: LlmPricing | undefined;
}

export interface PersistLlmCallInput {
  readonly startedAt: Date;
  readonly durationMs: number;
  readonly kind: LlmCallKind;
  readonly options: LlmOptions | undefined;
  readonly status: LlmCallStatus;
  readonly errorCode: string | null;
  readonly attempts: number;
  readonly usage: LlmUsage | null;
}

export function listLlmCalls(
  callLog: LlmCallLogPort | undefined,
  options: ListLlmCallsOptions,
): LlmCallPage {
  if (callLog === undefined) {
    return { items: [], nextCursor: null };
  }
  const limit = options.limit ?? DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
    throw new ComemError(
      'INVALID_ARGUMENT',
      `limit 必须是 1–${String(MAX_PAGE_SIZE)} 的整数。`,
      { field: 'limit', value: limit },
    );
  }
  const before = options.cursor === undefined ? undefined : decodeCursor(options.cursor);
  const rows = before === undefined
    ? callLog.list({ subject: options.subject, limit })
    : callLog.list({ subject: options.subject, limit, before });
  const pageRows = rows.slice(0, limit);
  const last = pageRows.at(-1);
  return {
    items: pageRows.map(toPageItem),
    nextCursor:
      rows.length > limit && last !== undefined
        ? encodeCursor({ startedAt: last.startedAt, id: last.id })
        : null,
  };
}

export function persistLlmCall(
  ports: PersistLlmCallPorts,
  input: PersistLlmCallInput,
): void {
  if (ports.callLog === undefined) {
    return;
  }
  const promptTokens = input.usage?.promptTokens ?? null;
  const completionTokens = input.usage?.completionTokens ?? null;
  const context = currentLlmCallContext();
  const record: LlmCallRecord = {
    id: randomUUID(),
    requestId: context.requestId,
    sessionId: input.options?.sessionId ?? context.sessionId,
    subject: context.subject,
    purpose: input.options?.purpose ?? 'unspecified',
    kind: input.kind,
    model: ports.modelName,
    status: input.status,
    startedAt: input.startedAt.toISOString(),
    endedAt: new Date(input.startedAt.getTime() + input.durationMs).toISOString(),
    durationMs: Math.max(0, input.durationMs),
    promptTokens,
    completionTokens,
    costUsd:
      promptTokens === null || completionTokens === null
        ? null
        : llmCostUsd(ports.pricing, promptTokens, completionTokens),
    errorCode: input.errorCode,
    attempts: input.attempts,
  };
  try {
    ports.callLog.insert(record);
  } catch (error) {
    ports.logger.warn('模型调用记录写入失败。', {
      model: record.model,
      purpose: record.purpose,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function encodeCursor(cursor: LlmCallCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeCursor(value: string): LlmCallCursor {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      typeof (parsed as Record<string, unknown>)['startedAt'] === 'string' &&
      typeof (parsed as Record<string, unknown>)['id'] === 'string' &&
      !Number.isNaN(Date.parse(String((parsed as Record<string, unknown>)['startedAt']))) &&
      (parsed as Record<string, unknown>)['id'] !== ''
    ) {
      return {
        startedAt: String((parsed as Record<string, unknown>)['startedAt']),
        id: String((parsed as Record<string, unknown>)['id']),
      };
    }
  } catch {
    // 统一走下面的 INVALID_ARGUMENT。
  }
  throw new ComemError('INVALID_ARGUMENT', 'cursor 不是有效的调用记录分页游标。', {
    field: 'cursor',
  });
}

function toPageItem(record: LlmCallRecord): LlmCallPageItem {
  return {
    id: record.id,
    requestId: record.requestId,
    sessionId: record.sessionId,
    purpose: record.purpose,
    kind: record.kind,
    model: record.model,
    status: record.status,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    durationMs: record.durationMs,
    promptTokens: record.promptTokens,
    completionTokens: record.completionTokens,
    totalTokens:
      record.promptTokens === null || record.completionTokens === null
        ? null
        : record.promptTokens + record.completionTokens,
    costUsd: record.costUsd,
    attempts: record.attempts,
    errorCode: record.errorCode,
  };
}
