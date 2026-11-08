/**
 * 提示词覆盖仓储（架构文档 §18、`0012_prompt.sql`）。
 *
 * 只做 `prompt_override` 表的行与值转换。「默认值从哪读」「覆盖是否过期」「保存
 * 前怎么校验」在 `services/prompt-service.ts`。
 *
 * ## 三个不变量
 *
 * 1. **主键是 `prompt_id`，与 `prompts/{id}.md` 的文件名一致。** 两处对不上时
 *    覆盖会落到一条没人读的行上，界面显示「已覆盖」而实际没生效。
 * 2. **`body` 是完整模板，不是 diff。** 覆盖按整篇替换；存 diff 需要一套三方合并，
 *    而模板不超过几 KB。
 * 3. **`base_digest` 只写不读于本层。** 它服务的是「版本漂移」判断，读的一方是
 *    服务层；仓储负责原样存取，不在写入口重算。
 */

import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';

import type { PromptId } from '../../domain/prompt.js';

import { withWriteTransaction } from './database.js';

export interface PromptOverrideRow {
  readonly promptId: PromptId;
  readonly body: string;
  readonly baseDigest: string;
  readonly updatedAt: string;
}

export interface PromptRepositoryDeps {
  readonly db: DatabaseSync;
}

/** 列顺序与 `PromptOverrideRow` 字段顺序一致，映射函数只依赖这个常量。 */
const OVERRIDE_COLUMN_NAMES = ['prompt_id', 'body', 'base_digest', 'updated_at'] as const;

const OVERRIDE_COLUMNS = OVERRIDE_COLUMN_NAMES.join(', ');

function text(value: SQLOutputValue | undefined): string {
  return String(value);
}

/**
 * `prompt_id` 用 `as` 收窄：写入路径只接受 `PromptId`，表里出现的值一定是
 * `PROMPT_IDS` 的成员。再写一遍校验只会给一个不可能走到的分支。
 */
function toRow(row: Record<string, SQLOutputValue>): PromptOverrideRow {
  return {
    promptId: text(row['prompt_id']) as PromptId,
    body: text(row['body']),
    baseDigest: text(row['base_digest']),
    updatedAt: text(row['updated_at']),
  };
}

export class PromptRepository {
  readonly #db: DatabaseSync;

  constructor(deps: PromptRepositoryDeps) {
    this.#db = deps.db;
  }

  list(): readonly PromptOverrideRow[] {
    return this.#db
      .prepare(`SELECT ${OVERRIDE_COLUMNS} FROM prompt_override ORDER BY prompt_id`)
      .all()
      .map(toRow);
  }

  get(promptId: PromptId): PromptOverrideRow | null {
    const row = this.#db
      .prepare(`SELECT ${OVERRIDE_COLUMNS} FROM prompt_override WHERE prompt_id = ?`)
      .get(promptId);
    return row === undefined ? null : toRow(row);
  }

  /** 插入或整篇替换。覆盖没有「部分更新」的语义。 */
  upsert(row: PromptOverrideRow): void {
    withWriteTransaction(this.#db, () => {
      this.#db
        .prepare(
          `INSERT INTO prompt_override (${OVERRIDE_COLUMNS})
           VALUES (?, ?, ?, ?)
           ON CONFLICT(prompt_id) DO UPDATE SET
             body = excluded.body,
             base_digest = excluded.base_digest,
             updated_at = excluded.updated_at`,
        )
        .run(row.promptId, row.body, row.baseDigest, row.updatedAt);
    });
  }

  /** 删掉覆盖，返回是否真的删到了行。删掉即恢复默认。 */
  delete(promptId: PromptId): boolean {
    const result = this.#db
      .prepare('DELETE FROM prompt_override WHERE prompt_id = ?')
      .run(promptId);
    return Number(result.changes) > 0;
  }
}
