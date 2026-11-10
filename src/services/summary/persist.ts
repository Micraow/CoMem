/**
 * 摘要落盘：写文件、写索引两行、写回新鲜度、物化权限（§9.2、§9.3、§12.4）。
 *
 * ## 写盘顺序与崩溃恢复
 *
 * 先写摘要文件（真相），再在一个事务里写索引行与新鲜度列（缓存）。理由与 §7 一致：
 * 索引永远能从文件重建，反过来不成立。窗口期（文件 rename 成功、事务提交之前进程
 * 挂掉）的后果是 `summary_baseline` 落后于摘要文件：该目录会被判定为「摘要基于旧
 * 正文」，下一次 `invalidate` / `regenerate` 重算即可修复，不丢数据。
 *
 * ## 为什么事务不调用 `withWriteTransaction`
 *
 * 那是 `adapters/sqlite/database.ts` 的**值**导出，而 `services/` 只允许 `import type`
 * 引用适配层（§4.2）。这里用最小结构端口 `SummaryDatabase` 自己开 `BEGIN IMMEDIATE`，
 * `SqliteFtsIndex.upsert` 检测到外层已有事务会直接复用，所以索引行与新鲜度列仍在
 * 同一个事务里。
 *
 * 事务体里有一次 `await`（`upsert` 是 async 方法）。它的实现是同步的，`await` 只让出
 * 一个微任务；同一目录的重算由 EXACT 锁串行化。跨服务的事务若恰好落在这个微任务
 * 窗口里，会加入本事务——SQLite 单连接本来就是单写者，失败方向是可自愈的（见上），
 * 这里不为它引入跨服务写队列。
 */

import type { PathLockManager } from '../../adapters/fs/lock.js';
import type { MetadataFileStore } from '../../adapters/fs/metadata-file.js';
import type { ContentStore } from '../../adapters/fs/content-store.js';
import type { NodeRepository } from '../../adapters/sqlite/node-repository.js';
import type { SqliteFtsIndex } from '../../adapters/sqlite/retrieval-index.js';
import type { Logger } from '../../domain/log.js';
import { stableDigest } from '../../domain/node.js';
import type { DirectorySummary } from '../../domain/summary.js';
import type { Uri } from '../../domain/uri.js';

import type { AclService } from '../acl.js';

import { consumeFreshness } from './freshness.js';
import type { SummaryDatabase } from './ports.js';
import { indexRecord, overviewRecord } from './records.js';

/** 落盘、写索引、写回新鲜度所需的端口。 */
export interface SummaryPersistPorts {
  readonly nodes: Pick<NodeRepository, 'get'>;
  readonly index: SqliteFtsIndex;
  readonly metadata: MetadataFileStore;
  readonly store: ContentStore;
  readonly db: SummaryDatabase;
  readonly logger: Logger;
  readonly acl: Pick<AclService, 'materializeNode'>;
  /** 每个目录一把 EXACT 锁；省略时不加锁（见 `../summary.ts` 文件头「并发」）。 */
  readonly locks: PathLockManager | undefined;
}

/**
 * 把一个已生成的摘要落盘、写索引、写回新鲜度（§9.2、§9.3）。
 *
 * 调用方必须持本目录的 `EXACT` 锁：这里是「写状态」，要与并发的目录写入 / 删除
 * 互斥。`snapshotPending` 是第一段锁记下的 `pending` 快照，写回时
 * `pending = max(pending - 快照, 0)`——慢操作期间到达的改动留在计数里
 * （`consumeChanges`）。
 *
 * 返回 `changed` / `unchanged`（后者指 L0 与旧 `bodyDigest` 相同）。
 */
