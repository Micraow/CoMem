import { isVersionFile, stableDigest } from '../../domain/node.js';
import { segmentCjk } from '../../domain/text.js';
import { recordChange, shouldRecompute } from '../../domain/summary.js';
import type { Uri } from '../../domain/uri.js';

import { readFreshness, writePendingChanges } from './freshness.js';
import { DIRECTORY_LEVEL, OVERVIEW_LEVEL } from './levels.js';
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
    // 输入没变并不等于产物完整：一个摘要文件或一条索引行可能被外部删除。
    // 这类缺失也必须走进生成，否则“相同 digest 直接消费 pending”会把坏状态
    // 永久保留下来。
    const repair =
      force
      || (
        current.inputDigest !== null
        && !(await summaryStorageIntact(ports, directoryUri))
      );
    let changed = current;
    for (let index = 0; index < changes; index += 1) {
      changed = recordChange(changed);
    }

    if (repair) {
      // 生成前只记下要消费的 pending 快照，成功写回时再扣。失败时数据库里的
      // 待刷新计数保持原值，健康检查仍能看到这笔未完成的工作。
      if (changes > 0) {
        writePendingChanges(ports.db, uri, changed.pendingChanges);
      }
      return {
        recompute: true,
        previous,
        // 产物缺失时即使输入没变也必须真正生成。用 NULL 让协调器跳过
        // “相同 digest 直接消费”的快速路径。
        persistedInputDigest: null,
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

async function summaryStorageIntact(
  ports: SummaryContext,
  directoryUri: Uri,
): Promise<boolean> {
  const files = await ports.metadata.readSummary(directoryUri);
  if (!files.complete || !files.consistent) {
    return false;
  }
  const uri = directoryUri.toString();
  const l0 = ports.db
    .prepare('SELECT abstract, body_digest FROM node WHERE uri = ? AND level = ?')
    .get(uri, DIRECTORY_LEVEL);
  const l1 = ports.db
    .prepare('SELECT abstract, body_digest FROM node WHERE uri = ? AND level = ?')
    .get(uri, OVERVIEW_LEVEL);
  const l0Fts = ports.db
    .prepare('SELECT abstract, content FROM node_fts WHERE uri = ? AND level = ?')
    .get(uri, DIRECTORY_LEVEL);
  const l1Fts = ports.db
    .prepare('SELECT abstract, content FROM node_fts WHERE uri = ? AND level = ?')
    .get(uri, OVERVIEW_LEVEL);

  return (
    l0?.['abstract'] === files.abstract
    && l0?.['body_digest'] === stableDigest(files.abstract)
    && l1?.['abstract'] === files.abstract
    && l1?.['body_digest'] === stableDigest(files.overview)
    && l0Fts?.['abstract'] === segmentCjk(files.abstract)
    && l0Fts?.['content'] === ''
    && l1Fts?.['abstract'] === ''
    && l1Fts?.['content'] === segmentCjk(files.overview)
  );
}
