/**
 * `memory_link` 表仓储（架构文档 §11.10）。
 *
 * 只做两件事：把一条边写进表（撞去重键时 weight 取 max），按起点 / 终点反查。
 * 不解析记忆正文、不校验 URI 是否真实存在——边是**关联数据**，跨存储的外键无从
 * 校验（记忆正文在文件系统里，不在本库），悬空边读时容忍、写时不拦。
 */

import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';

import type { Logger } from '../../domain/log.js';
import { mergeWeight, type MemoryLink } from '../../domain/memory-link.js';
import { Uri } from '../../domain/uri.js';
import { withWriteTransaction } from './database.js';

const LINK_COLUMNS = 'from_uri, to_uri, link_type, weight, match_text, description';

/** 一条待写入的边；`from` 已在服务侧确定。 */
export interface MemoryLinkRowInput {
  readonly fromUri: string;
  readonly toUri: string;
  readonly linkType: string;
  readonly weight: number;
  readonly matchText: string;
  readonly description: string;
}

export interface MemoryLinkRepositoryDeps {
  readonly db: DatabaseSync;
  readonly logger: Logger;
}

function text(value: SQLOutputValue | undefined): string {
  return String(value);
}

function toMemoryLink(row: Record<string, SQLOutputValue>): MemoryLink {
  return {
    fromUri: Uri.parse(text(row['from_uri'])),
    toUri: Uri.parse(text(row['to_uri'])),
    linkType: text(row['link_type']),
    weight: Number(row['weight']),
    matchText: text(row['match_text']),
    description: text(row['description']),
  };
}

export class MemoryLinkRepository {
  readonly #db: DatabaseSync;
  readonly #logger: Logger;

  constructor(deps: MemoryLinkRepositoryDeps) {
    this.#db = deps.db;
    this.#logger = deps.logger;
  }

  /**
   * 写入一批边，返回真正新增的条数与 weight 被抬高的条数。
   *
   * 去重键是 `(from_uri, to_uri, match_text)`：撞键时 `weight = max(旧, 新)`，
   * `description` 以最新一次为准（后写的说明覆盖旧说明——说明是文字，取哪一份
   * 都比留着旧的多个版本好），`link_type` 同样更新。整批在一个事务里，避免
   * 「前三条写进、第四条失败」留下半批。
   */
  upsertMany(inputs: readonly MemoryLinkRowInput[]): { inserted: number; merged: number } {
    if (inputs.length === 0) {
      return { inserted: 0, merged: 0 };
    }
    const now = new Date().toISOString();
    let inserted = 0;
    let merged = 0;

    const selectStmt = this.#db.prepare(
      `SELECT weight FROM memory_link WHERE from_uri = ? AND to_uri = ? AND match_text = ?`,
    );
    const insertStmt = this.#db.prepare(
      `INSERT INTO memory_link (${LINK_COLUMNS}, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const updateStmt = this.#db.prepare(
      `UPDATE memory_link
         SET weight = ?, link_type = ?, description = ?, updated_at = ?
       WHERE from_uri = ? AND to_uri = ? AND match_text = ?`,
    );

    withWriteTransaction(this.#db, () => {
      for (const input of inputs) {
        const existing = selectStmt.get(input.fromUri, input.toUri, input.matchText);
        if (existing === undefined) {
          insertStmt.run(
            input.fromUri,
            input.toUri,
            input.linkType,
            input.weight,
            input.matchText,
            input.description,
            now,
            now,
          );
          inserted += 1;
          continue;
        }
        const previous = Number(existing['weight']);
        updateStmt.run(
          mergeWeight(previous, input.weight),
          input.linkType,
          input.description,
          now,
          input.fromUri,
          input.toUri,
          input.matchText,
        );
        merged += 1;
      }
    });

    this.#logger.debug('memory_link 已写入', { inserted, merged });
    return { inserted, merged };
  }

  /** 正向：一个起点指向的所有边，按权重降序。 */
  linksFrom(fromUri: string): readonly MemoryLink[] {
    const rows = this.#db
      .prepare(`SELECT ${LINK_COLUMNS} FROM memory_link WHERE from_uri = ? ORDER BY weight DESC`)
      .all(fromUri);
    return rows.map(toMemoryLink);
  }

  /** 派生：所有指向 `toUri` 的边（backlinks），按权重降序。 */
  backlinksOf(toUri: string): readonly MemoryLink[] {
    const rows = this.#db
      .prepare(`SELECT ${LINK_COLUMNS} FROM memory_link WHERE to_uri = ? ORDER BY weight DESC`)
      .all(toUri);
    return rows.map(toMemoryLink);
  }
}
