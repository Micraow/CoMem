/**
 * ACL 服务（架构文档 §8.2、§12）。
 *
 * 这一层是「授权管理与鉴权入口」：`FileSystemService` / `SearchService` 通过
 * `Authorizer` 端口调它，控制台的 ACL 页通过管理面调它。求值规则全部在
 * `domain/acl.ts`，这里只负责三件事：把 URI 链从磁盘读出来、把结果物化进
 * `node_permission`、把查询折成一条 SQL。
 *
 * ## 链式求值，物化表是缓存
 *
 * `effective(N)` 递归到 parent，**不预存继承快照**（§12.3）——存了必然在祖先变更
 * 后过期。`setAcl` 时把整棵子树重算一遍写进 `node_permission`，之后
 * `check` / `filterReadable` 只查表（§8.2 的代价转移：ACL 改动低频，读高频）。
 *
 * ## 写文件的顺序
 *
 * `setAcl` 先写 `.acl.json`（真相），再在一个事务里重算 `node_permission` 与
 * `acl_entry`（缓存）。两个原因：
 *
 * 1. 架构文档 §7 的通用规则是「先写内容再更新索引；索引失败时标记为待重建」。
 *    索引是派生数据，永远可以从文件重建；反过来不成立。
 * 2. 失败方向。文件写失败时事务根本不会开始，缓存保持旧值，不会出现「缓存宣称
 *    一个磁盘上没有的授权」。
 *
 * **崩溃窗口**：文件 `rename` 成功之后、`COMMIT` 之前进程挂掉，磁盘上是新 ACL，
 * 物化表是旧 ACL。下次启动的重建/对账以 `.acl.json` 为真相重算整棵子树即可修复
 * （§6.5「删库可重建」）。窗口内 `check` 可能按旧权限放行或拦截，这是文件与
 * SQLite 之间没有跨介质事务的必然代价。
 *
 * ## 为什么事务不调用 `withWriteTransaction`
 *
 * 那是 `adapters/sqlite/database.ts` 的**值**导出，而 `services/` 只允许
 * `import type` 引用适配层（§4.2）。这里用最小结构端口 `AclDatabase` 自己开
 * `BEGIN IMMEDIATE`，`PermissionRepository` 的两个写入方法检测到外层已有事务会
 * 直接复用，所以两步仍是一个事务。
 */

import type { AclFile, AclFileEntry, AclFileStore } from '../adapters/fs/acl-file.js';
import type { NodeRepository, NodeRow } from '../adapters/sqlite/node-repository.js';
import type {
  AclEntryRow,
  PermissionRepository,
  PermissionRow,
} from '../adapters/sqlite/permission-repository.js';
import { effectiveAcl, levelSatisfies, parsePrincipal, rootPreset } from '../domain/acl.js';
import type { AclEntry, AclLevel, AclMode, AclNode } from '../domain/acl.js';
import { ComemError } from '../domain/errors.js';
import type { Logger } from '../domain/log.js';
import type { NodeKind } from '../domain/node.js';
import { Uri } from '../domain/uri.js';

import { permissionDenied, type AclAction, type Authorizer } from './authorizer.js';

/** §12.1：read = 1、write = 3、manage = 7，高位包含低位。 */
const READ_LEVEL: AclLevel = 1;
const MANAGE_LEVEL: AclLevel = 7;

/** §12.6：组根预置的默认级别是 write；§18 的 `acl.groupDefaultLevel` 可降为 read。 */
const DEFAULT_GROUP_LEVEL: AclLevel = 3;

/** §12.1：唯一的通配主体。`group:*` 不支持（`parsePrincipal` 拒绝）。 */
const USER_WILDCARD = 'user:*';

/**
 * `services/` 不能 import `node:sqlite`（§4.2，连类型导入都算依赖）。
 *
 * 这里只声明 `check` 需要的最小形状：`node_permission` 的级别查询要按
 * `action` 过滤，而 `PermissionRepository.readableUris` 固定 `level >= 1`
 * （只服务 read 过滤）。`DatabaseSync` 结构上可赋值。
 */
export interface AclDatabase {
  readonly isTransaction: boolean;
  exec(sql: string): void;
  prepare(sql: string): {
    get(...params: unknown[]): Record<string, unknown> | undefined;
  };
}

