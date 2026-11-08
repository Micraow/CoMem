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
 * ## deny 也要物化
 *
 * `node_permission` 带 `effect` 列。被 deny 清空的主体没有 allow 行，但必须有一条
 * deny 行：否则查询主体集合里的 `user:*` 通配会把该主体放进来，跨用户越权。
 * 只对**具体主体**写 deny 行——`user:*` 自己不是「被拒绝的人」，给它写 deny 会
 * 把所有人都挡掉。
 *
 * 判定规则：主体的有效权限为空、且链上有命中它的 deny 条目时写 deny 行。
 * 「链上有 allow」本身不够——`restricted` 切断继承同样产生空集，那不是拒绝，
 * 给被切断的主体写 deny 会顺带压掉同一请求里其它主体的合法 allow。
 *
 * 物化行由 `materializePermissions` 这个私有纯函数产出。这段逻辑更适合放
 * `domain/acl.ts`（与 `effectiveAcl` 同源），但本 wave 不改 domain，先留在服务层。
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
import {
  assertOwnerUserId,
  effectiveAcl,
  groupPrincipal,
  levelSatisfies,
  parsePrincipal,
  rootPreset,
  userPrincipal,
} from '../domain/acl.js';
import type { AclEntry, AclLevel, AclMode, AclNode, RootPreset } from '../domain/acl.js';
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
 * `services/` 不能 import `node:sqlite`（§4.2，连类型导入都算依赖）。
 *
 * 这里只声明用到的形状：`node_permission` 的级别查询要按 `action` 过滤，而
 * `PermissionRepository.readableUris` 固定 `level >= 1`（只服务 read 过滤）；
 * `purgePrincipal` 按主体删两张表的行，仓储没有这个方法，只能写在这里。
 * `DatabaseSync` 结构上可赋值。
 */
export interface AclDatabase {
  readonly isTransaction: boolean;
  exec(sql: string): void;
  prepare(sql: string): {
    get(...params: unknown[]): Record<string, unknown> | undefined;
    run(...params: unknown[]): { readonly changes: number | bigint };
  };
}

/**
 * `purgePrincipal` 要写回的一个 `.acl.json`。
 *
 * `previous` 是写盘之前的内容，只用于回滚：数据库删除失败时把它写回去，
 * 否则磁盘上撤了权、数据库里还留着旧行，下一个请求会按旧行放行。
 */
interface PurgeRewrite {
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

export interface AclServiceOptions {
  readonly dataDir: string;
  readonly db: AclDatabase;
  readonly aclFile: AclFileStore;
  readonly permissions: PermissionRepository;
  readonly nodes: NodeRepository;
  readonly logger: Logger;
  /** §18 的 acl.groupDefaultLevel，默认 'write' */
  readonly groupDefaultLevel?: AclLevel;
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

/**
 * 条目是否命中主体：精确相等，或 `user:*` 命中所有 user 主体（§12.1）。
 *
 * 与 `domain/acl.ts` 的 `entryMatches` 同一规则。domain 没有导出它，而本 wave
 * 不改 domain，所以服务层重复这三行——规则本身只有「精确匹配 + 唯一通配符」。
 */
function entryMatches(entryPrincipal: string, subject: string): boolean {
  if (entryPrincipal === subject) {
    return true;
  }
  return entryPrincipal === USER_WILDCARD && subject.startsWith('user:');
}

/** 链上是否有命中主体的 deny 条目。命中即该主体在目标节点上被拒绝（§12.2）。 */
function hasDenyEntry(chain: readonly AclNode[], subject: string): boolean {
  return chain.some((node) =>
    node.entries.some(
      (entry) => entry.effect === 'deny' && entryMatches(entry.principal, subject),
    ),
  );
}

/**
 * 单个节点的物化行：每个主体的有效权限 → `node_permission` 的一行。
 *
 * 输入是链与主体集合，输出只依赖纯函数 `effectiveAcl`，没有 IO。
 *
 * - 有效集合非空 → allow 行，级别取集合最大值（高位包含低位，见 `maxLevel`）。
 * - 有效集合为空且链上有命中该主体的 deny → deny 行。deny 行的 `level` 不参与
 *   判定（读侧只看 `effect`），存最小合法级别 `READ_LEVEL` 避免暗示「拒绝到某一级」。
 * - `user:*` 不写 deny 行：它是通配符，不是「被拒绝的人」。给它写 deny 会把所有
 *   user 主体一起挡掉，包括 owner。
 *
 * 这段逻辑更适合 `domain/acl.ts`（与 `effectiveAcl` 同源），本 wave 不改 domain。
 */
function materializePermissions(
  uri: Uri,
  chain: readonly AclNode[],
  principals: readonly string[],
): readonly PermissionRow[] {
  const rows: PermissionRow[] = [];
  for (const principal of principals) {
    const levels = effectiveAcl(chain, principal);
    if (levels.size > 0) {
      rows.push({
        nodeUri: uri.toString(),
        principal,
        level: maxLevel(levels),
        effect: 'allow',
      });
      continue;
    }
    if (principal === USER_WILDCARD || !hasDenyEntry(chain, principal)) {
      continue;
    }
    rows.push({
      nodeUri: uri.toString(),
      principal,
      level: READ_LEVEL,
      effect: 'deny',
    });
  }
  return rows;
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
  }

