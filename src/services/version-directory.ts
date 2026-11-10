/**
 * 用户面的写目标不能落在记忆的版本快照目录下（`.history`，架构文档 §11.11）。
 *
 * 版本文件只由记忆服务写（`writeVersionSnapshot` 走 `ContentStore` 的字节接口，
 * 不经过 `FileSystemService`）。用户面写进去能造出一份「看起来像旧值」的文件：
 * 它没有 frontmatter 里的 `valid_until`，`reject` 会把 `supersedes` 指向它的
 * 记忆当成可以回退的目标。建目录、移动与删除同样会破坏 `supersedes` 链，所以五个
 * 写入口共用这一条判据。
 *
 * 判据是 `domain/node.ts` 的 `isVersionFile`（按路径段，不看子串）：文件名是
 * `.history.md` 的普通记忆照常可写。
 */

import { ComemError } from '../domain/errors.js';
import { isVersionFile } from '../domain/node.js';
import type { Uri } from '../domain/uri.js';

/** 写目标落在版本快照目录下时抛 `INVALID_ARGUMENT`。 */
export function assertNotVersionTarget(uri: Uri): void {
  if (isVersionFile(uri)) {
    throw new ComemError(
      'INVALID_ARGUMENT',
      `这个路径位于记忆的版本历史目录下，不能作为写入目标：${uri.toString()}`,
      { uri: uri.toString() },
    );
  }
}
