/**
 * ACL 服务的共享类型：数据库端口、写回记录、对外快照与入参。
 *
 * 这里只有类型，没有运行时代码：`AclPorts` 是各模块显式接收的端口集合，
 * `AclService` 持有实例并把它们作为参数传下去（不把内部状态变成 public 字段）。
 */

import type { AclFile, AclFileStore } from '../../adapters/fs/acl-file.js';
import type { PathLockManager } from '../../adapters/fs/lock.js';
import type { NodeRepository } from '../../adapters/sqlite/node-repository.js';
import type { PermissionRepository } from '../../adapters/sqlite/permission-repository.js';
import type { AclEntry, AclLevel, AclMode } from '../../domain/acl.js';
import type { Logger } from '../../domain/log.js';
import type { Uri } from '../../domain/uri.js';

/** 各模块显式接收的端口集合。`AclService` 从自己的私有字段组装它。 */
export interface AclPorts {
  readonly db: AclDatabase;
  readonly aclFile: AclFileStore;
  readonly permissions: PermissionRepository;
  readonly nodes: NodeRepository;
  readonly logger: Logger;
  readonly locks: PathLockManager;
}

/**
 * `services/` 不能 import `node:sqlite`（§4.2，连类型导入都算依赖）。
 *
 * 这里只声明用到的形状：`purgePrincipal` 按主体删两张表的行，仓储没有这个方法，
 * 只能写在这里。`DatabaseSync` 结构上可赋值。
 */
export interface AclDatabase {
  readonly isTransaction: boolean;
  exec(sql: string): void;
  prepare(sql: string): {
    run(...params: unknown[]): { readonly changes: number | bigint };
  };
}

/**
 * `purgePrincipal` 要写回的一个 `.acl.json`。
 *
 * `previous` 是写盘之前的内容，只用于回滚：数据库删除失败时把它写回去，
 * 否则磁盘上撤了权、数据库里还留着旧行，下一个请求会按旧行放行。
 */
export interface PurgeRewrite {
  readonly uri: Uri;
  readonly previous: AclFile;
  readonly next: AclFile;
}

export interface AclSnapshot {
  readonly uri: Uri;
  readonly mode: AclMode;
  readonly entries: readonly AclEntry[];
  /** 求值后的有效权限，按 principal 分组。控制台的「权限推导」面板要显示它 */
  readonly effective: ReadonlyMap<string, ReadonlySet<AclLevel>>;
}

/** 一份 ACL 的领域形态（`setAcl` 的输入与转换函数的参数）。 */
export interface AclState {
  readonly mode: AclMode;
  readonly entries: readonly AclEntry[];
}

/**
 * `setAcl` 的输入：完整快照，或在锁内基于最新快照计算的转换函数。
 *
 * 两种形态对应两种语义，不能混为一谈：
 *
 * - **完整快照**是「整份替换」（`PUT /acl` 的编辑器语义）。两个并发调用是后写者
 *   赢——但那是调用方选择要覆盖，不是丢更新。锁只能保证两次写入不交错。
 * - **转换函数**是「在现有条目上加/减一条」（`/acl/grant`、`/acl/revoke`）。读发生
 *   在 `exact(uri)` 锁内，两个并发 grant 各自看到对方写入的结果；锁外的
 *   `getAcl` + `setAcl` 会让后写者拿一份旧快照整份覆盖，先写者的条目静默消失。
 */
export type AclInput = AclState | ((current: AclState) => AclState);

export interface AclServiceOptions {
  readonly db: AclDatabase;
  readonly aclFile: AclFileStore;
  readonly permissions: PermissionRepository;
  readonly nodes: NodeRepository;
  readonly logger: Logger;
  /** 路径锁（§10.6）。ACL 写入是读-改-写，锁必须覆盖读写两步，见文件头。 */
  readonly locks: PathLockManager;
  /** §18 的 acl.groupDefaultLevel，默认 'write' */
  readonly groupDefaultLevel?: AclLevel;
}
