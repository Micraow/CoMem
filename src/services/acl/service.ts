/**
 * ACL 服务的编排层：鉴权入口（`Authorizer`）、管理面入口与物化入口。
 *
 * 求值规则全部在 `domain/acl.ts`；链读取 / 纯求值 / 物化 / 写盘 / 撤权 / 预置
 * 分别在 `./acl/` 下的模块里。本类只持有端口与锁，把调用路由到对应模块。
 * 并发契约、崩溃窗口与锁序的完整说明见 `src/services/acl.ts` 的文件头。
 */

import type { AclFileStore } from '../../adapters/fs/acl-file.js';
import type { PathLockManager } from '../../adapters/fs/lock.js';
import type { NodeRepository } from '../../adapters/sqlite/node-repository.js';
import type { PermissionRepository } from '../../adapters/sqlite/permission-repository.js';
import { MANAGE_LEVEL, WRITE_LEVEL, isAclLevel, levelSatisfies } from '../../domain/acl.js';
import type { AclLevel, RootPreset } from '../../domain/acl.js';
import { ComemError } from '../../domain/errors.js';
import type { Logger } from '../../domain/log.js';
import type { Uri } from '../../domain/uri.js';

import { permissionDenied, type AclAction, type Authorizer } from '../authorizer.js';
import { assertDirectory, filterReadable as filterReadableUris, hasAncestorPermission as ancestorPermission } from './guard.js';
import { materializeNode as materializeOneNode } from './materialize.js';
import { resolvePrincipals as expandPrincipals } from './principals.js';
import {
  ensureRootPreset as writeRootPreset,
  setGroupOwner as applyGroupOwner,
} from './preset.js';
import { purgeSubtree as purgeAclSubtree } from './purge.js';
import { purgePrincipal as purgeAclPrincipal } from './revoke.js';
import { readSnapshot, readState } from './snapshot.js';
import type {
  AclDatabase,
  AclInput,
  AclPorts,
  AclServiceOptions,
  AclSnapshot,
  AclState,
} from './types.js';
import { syncEntriesFromFile as syncEntries, toFile, writeAcl } from './write.js';

export class AclService implements Authorizer {
  readonly #db: AclDatabase;
  readonly #aclFile: AclFileStore;
  readonly #permissions: PermissionRepository;
  readonly #nodes: NodeRepository;
  readonly #logger: Logger;
  readonly #locks: PathLockManager;
  readonly #groupDefaultLevel: AclLevel;

  constructor(options: AclServiceOptions) {
    if (options.groupDefaultLevel !== undefined && !isAclLevel(options.groupDefaultLevel)) {
      throw new ComemError(
        'INVALID_ARGUMENT',
        `组根默认级别不合法：${String(options.groupDefaultLevel)}。只支持 1 / 3 / 7。`,
        { groupDefaultLevel: options.groupDefaultLevel },
      );
    }

    this.#db = options.db;
    this.#aclFile = options.aclFile;
    this.#permissions = options.permissions;
    this.#nodes = options.nodes;
    this.#logger = options.logger;
    this.#locks = options.locks;
    // §12.6：组根预置默认 write；§18 的 `acl.groupDefaultLevel` 可降为 read。
    this.#groupDefaultLevel = options.groupDefaultLevel ?? WRITE_LEVEL;
  }

  // ── Authorizer ──

  async check(
    uri: Uri,
    action: AclAction,
    principals: readonly string[],
  ): Promise<boolean> {
    return this.#checkPrincipals(uri, action, principals);
  }

