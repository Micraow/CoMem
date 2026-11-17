/**
 * 摘要失效的判定与向上传播（§9.3）。
 *
 * 只增量失效，不全量重算。写节点 N 之后：算 N 的正文 digest，与索引里记录的
 * `body_digest` 比较——**一致就到此为止**，正文没变不传播。变化了才给
 * `P = parent(N)` 的计数器加一，再按四个条件判定「立刻重算」还是「只记脏」。
 * 重算 P 之后如果 P 的 L0 也变了，对 `parent(P)` 重复。到达 scope 根停止。
 *
 * 「事件计数」而不是「脏标记」：同一个文件反复改，脏标记只算一次，永远到不了阈值。
 * 消费时**减**而不是清零：生成期间可能又有新改动进来（`freshness.ts` 的
 * `consumeFreshness`）。
 *
 * **投递不在本文件**：观察者对摘要失效只做投递（`services/observer/summary.ts`），
 * 传播与终止条件在这里。两处分工不要合并——投递要等路径锁释放，传播要拿目录锁。
 */

import { stableDigest } from '../../domain/node.js';
import type { Logger } from '../../domain/log.js';
import type { Uri } from '../../domain/uri.js';

import type { SummaryGenerationPorts } from './generation.js';
import type { InvalidationResult } from './ports.js';
import type { DirectoryRefreshResult } from './refresh.js';

/** 失效传播只读正文与索引行，用来比较 digest。 */
export type SummaryInvalidationPorts =
  & Pick<SummaryGenerationPorts, 'store' | 'metadata' | 'nodes'>
  & { readonly logger: Logger };

export type DirectoryRefresher = (
  directoryUri: Uri,
  changes: number,
) => Promise<DirectoryRefreshResult>;

/**
 * 写节点之后的失效传播（§9.3）。
 *
 * `nodeUri` 是被写入 / 删除 / 移动的节点。五步见文件头；两条提前返回的路径都要
 * 有测试：正文没变（第 2 步）与「只记脏」（第 4 步的 else 分支）。
 */
export async function invalidateNode(
  ports: SummaryInvalidationPorts,
  nodeUri: Uri,
  refresh: DirectoryRefresher,
): Promise<InvalidationResult> {
  if (!(await bodyChanged(ports, nodeUri))) {
    // §9.3 第 2 步：正文没变不传播。这是性能的关键——同一个内容重复写不应该
    // 让整条祖先链都重算。
    return { recomputed: [], markedStale: [], stoppedAt: nodeUri.toString() };
  }
  return propagateFrom(ports, nodeUri, nodeUri.parent(), refresh);
}

/** 从 `start` 开始向上传播；`origin` 只用于日志。 */
export async function propagateFrom(
  ports: SummaryInvalidationPorts,
  origin: Uri,
  start: Uri | null,
  refresh: DirectoryRefresher,
): Promise<InvalidationResult> {
  const recomputed: string[] = [];
  const markedStale: string[] = [];

  let stoppedAt = origin.toString();
  let current = start;

  while (current !== null) {
    stoppedAt = current.toString();
    const { outcome, propagate } = await refresh(current, 1);

    if (outcome === 'stale') {
      markedStale.push(stoppedAt);
      break;
    }

    recomputed.push(stoppedAt);
    // §9.3 第 5 步：只有 P 的 L0 正文也变了才继续向上。
    // 同目录的并发通知只生成一次，也只应有其中一个调用把这一处变化继续向上传播；
    // 否则祖父目录会把同一份 L0 变化重复计为多次 pending。
    if (!propagate || outcome === 'unchanged' || current.isRoot) {
      break;
    }
    current = current.parent();
  }

  ports.logger.debug('摘要失效传播完成', {
    node: origin.toString(),
    recomputed: recomputed.length,
    markedStale: markedStale.length,
    stoppedAt,
  });
  return { recomputed, markedStale, stoppedAt };
}

/** §9.3 第 1–2 步：节点正文是否与索引里记录的不一致。 */
async function bodyChanged(ports: SummaryInvalidationPorts, nodeUri: Uri): Promise<boolean> {
  const digest = await bodyDigest(ports, nodeUri);
  const recorded = ports.nodes.get(nodeUri.toString())?.bodyDigest;
  if (recorded === undefined) {
    // 索引里没有这一行（还没索引过，或刚被删除）：按「变化了」处理，让父目录
    // 至少记一次脏。不能按「没变」处理——那会让没建过索引的目录永远不生成摘要。
    return true;
  }
  return recorded !== digest;
}

/**
 * 节点的正文 digest（§9.3 第 1 步）。
 *
 * 文件是正文；目录的正文是它的 L0 摘要（`Directory.digest()`）。节点已不在磁盘上
 * （删除 / 移动后的旧地址）时返回 `null`：调用方拿到的一定与索引里的记录不同。
 */
async function bodyDigest(ports: SummaryInvalidationPorts, nodeUri: Uri): Promise<string | null> {
  const stat = await ports.store.stat(nodeUri);
  if (stat === null) {
    return null;
  }
  if (stat.kind === 'directory') {
    const summary = await ports.metadata.readSummary(nodeUri);
    return stableDigest(summary.abstract);
  }
  const document = await ports.store.readText(nodeUri);
  return stableDigest(document.text);
}
