/**
 * 写盘后的索引行维护：`node` / `node_fts` 双写与删除（§7、§8.5、§10.6）。
 *
 * 写入的判定与顺序都不在这里——`observer.ts` 决定「写完索引还要物化权限、排期摘要」；
 * 这里只负责「节点落盘后，索引里那一行应该长什么样、写失败怎么办」。
 *
 * ## 观察者抛错不能拖垮写操作
 *
 * 文件已经落盘，回滚反而丢数据；派生数据靠对账修复（§7）。`FileSystemService` 已经
 * 捕获了异常，这里**再自己 try/catch** 的目的不是兜底，而是让日志能定位到 URI——
 * 上层只有一个「观察者失败」的泛化消息，串不起是哪条路径。
 *
 * ## 索引失败为什么不抛出
 *
 * 后面还有派生数据要维护：`materializeNode` 不跟着做，节点在 `node_permission` 里
 * 没有行，权限过滤是纯 SQL 查询——重放补上索引行之后 `find` 仍然搜不到（默认
 * deny）。`ResourceService` / `SkillService` 的批量路径是同一个取舍。
 */

import type { IndexRecord } from '../../domain/retrieval.js';
import { contextTypeOf } from '../../domain/node.js';
import type { Uri } from '../../domain/uri.js';

import { errorMessage } from '../../domain/errors.js';

import type { IndexObserverDeps } from './ports.js';
import { directoryRecord, documentRecord } from './record.js';
import { recordIndexRowFailure, recordMovedIndexFailure } from './replay.js';

export type WritePorts = Pick<
  IndexObserverDeps,
  'store' | 'index' | 'nodes' | 'permissions' | 'logger' | 'reconcile'
>;

/**
 * 一个节点落盘后的索引行；返回 `null` 表示节点已经不在磁盘上。
 *
 * `stat` 为 `null` 说明写完之后节点已经不在了（并发删除、或名字是产物），按删除
 * 处理：留一行指向不存在文件的索引，`read` 会 404，而 `find` 会命中一条打不开的
 * 记录——两者都不如直接清掉。
 *
 * 返回值交给调用方继续做「物化权限 → 嵌入 → 摘要失效」；`null` 时这几步整体跳过，
 * 与「删掉的节点不需要派生行」一致。
 */
export async function writeNodeIndex(
  ports: WritePorts,
  uri: Uri,
  kind: 'file' | 'directory',
): Promise<IndexRecord | null> {
  const stat = await ports.store.stat(uri);
  if (stat === null) {
    ports.logger.warn('节点写入后已不可寻址，按删除清理索引。', { uri: uri.toString() });
    await ports.index.deleteByUri(uri.toString(), { recursive: true });
    ports.permissions.deleteSubtree(uri.toString());
    return null;
  }

  const contextType = contextTypeOf(uri);
  const record =
    kind === 'file'
      ? await documentRecord(ports, uri, contextType, stat.size, stat.updatedAt)
      : directoryRecord(ports, uri, contextType, stat.size, stat.updatedAt);

  await writeIndexRecord(ports, record);
  return record;
}

/**
 * 写节点自己的索引行；失败时留一条 `op: 'index'` 的对账记录，**不抛出**（见文件头）。
 *
 * 只有文件记录对账：重放器按文件重建索引行（`ReconcileService.#reindex`），目录目标
 * 会被当成 `not-a-file` 移出日志。为目录写一条重放不动的记录，等于把「修不了」伪装
 * 成「已排队」。
 */
async function writeIndexRecord(ports: WritePorts, record: IndexRecord): Promise<void> {
  try {
    await ports.index.upsert([record]);
  } catch (error) {
    await recordIndexRowFailure(ports, record, errorMessage(error));
  }
}

/**
 * 移动后目标子树的索引行。
 *
 * 批量 `upsert` 失败时记录的是**目标** URI：源前缀磁盘上已经没有了，记源 URI 会被
 * 重放器按「目标已不存在」移出，等于没记；只记文件（见 `write.ts` 文件头）。
 *
 * 与 `writeIndexRecord` 一样不抛出：后面的物化权限、向量重挂与摘要失效都还要跑，
 * 否则「移动之后目标子树在磁盘上、在索引里不存在、权限表也空着」会同时发生。
 */
export async function writeMovedRecords(
  ports: WritePorts,
  records: readonly IndexRecord[],
  details: Readonly<Record<string, string>>,
): Promise<void> {
  try {
    await ports.index.upsert(records);
  } catch (error) {
    await recordMovedIndexFailure(ports, details, records, errorMessage(error));
  }
}
