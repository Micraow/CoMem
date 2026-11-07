/**
 * 请求记录仓储（架构文档 §17.6、§17.7）。
 *
 * 只做 `request_log` 表的行与值转换。「该不该记这条请求」（采样、`enabled`）与
 * 「归因报告长什么样」在 `services/observability.ts`。
 *
 * 三个不变量：
 *
 * 1. **诊断数据不跟业务一起失败**：`phases` 是 JSON 文本，解析失败返回 `null` 而不是
 *    抛错。一条坏行不该让整个列表页 500——那样连「哪一行坏了」都看不到。
 * 2. **时间只用 ISO 8601 字符串**。与 `node` / `task` 表一致：ISO 8601 的字典序等于
 *    时间序，裁剪与分页的 `WHERE` / `ORDER BY` 不需要 `julianday()` 之类的转换。
 * 3. **裁剪两条规则都在一个事务里**（§17.6：7 天或 10 万条，先到先删）。先按天数
 *    删、再按行数删；第二条只看剩下的行，所以两条规则不会互相「救回」被删的行。
 */

import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';

import type { Logger } from '../../domain/log.js';

import { withWriteTransaction } from './database.js';
import { placeholders } from './node-repository.js';

/** `request_log` 表的一行（架构文档 §17.6）。 */
export interface RequestLogRow {
  readonly id: string;
  readonly requestId: string;
  readonly method: string;
  readonly path: string;
  readonly statusCode: number;
  readonly durationMs: number;
  /** §17.2 的四阶段，缺的字段为 null */
  readonly phases: Record<string, number | null> | null;
  readonly errorCode: string | null;
  readonly subject: string | null;
  readonly createdAt: string;
}

export interface RequestLogRepositoryDeps {
  readonly db: DatabaseSync;
  readonly logger: Logger;
}

export interface RequestLogListOptions {
  readonly limit: number;
  readonly offset?: number;
  /** 只要 `status_code >= 400` 或 `error_code IS NOT NULL` 的行 */
  readonly onlyErrors?: boolean;
}

export interface RequestLogPruneOptions {
  /** §18 的 `telemetry.requestLog.retainDays`：保留最近这么多天 */
  readonly retainDays: number;
  /** §18 的 `telemetry.requestLog.retainRows`：总共保留这么多行（最新的） */
  readonly retainRows: number;
  readonly now: Date;
}

/** 列顺序与 `RequestLogRow` 字段顺序一致，映射函数只依赖这个常量。 */
const REQUEST_LOG_COLUMN_NAMES = [
  'id',
  'request_id',
  'method',
  'path',
  'status_code',
  'duration_ms',
  'phases',
  'error_code',
  'subject',
  'created_at',
] as const;

const REQUEST_LOG_COLUMNS = REQUEST_LOG_COLUMN_NAMES.join(', ');

/** 1 天 = 86 400 000 毫秒；`retainDays` 是配置里的天数。 */
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

function text(value: SQLOutputValue | undefined): string {
  return String(value);
}

function nullableText(value: SQLOutputValue | undefined): string | null {
  return value === null || value === undefined ? null : String(value);
}

function number(value: SQLOutputValue | undefined): number {
  return Number(value);
}

/**
 * 解析 `phases` 列。
 *
 * 失败（非法 JSON、不是对象）返回 `null`：阶段计时是诊断数据，缺了它请求记录本身
 * 仍然有用（§17.6 要的是「哪个请求、多慢、什么状态」）。值不是数字的条目按 `null`
 * 处理，与 `RequestLogRow.phases` 的「缺的字段为 null」一致。
 */
function parsePhases(raw: string | null): Record<string, number | null> | null {
  if (raw === null) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const phases: Record<string, number | null> = {};
  for (const [name, value] of Object.entries(parsed)) {
    phases[name] = typeof value === 'number' ? value : null;
  }
  return phases;
}

function toRequestLogRow(row: Record<string, SQLOutputValue>): RequestLogRow {
  return {
    id: text(row['id']),
    requestId: text(row['request_id']),
    method: text(row['method']),
    path: text(row['path']),
    statusCode: number(row['status_code']),
    durationMs: number(row['duration_ms']),
    phases: parsePhases(nullableText(row['phases'])),
    errorCode: nullableText(row['error_code']),
    subject: nullableText(row['subject']),
    createdAt: text(row['created_at']),
  };
}

export class RequestLogRepository {
  readonly #db: DatabaseSync;
  readonly #logger: Logger;

  constructor(deps: RequestLogRepositoryDeps) {
    this.#db = deps.db;
    this.#logger = deps.logger;
  }

  insert(row: RequestLogRow): void {
    withWriteTransaction(this.#db, () => {
      this.#db
        .prepare(
          `INSERT INTO request_log (${REQUEST_LOG_COLUMNS})
           VALUES (${placeholders(REQUEST_LOG_COLUMN_NAMES.length)})`,
        )
        .run(
          row.id,
          row.requestId,
          row.method,
          row.path,
          row.statusCode,
          row.durationMs,
          row.phases === null ? null : JSON.stringify(row.phases),
          row.errorCode,
          row.subject,
          row.createdAt,
        );
    });
    this.#logger.debug('请求记录已写入', {
      requestId: row.requestId,
      method: row.method,
      path: row.path,
      statusCode: row.statusCode,
    });
  }

  /**
   * 按时间倒序分页。
   *
   * 排序的第二键是 `id`：同一毫秒内到达的并发请求 `created_at` 相同，不补一个稳定
   * 的次序时，翻页会看到重复或漏行。
   */
  list(options: RequestLogListOptions): readonly RequestLogRow[] {
    const errorFilter =
      options.onlyErrors === true ? ' WHERE status_code >= 400 OR error_code IS NOT NULL' : '';
    return this.#db
      .prepare(
        `SELECT ${REQUEST_LOG_COLUMNS} FROM request_log${errorFilter}
          ORDER BY created_at DESC, id DESC
          LIMIT ? OFFSET ?`,
      )
      .all(options.limit, options.offset ?? 0)
      .map(toRequestLogRow);
  }

  /**
   * 按 §17.6 的保留策略裁剪，返回删除行数。
   *
   * 两条规则都要：只按天数删，突发流量能在一天内把表撑到百万行；只按行数删，
   * 低频部署会永远留着上个月的请求。先删过期、再按行数保留最新的 `retainRows`
   * 条——`retainRows <= 0` 表示一条都不留（配置允许 0，语义就是「不留历史」）。
   */
  prune(options: RequestLogPruneOptions): number {
    const cutoff = new Date(
      options.now.getTime() - options.retainDays * MILLISECONDS_PER_DAY,
    ).toISOString();

    const deleted = withWriteTransaction(this.#db, () => {
      const expired = this.#db
        .prepare('DELETE FROM request_log WHERE created_at < ?')
        .run(cutoff).changes;

      const overflow =
        options.retainRows <= 0
          ? this.#db.prepare('DELETE FROM request_log').run().changes
          : this.#db
              .prepare(
                `DELETE FROM request_log
                  WHERE id NOT IN (
                    SELECT id FROM request_log
                     ORDER BY created_at DESC, id DESC
                     LIMIT ?
                  )`,
              )
              .run(options.retainRows).changes;

      return Number(expired) + Number(overflow);
    });

    if (deleted > 0) {
      this.#logger.info('请求记录已裁剪', {
        deleted,
        retainDays: options.retainDays,
        retainRows: options.retainRows,
      });
    }
    return deleted;
  }

  count(): number {
    const row = this.#db.prepare('SELECT COUNT(*) AS total FROM request_log').get();
    return Number(row?.['total'] ?? 0);
  }
}
