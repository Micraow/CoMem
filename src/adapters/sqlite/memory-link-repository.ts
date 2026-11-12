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
import { text } from './row.js';

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

  /**
   * 用一批行**整体替换**某一类边（`reindex` 的 `derived_from` 重建入口）。
   *
   * 先删后写，在同一个事务里：重建要的是「表里的 `derived_from` 与磁盘上的 `sources`
   * 一致」，增量补齐删不掉「`sources` 里已经没有、表里还留着」的边——而那正是手工
   * 改过 `sources` 之后读端点与文件不一致的形态（§11.10）。
   *
   * 只动调用方指定的 `link_type`：其它类型的边没有 frontmatter 里的真相，推不出来，
   * 也不能被这次重建误删。
   *
   * 不检查 `to_uri` 指向的文件是否存在：`sources` 是真相，归档被清理之后那条溯源
   * 仍然成立（§11.10「悬空边写时不拦、读时容忍」）。查存在性还会让同一份输入因为
   * 磁盘现状不同而得到不同的边，重建不再幂等。
   *
   * 与 `upsertMany` 不同，这里直接 INSERT：这一类边刚被删空，不会撞唯一键。重复的
   * `(from_uri, to_uri, match_text)` 必须由调用方去掉，否则整批回滚。
   */
  replaceByLinkType(
    linkType: string,
    inputs: readonly MemoryLinkRowInput[],
  ): { inserted: number; deleted: number } {
    const now = new Date().toISOString();
    let deleted = 0;
    const insertStmt = this.#db.prepare(
      `INSERT INTO memory_link (${LINK_COLUMNS}, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    withWriteTransaction(this.#db, () => {
      deleted = Number(
        this.#db.prepare('DELETE FROM memory_link WHERE link_type = ?').run(linkType).changes,
      );
      for (const input of inputs) {
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
      }
    });

    this.#logger.info('memory_link 已按类别整体替换', {
      linkType,
      inserted: inputs.length,
      deleted,
    });
    return { inserted: inputs.length, deleted };
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