export interface AclSnapshot {
  readonly uri: Uri;
  readonly mode: AclMode;
  readonly entries: readonly AclEntry[];
  /** 求值后的有效权限，按 principal 分组。控制台的「权限推导」面板要显示它 */
  readonly effective: ReadonlyMap<string, ReadonlySet<AclLevel>>;
}

export interface AclServiceOptions {
  readonly dataDir: string;
  readonly db: AclDatabase;
  readonly aclFile: AclFileStore;
  readonly permissions: PermissionRepository;
  readonly nodes: NodeRepository;
  readonly logger: Logger;
  /** §18 的 acl.groupDefaultLevel，默认 'write' */
  readonly groupDefaultLevel?: AclLevel;
  /**
   * 当前请求的身份。`Authorizer` 的三个方法没有 subject 参数（§12.4），所以身份
   * 在装配期绑定——每请求一个实例，请求结束丢弃。管理面的方法额外收显式
   * `subject`，用于「控制台以管理员身份改别人的 ACL」。
   */
  readonly subject: string;
  /** 当前请求身份所属的组，形如 `group:eng`。 */
  readonly groups?: readonly string[];
}

function isAclLevel(value: unknown): value is AclLevel {
  return value === 1 || value === 3 || value === 7;
}

/** 磁盘级别名 → 领域级别。映射只在这一个方向发生（写 `.acl.json` 时）。 */
function levelName(level: AclLevel): AclFileEntry['level'] {
  switch (level) {
    case 1:
      return 'read';
    case 3:
      return 'write';
    case 7:
      return 'manage';
    default:
      // 类型上不可达。运行时脏数据在写盘之前挡掉——写进 `undefined` 会被
      // `JSON.stringify` 静默删键，读回来时那一条授权就消失了。
      throw new ComemError('INVALID_ARGUMENT', `ACL 级别不合法：${String(level)}`, { level });
  }
}

/** 领域级别 → 磁盘级别名。映射只在读 `.acl.json` 时发生。 */
function levelByName(name: AclFileEntry['level']): AclLevel {
  switch (name) {
    case 'read':
      return 1;
    case 'write':
      return 3;
    case 'manage':
      return 7;
  }
}

function fromAclFileEntry(entry: AclFileEntry): AclEntry {
  return { principal: entry.principal, level: levelByName(entry.level), effect: entry.effect };
}

/**
 * 节点的所有者。
 *
 * user 空间的所有者是根标识对应的用户（§12.6 的根预置就是它），**恒 manage**。
 * group 空间没有单个所有者：组员拿到的是根预置的 write，如果把 `group:{gid}`
 * 当成每个节点的 owner，write 预设就永远收不回去（§12.6「写死会让组空间无法
 * 降级成只读」）。空串不是合法主体（`parsePrincipal` 要求 `user:` / `group:`），
 * 不会和任何 subject 相等。
 */
function ownerOf(uri: Uri): string {
  return uri.scope === 'user' ? `user:${uri.rootId}` : '';
}

/** 链上出现过的全部主体：owner + 每条授权（allow 与 deny 都算）。 */
function collectPrincipals(chain: readonly AclNode[]): readonly string[] {
  const principals = new Set<string>();
  for (const node of chain) {
    if (node.owner !== '') {
      principals.add(node.owner);
    }
    for (const entry of node.entries) {
      principals.add(entry.principal);
    }
  }
  return [...principals];
}

/**
 * 有效集合的「代表级别」。
 *
 * 高位包含低位（§12.1：7 & 3 === 3），所以 `{1, 3}` 与 `{3}` 对 `check` 等价；
 * 物化表每行只存一个级别时取最大值。
 */
