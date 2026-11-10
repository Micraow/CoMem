/**
 * 命名空间预置：新建 user / group 根时写 `.acl.json`（§12.6），以及组 owner 变更。
 *
 * 三个入口都只改**一个**目录的 `.acl.json`，所以锁一律是 `exact(uri)`，并且读
 * 与写都在锁内——锁外读到的旧条目会被整份覆盖（§10.6 的锁契约）。
 */

import type { AclFile, AclFileEntry } from '../../adapters/fs/acl-file.js';
import {
  assertOwnerUserId,
  groupPrincipal,
  rootPreset,
  userPrincipal,
} from '../../domain/acl.js';
import type { AclLevel, RootPreset } from '../../domain/acl.js';
import { ComemError } from '../../domain/errors.js';
import type { Uri } from '../../domain/uri.js';
import { levelName } from './levels.js';
import { writeAcl } from './write.js';
import type { AclPorts } from './types.js';

/** 根预置是否已经应用。见 `ensureRootPreset` 的注释。 */
function hasRootPreset(uri: Uri, file: AclFile): boolean {
  if (uri.scope === 'user') {
    return true;
  }
  const group = groupPrincipal(uri.rootId);
  return file.entries.some((entry) => entry.principal === group && entry.effect === 'allow');
}

/**
 * 新建根时写预置（§12.6）。
 *
 * user 根 → `user:{uid} = manage`；group 根 → `group:{gid} = write`（可由
 * `groupDefaultLevel` 降为 read），组有 owner 时再预置 `user:{owner} = manage`。
 *
 * **判断依据是文件里的条目，不是文件是否存在。** 删组时会把 `.acl.json` 写成
 * `{mode:'inherit', entries:[]}`（`restricted` 语义需要这个空文件），重建同 ID
 * 的组时文件仍然在。按存在性跳过预置的话，新组根没有任何 `group:{gid}` 授权，
 * 组空间对所有人永久空 ACL。user 根保持「文件存在就跳过」：user 的 manage 来自
 * owner 规则（URI 根标识），不依赖条目。
 *
 * 幂等：组根已经有 `group:{gid}` 条目就不覆盖，否则每次启动都会把管理员调过的
 * 根权限冲掉。
 *
 * 返回的 `ownerMissing` 告诉调用方「这个组还没有人管」——group 作用域没有 owner
 * 时只有 `group:{gid} = write`，没有主体能求 manage，组空间无法改 ACL。
 *
 * **幂等判断在 `exact(uri)` 锁内做。** 这是读-改-写：锁外的 `existing` 会让两个
 * 并发创建（用户/组创建时自动跑，与管理员改 ACL 撞车）各自看到「没有预置」，
 * 后写者整份覆盖。新组根目录可能还不存在，所以必须
 * `createParentDirectory: true`，否则锁文件没有地方放、等于没锁。
 */
export async function ensureRootPreset(
  ports: AclPorts,
  uri: Uri,
  ownerUserId: string | null,
  groupDefaultLevel: AclLevel,
): Promise<RootPreset> {
  const { aclFile, logger, locks } = ports;
  if (!uri.isRoot) {
    throw new ComemError(
      'INVALID_ARGUMENT',
      `根预置只能写在根 URI 上：${uri.toString()}`,
      { uri: uri.toString() },
    );
  }
  // owner 会变成组根的 `user:{owner} = manage` 条目。空串是「没有 owner」，与
  // `null` 同义；其余形态（含通配 `*`）一律拒绝——这是 §12.2 的唯一授权来源
  // 在服务层的落点，不能假设调用方已经过 `assertValidUserId`。
  if (ownerUserId !== null && ownerUserId !== '') {
    assertOwnerUserId(ownerUserId);
  }

  const preset = rootPreset(uri, {
    ownerUserId,
    groupLevel: groupDefaultLevel,
  });
  if (preset.ownerMissing) {
    logger.warn('组根预置没有 owner，组空间暂时无人可管理', {
      uri: uri.toString(),
      hint: 'POST /api/v1/admin/groups/{id}/owner 可以指定 owner。',
    });
  }

  const file: AclFile = {
    mode: 'inherit',
    entries: preset.entries.map((entry) => ({
      principal: entry.principal,
      level: levelName(entry.level),
      effect: entry.effect,
    })),
  };

  return locks.withLock(
    uri,
    'exact',
    async () => {
      const existing = await aclFile.read(uri);
      if (existing !== null && hasRootPreset(uri, existing)) {
        logger.debug('根预置已存在，跳过', { uri: uri.toString() });
        return preset;
      }

      const permissions = await writeAcl(ports, uri, file);

      logger.info('根预置已写入', {
        uri: uri.toString(),
        scope: uri.scope,
        ownerMissing: preset.ownerMissing,
        entries: file.entries.length,
        permissions,
      });
      return preset;
    },
    { createParentDirectory: true },
  );
}

