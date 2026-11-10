/**
 * 画像格式契约的自查（§11.1）：健康度里的 `memory.profileFormat`。
 *
 * 与索引统计不同，它读**文件正文**：索引里的 `memory_type` 只说明这是一条画像，
 * 说明不了它是否符合格式契约。唯一出口是 `health()`，没有单独的分析端点。
 */

import type { Logger } from '../../domain/log.js';
import { validateProfileBody } from '../../domain/profile-format.js';
import { Uri } from '../../domain/uri.js';

import type { ObservabilityDatabase } from './contracts.js';

/**
 * 画像格式契约的自查结果（§11.1）。
 *
 * 画像一个 scope 只有一份，代价是「一份文件一次读」，所以可以按 scope 逐个校验。
 */
export interface ProfileFormatHealth {
  /** 成功读取并校验的画像份数（索引有节点但文件读不到的不算） */
  readonly checked: number;
  /** 至少有一条违规的画像份数（不是违规条数） */
  readonly invalid: number;
  /** 违规条数合计（一份画像可以有多条） */
  readonly violations: number;
  /**
   * 是否因为上限只检查了一部分。为 `true` 时 `checked` / `invalid` /
   * `violations` 都是**下界**，不能当成全库结论。
   */
  readonly truncated: boolean;
}

/**
 * 画像正文读取（§11.1 的格式自查）。
 *
 * `services/` 不能读盘（§4.2），由 bootstrap 用 `MemoryService.read` 注入。
 */
export interface ProfileBodyReader {
  /** 返回画像正文；索引里有节点但文件不在时返回 `null`（跳过，不计入 `checked`）。 */
  readContent(uri: Uri): Promise<string | null>;
}

/**
 * 一次健康检查最多校验的画像份数：200。
 *
 * 画像一个 scope 只有一份，每份一次读，所以 200 份约等于 200 次文件读取。
 * 来源：经验值，没有实测。§17.5 把健康检查定为诊断端点（500ms 级），200 次
 * 本地读在这个预算内；画像更多的部署应该用专门的巡检脚本，而不是让 `/health`
 * 把磁盘读穿。达到上限时返回值 `truncated: true` 并记一条
 * `warn`，**不静默截断**。
 */
const PROFILE_CHECK_LIMIT = 200;

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface ProfileFormatPorts {
  readonly db: ObservabilityDatabase;
  readonly profileBodies: ProfileBodyReader;
  readonly logger: Logger;
}

/**
 * 画像格式契约自查（§11.1）。只由 `health()` 调用。
 *
 * 索引里 `memory_type = 'profile'` 的节点就是全部画像（画像单文件类型，一个
 * scope 一份）。逐个读正文跑 `validateProfileBody`，只统计、不修改文件。
 *
 * 不单独导出为服务方法：`health()` 的 `memory.profileFormat` 是唯一出口。曾经有过
 * 一个分析端点只为避开 `health()` 的目录摘要读盘而单独调它，那个端点已删——没有
 * 第二个调用方就不留公开面（`pnpm check:reachability` 的口径：导出符号必须在
 * 入口可达的生产代码里被值引用）。
 */
export async function profileFormatHealth(
  ports: ProfileFormatPorts,
): Promise<ProfileFormatHealth> {
  const { db, profileBodies, logger } = ports;
  // 多取一行判断是否还有更多，避免再跑一次 COUNT。
  const rows = db
    .prepare(
      `SELECT uri FROM node
          WHERE memory_type = 'profile'
          ORDER BY uri
          LIMIT ?`,
    )
    .all(PROFILE_CHECK_LIMIT + 1);

  const truncated = rows.length > PROFILE_CHECK_LIMIT;
  if (truncated) {
    logger.warn('画像格式检查达到上限，只检查了一部分画像。', {
      limit: PROFILE_CHECK_LIMIT,
    });
  }

  let checked = 0;
  let invalid = 0;
  let violations = 0;
  for (const row of rows.slice(0, PROFILE_CHECK_LIMIT)) {
    const raw = row['uri'];
    if (typeof raw !== 'string') {
      continue;
    }
    const uri = Uri.tryParse(raw);
    if (uri === null) {
      continue;
    }
    // 单份画像读失败不能把整个健康检查打成 500：跳过并记一条 warn。
    let body: string | null;
    try {
      body = await profileBodies.readContent(uri);
    } catch (error) {
      logger.warn('读取画像正文失败，跳过格式检查。', {
        uri: raw,
        error: errorMessage(error),
      });
      continue;
    }
    if (body === null) {
      continue;
    }
    checked += 1;
    const found = validateProfileBody(body);
    if (found.length > 0) {
      invalid += 1;
      violations += found.length;
    }
  }

  return { checked, invalid, violations, truncated };
}
