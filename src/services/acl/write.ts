/**
 * `.acl.json` 的写入与校验，以及撤权时的回滚。
 *
 * 写入顺序（见 `src/services/acl.ts` 文件头）：先求值、再写文件（真相）、最后在
 * 一个事务里替换 `node_permission` 与 `acl_entry`（派生表）。文件写失败时事务
 * 根本不会开始，物化表保持旧值。
 *
 * **调用方必须已经持有 `exact(uri)`。** 本模块不自己拿锁：`setAcl` /
 * `ensureRootPreset` / `setGroupOwner` 的读都在锁内，锁若加在这里就只覆盖了写；
 * `purgeSubtree` / `purgePrincipal` 在 `tree(root)` / 逐个 `exact` 里直接写文件。
 */

import type { AclFile, AclFileEntry } from '../../adapters/fs/acl-file.js';
import type { AclEntryRow } from '../../adapters/sqlite/permission-repository.js';
import { parsePrincipal } from '../../domain/acl.js';
import { ComemError } from '../../domain/errors.js';
import type { Uri } from '../../domain/uri.js';
import { levelByName, levelName } from './levels.js';
import { materializeForWrite, type MaterializePorts } from './materialize.js';
import { runInTransaction } from './transaction.js';
import type { AclPorts, AclState, PurgeRewrite } from './types.js';

type RewritePorts = Pick<AclPorts, 'aclFile' | 'db' | 'logger'>;

/** 领域形态 → 磁盘文件，逐项校验主体与效果。 */
export function toFile(state: AclState): AclFile {
  if (state.mode !== 'inherit' && state.mode !== 'restricted') {
    throw new ComemError('INVALID_ARGUMENT', `ACL 模式不合法：${String(state.mode)}`, {
      mode: state.mode,
    });
  }
  const entries: AclFileEntry[] = state.entries.map((entry) => {
    // 安全边界：主体与效果都是调用方输入，进 `.acl.json` 之前逐项校验。
    // 一个 `user:*` 之外的畸形主体如果被静默写入，磁盘上就多一条谁也解释不了
    // 的授权；非法的 effect 会被下次读取拒绝，但那时写盘已经发生了。
    parsePrincipal(entry.principal);
    if (entry.effect !== 'allow' && entry.effect !== 'deny') {
      throw new ComemError('INVALID_ARGUMENT', `ACL 效果不合法：${String(entry.effect)}`, {
        effect: entry.effect,
      });
    }
    return { principal: entry.principal, level: levelName(entry.level), effect: entry.effect };
  });
  return { mode: state.mode, entries };
}

function toEntryRows(uri: Uri, entries: readonly AclFileEntry[]): readonly AclEntryRow[] {
  const rows = new Map<string, AclEntryRow>();
  for (const entry of entries) {
    const row: AclEntryRow = {
      uri: uri.toString(),
      principal: entry.principal,
      level: levelByName(entry.level),
      effect: entry.effect,
    };
    const existing = rows.get(entry.principal);
    // acl_entry 的主键是 (uri, principal)，同一主体只能存一条。同节点 deny 优先
    // （§12.2 不变量 2），所以冲突时保留 deny，反查结果才与求值结果一致。
    if (existing === undefined || row.effect === 'deny') {
      rows.set(entry.principal, row);
    }
  }
  return [...rows.values()];
}

/**
 * 写 `.acl.json`（真相）并重算整棵子树的 `node_permission` 与反查表。
 *
 * `setAcl` / `ensureRootPreset` / `setGroupOwner` 共用这一条顺序。文件写失败时
 * 事务根本不会开始，物化表保持旧值。
 */
export async function writeAcl(
  ports: MaterializePorts,
  uri: Uri,
  file: AclFile,
): Promise<number> {
  const { aclFile, permissions: permissionRepository, db } = ports;
  // 求值只读文件，先算完再落盘：这样文件写失败时没有任何物化副作用。
  const permissions = await materializeForWrite(ports, uri, file);
  const entryRows = toEntryRows(uri, file.entries);

  await aclFile.write(uri, file);

  runInTransaction(db, () => {
    permissionRepository.replaceSubtree(uri.toString(), permissions);
    permissionRepository.replaceEntries(uri.toString(), entryRows);
  });
  return permissions.length;
}

