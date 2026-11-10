/**
 * 磁盘遍历：把数据根下的全部节点列出来，顺序稳定（`reindex` 的断点续跑依据）。
 *
 * 只从磁盘读，不信任 SQLite：索引坏了才是要重建的理由，拿 `node` 表当输入等于假设
 * 「坏掉的东西还能用」。
 */

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { ContentStore } from '../../adapters/fs/content-store.js';
import { ComemError } from '../../domain/errors.js';
import type { Logger } from '../../domain/log.js';
import { Uri } from '../../domain/uri.js';

/** 磁盘上的一个节点：URI 与它此刻的类型（文件 / 目录）。 */
export interface DiskNode {
  readonly uri: Uri;
  readonly kind: 'file' | 'directory';
}

function fsErrorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return null;
  }
  const code: unknown = error.code;
  return typeof code === 'string' ? code : null;
}

/** 数据根下的两个 scope 目录（`user` / `group`）。不存在不是错误。 */
async function listRoots(dataDir: string): Promise<readonly Uri[]> {
  const roots: Uri[] = [];
  for (const scope of ['user', 'group'] as const) {
    let names: readonly string[];
    try {
      names = await readdir(join(dataDir, scope));
    } catch (error) {
      if (fsErrorCode(error) === 'ENOENT') {
        continue;
      }
      throw error;
    }
    for (const name of names) {
      try {
        roots.push(Uri.parse(`comem://${scope}/${name}`));
      } catch {
        // 不是合法根标识的目录（`_meta` 之外的临时产物）：`Uri` 表示不了，跳过。
      }
    }
  }
  return roots;
}

/**
 * 遍历磁盘上的全部节点。
 *
 * 用 `ContentStore.list` 而不是 `node:fs` 裸遍历：它已经处理了 NFC 规范化、
 * 保留名、临时文件过滤与「URI 表示不了的条目」——重写一遍这些规则只会让两处
 * 慢慢漂移。排序放在最后，保证重跑时处理顺序稳定（断点续跑的依据）。
 */
export async function walkDataDir(dataDir: string, logger: Logger): Promise<readonly DiskNode[]> {
  const store = new ContentStore({ dataDir, logger });
  const nodes: DiskNode[] = [];

  for (const root of await listRoots(dataDir)) {
    const stat = await store.stat(root);
    if (stat === null) {
      continue;
    }
    nodes.push({ uri: root, kind: stat.kind });

    const stack: Uri[] = stat.kind === 'directory' ? [root] : [];
    while (stack.length > 0) {
      const current = stack.pop();
      if (current === undefined) {
        break;
      }
      let children;
      try {
        children = await store.list(current);
      } catch (error) {
        if (error instanceof ComemError && error.code === 'NOT_FOUND') {
          continue;
        }
        throw error;
      }
      for (const child of children) {
        nodes.push({ uri: child.uri, kind: child.kind });
        if (child.kind === 'directory') {
          stack.push(child.uri);
        }
      }
    }
  }

  return nodes.sort((left, right) => {
    const leftUri = left.uri.toString();
    const rightUri = right.uri.toString();
    if (leftUri === rightUri) {
      return 0;
    }
    return leftUri < rightUri ? -1 : 1;
  });
}