/**
 * 改组 owner 的根预置：把 `user:{previousOwner} = manage` 换成
 * `user:{nextOwner} = manage`。
 *
 * **这里不再求一次 manage。** 授权判定在路由：当前 owner（`owner_user_id`）
 * 或组根 manage 持有者可以改。迁移回填的 owner 在 `.acl.json` 里通常还没有
 * manage 条目（SQL 迁移写不了文件），如果这里再求一次 manage，它会被自己
 * 的组挡在外面——「改 owner」这条唯一的修复路径就断了。
 *
 * 保留其他条目与 `mode`：owner 变更不应该顺手把组根的 `restricted` 或别人
 * 的授权冲掉。组条目已存在时保留它的级别（管理员可能把它降成了 read）。
 *
 * 整个「读 `previous` → 拼条目 → 写」在 `exact(uri)` 锁内：锁外的 `previous`
 * 会让并发的 `setAcl` / `ensureRootPreset` 条目被整份覆盖。
 */
export async function setGroupOwner(
  ports: AclPorts,
  uri: Uri,
  previousOwnerId: string | null,
  nextOwnerId: string,
  groupDefaultLevel: AclLevel,
): Promise<void> {
  const { aclFile, logger, locks } = ports;
  if (uri.scope !== 'group' || !uri.isRoot) {
    throw new ComemError(
      'INVALID_ARGUMENT',
      `组 owner 预置只能写在组根 URI 上：${uri.toString()}`,
      { uri: uri.toString() },
    );
  }
  assertOwnerUserId(nextOwnerId);

  const preset = rootPreset(uri, {
    ownerUserId: nextOwnerId,
    groupLevel: groupDefaultLevel,
  });
  const previousOwnerPrincipal =
    previousOwnerId === null ? null : userPrincipal(previousOwnerId);
  const nextOwnerPrincipal = userPrincipal(nextOwnerId);

  await locks.withLock(
    uri,
    'exact',
    async () => {
      const previous = await aclFile.read(uri);
      const entries: AclFileEntry[] = (previous?.entries ?? []).filter(
        (entry) =>
          entry.principal !== previousOwnerPrincipal && entry.principal !== nextOwnerPrincipal,
      );
      for (const entry of preset.entries) {
        // 已经有的条目保留原级别：管理员把组根降成 read 之后改 owner 不应该恢复成 write。
        if (entries.some((candidate) => candidate.principal === entry.principal)) {
          continue;
        }
        entries.push({
          principal: entry.principal,
          level: levelName(entry.level),
          effect: entry.effect,
        });
      }
      const file: AclFile = { mode: previous?.mode ?? 'inherit', entries };

      await writeAcl(ports, uri, file);
      logger.info('组 owner 预置已更新', {
        uri: uri.toString(),
        previousOwnerId,
        nextOwnerId,
      });
    },
    { createParentDirectory: true },
  );
}
