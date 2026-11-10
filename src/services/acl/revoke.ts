/**
 * 撤权：从所有 `.acl.json` 里移除某个主体（删账号用）。
 *
 * **必须真改文件**，不能只删 `acl_entry` / `node_permission` 的行——那两张表是
 * `.acl.json` 的物化结果，下次 `materializeNode` 会把它们重新算出来。删掉的账号
 * 重新创建同 ID 的用户就会立刻继承旧授权，这是一条提权路径。
 *
 * **两路来源取并集。** `acl_entry` 的反查索引（`acl_principal`）是快路径；但
 * 它可能不全——手工改过 `.acl.json`、或者 `mv` 之后反查表丢过行的目录都不在
 * 表里。反查表与文件不同步时以文件为准（§7），所以还要扫描数据根下所有带
 * `.acl.json` 的目录（`AclFileStore.scanDirectories`）。扫描有目录数上限
 * （`MAX_PURGE_SCAN_DIRECTORIES`），达到上限时记 warn 并继续，避免大库上
 * 变成无界操作。
 *
 * 文件里没有该主体就只删行、不写盘。返回被改动的目录数。空操作返回 0。
 *
 * **事务边界**：文件写入与两张表的删除包在同一个 `BEGIN IMMEDIATE` 里。写文件
 * 失败时 `ROLLBACK`，数据库保持旧值；数据库删除失败时把已经写出去的 `.acl.json`
 * 写回原内容。抛出的异常不会留下半撤的状态。
 *
 * **崩溃窗口**：进程在 `.acl.json` 写完、`COMMIT` 之前被杀掉时，SQLite 会回滚
 * 事务，物化表仍是旧行——`check` 读的是物化表，会按旧授权放行。文件与 SQLite
 * 之间没有跨介质事务，这个窗口只能靠「以 `.acl.json` 为真相重算物化表」收口，
 * 而那个重建命令现在还不存在（`docs/operations.md` 的已知限制），要人工对相关
 * 目录调一次 `materializeNode`。窗口与 `setAcl` 的崩溃窗口同源。
 */

import { parsePrincipal } from '../../domain/acl.js';
import { Uri } from '../../domain/uri.js';
import { scanAclDirectories } from './purge.js';
import { deletePrincipalRows } from './transaction.js';
import { commitAclRewrites } from './write.js';
import type { AclPorts, PurgeRewrite } from './types.js';

export async function purgePrincipal(ports: AclPorts, principal: string): Promise<number> {
  // 主体是调用方输入，进 SQL 之前按 §12.1 的形态校验。
  parsePrincipal(principal);

  const { permissions, locks, aclFile, logger, db } = ports;
  const targets = new Map<string, Uri>();
  for (const row of permissions.entriesByPrincipal(principal)) {
    targets.set(row.uri, Uri.parse(row.uri));
  }
  const scan = await scanAclDirectories(ports, '撤权扫描', { principal });
  for (const uri of scan.uris) {
    targets.set(uri.toString(), uri);
  }

  // 按 URI 升序：回滚顺序与日志顺序可复现，不依赖 Map 的插入来源。
  const ordered = [...targets.values()].sort((left, right) => {
    const leftUri = left.toString();
    const rightUri = right.toString();
    return leftUri < rightUri ? -1 : leftUri > rightUri ? 1 : 0;
  });

  // 撤权横跨整库，没有单一路径能覆盖全部目标，所以逐目录 `exact`。**多锁必须
  // 定序**（§10.6）：全部按 URI 升序获取、反序释放，两个并发撤权不会各持一把
  // 等另一把。`FileSystemService.move` 用同一条全局顺序。
  //
  // 锁在扫描之后才拿：扫描本身是只读的目录遍历，把它放进锁里只会拉长持有时间，
  // 挡不住「扫描之后新建的目录」——那是撤权的已知边界，由 `purgeSubtree` 的
  // `tree` 锁在删组路径上兜底。
  const releases: (() => void)[] = [];
  try {
    for (const uri of ordered) {
      releases.push(await locks.acquire(uri, 'exact'));
    }

    const rewrites: PurgeRewrite[] = [];
    for (const uri of ordered) {
      const previous = await aclFile.read(uri);
      if (previous === null) {
        // 节点被外部删除、或反查表比文件新：没有文件要改，行仍然要删。
        continue;
      }
      const entries = previous.entries.filter((entry) => entry.principal !== principal);
      if (entries.length === previous.entries.length) {
        continue;
      }
      rewrites.push({ uri, previous, next: { mode: previous.mode, entries } });
    }

    // 回滚仍在锁内：锁外回滚会覆盖并发写者刚写进去的条目。
    await commitAclRewrites(ports, rewrites, () => deletePrincipalRows(db, principal));

    logger.info('主体授权已撤销', {
      principal,
      directories: rewrites.length,
      scannedDirectories: scan.directoriesScanned,
      aclFiles: scan.uris.length,
      truncated: scan.truncated,
    });
    return rewrites.length;
  } finally {
    for (const release of releases.reverse()) {
      release();
    }
  }
}
