/**
 * 归档目录里的 `memory_diff.json`：读出「这次归档写入了哪些记忆」。
 *
 * 唯一用途是删除会话前的待复核记忆检查。关联只有一条：`archive_NNN/memory_diff.json`
 * 记下了每次归档写入了哪些记忆（§6.6）。它就在会话目录里，所以「删掉会话」等于删掉
 * 「这条待复核记忆是哪个会话产出的」这唯一线索。
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { toDiskPath } from '../../adapters/fs/path.js';
import { ComemError } from '../../domain/errors.js';
import { fsErrorCode } from '../../domain/errors.js';
import { isRecord } from '../../domain/guards.js';
import type { Uri } from '../../domain/uri.js';

import { MEMORY_DIFF_FILE_NAME } from './constants.js';

/**
 * 从 `memory_diff.json` 里读出「这次归档写入了哪些记忆」。
 *
 * 只取 `operations.adds` / `operations.updates` 的 URI：`deletes` 指向的记忆已经
 * 没了，没有「还在待复核」这回事；`skippedOperations` 没有 URI（它们没写成）。
 *
 * 形状不对时抛 `INTERNAL`：这个文件只由 `MemoryMergeStep` 写，磁盘上的内容不合法
 * 说明数据被改坏了。调用方（`expireSession`）按「无法证明安全」处理——**不删**。
 */
export function memoryUrisOf(value: unknown, archiveUri: Uri): readonly string[] {
  const corrupt = (reason: string): ComemError =>
    new ComemError('INTERNAL', `memory_diff.json 内容不合法：${archiveUri.toString()}（${reason}）`, {
      uri: archiveUri.toString(),
      reason,
    });

  if (!isRecord(value)) {
    throw corrupt('不是对象');
  }
  const operations = value['operations'];
  if (!isRecord(operations)) {
    throw corrupt('operations 不是对象');
  }

  const uris: string[] = [];
  for (const key of ['adds', 'updates'] as const) {
    const entries = operations[key];
    if (!Array.isArray(entries)) {
      throw corrupt(`operations.${key} 不是数组`);
    }
    for (const entry of entries) {
      const uri = isRecord(entry) ? entry['uri'] : undefined;
      if (typeof uri !== 'string') {
        throw corrupt(`operations.${key}[] 缺少字符串 uri`);
      }
      uris.push(uri);
    }
  }
  return uris;
}

/** 读归档的 `memory_diff.json`；不存在返回 `null`（正常状态：阶段二还没跑）。 */
export async function readMemoryDiff(dataDir: string, archiveUri: Uri): Promise<unknown | null> {
  const path = join(toDiskPath(dataDir, archiveUri), MEMORY_DIFF_FILE_NAME);
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if (fsErrorCode(error) === 'ENOENT') {
      return null;
    }
    throw error;
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new ComemError('INTERNAL', `memory_diff.json 不是合法 JSON：${archiveUri.toString()}`, {
      uri: archiveUri.toString(),
    });
  }
}