function maxLevel(levels: ReadonlySet<AclLevel>): AclLevel {
  let max: AclLevel = READ_LEVEL;
  for (const level of levels) {
    if (level > max) {
      max = level;
    }
  }
  return max;
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

export class AclService implements Authorizer {
  readonly #db: AclDatabase;
  readonly #aclFile: AclFileStore;
  readonly #permissions: PermissionRepository;
  readonly #nodes: NodeRepository;
  readonly #logger: Logger;
  readonly #groupDefaultLevel: AclLevel;
  readonly #subject: string;
  readonly #groups: readonly string[];
  readonly #principals: readonly string[];

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
    this.#groupDefaultLevel = options.groupDefaultLevel ?? DEFAULT_GROUP_LEVEL;
    this.#subject = options.subject;
    this.#groups = [...(options.groups ?? [])];
    this.#principals = this.resolvePrincipals(this.#subject, this.#groups);
  }

  // ── Authorizer ──

  async check(uri: Uri, action: AclAction): Promise<boolean> {
    return this.#checkPrincipals(uri, action, this.#principals);
  }

  /**
   * 批量求权：一次 `IN (...)` 查询，不按 URI 逐条查。
   *
   * 查询本身固定 `level >= read`（`readableUris` 的语义），所以这个方法是「过滤
   * 出可读的」，不是「按任意动作过滤」——`Authorizer` 只要求 read。
   */
  async filterReadable(uris: readonly Uri[]): Promise<ReadonlySet<string>> {
    if (uris.length === 0) {
      return new Set<string>();
    }
    return this.#permissions.readableUris(
      uris.map((uri) => uri.toString()),
      this.#principals,
    );
  }

  async assert(uri: Uri, action: AclAction): Promise<void> {
    if (!(await this.check(uri, action))) {
      throw permissionDenied(uri, action);
    }
  }

  // ── 管理面（只走 HTTP，不进 MCP，§12.2 第 3 条）──

  /** 读 ACL 快照 + 链式求值结果。调用方必须对 uri 有 manage 权限（§12.4）。 */
  async getAcl(uri: Uri, subject: string): Promise<AclSnapshot> {
    await this.#assertManage(uri, subject);
    this.#assertDirectory(uri);

    const file = await this.#aclFile.read(uri);
    const chain = await this.#readChain(uri, 'directory', new Map<string, AclFile | null>());

    const effective = new Map<string, ReadonlySet<AclLevel>>();
    for (const principal of collectPrincipals(chain)) {
      const levels = effectiveAcl(chain, principal);
      // 空集不放进 map：「有效权限」表里出现一行空值只会让人以为它是一条授权。
      if (levels.size > 0) {
        effective.set(principal, levels);
      }
    }

    this.#logger.debug('读取 ACL 快照', {
      uri: uri.toString(),
      subject,
      principals: effective.size,
    });
    return {
      uri,
      mode: file?.mode ?? 'inherit',
      entries: file?.entries.map(fromAclFileEntry) ?? [],
      effective,
    };
  }

  /**
   * 写 ACL 并物化整棵子树。
   *
   * 顺序见文件头：先写 `.acl.json`（真相），再在一个事务里重算物化表与反查表。
   * 写文件失败时不会进入事务，`node_permission` 保持原样。
   */
  async setAcl(
    uri: Uri,
    acl: { readonly mode: AclMode; readonly entries: readonly AclEntry[] },
    subject: string,
  ): Promise<void> {
    await this.#assertManage(uri, subject);
    this.#assertDirectory(uri);

    if (acl.mode !== 'inherit' && acl.mode !== 'restricted') {
      throw new ComemError('INVALID_ARGUMENT', `ACL 模式不合法：${String(acl.mode)}`, {
        mode: acl.mode,
      });
    }
    const entries: AclFileEntry[] = acl.entries.map((entry) => {
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
    const file: AclFile = { mode: acl.mode, entries };

    // 求值只读文件，先算完再落盘：这样文件写失败时没有任何物化副作用。
    const permissions = await this.#materialize(uri, file);
    const entryRows = toEntryRows(uri, entries);

    await this.#aclFile.write(uri, file);

    this.#runInTransaction(() => {
      this.#permissions.replaceSubtree(uri.toString(), permissions);
      this.#permissions.replaceEntries(uri.toString(), entryRows);
    });

    this.#logger.info('ACL 已更新', {
      uri: uri.toString(),
      subject,
      mode: file.mode,
      entries: file.entries.length,
      permissions: permissions.length,
    });
  }

  /**
   * 新建根时写预置（§12.6）。
   *
   * user 根 → `user:{uid} = manage`；group 根 → `group:{gid} = write`（可由
   * `groupDefaultLevel` 降为 read）。幂等：已有 `.acl.json` 就不覆盖，否则每次
   * 启动都会把管理员改过的根权限冲掉。
   */
  async ensureRootPreset(uri: Uri): Promise<void> {
    if (!uri.isRoot) {
      throw new ComemError(
        'INVALID_ARGUMENT',
        `根预置只能写在根 URI 上：${uri.toString()}`,
        { uri: uri.toString() },
      );
    }
    if (await this.#aclFile.exists(uri)) {
      this.#logger.debug('根预置已存在，跳过', { uri: uri.toString() });
      return;
    }

    const entries: AclFileEntry[] = rootPreset(uri).map((entry) => ({
      principal: entry.principal,
      // 组根的预置级别来自配置（§18）；user 根恒 manage，不读配置。
      level: levelName(uri.scope === 'group' ? this.#groupDefaultLevel : entry.level),
      effect: entry.effect,
    }));
    const file: AclFile = { mode: 'inherit', entries };

    const permissions = await this.#materialize(uri, file);
    const entryRows = toEntryRows(uri, entries);

    await this.#aclFile.write(uri, file);

    this.#runInTransaction(() => {
      this.#permissions.replaceSubtree(uri.toString(), permissions);
      this.#permissions.replaceEntries(uri.toString(), entryRows);
    });

    this.#logger.info('根预置已写入', {
      uri: uri.toString(),
      scope: uri.scope,
      level: entries[0]?.level ?? 'read',
      permissions: permissions.length,
    });
  }

  /**
   * 主体展开：`user:alice` + 所属组 → 查询用的 principals 数组。
   *
   * 退组立即生效（§12.5）靠的就是「每次重新展开」：ACL 里存的是
   * `group:{gid}` 这个字符串，不展开成成员列表，所以成员变化不需要回写任何
   * 授权。`user:*` 只对 user 主体生效（§12.1），单独追加在末尾。
   */
  resolvePrincipals(subject: string, groups: readonly string[]): readonly string[] {
    const parsed = parsePrincipal(subject);
    if (parsed.kind !== 'user') {
      throw new ComemError(
        'INVALID_ARGUMENT',
        `调用方身份必须是 user 主体：${subject}`,
        { subject },
      );
    }

    const principals: string[] = [subject];
    for (const group of groups) {
      const parsedGroup = parsePrincipal(group);
      if (parsedGroup.kind !== 'group') {
        throw new ComemError('INVALID_ARGUMENT', `组必须是 group 主体：${group}`, { group });
      }
      principals.push(group);
    }
    principals.push(USER_WILDCARD);

    // 去重但保留顺序（subject 在最前）：同一组重复传入不应产生重复的 IN 参数。
    return [...new Set(principals)];
  }

  // ── 内部 ──

  async #checkPrincipals(
    uri: Uri,
    action: AclAction,
    principals: readonly string[],
  ): Promise<boolean> {
    const level = this.#maxLevel(uri.toString(), principals);
    return level !== null && levelSatisfies(level, action);
  }

  /**
   * 物化表里该主体集合拿到的最高级别。
   *
   * 直接查 `node_permission` 而不是 `readableUris`：后者固定 `level >= 1`，
   * 回答不了 `write` / `manage` 的检查。
   */
  #maxLevel(uri: string, principals: readonly string[]): AclLevel | null {
    if (principals.length === 0) {
      return null;
    }
    const sql = `SELECT MAX(level) AS level FROM node_permission
      WHERE node_uri = ? AND principal IN (${principals.map(() => '?').join(', ')})`;
    const row = this.#db.prepare(sql).get(uri, ...principals);
    const value = row?.['level'];
    return typeof value === 'number' ? (value as AclLevel) : null;
  }

  /**
   * 管理面授权：调用方在 uri 上必须有 manage（§12.4）。
   *
   * 用显式 `subject` 而不是实例绑定的身份：控制台可能以管理员身份操作别人的
   * 节点。组身份只在「操作者就是当前请求身份」时可用——管理面的签名里没有
   * groups，跨身份调用拿不到组。
   */
  async #assertManage(uri: Uri, subject: string): Promise<void> {
    const groups = subject === this.#subject ? this.#groups : [];
    const principals = this.resolvePrincipals(subject, groups);
    if (!(await this.#checkPrincipals(uri, MANAGE_LEVEL, principals))) {
      throw permissionDenied(uri, MANAGE_LEVEL);
    }
  }

  /** ACL 只能设在目录上；文件没有自己的 `.acl.json`（§6.7）。 */
  #assertDirectory(uri: Uri): void {
    const node: NodeRow | null = this.#nodes.get(uri.toString());
    if (node?.kind === 'document') {
      throw new ComemError(
        'INVALID_ARGUMENT',
        `ACL 只能设在目录上：${uri.toString()}`,
        { uri: uri.toString() },
      );
    }
  }

  /**
   * 重算 `uri` 整棵子树的物化权限。
   *
   * 子树来自 `nodes.descendants`（SQL 前缀匹配），**不递归 open 目录**：§8.2 的
   * 硬伤就是「一条候选 open 5 层目录」。这里的文件读取只发生在链上，且按目录
   * 缓存——`tree` 里 1000 个兄弟节点共享同一条祖先链。
   *
   * 文档（`kind === 'document'`）不读自己的 `.acl.json`：文件没有 ACL 文件，
   * 它的有效权限就是所在目录的。owner 按 URI 根推导，文档与目录同属一个根，
   * 所以省略文档节点不改变结果。
   */
  async #materialize(uri: Uri, file: AclFile): Promise<readonly PermissionRow[]> {
    const cache = new Map<string, AclFile | null>();
    cache.set(uri.toString(), file);

    const target = this.#nodes.get(uri.toString());
    const nodes: readonly { readonly uri: Uri; readonly kind: NodeKind }[] = [
      { uri, kind: target?.kind ?? 'directory' },
      ...this.#nodes
        .descendants(uri.toString())
        .map((row) => ({ uri: Uri.parse(row.uri), kind: row.kind })),
    ];

    const permissions: PermissionRow[] = [];
    for (const node of nodes) {
      const chain = await this.#readChain(node.uri, node.kind, cache);
      for (const principal of collectPrincipals(chain)) {
        const levels = effectiveAcl(chain, principal);
        if (levels.size === 0) {
          continue;
        }
        permissions.push({
          nodeUri: node.uri.toString(),
          principal,
          level: maxLevel(levels),
        });
      }
    }
    return permissions;
  }

  /** 根 → 目标目录的链。文档节点不把自己算进去（见 `#materialize`）。 */
  async #readChain(
    uri: Uri,
    kind: NodeKind,
    cache: Map<string, AclFile | null>,
  ): Promise<readonly AclNode[]> {
    const directories: Uri[] = [];
    let current: Uri | null = kind === 'document' ? uri.parent() : uri;
    while (current !== null) {
      directories.push(current);
      current = current.parent();
    }
    directories.reverse();

    const chain: AclNode[] = [];
    for (const directory of directories) {
      const file = await this.#readAcl(directory, cache);
      chain.push({
        uri: directory,
        owner: ownerOf(directory),
        mode: file?.mode ?? 'inherit',
        entries: file?.entries.map(fromAclFileEntry) ?? [],
      });
    }
    return chain;
  }

  /** 按目录缓存 `.acl.json` 读取；没有文件等价于 `{mode:'inherit', entries:[]}`。 */
  async #readAcl(directory: Uri, cache: Map<string, AclFile | null>): Promise<AclFile | null> {
    const key = directory.toString();
    if (cache.has(key)) {
      return cache.get(key) ?? null;
    }
    const file = await this.#aclFile.read(directory);
    cache.set(key, file);
    return file;
  }

  /**
   * `BEGIN IMMEDIATE` 包住 `PermissionRepository` 的两个写入。
   *
   * 不用 `withWriteTransaction` 的原因见文件头（services 禁止值导入适配层）。
   * 两个写入方法内部各自调 `withWriteTransaction`，检测到外层事务会直接复用，
   * 所以不会嵌套 `BEGIN`。
   */
  #runInTransaction(fn: () => void): void {
    if (this.#db.isTransaction) {
      fn();
      return;
    }
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      fn();
      this.#db.exec('COMMIT');
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }
}