export async function persistSummary(
  ports: SummaryPersistPorts,
  directoryUri: Uri,
  summary: DirectorySummary,
  snapshotPending: number,
  previous: string | null,
): Promise<'changed' | 'unchanged'> {
  const baseline = stableDigest(summary.abstract);

  // 先写文件（真相），再改表（缓存）：§7「先写内容再更新索引」。写文件失败时
  // 索引与新鲜度都没有动过，不会出现「摘要宣称更新了、磁盘上还是旧的」。
  await ports.metadata.writeSummary(directoryUri, summary.abstract, summary.overview, {
    generatedBy: summary.degraded ? 'rule' : 'llm',
    generatedAt: new Date().toISOString(),
    degraded: summary.degraded,
  });

  const children = await ports.store.list(directoryUri);

  await runInTransaction(ports.db, async () => {
    // 两行一起写：目录的 L0 摘要行（检索一句话）与 L1 概览行（检索概览正文）。
    // L1 行必须跟着摘要失效 / 重算同步更新，否则「概览改了、检索还是旧内容」
    // 会变成一条没有任何报错的陈旧数据。
    await ports.index.upsert([
      indexRecord(ports.nodes, directoryUri, summary, children.length, baseline),
      overviewRecord(ports.nodes, directoryUri, summary, children.length),
    ]);
    consumeFreshness(ports.db, directoryUri.toString(), baseline, snapshotPending, children.length);
  });

  // §12.4 的「写时算」：归档子树是 `SessionService` 直接写 `ContentStore` 建出来的，
  // 观察者收不到通知，所以 `node_permission` 里没有 `history/` 与 `archive_NNN/`
  // 的行。而 `list` / `tree` / `glob` 的权限过滤是**纯 SQL 查询**——归档写成功了，
  // 控制台的文件树里一条都没有，`stat` 一次又全部恢复（读路径的
  // `InheritingAuthorizer` 会补）。摘要生成是这条链上唯一的写后钩子。
  //
  // 物化在 `index.upsert` 之后：`materializeNode` 从 `node` 表读 kind 决定链的起点
  // （与 `IndexObserver.#indexNode` 同一顺序）。
  //
  // 失败不吞：本服务在后台任务里跑，静默跳过只会让「归档写成功、树里看不到」
  // 变成一条没有上下文的空目录；抛出去由提交步骤重试。
  await materialize(ports.acl, directoryUri);

  ports.logger.debug('目录摘要已生成', {
    uri: directoryUri.toString(),
    children: children.length,
    abstractChars: summary.abstract.length,
    overviewChars: summary.overview.length,
    degraded: summary.degraded,
  });

  // §9.3 第 5 步：L0 没变就不往上传。父目录的输入（这个目录的 L0）没有变化，
  // 重算父目录只会得到同一份摘要。
  return previous !== null && previous === baseline ? 'unchanged' : 'changed';
}

/**
 * 物化 `uri` 及其全部祖先的权限（§12.4 的「写时算」）。
 *
 * 只物化 `uri` 自己不够：`ContentStore.writeText` 写
 * `.../history/archive_001/messages.jsonl` 时顺手 `mkdir -p` 出 `history/` 与
 * `archive_001/`，两个目录都没有行，而 `filterReadable` 是纯 SQL 查询——它们在
 * `list` / `tree` / `glob` 里**整个消失**，用户看到的会话目录树是断的。
 *
 * 逐级 `materializeNode` 是幂等的（行已存在就是覆盖成同样的值），depth 通常
 * 3–6，换「归档目录树不断」是划算的。与 `IndexObserver.#materializeAncestors`
 * 同一做法。
 */
async function materialize(
  acl: Pick<AclService, 'materializeNode'>,
  uri: Uri,
): Promise<void> {
  let current: Uri | null = uri;
  while (current !== null) {
    await acl.materializeNode(current);
    current = current.parent();
  }
}

export async function withDirectoryLock<T>(
  locks: PathLockManager | undefined,
  uri: Uri,
  fn: () => Promise<T>,
): Promise<T> {
  if (locks === undefined) {
    return fn();
  }
  return locks.withLock(uri, 'exact', fn);
}

/** 见文件头「为什么事务不调用 `withWriteTransaction`」。 */
async function runInTransaction(db: SummaryDatabase, fn: () => Promise<void>): Promise<void> {
  if (db.isTransaction) {
    await fn();
    return;
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    await fn();
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
