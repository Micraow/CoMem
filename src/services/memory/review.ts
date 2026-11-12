/**
 * 复核闸门（架构文档 §11.6、§11.11）：`pending` → `active` 的通过，以及拒绝时的
 * 「先回退被顶替的版本，回退不了才删」。
 *
 * 判定与写回在这里，锁由 `MemoryService` 持有：通过 / 拒绝的「读 → 写 → 删」必须
 * 落在同一把 `exact(uri)` 锁里（§18），所以这两个函数假定调用方已经在锁内。
 *
 * 复核闸门按记忆类型打开，默认 `experiences` 与 `rules`：这两类写入时 `status =
 * 'pending'`，检索侧按 `status = 'active'` 过滤，所以它们在被 `approve` 之前**不进
 * 检索结果**。其余类型直接 `active`。更新一条已复核的记录会把它重新打回 `pending`：
 * 正文变了就该重新看一遍。
 */

import { ComemError, invalidArgument } from '../../domain/errors.js';
import type { Logger } from '../../domain/log.js';
import { getMemoryType } from '../../domain/memory-types/index.js';
import type { Uri } from '../../domain/uri.js';
import { serializeMemoryDocument } from './document.js';
import { readMemoryDocument, type MemoryFileStore } from './ports.js';
import { restoreSuperseded } from './versioning.js';

/**
 * 一次复核拒绝的终态（§11.11「`reject` 先回退，回退不了才删」）。
 *
 * 两个分支互斥，各自说清发生了什么，调用方不需要再用另一个布尔字段推断：
 *
 * - `restored`：把 `supersedes` 指向的版本写回了规范 URI，`restoredFrom` 就是
 *   那份版本文件的 URI。**没有删除任何东西。**
 * - `removed`：没有可回退的版本（首条写入、`supersedes` 缺失或指向的文件不在了），
 *   规范文件被删掉。
 *
 * 不做成 `{ removed: boolean, restoredFrom: Uri | null }`：那样「恢复了」与
 * 「删除了」在类型上无法区分，恰好是这次要修的那类说谎。
 */
export type MemoryRejectResult =
  | { readonly outcome: 'restored'; readonly restoredFrom: Uri }
  | { readonly outcome: 'removed' };

/** 复核通过：`pending` → `active`（§11.6）。已经是 `active` 时是空操作。 */
export async function approveMemory(
  filesystem: MemoryFileStore,
  logger: Logger,
  uri: Uri,
): Promise<void> {
  const document = await readMemoryDocument(filesystem, logger, uri);
  if (document === null) {
    throw new ComemError('NOT_FOUND', `记忆不存在：${uri.toString()}`, {
      uri: uri.toString(),
    });
  }
  const schema = getMemoryType(document.memoryType);
  if (schema === undefined) {
    throw invalidArgument(`未知的记忆类型：${document.memoryType}。`, {
      memoryType: document.memoryType,
    });
  }
  if (document.status === 'active') {
    return;
  }

  const now = new Date().toISOString();
  await filesystem.write(
    uri,
    serializeMemoryDocument({
      uri,
      memoryType: document.memoryType,
      status: 'active',
      createdAt: document.createdAt,
      updatedAt: now,
      schema,
      fields: document.fields,
      // 复核也是**一次完整重写**：不把读到的溯源带过来，approve 会在用户
      // 点下「通过」的那一刻把 `sources` 抹掉。有效期与 `supersedes` 同理：
      // 通过一次复核不改「这条记忆从哪一刻开始有效、顶替了谁」。
      sources: document.sources,
      validFrom: document.validFrom,
      validUntil: document.validUntil,
      supersedes: document.supersedes,
    }),
  );
  logger.info('记忆复核通过', {
    uri: uri.toString(),
    memoryType: document.memoryType,
  });
}

/**
 * 复核拒绝（§11.6）：回到写入前。
 *
 * 拒绝的是一次**覆盖写**时，规范文件里现在是不该留下的新值、旧值在版本文件里。
 * 所以这里把 `supersedes` 指向的版本写回规范 URI 并清掉 `valid_until`（它现在
 * 又有效了），调用方不需要为拒绝指定版本文件的位置。`MemoryRecord.supersedes`
 * 会带出这个 URI，供复核界面说明「拒绝会回到哪一版」；它不是读取版本文件内容的
 * 入口。这样拒绝一次错误写入的终态是「写入前的数据」，不是「这条记忆消失了」。
 *
 * 没有版本可回（首条写入、`supersedes` 指向的文件已被 `MAX_VERSIONS` 截断）时维持
 * 原来的行为：删掉 pending 文件。同一 identity 覆盖写超过 5 次之后，更早的版本不在了。
 *
 * 返回值如实说明这两种终态（`MemoryRejectResult`）：恢复时没有删除任何东西，
 * 调用方不能把它当成「删掉了一条记忆」。
 */
export async function rejectMemory(
  filesystem: MemoryFileStore,
  logger: Logger,
  uri: Uri,
  reason: string,
): Promise<MemoryRejectResult> {
  const document = await readMemoryDocument(filesystem, logger, uri);
  if (document === null) {
    // 文件已经不在了：终态与「删掉」相同（`rm -f` 语义），也没有可回退的版本。
    return { outcome: 'removed' };
  }
  const restoredFrom = await restoreSuperseded(filesystem, logger, uri, document);
  if (restoredFrom === null) {
    await filesystem.remove(uri);
    logger.info('记忆复核拒绝，已删除', {
      uri: uri.toString(),
      memoryType: document.memoryType,
      reason,
    });
    return { outcome: 'removed' };
  }
  logger.info('记忆复核拒绝，已恢复到上一个有效版本', {
    uri: uri.toString(),
    memoryType: document.memoryType,
    reason,
    restoredFrom: restoredFrom.toString(),
  });
  return { outcome: 'restored', restoredFrom };
}
