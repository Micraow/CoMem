/**
 * 权限物化：把授权判定写进 `node_permission`（§12.3）。
 *
 * `filterReadable` 是纯 SQL 查询，没有物化行就等于默认 deny——节点对所有人不可见。
 * 所以写路径在索引行之后必须物化，包括 `mkdir -p` 顺手建出来的祖先目录。
 *
 * 失败**不抛**：后续的权限物化与摘要失效是彼此独立的派生数据，一个节点失败不该让
 * 整条祖先链静默丢行（与写索引行同一个取舍）。失败留一条 `op: 'permission'` 的
 * 对账记录（见 `replay.ts`）。
 */

import type { Uri } from '../../domain/uri.js';

import { errorMessage, type IndexObserverDeps } from './ports.js';
import { recordPermissionMaterializationFailure } from './replay.js';

export type PermissionPorts = Pick<IndexObserverDeps, 'acl' | 'logger' | 'reconcile'>;

/**
 * 物化一个节点的权限；失败时留一条 `op: 'permission'` 的记录（§10.6）。
 *
 * `uri` 必须是磁盘上仍然存在的节点：删掉的节点重放器会按「目标已不存在」移出
 * 日志，删除路径因此记父目录。
 */
export async function materializePermission(ports: PermissionPorts, uri: Uri): Promise<void> {
  try {
    await ports.acl.materializeNode(uri);
  } catch (error) {
    await recordPermissionMaterializationFailure(ports, uri, errorMessage(error));
  }
}

/**
 * 给磁盘上刚被自动建出来的祖先目录补物化权限。
 *
 * `ContentStore.writeText` 写 `.../memories/preferences/code-style.md` 时会顺手
 * `mkdir -p` 出 `memories/` 和 `preferences/`，但观察者只收到文件 URI。这两个目录
 * 因此没有 `node_permission` 行，而 `filterReadable` 是纯 SQL 查询——它们会在
 * `list` / `tree` 里**整个消失**，用户看到的目录树是断的。
 *
 * 逐级 `materializeNode` 是幂等的（行已存在就是覆盖成同样的值），代价是每次写
 * 多 O(depth) 条 UPSERT。depth 通常 3–6，换「目录树不断」是划算的。
 */
export async function materializeAncestors(ports: PermissionPorts, uri: Uri): Promise<void> {
  let current = uri.parent();
  while (current !== null) {
    await materializePermission(ports, current);
    current = current.parent();
  }
}
