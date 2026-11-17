import { isVersionFile } from '../../domain/node.js';
import { recordChange, shouldRecompute } from '../../domain/summary.js';
import type { Uri } from '../../domain/uri.js';

import { readFreshness, writePendingChanges } from './freshness.js';
import { withDirectoryLock } from './persist.js';
import type { SummaryContext } from './ports.js';

export type RecomputeClaim =
  | {
      readonly recompute: true;
      readonly previous: string | null;
      readonly persistedInputDigest: string | null;
      readonly snapshotPending: number;
    }
  | {
      readonly recompute: false;
      readonly outcome: 'unchanged' | 'stale';
    };

export async function claimRefresh(
  ports: SummaryContext,
  directoryUri: Uri,
  changes: number,
  force: boolean,
): Promise<RecomputeClaim> {
  if (isVersionFile(directoryUri)) {
    return { recompute: false, outcome: 'unchanged' };
  }

  const uri = directoryUri.toString();
  return withDirectoryLock(ports.locks, directoryUri, async () => {
    const current = readFreshness(ports.db, uri);
    const previous = ports.nodes.get(uri)?.bodyDigest ?? null;
    let changed = current;
    for (let index = 0; index < changes; index += 1) {
      changed = recordChange(changed);
    }

    if (force) {
      // 生成前只记下要消费的 pending 快照，成功写回时再扣。失败时数据库里的
      // 待刷新计数保持原值，健康检查仍能看到这笔未完成的工作。
      if (changes > 0) {
        writePendingChanges(ports.db, uri, changed.pendingChanges);
      }
      return {
        recompute: true,
        previous,
        persistedInputDigest: current.inputDigest,
        snapshotPending: changed.pendingChanges,
      };
    }

    if (!shouldRecompute(changed, ports.thresholds)) {
      writePendingChanges(ports.db, uri, changed.pendingChanges);
      return { recompute: false, outcome: 'stale' };
    }

    // 把本轮通知先持久化，生成失败也不会丢脏状态。成功写回时
    // `persistSummary` 只消费这个快照；生成期间额外到达的计数仍会保留。
    writePendingChanges(ports.db, uri, changed.pendingChanges);
    return {
      recompute: true,
      previous,
      persistedInputDigest: current.inputDigest,
      snapshotPending: changed.pendingChanges,
    };
  });
}
