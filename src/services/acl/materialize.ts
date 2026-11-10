/**
 * 权限物化：把链上求值结果写进 `node_permission`（§8.2 的「写时算，读时查」）。
 *
 * 三条路径共用 `materializePermissions`，保证谓词一致：`setAcl` 的整棵子树重算、
 * `purgeSubtree` 的清空后重算、`IndexObserver` / `SummaryService` 的单节点增量物化。
 */

import type { AclFile } from '../../adapters/fs/acl-file.js';
import type { PermissionRow } from '../../adapters/sqlite/permission-repository.js';
import { READ_LEVEL, USER_WILDCARD, effectiveAcl } from '../../domain/acl.js';
import type { AclNode } from '../../domain/acl.js';
import type { NodeKind } from '../../domain/node.js';
import { Uri } from '../../domain/uri.js';
import { collectPrincipals, hasDenyEntry, maxLevel } from './evaluate.js';
import { readChain, type AclFileCache } from './snapshot.js';
import { runInTransaction } from './transaction.js';
import type { AclPorts } from './types.js';

export type MaterializePorts = Pick<
  AclPorts,
  'aclFile' | 'permissions' | 'nodes' | 'db' | 'logger'
>;

/**
 * 单个节点的物化行：每个主体的有效权限 → `node_permission` 的一行。
 *
 * 输入是链与主体集合，输出只依赖纯函数 `effectiveAcl`，没有 IO。
 *
 * - 有效集合非空 → allow 行，级别取集合最大值（高位包含低位，见 `maxLevel`）。
 * - 有效集合为空且链上有命中该主体的 deny → deny 行。deny 行的 `level` 不参与
 *   判定（读侧只看 `effect`），存最小合法级别 `READ_LEVEL` 避免暗示「拒绝到某一级」。
 * - `user:*` 不写 deny 行：它是通配符，不是「被拒绝的人」。给它写 deny 会把所有
 *   user 主体一起挡掉，包括 owner。
 *
 * 这段逻辑更适合 `domain/acl.ts`（与 `effectiveAcl` 同源），本 wave 不改 domain。
 */
function materializePermissions(
  uri: Uri,
  chain: readonly AclNode[],
  principals: readonly string[],
): readonly PermissionRow[] {
  const rows: PermissionRow[] = [];
  for (const principal of principals) {
    const levels = effectiveAcl(chain, principal);
    if (levels.size > 0) {
      rows.push({
        nodeUri: uri.toString(),
        principal,
        level: maxLevel(levels),
        effect: 'allow',
      });
      continue;
    }
    if (principal === USER_WILDCARD || !hasDenyEntry(chain, principal)) {
      continue;
    }
    rows.push({
      nodeUri: uri.toString(),
      principal,
      level: READ_LEVEL,
      effect: 'deny',
    });
  }
  return rows;
}

/**
 * 按链重算整棵子树的物化权限。
 *
 * 子树来自 `nodes.descendants`（SQL 前缀匹配），**不递归 open 目录**：§8.2 的
 * 硬伤就是「一条候选 open 5 层目录」。这里的文件读取只发生在链上，且按目录
 * 缓存——`tree` 里 1000 个兄弟节点共享同一条祖先链。
 *
 * 文档（`kind === 'document'`）不读自己的 `.acl.json`：文件没有 ACL 文件，
 * 它的有效权限就是所在目录的。owner 按 URI 根推导，文档与目录同属一个根，
 * 所以省略文档节点不改变结果。
 */
async function materializeChain(
  ports: Pick<MaterializePorts, 'aclFile' | 'nodes'>,
  uri: Uri,
  cache: AclFileCache,
): Promise<readonly PermissionRow[]> {
  const { nodes: nodeRepository, aclFile } = ports;
  const target = nodeRepository.get(uri.toString());
  const nodes: readonly { readonly uri: Uri; readonly kind: NodeKind }[] = [
    { uri, kind: target?.kind ?? 'directory' },
    ...nodeRepository
      .descendants(uri.toString())
      .map((row) => ({ uri: Uri.parse(row.uri), kind: row.kind })),
  ];

  const permissions: PermissionRow[] = [];
  for (const node of nodes) {
    const chain = await readChain(aclFile, node.uri, node.kind, cache);
    permissions.push(...materializePermissions(node.uri, chain, collectPrincipals(chain)));
  }
  return permissions;
}

/**
 * `setAcl` 用：目标目录的新内容**还没写盘**，预置进缓存。
 *
 * 求值必须用新 ACL，而文件写失败时事务根本不会开始。
 */
export async function materializeForWrite(
  ports: Pick<MaterializePorts, 'aclFile' | 'nodes'>,
  uri: Uri,
  file: AclFile,
): Promise<readonly PermissionRow[]> {
  return materializeChain(ports, uri, new Map<string, AclFile | null>([[uri.toString(), file]]));
}

/**
 * `purgeSubtree` 用：调用方已经写盘，按文件读到的就是新内容。
 *
 * 与 `materializeForWrite` 的唯一区别是不预置目标节点的文件。
 */
export async function materializeSubtree(
  ports: Pick<MaterializePorts, 'aclFile' | 'nodes'>,
  uri: Uri,
): Promise<readonly PermissionRow[]> {
  return materializeChain(ports, uri, new Map<string, AclFile | null>());
}

/**
 * 单个节点的物化（增量入口）。
 *
 * 用于「新建节点时从父目录复制有效权限」：新节点还没有后代，只重算自己。
 * 链仍然是唯一真相——父目录的 `node_permission` 行是派生结果，直接复制它会在
 * 父行过期时把错误一起继承下来。
 *
 * 与 `setAcl` 的整棵子树重算共用 `materializePermissions`，保证两条路径的
 * 谓词一致。
 *
 * **不加锁。** 只写派生表（`node_permission`），结果完全由 `.acl.json` 决定，
 * 重算是幂等的；加锁反而会死锁——调用方 `IndexObserver` / `SummaryService` 在
 * `FileSystemService` 已持有 `exact` / `tree` 的回调里调它（见 `acl.ts` 文件头
 * 「并发」）。
 */
export async function materializeNode(ports: MaterializePorts, uri: Uri): Promise<void> {
  const { nodes, aclFile, db, permissions: permissionRepository, logger } = ports;
  const kind = nodes.get(uri.toString())?.kind ?? 'directory';
  const chain = await readChain(aclFile, uri, kind, new Map<string, AclFile | null>());
  const permissions = materializePermissions(uri, chain, collectPrincipals(chain));

  runInTransaction(db, () => {
    permissionRepository.replaceNode(uri.toString(), permissions);
  });

  logger.debug('节点权限物化', {
    uri: uri.toString(),
    permissions: permissions.length,
  });
}
