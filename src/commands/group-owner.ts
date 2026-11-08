/**
 * 指定组的 owner（架构文档 §12.6 的管理面引导与恢复入口）。
 *
 * 用法：
 *
 * ```bash
 * pnpm group:owner <groupId> <userId>
 * ```
 *
 * **为什么不走 HTTP。** 改 owner 的端点要求「当前 owner 或组根 manage」。删账号会把
 * `app_group.owner_user_id` 清成 `NULL`（`IdentityService.deleteUser`），而撤权又会
 * 移除组根里 `user:{owner} = manage` 那一条。如果组里没有第二个 manage 持有者，
 * HTTP 端点在求权阶段就 403，永远走不到写库那一步——这个组从此不能改 ACL、不能加
 * 成员。命令行直接打开数据库写行，再补 `.acl.json`，绕开「管理端点自己也要认证」
 * 的循环，与 `pnpm password` 解决的是同一类问题（§12.7 的引导循环）。
 *
 * **写 `.acl.json` 用 `setGroupOwner`，不是 `ensureRootPreset`。** 后者的幂等判断
 * 是「文件里有没有 `group:{gid}` 这一条」（§12.6）：正常组的组根一定已经有这一条，
 * 早退之后 owner 的 `manage` 永远补不上。`setGroupOwner` 会替换 owner 条目、保留
 * 其它条目与 `mode`。
 *
 * 顺序与路由一致：先写文件，再写目录行。文件写失败时数据库停在原值——「磁盘上换了
 * owner、库里还是旧值」比反过来更难排查，因为下一次改 owner 会拿旧值做比对。
 *
 * 不启动调度器、不建服务图：只打开数据库与 ACL 文件。
 */

import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { AclFileStore } from '../adapters/fs/acl-file.js';
import { ConsoleLogger } from '../adapters/log/console.js';
import { openDatabase, runMigrations } from '../adapters/sqlite/database.js';
import { GroupRepository } from '../adapters/sqlite/group-repository.js';
import { NodeRepository } from '../adapters/sqlite/node-repository.js';
import { PermissionRepository } from '../adapters/sqlite/permission-repository.js';
import { UserRepository } from '../adapters/sqlite/user-repository.js';
import { loadConfig } from '../config/index.js';
import { ComemError } from '../domain/errors.js';
import { assertValidGroupId, assertValidUserId } from '../domain/identity.js';
import { Uri } from '../domain/uri.js';
import { AclService } from '../services/acl.js';

/** 数据库文件在数据根下的位置（§6.5 的 `_meta/comem.sqlite`）。 */
const META_DIRECTORY = '_meta';
const DATABASE_FILE = 'comem.sqlite';

export interface SetGroupOwnerOptions {
  readonly path?: string;
  readonly env?: NodeJS.ProcessEnv;
}

export interface SetGroupOwnerResult {
  readonly groupId: string;
  readonly userId: string;
}

/** 从数据根打开数据库，把组的 owner 改成指定用户。 */
export async function setGroupOwner(
  groupId: string,
  userId: string,
  options: SetGroupOwnerOptions = {},
): Promise<SetGroupOwnerResult> {
  const id = assertValidGroupId(groupId);
  const ownerUserId = assertValidUserId(userId);

  const config = await loadConfig({
    ...(options.path === undefined ? {} : { path: options.path }),
    ...(options.env === undefined ? {} : { env: options.env }),
  });
  const dataDir = config.dataDir;
  const logger = new ConsoleLogger({ level: 'warn' });
  const db = openDatabase(join(dataDir, META_DIRECTORY, DATABASE_FILE));
  try {
    runMigrations(db);
    const groups = new GroupRepository({ db, logger });
    const users = new UserRepository({ db, logger });

    const group = groups.get(id);
    if (group === null) {
      throw new ComemError('NOT_FOUND', `组不存在：${id}`, { groupId: id });
    }
    if (users.get(ownerUserId) === null) {
      throw new ComemError('NOT_FOUND', `用户不存在：${ownerUserId}`, { userId: ownerUserId });
    }

    const acl = new AclService({
      dataDir,
      db,
      aclFile: new AclFileStore({ dataDir, logger }),
      permissions: new PermissionRepository({ db, logger }),
      nodes: new NodeRepository({ db, logger }),
      logger,
      groupDefaultLevel: config.acl.groupDefaultLevel === 'write' ? 3 : 1,
    });

    // 先写文件：`.acl.json` 是权限的真相，目录行只是「谁是 owner」的元数据。
    await acl.setGroupOwner(Uri.parse(`comem://group/${id}`), group.ownerUserId, ownerUserId);
    groups.setOwner(id, ownerUserId, new Date());
    return { groupId: id, userId: ownerUserId };
  } finally {
    db.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [groupId, userId] = process.argv.slice(2);
  if (groupId === undefined || groupId === '' || userId === undefined || userId === '') {
    process.stderr.write('用法：pnpm group:owner <groupId> <userId>\n');
    process.exitCode = 2;
  } else {
    try {
      const result = await setGroupOwner(groupId, userId);
      process.stdout.write(`已把组 ${result.groupId} 的 owner 设为 ${result.userId}。\n`);
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    }
  }
}
