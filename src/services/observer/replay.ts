/**
 * 派生数据写失败后的对账线索（`op: 'index'` / `op: 'permission'`，§10.6）。
 *
 * 文件已经落盘，回滚反而丢数据；补偿的方向是「把索引 / 权限追上来」，不是「把文件
 * 退回去」。重放器能修的形态才写记录：
 *
 * | 失败 | 记录 | 重放动作 |
 * |---|---|---|
 * | 节点索引行 | `op: 'index'` + 该文件 URI | 从磁盘重建索引行 |
 * | 移动后目标子树批量写 | `op: 'index'` + 每个目标文件 URI | 同上 |
 * | 权限物化 | `op: 'permission'` + 节点 URI | `materializeNode` |
 *
 * 目录型节点的索引行只记日志（重放器只重建文件，目录目标会被判 `not-a-file` 后
 * 移出），所以那条 message 也不写「已记录」。其余不记的形态与原因见架构文档
 * §10.6「仍然无法重放的形态」：读盘失败（构造不出记录）、索引**删除**失败（重放器
 * 没有「删一条过期行」这个动作，写了也只能被移出日志）。
 *
 * 追加动作本身（`recordIndexFailures` / `recordPermissionFailure`）在
 * `services/reconcile-record.ts`，与资源 / 技能的批量路径共用同一份实现。
 */

import type { IndexRecord } from '../../domain/retrieval.js';
import type { Uri } from '../../domain/uri.js';

import { recordIndexFailures, recordPermissionFailure } from '../reconcile-record.js';
import type { IndexObserverDeps } from './ports.js';

export type ReplayPorts = Pick<IndexObserverDeps, 'logger' | 'reconcile'>;

/**
 * 单节点索引行写失败。
 *
 * 精确到 URI：写路径每次只写一行，失败的那一行就是 `record.uri`，不存在「整批失败
 * 只知道批里有哪些 URI」的模糊地带。目录行不进对账（见文件头）。
 */
export async function recordIndexRowFailure(
  ports: ReplayPorts,
  record: IndexRecord,
  reason: string,
): Promise<void> {
  if (record.kind !== 'document') {
    // 消息里不能说「已记录」——那会让运维在日志里看到一条并不存在的记录。
    ports.logger.error('节点写入后目录索引行写入失败，已忽略。', {
      uri: record.uri,
      error: reason,
    });
    return;
  }
  ports.logger.error('节点写入后索引写入失败，已记录待重放。', {
    uri: record.uri,
    error: reason,
  });
  await recordIndexFailures(
    ports.reconcile,
    ports.logger,
    [record.uri],
    reason,
    new Date().toISOString(),
  );
}

/**
 * 移动后目标子树的批量索引行写失败。
 *
 * 记录的是**目标** URI：`records` 里的 `uri` 就是新位置（源前缀磁盘上已经没有了，
 * 记源 URI 会被重放器按「目标已不存在」移出，等于没记）。只记文件——重放器不重建
 * 目录行（见文件头）。
 */
export async function recordMovedIndexFailure(
  ports: ReplayPorts,
  details: Readonly<Record<string, string>>,
  records: readonly IndexRecord[],
  reason: string,
): Promise<void> {
  const replayable = records
    .filter((record) => record.kind === 'document')
    .map((record) => record.uri);
  if (replayable.length === 0) {
    ports.logger.error('节点移动后目录索引行写入失败，已忽略。', {
      ...details,
      count: records.length,
      error: reason,
    });
    return;
  }
  ports.logger.error('节点移动后重建索引失败，已记录待重放。', {
    ...details,
    count: records.length,
    documents: replayable.length,
    error: reason,
  });
  await recordIndexFailures(
    ports.reconcile,
    ports.logger,
    replayable,
    reason,
    new Date().toISOString(),
  );
}

/**
 * 权限物化失败。
 *
 * 重放器能修这类失败（`AclService.materializeNode` 幂等）。`uri` 必须是磁盘上仍然
 * 存在的节点：删掉的节点重放器会按「目标已不存在」移出日志，删除路径因此记父目录。
 */
export async function recordPermissionMaterializationFailure(
  ports: ReplayPorts,
  uri: Uri,
  reason: string,
): Promise<void> {
  ports.logger.error('节点权限物化失败，已记录待重放。', {
    uri: uri.toString(),
    error: reason,
  });
  await recordPermissionFailure(
    ports.reconcile,
    ports.logger,
    uri.toString(),
    reason,
    new Date().toISOString(),
  );
}
