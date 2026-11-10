/**
 * 鉴权与目录检查的端口函数。
 *
 * 这两个检查不持有状态：`filterReadable` 是一次批量查询，`assertDirectory` 是一次
 * 单行读。放在这里是为了让 `AclService` 只保留编排与私有状态。
 */

import type { NodeRepository, NodeRow } from '../../adapters/sqlite/node-repository.js';
import type { PermissionRepository } from '../../adapters/sqlite/permission-repository.js';
import { ComemError } from '../../domain/errors.js';
import type { Uri } from '../../domain/uri.js';

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
