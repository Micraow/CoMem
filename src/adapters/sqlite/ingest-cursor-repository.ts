/**
 * 导入游标仓储（架构文档 §11.9、`0011_ingest.sql`）。
 *
 * 只做 `ingest_cursor` 表的行与值转换。「什么时候前进游标」「哪些会话该跳过」在
 * `services/ingest.ts`。
 *
 * ## 三个不变量
 *
 * 1. **主键是 `(harness, native_session_id)`。** 同一个原生 ID 在不同宿主里是不同
 *    的会话；跨宿主去重会把两个不相干的对话并成一个。
 * 2. **时间是 ISO 8601 字符串。** 与 `node` / `task` / `request_log` 一致：ISO 的
 *    字典序等于时间序，排序与裁剪不需要 `julianday()` 转换。
 * 3. **`upsert` 是唯一的写入口。** 首次导入插入、续跑更新，两条路径不能各写一份
 *    SQL——否则「续跑时忘了更新 `session_uri`」这类缺陷只会在重跑时出现。
 */

import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';

import type { CursorKind, IngestHarness } from '../../domain/ingest.js';
import type { Logger } from '../../domain/log.js';

import { withWriteTransaction } from './database.js';
import { placeholders } from './node-repository.js';

export interface IngestCursorRow {
  readonly harness: IngestHarness;
  readonly nativeSessionId: string;
  readonly sessionUri: string;
  readonly cursorKind: CursorKind;
  readonly cursorValue: string;
  readonly messageCount: number;
  readonly updatedAt: string;
}

export interface IngestCursorRepositoryDeps {
  readonly db: DatabaseSync;
  readonly logger: Logger;
}

/** 列顺序与 `IngestCursorRow` 字段顺序一致，映射函数只依赖这个常量。 */
const CURSOR_COLUMN_NAMES = [
  'harness',
  'native_session_id',
  'session_uri',
  'cursor_kind',
  'cursor_value',
  'message_count',
  'updated_at',
] as const;

const CURSOR_COLUMNS = CURSOR_COLUMN_NAMES.join(', ');

function text(value: SQLOutputValue | undefined): string {
  return String(value);
}

function integer(value: SQLOutputValue | undefined): number {
  return Number(value);
}

/**
 * `harness` / `cursor_kind` 用 `as` 收窄：写入路径只接受领域类型，表里出现的
 * 值一定是联合成员。再写一遍校验只会给两个字段各加一个不可能走到的分支。
 */
function toRow(row: Record<string, SQLOutputValue>): IngestCursorRow {
  return {
    harness: text(row['harness']) as IngestHarness,
    nativeSessionId: text(row['native_session_id']),
    sessionUri: text(row['session_uri']),
    cursorKind: text(row['cursor_kind']) as CursorKind,
    cursorValue: text(row['cursor_value']),
    messageCount: integer(row['message_count']),
    updatedAt: text(row['updated_at']),
  };
}

export class IngestCursorRepository {
  readonly #db: DatabaseSync;
  readonly #logger: Logger;

  constructor(deps: IngestCursorRepositoryDeps) {
    this.#db = deps.db;
    this.#logger = deps.logger;
  }

  get(harness: IngestHarness, nativeSessionId: string): IngestCursorRow | null {
    const row = this.#db
      .prepare(
        `SELECT ${CURSOR_COLUMNS} FROM ingest_cursor
          WHERE harness = ? AND native_session_id = ?`,
      )
      .get(harness, nativeSessionId);
    return row === undefined ? null : toRow(row);
  }

  list(harness?: IngestHarness): readonly IngestCursorRow[] {
    const rows =
      harness === undefined
        ? this.#db
            .prepare(
              `SELECT ${CURSOR_COLUMNS} FROM ingest_cursor
                ORDER BY harness, native_session_id`,
            )
            .all()
        : this.#db
            .prepare(
              `SELECT ${CURSOR_COLUMNS} FROM ingest_cursor
                WHERE harness = ?
                ORDER BY native_session_id`,
            )
            .all(harness);
    return rows.map(toRow);
  }

  /**
   * 插入或更新。主键冲突时更新全部可变列：续跑时游标、消息数与 `session_uri`
   * 都可能变（首次导入还没建会话时 `session_uri` 为空串的路径不存在——服务层
   * 只在会话建好之后才写第一行）。
   */
  upsert(row: IngestCursorRow): void {
    withWriteTransaction(this.#db, () => {
      this.#db
        .prepare(
          `INSERT INTO ingest_cursor (${CURSOR_COLUMNS})
           VALUES (${placeholders(CURSOR_COLUMN_NAMES.length)})
           ON CONFLICT(harness, native_session_id) DO UPDATE SET
             session_uri = excluded.session_uri,
             cursor_kind = excluded.cursor_kind,
             cursor_value = excluded.cursor_value,
             message_count = excluded.message_count,
             updated_at = excluded.updated_at`,
        )
        .run(
          row.harness,
          row.nativeSessionId,
          row.sessionUri,
          row.cursorKind,
          row.cursorValue,
          row.messageCount,
          row.updatedAt,
        );
    });
    this.#logger.debug('导入游标已写入', {
      harness: row.harness,
      nativeSessionId: row.nativeSessionId,
      cursorKind: row.cursorKind,
      cursorValue: row.cursorValue,
      messageCount: row.messageCount,
    });
  }

  /** 删掉一条游标，返回是否真的删到了行（测试与「重导某个会话」用）。 */
  delete(harness: IngestHarness, nativeSessionId: string): boolean {
    const result = this.#db
      .prepare('DELETE FROM ingest_cursor WHERE harness = ? AND native_session_id = ?')
      .run(harness, nativeSessionId);
    return Number(result.changes) > 0;
  }

  count(harness?: IngestHarness): number {
    const row =
      harness === undefined
        ? this.#db.prepare('SELECT COUNT(*) AS total FROM ingest_cursor').get()
        : this.#db
            .prepare('SELECT COUNT(*) AS total FROM ingest_cursor WHERE harness = ?')
            .get(harness);
    return Number(row?.['total'] ?? 0);
  }
}
