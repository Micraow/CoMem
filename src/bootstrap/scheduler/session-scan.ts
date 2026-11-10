/**
 * 从数据根扫出「有哪些会话」。
 *
 * 为什么遍历会话要碰文件系统（原 `scheduler.ts` 文件头的一节）：
 *
 * 会话不是 SQLite 行：`sessions/sess_xxx/` 是磁盘目录，`.meta.json` 是真相（§7），
 * `GET /sessions` 也是列目录再逐个 `load`（`api/http/routes/sessions.ts` 的文件头）。
 * 所以「有哪些会话」只能从数据根扫出来，而这一层是唯一允许同时碰 `node:fs` 与服务
 * 的层（§4.2）。**不建 `session` 表**：那会造出第二个真相来源。
 */

import type { Dirent } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { errorMessage } from '../../domain/errors.js';
import { fsErrorCode } from '../../domain/errors.js';
import type { Logger } from '../../domain/log.js';
import { Uri } from '../../domain/uri.js';

import { SESSIONS_DIRECTORY_NAME, SCOPE_DIRECTORY_NAMES } from './constants.js';

/**
 * 数据根下所有会话的 URI，按字符串升序。
 *
 * 两层目录：`{user,group}/<rootId>/sessions/<sessionId>`。`rootId` 与 `sessionId`
 * 来自磁盘（可能被手工改过），所以每个都要过 `Uri.parse` 的校验；不合法时记
 * warn 并跳过——为一个人工放错名字的目录让整轮调度失败不值得。
 */
export async function discoverSessionUris(dataDir: string, logger: Logger): Promise<readonly Uri[]> {
  const uris: Uri[] = [];
  for (const scope of SCOPE_DIRECTORY_NAMES) {
    for (const rootId of await listDirectories(join(dataDir, scope))) {
      const sessionsDirectory = join(dataDir, scope, rootId, SESSIONS_DIRECTORY_NAME);
      for (const sessionId of await listDirectories(sessionsDirectory)) {
        const uri = parseSessionUri(scope, rootId, sessionId, logger);
        if (uri !== null) {
          uris.push(uri);
        }
      }
    }
  }
  return uris.sort((left, right) => (left.toString() < right.toString() ? -1 : 1));
}

function parseSessionUri(
  scope: (typeof SCOPE_DIRECTORY_NAMES)[number],
  rootId: string,
  sessionId: string,
  logger: Logger,
): Uri | null {
  try {
    return Uri.parse(`comem://${scope}/${rootId}/${SESSIONS_DIRECTORY_NAME}/${sessionId}`);
  } catch (error) {
    logger.warn('数据根下的会话目录名不合法，已跳过。', {
      scope,
      rootId,
      sessionId,
      reason: errorMessage(error),
    });
    return null;
  }
}

/** 直接子目录名（只要目录）；目录不存在返回空数组。 */
async function listDirectories(directory: string): Promise<readonly string[]> {
  let entries: readonly Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    const code = fsErrorCode(error);
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return [];
    }
    throw error;
  }
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}