/**
 * 在一个 `BEGIN IMMEDIATE` 里写回 `rewrites` 的 `.acl.json`，再执行 `mutate`
 * 更新索引；失败时 `ROLLBACK` 并把已经写出去的文件恢复成 `previous`。
 *
 * **为什么两条撤销路径共用它。** 磁盘 `.acl.json` 已撤、`node_permission` 没撤
 * 的失效形态是**提权**：文件说 deny、求值说 allow，而且不报错。两份实现时修好
 * 一份不保证另一份也修好；回滚只有这一条路径才能保证「索引写失败就恢复磁盘」。
 *
 * **`BEGIN` 放在 `try` 之外**：开事务失败时没有任何文件被写过，不需要 ROLLBACK
 * 或恢复。抛出的异常原样向上传，不包装、不改错误码。
 *
 * **调用方必须仍持有 `rewrites` 里每个 URI 的锁，并在锁释放前 await 本函数。**
 * 回滚是在并发写者可能刚写过的新内容上再覆盖一次；锁外回滚会把对方的条目一起
 * 抹掉，那正是本次要修的缺陷。
 */
export async function commitAclRewrites(
  ports: RewritePorts,
  rewrites: readonly PurgeRewrite[],
  mutate: () => void | Promise<void>,
): Promise<void> {
  const { db, aclFile } = ports;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const rewrite of rewrites) {
      await aclFile.write(rewrite.uri, rewrite.next);
    }
    await mutate();
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    await restoreAclFiles(ports, rewrites);
    throw error;
  }
}

/**
 * 回滚已经写出去的 `.acl.json`（`purgePrincipal` 的数据库删除失败时）。
 *
 * 尽力而为：恢复失败只记 `error`，原始错误继续抛。掩盖原始错误会让「为什么
 * 删账号失败」变成「为什么磁盘上有两份不同的授权」，后者更难定位。
 *
 * **调用方必须仍持有这些 URI 的锁。** 回滚是在并发写者可能刚写过的新内容上再
 * 覆盖一次；锁外回滚会把对方的条目一起抹掉，那正是本次要修的缺陷。
 */
async function restoreAclFiles(
  ports: RewritePorts,
  rewrites: readonly PurgeRewrite[],
): Promise<void> {
  const { aclFile, logger } = ports;
  for (const rewrite of rewrites) {
    try {
      await aclFile.write(rewrite.uri, rewrite.previous);
    } catch (error) {
      logger.error('回滚 .acl.json 失败，磁盘授权与物化表不一致', {
        uri: rewrite.uri.toString(),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/**
 * 按磁盘上的 `.acl.json` 重建某节点的反查表（`acl_entry`）。
 *
 * 移动 / 改名后目标侧用：`PermissionRepository.deleteSubtree(from)` 会把源子树
 * 的 `acl_entry` 删掉，而 `materializeNode` 只写 `node_permission`。反查表丢了
 * 行之后 `purgePrincipal` 找不到那个目录，删账号撤不掉文件里的授权——同 ID 重建
 * 的用户会继承旧权限，这是一条提权路径。
 *
 * 没有 `.acl.json` 时什么都不做：按文件为准，没有文件就没有直接授权（继承来的
 * 权限不是这个节点的直接条目）。返回是否写了行，供观察者日志与测试判断。
 *
 * **不加锁，而且不能加。** 调用方是 `IndexObserver.onNodeWritten` /
 * `onNodeMoved`，它们在 `FileSystemService` 已经持有 `exact(uri)` / `tree(uri)`
 * 的回调里执行；这里再拿同一路径的锁就是「自己等自己」，5 秒后 `CONFLICT`。
 */
export async function syncEntriesFromFile(ports: MaterializePorts, uri: Uri): Promise<boolean> {
  const { aclFile, permissions, db, logger } = ports;
  const file = await aclFile.read(uri);
  if (file === null) {
    logger.debug('节点没有 .acl.json，跳过反查表重建', { uri: uri.toString() });
    return false;
  }

  const entryRows = toEntryRows(uri, file.entries);
  runInTransaction(db, () => {
    permissions.replaceEntries(uri.toString(), entryRows);
  });
  logger.debug('反查表已按文件重建', {
    uri: uri.toString(),
    entries: entryRows.length,
  });
  return true;
}