  /** 批量求权：一次 `IN (...)` 查询，不按 URI 逐条查。见 `./acl/guard.ts`。 */
  async filterReadable(
    uris: readonly Uri[],
    principals: readonly string[],
  ): Promise<ReadonlySet<string>> {
    return filterReadableUris(this.#permissions, uris, principals);
  }

  async assert(
    uri: Uri,
    action: AclAction,
    principals: readonly string[],
  ): Promise<void> {
    if (!(await this.check(uri, action, principals))) {
      throw permissionDenied(uri, action);
    }
  }

  // ── 管理面（只走 HTTP，不进 MCP，§12.2 第 3 条）──

  /**
   * 读 ACL 快照 + 链式求值结果。调用方必须对 uri 有 manage 权限（§12.4）。
   *
   * `subject` 只用于日志：授权判定用 `principals`，不把管理员的身份拼进主体集合。
   * **不加锁**：只读；`.acl.json` 走临时文件 + `rename` 原子替换。
   */
  async getAcl(
    uri: Uri,
    subject: string,
    principals: readonly string[],
  ): Promise<AclSnapshot> {
    await this.#assertManage(uri, principals);
    assertDirectory(this.#nodes, uri);

    const snapshot = await readSnapshot(this.#ports(), uri);

    this.#logger.debug('读取 ACL 快照', {
      uri: uri.toString(),
      subject,
      principals: snapshot.effective.size,
    });
    return { uri, ...snapshot };
  }

  /**
   * 写 ACL 并物化整棵子树。顺序见文件头：先写 `.acl.json`（真相），再在一个
   * 事务里重算物化表与反查表。`exact(uri)` 覆盖整个读写。
   */
  async setAcl(
    uri: Uri,
    input: AclInput,
    subject: string,
    principals: readonly string[],
  ): Promise<void> {
    await this.#assertManage(uri, principals);
    assertDirectory(this.#nodes, uri);

    await this.#locks.withLock(
      uri,
      'exact',
      async () => {
        // 转换函数必须在锁内基于**最新**读到的快照求值：锁外的 `getAcl` + 整份
        // `setAcl` 正是本次要修的丢更新——两个并发 grant 各拿一份旧条目，后写者
        // 整份覆盖，先写者的条目静默消失。整份快照输入则直接沿用调用方给的值。
        const acl = typeof input === 'function' ? input(await this.#readState(uri)) : input;
        const file = toFile(acl);
        const permissions = await writeAcl(this.#ports(), uri, file);

        this.#logger.info('ACL 已更新', {
          uri: uri.toString(),
          subject,
          mode: file.mode,
          entries: file.entries.length,
          permissions,
        });
      },
      { createParentDirectory: true },
    );
  }

  /** 读出目录当前的领域形态（转换函数的输入）。 */
  async #readState(uri: Uri): Promise<AclState> {
    return readState(this.#aclFile, uri);
  }

  /** 新建根时写预置（§12.6）。实现见 `./acl/preset.ts`。 */
  async ensureRootPreset(uri: Uri, ownerUserId: string | null = null): Promise<RootPreset> {
    return writeRootPreset(this.#ports(), uri, ownerUserId, this.#groupDefaultLevel);
  }

  /** 改组 owner 的根预置。实现见 `./acl/preset.ts`。 */
  async setGroupOwner(
    uri: Uri,
    previousOwnerId: string | null,
    nextOwnerId: string,
  ): Promise<void> {
    await applyGroupOwner(
      this.#ports(),
      uri,
      previousOwnerId,
      nextOwnerId,
      this.#groupDefaultLevel,
    );
  }

  /** 清空某个 URI 子树内的全部直接授权条目（删组用）。实现见 `./acl/purge.ts`。 */
  async purgeSubtree(root: Uri): Promise<number> {
    return purgeAclSubtree(this.#ports(), root);
  }

  /** 从所有 `.acl.json` 里移除某个主体。实现见 `./acl/revoke.ts`。 */
  async purgePrincipal(principal: string): Promise<number> {
    return purgeAclPrincipal(this.#ports(), principal);
  }

  /** 按磁盘上的 `.acl.json` 重建某节点的反查表。实现见 `./acl/write.ts`。 */
  async syncEntriesFromFile(uri: Uri): Promise<boolean> {
    return syncEntries(this.#ports(), uri);
  }

  /** 主体展开：`user:alice` + 所属组 → 查询用的 principals 数组。 */
  resolvePrincipals(subject: string, groups: readonly string[]): readonly string[] {
    return expandPrincipals(subject, groups);
  }

  /** 单个节点的增量物化。实现见 `./acl/materialize.ts`。 */
  async materializeNode(uri: Uri): Promise<void> {
    await materializeOneNode(this.#ports(), uri);
  }

  /** 目标（可能不存在）沿祖先链的权限。实现见 `./acl/guard.ts`。 */
  async hasAncestorPermission(uri: Uri, action: AclAction, principals: readonly string[]): Promise<boolean> {
    return ancestorPermission(this.#ports(), uri, action, principals);
  }

  // ── 内部 ──

  /** 各模块显式接收的端口；状态留在类里，不变成 public 字段。 */
  #ports(): AclPorts {
    return {
      db: this.#db,
      aclFile: this.#aclFile,
      permissions: this.#permissions,
      nodes: this.#nodes,
      logger: this.#logger,
      locks: this.#locks,
    };
  }

  /** 单节点求权：物化表里的级别 → `levelSatisfies` 位测试。查询与 deny 谓词在 `PermissionRepository`。 */
  async #checkPrincipals(
    uri: Uri,
    action: AclAction,
    principals: readonly string[],
  ): Promise<boolean> {
    const level = this.#permissions.maxLevel(uri.toString(), principals);
    return level !== null && levelSatisfies(level, action);
  }

  /**
   * 管理面授权：调用方在 uri 上必须有 manage（§12.4）。
   *
   * 用调用方自己的 `principals` 求权，而不是把被操作节点的 owner 当身份。
   */
  async #assertManage(uri: Uri, principals: readonly string[]): Promise<void> {
    if (!(await this.#checkPrincipals(uri, MANAGE_LEVEL, principals))) {
      throw permissionDenied(uri, MANAGE_LEVEL);
    }
  }
}