  // ── Authorizer ──

  async check(
    uri: Uri,
    action: AclAction,
    principals: readonly string[],
  ): Promise<boolean> {
    return this.#checkPrincipals(uri, action, principals);
  }

  /**
   * 批量求权：一次 `IN (...)` 查询，不按 URI 逐条查。
   *
   * 查询本身固定 `level >= read`（`readableUris` 的语义），所以这个方法是「过滤
   * 出可读的」，不是「按任意动作过滤」——`Authorizer` 只要求 read。
   */
  async filterReadable(
    uris: readonly Uri[],
    principals: readonly string[],
  ): Promise<ReadonlySet<string>> {
    if (uris.length === 0) {
      return new Set<string>();
    }
    return this.#permissions.readableUris(
      uris.map((uri) => uri.toString()),
      principals,
    );
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
   * `subject` 只用于日志：授权判定用 `principals`。管理面可能以管理员身份操作
   * 别人的节点，所以这里不把 `subject` 拼进主体集合——那会让「管理员是谁」和
   * 「被操作的是谁的节点」混成一份身份。
   */
  async getAcl(
    uri: Uri,
    subject: string,
    principals: readonly string[],
  ): Promise<AclSnapshot> {
    await this.#assertManage(uri, principals);
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
    principals: readonly string[],
  ): Promise<void> {
    await this.#assertManage(uri, principals);
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

    const permissions = await this.#writeAcl(uri, file);

    this.#logger.info('ACL 已更新', {
      uri: uri.toString(),
      subject,
      mode: file.mode,
      entries: file.entries.length,
      permissions,
    });
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
   */
  async ensureRootPreset(uri: Uri, ownerUserId: string | null = null): Promise<RootPreset> {
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
      groupLevel: this.#groupDefaultLevel,
    });
    if (preset.ownerMissing) {
      this.#logger.warn('组根预置没有 owner，组空间暂时无人可管理', {
        uri: uri.toString(),
        hint: 'POST /api/v1/admin/groups/{id}/owner 可以指定 owner。',
      });
    }

    const existing = await this.#aclFile.read(uri);
    if (existing !== null && this.#hasRootPreset(uri, existing)) {
      this.#logger.debug('根预置已存在，跳过', { uri: uri.toString() });
      return preset;
    }

    const file: AclFile = {
      mode: 'inherit',
      entries: preset.entries.map((entry) => ({
        principal: entry.principal,
        level: levelName(entry.level),
        effect: entry.effect,
      })),
    };
    const permissions = await this.#writeAcl(uri, file);

    this.#logger.info('根预置已写入', {
      uri: uri.toString(),
      scope: uri.scope,
      ownerMissing: preset.ownerMissing,
      entries: file.entries.length,
      permissions,
    });
    return preset;
  }

  /** 根预置是否已经应用。见 `ensureRootPreset` 的注释。 */
  #hasRootPreset(uri: Uri, file: AclFile): boolean {
    if (uri.scope === 'user') {
      return true;
    }
    const group = groupPrincipal(uri.rootId);
    return file.entries.some((entry) => entry.principal === group && entry.effect === 'allow');
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
   */
  async setGroupOwner(
    uri: Uri,
    previousOwnerId: string | null,
    nextOwnerId: string,
  ): Promise<void> {
    if (uri.scope !== 'group' || !uri.isRoot) {
      throw new ComemError(
        'INVALID_ARGUMENT',
        `组 owner 预置只能写在组根 URI 上：${uri.toString()}`,
        { uri: uri.toString() },
      );
    }
    assertOwnerUserId(nextOwnerId);

    const previous = await this.#aclFile.read(uri);
    const preset = rootPreset(uri, {
      ownerUserId: nextOwnerId,
      groupLevel: this.#groupDefaultLevel,
    });
    const previousOwnerPrincipal =
      previousOwnerId === null ? null : userPrincipal(previousOwnerId);
    const nextOwnerPrincipal = userPrincipal(nextOwnerId);

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

    await this.#writeAcl(uri, file);
    this.#logger.info('组 owner 预置已更新', {
      uri: uri.toString(),
      previousOwnerId,
      nextOwnerId,
    });
  }

  /**
   * 清空某个 URI 子树内的全部直接授权条目（删组用）。
   *
   * **为什么需要它。** `purgePrincipal` 只按主体清：删组时它移除 `group:{gid}`
   * 这个 principal 的条目，组子树里 `user:bob = write` 这样的**直接授权**不会被动。
   * 组被删、数据留在磁盘上，同 ID 重建后旧授权立刻生效——删组没有撤销共享范围。
   * 同 ID 复用是常规操作（测试环境重置、离职回归）。
   *
   * **语义：保留数据与 `mode`，清空条目。** 删组不是删数据（`DELETE
   * /admin/groups/{id}` 不删 `comem://group/{gid}/` 下的文件）。清空条目而不是
   * 重置 `mode`：`restricted` 是旧组管理员的决定，清空后它仍然收得最紧（没人可读）；
   * 重置成 `inherit` 反而可能让祖先的 `user:*` 放开数据。要连数据一起删，用文件
   * 系统显式删除目录，不在 HTTP 管理面。
   *
   * **物化表要重算，不能只删行。** 子树里的节点可能从**子树之外**的祖先继承权限
   * （`comem://group/` 上的条目），所以 `node_permission` 按清空后的文件重算整棵
   * 子树；`acl_entry` 的子树行直接删除（文件里已经没有条目）。
   *
   * 扫描上限沿用 `MAX_PURGE_SCAN_DIRECTORIES`，达到上限时记 warn 并继续——与
   * `purgePrincipal` 同一个判据：撤权失败会让组删不掉，失败方向更差。返回被改写的
   * `.acl.json` 文件数。空操作返回 0。
   */
  async purgeSubtree(root: Uri): Promise<number> {
    const prefix = root.toString();

    const scan = await this.#aclFile.scanDirectories({
      maxDirectories: MAX_PURGE_SCAN_DIRECTORIES,
    });
    if (scan.truncated) {
      this.#logger.warn('清空子树授权达到目录上限，上限之外的 .acl.json 未检查', {
        uri: prefix,
        limit: MAX_PURGE_SCAN_DIRECTORIES,
        scannedDirectories: scan.directoriesScanned,
        aclFiles: scan.uris.length,
      });
    }

    const rewrites: PurgeRewrite[] = [];
    for (const uri of scan.uris) {
      const value = uri.toString();
      if (value !== prefix && !value.startsWith(`${prefix}/`)) {
        continue;
      }
      const previous = await this.#aclFile.read(uri);
      if (previous === null || previous.entries.length === 0) {
        continue;
      }
      rewrites.push({ uri, previous, next: { mode: previous.mode, entries: [] } });
    }

    this.#db.exec('BEGIN IMMEDIATE');
    try {
      for (const rewrite of rewrites) {
        await this.#aclFile.write(rewrite.uri, rewrite.next);
      }
      const permissions = await this.#materializeSubtree(root);
      this.#runInTransaction(() => {
        this.#permissions.replaceSubtree(prefix, permissions);
        this.#permissions.deleteEntriesSubtree(prefix);
      });
      this.#db.exec('COMMIT');
    } catch (error) {
      this.#db.exec('ROLLBACK');
      await this.#restoreAclFiles(rewrites);
      throw error;
    }

    this.#logger.info('子树授权已清空', {
      uri: prefix,
      files: rewrites.length,
      entries: rewrites.reduce((total, rewrite) => total + rewrite.previous.entries.length, 0),
      scannedDirectories: scan.directoriesScanned,
      aclFiles: scan.uris.length,
      truncated: scan.truncated,
    });
    return rewrites.length;
  }

  /**
   * 从所有 `.acl.json` 里移除某个主体。
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
  async purgePrincipal(principal: string): Promise<number> {
    // 主体是调用方输入，进 SQL 之前按 §12.1 的形态校验。
    parsePrincipal(principal);

    const targets = new Map<string, Uri>();
    for (const row of this.#permissions.entriesByPrincipal(principal)) {
      targets.set(row.uri, Uri.parse(row.uri));
    }
    const scan = await this.#aclFile.scanDirectories({
      maxDirectories: MAX_PURGE_SCAN_DIRECTORIES,
    });
    for (const uri of scan.uris) {
      targets.set(uri.toString(), uri);
    }
    if (scan.truncated) {
      this.#logger.warn('撤权扫描达到目录上限，上限之外的 .acl.json 未检查', {
        principal,
        limit: MAX_PURGE_SCAN_DIRECTORIES,
        scannedDirectories: scan.directoriesScanned,
        aclFiles: scan.uris.length,
      });
    }

    // 按 URI 升序：回滚顺序与日志顺序可复现，不依赖 Map 的插入来源。
    const ordered = [...targets.values()].sort((left, right) => {
      const leftUri = left.toString();
      const rightUri = right.toString();
      return leftUri < rightUri ? -1 : leftUri > rightUri ? 1 : 0;
    });
    const rewrites: PurgeRewrite[] = [];
    for (const uri of ordered) {
      const previous = await this.#aclFile.read(uri);
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

    this.#db.exec('BEGIN IMMEDIATE');
    try {
      for (const rewrite of rewrites) {
        await this.#aclFile.write(rewrite.uri, rewrite.next);
      }
      this.#deletePrincipalRows(principal);
      this.#db.exec('COMMIT');
    } catch (error) {
      this.#db.exec('ROLLBACK');
      await this.#restoreAclFiles(rewrites);
      throw error;
    }

    this.#logger.info('主体授权已撤销', {
      principal,
      directories: rewrites.length,
      scannedDirectories: scan.directoriesScanned,
      aclFiles: scan.uris.length,
      truncated: scan.truncated,
    });
    return rewrites.length;
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
   */
  async syncEntriesFromFile(uri: Uri): Promise<boolean> {
    const file = await this.#aclFile.read(uri);
    if (file === null) {
      this.#logger.debug('节点没有 .acl.json，跳过反查表重建', { uri: uri.toString() });
      return false;
    }

    const entryRows = toEntryRows(uri, file.entries);
    this.#runInTransaction(() => {
      this.#permissions.replaceEntries(uri.toString(), entryRows);
    });
    this.#logger.debug('反查表已按文件重建', {
      uri: uri.toString(),
      entries: entryRows.length,
    });
    return true;
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
   *
   * deny 优先（§12.2 不变量 2）：主体集合里有人被 deny 时 allow 一律作废。这与
   * `PermissionRepository.readableUris` 是同一套谓词，只把「级别 >= read」换成
   * `MAX(level)`。
   */
  #maxLevel(uri: string, principals: readonly string[]): AclLevel | null {
    if (principals.length === 0) {
      return null;
    }
    const principalList = principals.map(() => '?').join(', ');
    const sql = `SELECT MAX(level) AS level FROM node_permission
      WHERE node_uri = ?
        AND principal IN (${principalList})
        AND effect = 'allow'
        AND NOT EXISTS (
          SELECT 1 FROM node_permission d
          WHERE d.node_uri = node_permission.node_uri
            AND d.principal IN (${principalList})
            AND d.effect = 'deny'
        )`;
    const row = this.#db.prepare(sql).get(uri, ...principals, ...principals);
    const value = row?.['level'];
    return typeof value === 'number' ? (value as AclLevel) : null;
  }

  /**
   * 管理面授权：调用方在 uri 上必须有 manage（§12.4）。
   *
   * 用调用方自己的 `principals` 求权，而不是把被操作节点的 owner 当身份。管理面
   * 可能以管理员身份操作别人的节点——授权判定回答的是「管理员能不能动这个节点」，
   * 不是「节点所有者能不能动自己」。
   */
  async #assertManage(uri: Uri, principals: readonly string[]): Promise<void> {
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
   * 写 `.acl.json`（真相）并重算整棵子树的 `node_permission` 与反查表。
   *
   * `setAcl` / `ensureRootPreset` / `setGroupOwner` 共用这一条顺序：先求值、再写
   * 文件、最后在事务里替换两张派生表。文件写失败时事务根本不会开始，物化表保持
   * 旧值（见文件头「写文件的顺序」）。
   */
  async #writeAcl(uri: Uri, file: AclFile): Promise<number> {
    // 求值只读文件，先算完再落盘：这样文件写失败时没有任何物化副作用。
    const permissions = await this.#materialize(uri, file);
    const entryRows = toEntryRows(uri, file.entries);

    await this.#aclFile.write(uri, file);

    this.#runInTransaction(() => {
      this.#permissions.replaceSubtree(uri.toString(), permissions);
      this.#permissions.replaceEntries(uri.toString(), entryRows);
    });
    return permissions.length;
  }

  /**
   * 重算 `uri` 整棵子树的物化权限（`setAcl` 用）。
   *
   * 子树来自 `nodes.descendants`（SQL 前缀匹配），**不递归 open 目录**：§8.2 的
   * 硬伤就是「一条候选 open 5 层目录」。这里的文件读取只发生在链上，且按目录
   * 缓存——`tree` 里 1000 个兄弟节点共享同一条祖先链。
   *
   * 文档（`kind === 'document'`）不读自己的 `.acl.json`：文件没有 ACL 文件，
   * 它的有效权限就是所在目录的。owner 按 URI 根推导，文档与目录同属一个根，
   * 所以省略文档节点不改变结果。
   *
   * `file` 是**还没写盘**的新内容，预置进缓存：求值必须用新 ACL，而文件写失败时
   * 事务根本不会开始。
   */
  async #materialize(uri: Uri, file: AclFile): Promise<readonly PermissionRow[]> {
    return this.#materializeChain(uri, new Map<string, AclFile | null>([[uri.toString(), file]]));
  }

  /**
   * 按磁盘上的 `.acl.json` 重算整棵子树的物化权限（`purgeSubtree` 用）。
   *
   * 与 `#materialize` 的唯一区别是不预置目标节点的文件：调用方已经写盘，按文件
   * 读到的就是新内容。
   */
  async #materializeSubtree(uri: Uri): Promise<readonly PermissionRow[]> {
    return this.#materializeChain(uri, new Map<string, AclFile | null>());
  }

  async #materializeChain(
    uri: Uri,
    cache: Map<string, AclFile | null>,
  ): Promise<readonly PermissionRow[]> {
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
      permissions.push(...materializePermissions(node.uri, chain, collectPrincipals(chain)));
    }
    return permissions;
  }

  /**
   * 单个节点的物化（增量入口）。
   *
   * 用于「新建节点时从父目录复制有效权限」：新节点还没有后代，只重算自己。
   * 链仍然是唯一真相——父目录的 `node_permission` 行是派生结果，直接复制它会在
   * 父行过期时把错误一起继承下来。
   *
   * 与 `setAcl` 的整棵子树重算共用 `materializePermissions`，保证两条路径的
   * 谓词一致。
   */
  async materializeNode(uri: Uri): Promise<void> {
    const kind = this.#nodes.get(uri.toString())?.kind ?? 'directory';
    const chain = await this.#readChain(uri, kind, new Map<string, AclFile | null>());
    const permissions = materializePermissions(uri, chain, collectPrincipals(chain));

    this.#runInTransaction(() => {
      this.#permissions.replaceNode(uri.toString(), permissions);
    });

    this.#logger.debug('节点权限物化', {
      uri: uri.toString(),
      permissions: permissions.length,
    });
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
   * 删掉主体的物化行与反查行（列名见迁移 0002 的两张表）。
   *
   * 两张表都要清：`node_permission` 是求权实际读的表，留着就等于授权还在；
   * `acl_entry` 是反查来源，留着会让控制台列出一个不存在的主体。
   */
  #deletePrincipalRows(principal: string): void {
    this.#db.prepare('DELETE FROM acl_entry WHERE principal = ?').run(principal);
    this.#db.prepare('DELETE FROM node_permission WHERE principal = ?').run(principal);
  }

  /**
   * 回滚已经写出去的 `.acl.json`（`purgePrincipal` 的数据库删除失败时）。
   *
   * 尽力而为：恢复失败只记 `error`，原始错误继续抛。掩盖原始错误会让「为什么
   * 删账号失败」变成「为什么磁盘上有两份不同的授权」，后者更难定位。
   */
  async #restoreAclFiles(rewrites: readonly PurgeRewrite[]): Promise<void> {
    for (const rewrite of rewrites) {
      try {
        await this.#aclFile.write(rewrite.uri, rewrite.previous);
      } catch (error) {
        this.#logger.error('回滚 .acl.json 失败，磁盘授权与物化表不一致', {
          uri: rewrite.uri.toString(),
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
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
