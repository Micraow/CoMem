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

import {
  recordChange,
  shouldRecompute,
  type FreshnessThresholds,
} from '../../domain/summary.js';
import { isVersionFile, stableDigest } from '../../domain/node.js';
import type { Uri } from '../../domain/uri.js';

import { readFreshness, writePendingChanges } from './freshness.js';
import { summarize, type SummaryGenerationPorts } from './generation.js';
import { persistSummary, withDirectoryLock, type SummaryPersistPorts } from './persist.js';
import type { InvalidationResult } from './ports.js';

/** 失效传播所需的端口：生成 + 落盘 + 阈值。 */
export interface SummaryInvalidationPorts
  extends SummaryGenerationPorts,
    SummaryPersistPorts {
  readonly thresholds: FreshnessThresholds;
}

/** 只读正文与索引行，用来比较 digest。 */
type SummaryDigestPorts = Pick<SummaryInvalidationPorts, 'store' | 'metadata' | 'nodes'>;

/**
 * 写节点之后的失效传播（§9.3）。
 *
 * `nodeUri` 是被写入 / 删除 / 移动的节点。五步见文件头；两条提前返回的路径都要
 * 有测试：正文没变（第 2 步）与「只记脏」（第 4 步的 else 分支）。
 */
export async function invalidateNode(
  ports: SummaryInvalidationPorts,
  nodeUri: Uri,
): Promise<InvalidationResult> {
  if (!(await bodyChanged(ports, nodeUri))) {
    // §9.3 第 2 步：正文没变不传播。这是性能的关键——同一个内容重复写不应该
    // 让整条祖先链都重算。
    return { recomputed: [], markedStale: [], stoppedAt: nodeUri.toString() };
  }
  return propagateFrom(ports, nodeUri, nodeUri.parent());
}

/** 从 `start` 开始向上传播；`origin` 只用于日志。 */
export async function propagateFrom(
  ports: SummaryInvalidationPorts,
  origin: Uri,
  start: Uri | null,
): Promise<InvalidationResult> {
  const recomputed: string[] = [];
  const markedStale: string[] = [];

  let stoppedAt = origin.toString();
  let current = start;

  while (current !== null) {
    stoppedAt = current.toString();
    const outcome = await invalidateDirectory(ports, current);

    if (outcome === 'stale') {
      markedStale.push(stoppedAt);
      break;
    }

    recomputed.push(stoppedAt);
    // §9.3 第 5 步：只有 P 的 L0 正文也变了才继续向上。
    if (outcome === 'unchanged' || current.isRoot) {
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
async function bodyChanged(ports: SummaryDigestPorts, nodeUri: Uri): Promise<boolean> {
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
async function bodyDigest(ports: SummaryDigestPorts, nodeUri: Uri): Promise<string | null> {
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

/**
 * 处理一个目录：记一次脏，然后判定是否立刻重算。
 *
 * 返回 `changed` / `unchanged` 表示重算了（后者指 L0 与旧值相同），`stale` 表示
 * 只记了脏。
 *
 * ## 为什么拆成两段锁（§10.6「锁内不得跨越慢操作」）
 *
 * 第一段（`EXACT`，几毫秒）：记脏、判定、需要重算则把本次要覆盖的 `pending`
 * 快照抢下来并清零计数——这一段是「读状态 → 决定 → 写状态」的短路径，不能放
 * LLM。`summarize` 里的 `generator.generate` 是一次 7–9 秒的模型调用，放进锁里
 * 会让 `EXACT` 锁持有 7–9 秒；而 `PathLockManager` 不可重入且与祖先 `TREE`
 * 互斥，并发的 `rm -r` / `tree` 会在 5 秒后 `CONFLICT`（W83 实测：LLM 摘要时
 * ingest 撞祖先 `tree` 锁超时，只能把 `summary.generator` 降级成 `rule`）。
 *
 * 第二段（`EXACT`，几毫秒）：写摘要文件、写索引、写回新鲜度。
 *
 * ## 两段之间的竞态
 *
 * 慢操作在锁外进行时，目录内容可能被别的写者改动（新增 / 删除子项）。我们
 * **接受「摘要可能比内容旧一拍」**：第一段已经把 `pending` 清零，慢操作期间
 * 到达的改动会重新把 `pending` 加回来（`onNodeWritten` → `markStale`），下一轮
 * 失效会再次重算，摘要最终收敛到最新内容。这与文件头「消费时减而不是清零」
 * 同一个机制——旧实现也在生成时读 `pending` 快照后于锁内消费，只是那时改动
 * 无法插进来。
 *
 * 要「严格不旧」需要版本号：第一段记下当前内容版本，第二段写回前比对，不一致
 * 就放弃这次结果、留待下次。这里不引入——摘要是派生数据、按拍收敛即可，多一次
 * 重算的代价远小于 7–9 秒的锁。
 */
async function invalidateDirectory(
  ports: SummaryInvalidationPorts,
  directoryUri: Uri,
): Promise<'changed' | 'unchanged' | 'stale'> {
  // 记忆的版本快照目录（`memories/{type}/.history`）不参与目录摘要（W98）。
  // 每次覆盖写都会新增一份版本文件，它的父目录就是 `.history`（`rules` 的镜像
  // 子目录也一样）。若照常传播，每次覆盖写会多两次 LLM 摘要调用（`.history` 与
  // 它上面的类型目录），而版本文件不是给检索用的内容。直接返回 `unchanged`：
  // 传播在 `.history` 就停，类型目录的摘要保持原样（它的子项确实多了一个隐藏
  // 目录，接受这份摘要「比磁盘旧一拍」，由下一次真实改动收敛）。
  if (isVersionFile(directoryUri)) {
    return 'unchanged';
  }

  const uri = directoryUri.toString();

  // 第一段锁：记脏 → 判定 → （需要）抢快照并清零。
  const decision = await withDirectoryLock(ports.locks, directoryUri, async () => {
    const current = readFreshness(ports.db, uri);
    const changed = recordChange(current);

    if (!shouldRecompute(changed, ports.thresholds)) {
      // §9.3 第 4 步的 else 分支：只更新计数器，等改动攒够。
      writePendingChanges(ports.db, uri, changed.pendingChanges);
      return { recompute: false as const };
    }

    // 记下本次生成覆盖的 `pending` 快照，并把计数清零。慢操作期间到达的改动
    // 会被重新加回（`markStale`），因此清零不等于吞掉这些改动：写回时以
    // `snapshotPending = 0` 消费，本轮到达的改动原样留在计数里。
    writePendingChanges(ports.db, uri, 0);
    const previous = ports.nodes.get(uri)?.bodyDigest ?? null;
    return { recompute: true as const, previous };
  });

  if (!decision.recompute) {
    return 'stale';
  }

  // 慢操作在锁外：调模型 / 规则生成 L0 + L1。这一步可能要 7–9 秒。
  const summary = await summarize(ports, directoryUri);

  // 第二段锁：写回。摘要文件、索引、新鲜度都在这里落盘。
  return await withDirectoryLock(ports.locks, directoryUri, () =>
    persistSummary(ports, directoryUri, summary, 0, decision.previous),
  );
}
