/**
 * 记忆健康度聚合（§17.5）：`GET /health` 的 `memory` 字段。
 *
 * 这是诊断端点，不是全库扫描：能一条 SELECT 回答的走索引，需要读正文的两项
 * （降级摘要目录、画像格式）各有上界，达到上界只统计已读部分并记 `warn`。
 */

import type { MetadataFileStore } from '../../adapters/fs/metadata-file.js';
import type { TaskRepository } from '../../adapters/sqlite/task-repository.js';
import type { Logger } from '../../domain/log.js';
import { Uri } from '../../domain/uri.js';

import type { ObservabilityDatabase } from './contracts.js';
import { errorMessage } from '../../domain/errors.js';
import { MILLISECONDS_PER_SECOND } from '../../domain/time.js';
import {
  profileFormatHealth,
  type ProfileBodyReader,
  type ProfileFormatHealth,
} from './profile-format.js';
import { countRows, NODE_SELF_ROW } from './queries.js';

export interface MemoryHealth {
  readonly pendingReview: number;
  readonly staleSummaries: number;
  readonly degradedSummaries: number;
  readonly orphanTasks: number;
  readonly indexNodes: number;
  readonly oldestPendingAgeSeconds: number | null;
  /** 画像格式契约的自查结果（§11.1） */
  readonly profileFormat: ProfileFormatHealth;
}

/**
 * `degradedSummaries` 最多检查的目录数：1000。
 *
 * 经验值，来源未知：§17.5 只要求分析型统计，没给上界。每个目录要读两个摘要文件，
 * 1000 个目录约 2000 次读；健康检查是诊断端点，不该因为库大就把请求拖成秒级。
 */
const DEGRADED_DIRECTORY_LIMIT = 1000;

/** 健康度需要的端口（`ObservabilityServiceDeps` 的子集）。 */
export interface HealthPorts {
  readonly db: ObservabilityDatabase;
  readonly metadata: Pick<MetadataFileStore, 'readSummary'>;
  readonly tasks: Pick<TaskRepository, 'countExpiredLeases'>;
  readonly profileBodies: ProfileBodyReader;
  readonly logger: Logger;
}

/** §17.5 记忆健康度。字段口径见各查询的注释。 */
export async function healthSnapshot(ports: HealthPorts, now: Date): Promise<MemoryHealth> {
  const { db, metadata, tasks, profileBodies, logger } = ports;
  const pendingReview = countRows(
    db,
    `SELECT COUNT(*) AS total FROM node WHERE status = ? AND ${NODE_SELF_ROW}`,
    'pending',
  );
  const staleSummaries = countRows(
    db,
    `SELECT COUNT(*) AS total FROM node
        WHERE kind = 'directory' AND summary_pending > 0`,
  );
  // 租约过期的 running 任务就是孤儿：没人续租，正常的执行器不会再碰它。谓词与
  // `TaskRepository.recoverExpired` 是同一份（`LEASE_EXPIRED_SQL`），所以这里报的
  // 数字就是下次启动扫描能捞回的任务数。
  const orphanTasks = tasks.countExpiredLeases(now);
  const indexNodes = countRows(db, `SELECT COUNT(*) AS total FROM node WHERE ${NODE_SELF_ROW}`);
  const oldestPendingAgeSeconds = oldestPendingAgeSecondsOf(db, now);
  const degradedSummaries = await countDegradedSummaries(db, metadata, logger);
  const profileFormat = await profileFormatHealth({ db, profileBodies, logger });

  const health: MemoryHealth = {
    pendingReview,
    staleSummaries,
    degradedSummaries,
    orphanTasks,
    indexNodes,
    oldestPendingAgeSeconds,
    profileFormat,
  };
  logger.debug('记忆健康度统计完成。', { ...health });
  return health;
}

/** 最老的 pending 记忆距今秒数（§17.5）；没有则 `null`（「没有」不是 0 秒）。 */
function oldestPendingAgeSecondsOf(db: ObservabilityDatabase, now: Date): number | null {
  const row = db
    .prepare(
      `SELECT updated_at FROM node
          WHERE status = 'pending' AND ${NODE_SELF_ROW}
          ORDER BY updated_at ASC
          LIMIT 1`,
    )
    .get();
  const updatedAt = row?.['updated_at'];
  if (typeof updatedAt !== 'string') {
    return null;
  }
  const timestamp = Date.parse(updatedAt);
  if (Number.isNaN(timestamp)) {
    return null;
  }
  // 时钟回拨时差值为负，按 0 秒报——「未来更新的记忆」不是更老。
  return Math.max(0, Math.floor((now.getTime() - timestamp) / MILLISECONDS_PER_SECOND));
}

/**
 * 降级摘要的目录数（§17.5）。
 *
 * `degraded` 在 `.abstract.md` 的 frontmatter 里（§6.7），只能逐个目录读。上界
 * `DEGRADED_DIRECTORY_LIMIT`：超了说明库已经大到该用专门的巡检，而不是让健康
 * 检查把磁盘读穿。单个目录读失败只跳过（记 `warn`），否则一个坏文件会让整个
 * 健康检查 500。
 */
async function countDegradedSummaries(
  db: ObservabilityDatabase,
  metadata: Pick<MetadataFileStore, 'readSummary'>,
  logger: Logger,
): Promise<number> {
  // 多取一行：用来判断「是否还有更多目录」而不必再跑一次 COUNT。
  const rows = db
    .prepare(
      `SELECT uri FROM node
          WHERE kind = 'directory' AND ${NODE_SELF_ROW}
          ORDER BY uri
          LIMIT ?`,
    )
    .all(DEGRADED_DIRECTORY_LIMIT + 1);

  if (rows.length > DEGRADED_DIRECTORY_LIMIT) {
    logger.warn('目录摘要降级统计达到上限，只统计了一部分目录。', {
      limit: DEGRADED_DIRECTORY_LIMIT,
    });
  }

  let degraded = 0;
  for (const row of rows.slice(0, DEGRADED_DIRECTORY_LIMIT)) {
    const raw = row['uri'];
    if (typeof raw !== 'string') {
      continue;
    }
    try {
      const summary = await metadata.readSummary(Uri.parse(raw));
      if (summary.generation?.degraded === true) {
        degraded += 1;
      }
    } catch (error) {
      logger.warn('读取目录摘要失败，跳过降级统计。', {
        uri: raw,
        error: errorMessage(error),
      });
    }
  }
  return degraded;
}
