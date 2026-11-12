/**
 * 鉴权与目录检查的端口函数。
 *
 * 这两个检查不持有状态：`filterReadable` 是一次批量查询，`assertDirectory` 是一次
 * 单行读。放在这里是为了让 `AclService` 只保留编排与私有状态。
 */

import type { AclFile } from '../../adapters/fs/acl-file.js';
import type { NodeRepository, NodeRow } from '../../adapters/sqlite/node-repository.js';
import type { PermissionRepository } from '../../adapters/sqlite/permission-repository.js';
import { effectiveAcl, levelSatisfies } from '../../domain/acl.js';
import { ComemError } from '../../domain/errors.js';
import type { Uri } from '../../domain/uri.js';

import type { AclAction } from '../authorizer.js';
import { readChain } from './snapshot.js';
import type { AclPorts } from './types.js';

/**
 * 批量求权：一次 `IN (...)` 查询，不按 URI 逐条查。
 *
 * 查询本身固定 `level >= read`（`readableUris` 的语义），所以这个函数是「过滤
 * 出可读的」，不是「按任意动作过滤」——`Authorizer` 只要求 read。
 */
export async function filterReadable(
  permissions: PermissionRepository,
  uris: readonly Uri[],
  principals: readonly string[],
): Promise<ReadonlySet<string>> {
  if (uris.length === 0) {
    return new Set<string>();
  }
  return permissions.readableUris(
    uris.map((uri) => uri.toString()),
    principals,
  );
}

/** ACL 只能设在目录上；文件没有自己的 `.acl.json`（§6.7）。 */
export function assertDirectory(nodes: NodeRepository, uri: Uri): void {
  const node: NodeRow | null = nodes.get(uri.toString());
  if (node?.kind === 'document') {
    throw new ComemError(
      'INVALID_ARGUMENT',
      `ACL 只能设在目录上：${uri.toString()}`,
      { uri: uri.toString() },
    );
  }
}

/**
 * 目标（可能不存在）沿祖先链的权限。
 *
 * 读路径用它区分「节点不存在」与「没有权限」：目标在 `node_permission` 里没有行、
 * 磁盘上也没有文件时，只要祖先链对调用方有 read，「读不到」的原因是前者。
 *
 * 链读取与求值复用 `readChain` / `effectiveAcl`，与物化、`getAcl` 是同一份规则。
 * **不物化**：一次探测不该在库里留下权限行。
 *
 * 链包含目标 URI 本身：不存在的节点没有 `.acl.json`，按 inherit + 空条目参与求值
 * 不改变结果；包含它才能让根节点的 owner 规则也生效。
 */
export async function hasAncestorPermission(
  ports: Pick<AclPorts, 'aclFile'>,
  uri: Uri,
  action: AclAction,
  principals: readonly string[],
): Promise<boolean> {
  const chain = await readChain(
    ports.aclFile,
    uri,
    'directory',
    new Map<string, AclFile | null>(),
  );
  for (const principal of principals) {
    for (const level of effectiveAcl(chain, principal)) {
      if (levelSatisfies(level, action)) {
        return true;
      }
    }
  }
  return false;
}
