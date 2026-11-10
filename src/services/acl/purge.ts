/**
 * 删组时清空子树内的直接授权，以及两条撤销路径共用的目录扫描。
 *
 * 清空是「扫子树 → 改每个 `.acl.json`」，所以整棵子树一把 `tree(root)`；只锁
 * 单个文件时，扫描之后新建的目录不在快照里，它的授权会残留（组删了、同 ID
 * 重建后旧授权立刻生效）。
 *
 * **锁内不能回调 `setAcl`。** 后者要 `exact(descendant)`，与这里的 `tree(root)`
 * 冲突，而 `PathLockManager` 不可重入——会等一个自己持有的锁直到 5 秒超时。
 * 所以这里直接写文件（回滚路径也一样，回滚时锁仍被持有）。
 */

import type { AclDirectoryScan } from '../../adapters/fs/acl-file.js';
import type { Uri } from '../../domain/uri.js';
import { materializeSubtree } from './materialize.js';
import { runInTransaction } from './transaction.js';
import { commitAclRewrites } from './write.js';
import type { AclPorts, PurgeRewrite } from './types.js';

/**
 * `purgePrincipal` 扫描 `.acl.json` 的目录数上限。
 *
 * **来源：经验假设，不是测量值。** 撤权是一次低频管理操作，但它在删除账号的
 * 请求路径上；没有上限时，目录很多的部署上「删一个账号」会变成不可预期的长操作。
 * 10,000 个目录在本地 SSD 上大约是亚秒级（每个目录一次 `readdir`，只有存在
 * `.acl.json` 时才多一次读），覆盖到「中等规模部署」；再大的库由日志里的
 * `truncated: true` 暴露出来，交给运维按已知限制处理。
 *
 * 达到上限时**不中止**删除：账号删除与撤权是两件事，第一部分失败会让账号删不
 * 掉。残留风险是上限之外的手工授权没被撤回，记 warn。
 */
const MAX_PURGE_SCAN_DIRECTORIES = 10_000;

/**
 * 扫描数据根下所有带 `.acl.json` 的目录，截断时记 warn（`purgeSubtree` /
 * `purgePrincipal` 共用）。
 *
 * `reasonLabel` 是两种撤销场景各自的文案前缀（「清空子树授权」/「撤权扫描」），
 * `detail` 是各自的定位字段（`uri` / `principal`）。拆成两个入参是为了让截断
 * 判据与上限只在这里维护，同时保持两条路径原有的日志字段与顺序不变。
 *
 * **本函数不拿锁，由调用方决定扫描位置。** `purgeSubtree` 在 `tree(root)` 内
 * 调用：扫描与写回必须在同一把锁里，否则扫描之后新建的目录会漏撤；
 * `purgePrincipal` 在取锁之前调用：撤权横跨整库、锁在扫描之后才拿。
 */
export async function scanAclDirectories(
  ports: Pick<AclPorts, 'aclFile' | 'logger'>,
  reasonLabel: string,
  detail: Readonly<Record<string, string>>,
): Promise<AclDirectoryScan> {
  const { aclFile, logger } = ports;
  const scan = await aclFile.scanDirectories({
    maxDirectories: MAX_PURGE_SCAN_DIRECTORIES,
  });
  if (scan.truncated) {
    logger.warn(`${reasonLabel}达到目录上限，上限之外的 .acl.json 未检查`, {
      ...detail,
      limit: MAX_PURGE_SCAN_DIRECTORIES,
      scannedDirectories: scan.directoriesScanned,
      aclFiles: scan.uris.length,
    });
  }
  return scan;
}

/**
 * 清空某个 URI 子树内的全部直接授权条目（删组用）。
 *
 * **为什么需要它。** `purgePrincipal` 只按主体清：删组时它移除 `group:{gid}`
 * 这个 principal 的条目，组子树里 `user:bob = write` 这样的**直接授权**不会被动。
 * 组被删、数据留在磁盘上，同 ID 重建后旧授权立刻生效——删组没有撤销共享范围。
 *
 * **语义：保留数据与 `mode`，清空条目。** 删组不是删数据（`DELETE
 * /admin/groups/{id}` 不删 `comem://group/{gid}/` 下的文件）。清空条目而不是
 * 重置 `mode`：`restricted` 是旧组管理员的决定，清空后它仍然收得最紧（没人可读）；
 * 重置成 `inherit` 反而可能让祖先的 `user:*` 放开数据。
 *
 * **物化表要重算，不能只删行。** 子树里的节点可能从**子树之外**的祖先继承权限
 * （`comem://group/` 上的条目），所以 `node_permission` 按清空后的文件重算整棵
 * 子树；`acl_entry` 的子树行直接删除（文件里已经没有条目）。
 *
 * 扫描上限沿用 `MAX_PURGE_SCAN_DIRECTORIES`，达到上限时记 warn 并继续——与
 * `purgePrincipal` 同一个判据：撤权失败会让组删不掉，失败方向更差。返回被改写的
 * `.acl.json` 文件数。空操作返回 0。
 */
export async function purgeSubtree(ports: AclPorts, root: Uri): Promise<number> {
  const { aclFile, locks, permissions: permissionRepository, db, logger } = ports;
  const prefix = root.toString();

  return locks.withLock(root, 'tree', async () => {
    const scan = await scanAclDirectories(ports, '清空子树授权', { uri: prefix });

    const rewrites: PurgeRewrite[] = [];
    for (const uri of scan.uris) {
      const value = uri.toString();
      if (value !== prefix && !value.startsWith(`${prefix}/`)) {
        continue;
      }
      const previous = await aclFile.read(uri);
      if (previous === null || previous.entries.length === 0) {
        continue;
      }
      rewrites.push({ uri, previous, next: { mode: previous.mode, entries: [] } });
    }

    await commitAclRewrites(ports, rewrites, async () => {
      const permissions = await materializeSubtree(ports, root);
      runInTransaction(db, () => {
        permissionRepository.replaceSubtree(prefix, permissions);
        permissionRepository.deleteEntriesSubtree(prefix);
      });
    });

    logger.info('子树授权已清空', {
      uri: prefix,
      files: rewrites.length,
      entries: rewrites.reduce((total, rewrite) => total + rewrite.previous.entries.length, 0),
      scannedDirectories: scan.directoriesScanned,
      aclFiles: scan.uris.length,
      truncated: scan.truncated,
    });
    return rewrites.length;
  });
}