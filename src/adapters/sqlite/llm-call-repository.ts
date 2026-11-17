/**
 * LLM 调用记录的 SQLite 仓储（架构文档 §17.4、§17.6）。
 *
 * 表只保存结构化诊断字段。prompt、模型响应正文、密钥和供应商原始错误不进入这里，
 * 因此控制台的最近调用视图即使显示模型名与 token 数，也不会复制对话内容。
 */

import type { DatabaseSync } from 'node:sqlite';

import type { LlmCallRecord } from '../../domain/llm.js';
import type { Logger } from '../../domain/log.js';
import { MILLISECONDS_PER_DAY } from '../../domain/time.js';

import { withWriteTransaction } from './database.js';
import { placeholders } from './node-repository.js';

export interface LlmCallCursor {
  readonly startedAt: string;
  readonly id: string;
}

export interface LlmCallListOptions {
  readonly subject: string;
  /** 仓储返回 `limit + 1` 行，由服务层决定是否还有下一页并裁掉哨兵。 */
  readonly limit: number;
  readonly before?: LlmCallCursor;
}

export interface LlmCallPruneOptions {
  readonly retainDays: number;
  readonly retainRows: number;
  readonly now: Date;
}

export interface LlmCallRepositoryDeps {
  readonly db: DatabaseSync;
  readonly logger: Logger;
  /** 关闭时只停写，已有记录仍可查询，继续受保留策略裁剪。 */
  readonly enabled: boolean;
}

const COLUMN_NAMES = [
  'id',
  'request_id',
  'session_id',
  'subject',
  'purpose',
  'call_kind',
  'model',
  'status',
  'started_at',
  'ended_at',
  'duration_ms',
  'prompt_tokens',
  'completion_tokens',
  'cost_usd',
  'error_code',
  'attempts',
] as const;

const COLUMNS = COLUMN_NAMES.join(', ');

function rowToRecord(row: Record<string, unknown>): LlmCallRecord {
  return {
    id: String(row['id']),
    requestId: typeof row['request_id'] === 'string' ? row['request_id'] : null,
    sessionId: typeof row['session_id'] === 'string' ? row['session_id'] : null,
    subject: typeof row['subject'] === 'string' ? row['subject'] : null,
    purpose: String(row['purpose']) as LlmCallRecord['purpose'],
    kind: String(row['call_kind']) as LlmCallRecord['kind'],
    model: String(row['model']),
    status: String(row['status']) as LlmCallRecord['status'],
    startedAt: String(row['started_at']),
    endedAt: String(row['ended_at']),
    durationMs: Number(row['duration_ms']),
    promptTokens:
      typeof row['prompt_tokens'] === 'number' ? Number(row['prompt_tokens']) : null,
    completionTokens:
      typeof row['completion_tokens'] === 'number' ? Number(row['completion_tokens']) : null,
    costUsd: typeof row['cost_usd'] === 'number' ? Number(row['cost_usd']) : null,
    errorCode: typeof row['error_code'] === 'string' ? row['error_code'] : null,
    attempts: Number(row['attempts']),
  };
}

export class LlmCallRepository {
  readonly #db: DatabaseSync;
  readonly #logger: Logger;
  readonly #enabled: boolean;

  constructor(deps: LlmCallRepositoryDeps) {
    this.#db = deps.db;
    this.#logger = deps.logger;
    this.#enabled = deps.enabled;
  }

  insert(record: LlmCallRecord): void {
    if (!this.#enabled) {
      return;
    }
    withWriteTransaction(this.#db, () => {
      this.#db
        .prepare(
          `INSERT INTO llm_call_log (${COLUMNS})
           VALUES (${placeholders(COLUMN_NAMES.length)})`,
        )
        .run(
          record.id,
          record.requestId,
          record.sessionId,
          record.subject,
          record.purpose,
          record.kind,
          record.model,
          record.status,
          record.startedAt,
          record.endedAt,
          record.durationMs,
          record.promptTokens,
          record.completionTokens,
          record.costUsd,
          record.errorCode,
          record.attempts,
        );
    });
  }

  list(options: LlmCallListOptions): readonly LlmCallRecord[] {
    const rows = options.before === undefined
      ? this.#db
          .prepare(
            `SELECT ${COLUMNS}
               FROM llm_call_log
              WHERE subject = ?
              ORDER BY started_at DESC, id DESC
              LIMIT ?`,
          )
          .all(options.subject, options.limit + 1)
      : this.#db
          .prepare(
            `SELECT ${COLUMNS}
               FROM llm_call_log
              WHERE subject = ?
                AND (started_at < ? OR (started_at = ? AND id < ?))
              ORDER BY started_at DESC, id DESC
              LIMIT ?`,
          )
          .all(
            options.subject,
            options.before.startedAt,
            options.before.startedAt,
            options.before.id,
            options.limit + 1,
          );
    return rows.map(rowToRecord);
  }

  /** 按时间与全局行数裁剪；两者的最旧行都走 `llm_call_log_started`。 */
  prune(options: LlmCallPruneOptions): number {
    const cutoff = new Date(
      options.now.getTime() - options.retainDays * MILLISECONDS_PER_DAY,
    ).toISOString();

    const deleted = withWriteTransaction(this.#db, () => {
      const expired = this.#db
        .prepare('DELETE FROM llm_call_log WHERE started_at < ?')
        .run(cutoff).changes;
      const total = Number(
        this.#db.prepare('SELECT COUNT(*) AS total FROM llm_call_log').get()?.['total'] ?? 0,
      );
      let overflow = 0;
      if (total > options.retainRows) {
        overflow = Number(
          options.retainRows <= 0
            ? this.#db.prepare('DELETE FROM llm_call_log').run().changes
            : this.#db
                .prepare(
                  `DELETE FROM llm_call_log
                    WHERE rowid IN (
                      SELECT rowid FROM llm_call_log
                       ORDER BY started_at ASC
                       LIMIT ?
                    )`,
                )
                .run(total - options.retainRows).changes,
        );
      }
      return Number(expired) + Number(overflow);
    });

    if (deleted > 0) {
      this.#logger.info('模型调用记录已裁剪', {
        deleted,
        retainDays: options.retainDays,
        retainRows: options.retainRows,
      });
    }
    return deleted;
  }
}
