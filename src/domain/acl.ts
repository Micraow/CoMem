/**
 * ACL 求值（架构文档 §12）。
 *
 * 这一层是纯函数：给定「从根到目标节点」的链和主体标识，算出该主体在每个节点上的
 * 有效权限集合。owner、deny、restricted、继承四条规则全部在这里收口，调用方不需要
 * 再拼一遍。
 *
 * 链的顺序是硬约束：`chain[0]` 是根，`chain[chain.length - 1]` 是目标节点。
 * 求值从根向目标走，每一层把结果传给下一层。
 *
 * 三个不变量（§12.2）：
 *
 * 1. **owner 恒 manage。** owner 判断先于 ACL 求值，独立于 entries。即使 owner 自己
 *    在节点上被 `deny`，仍然得到 manage——否则存在「先收回 owner 权限、再借别人的
 *    路径提权」的可能。owner 节点上的结果直接替换继承来的集合。
 * 2. **同节点 deny 优先。** 同一主体在同一节点上既有 allow 又有 deny 时，deny 赢：
 *    该节点的结果直接是空集，allow 和祖先继承的权限都不再往下传。
 * 3. **restricted 切断继承。** 节点是 `restricted` 时只看本节点的直接授权，祖先的
 *    allow 不再生效；本节点自己的 deny 仍然生效（规则 2 先于规则 3 执行）。
 */

import { ComemError } from './errors.js';
import type { Uri } from './uri.js';

export type PrincipalKind = 'user' | 'group';

/** 主体标识。`user:*` 是唯一支持的通配符（§12.1）。 */
export interface Principal {
  readonly kind: PrincipalKind;
  readonly id: string;
}

/**
 * 授权效果。
 *
 * 数组是唯一来源，类型从它派生：HTTP 的 `effect` 参数校验从它取。手抄一份时
 * 加第三种效果（例如 `conditional`）不会编译失败，接口会继续拒绝它。
 */
export const ACL_EFFECTS = ['allow', 'deny'] as const;

export type AclEffect = (typeof ACL_EFFECTS)[number];

/** 权限级别（§12.1）：read = 1、write = 3、manage = 7，高位包含低位。 */
export const ACL_LEVELS = [1, 3, 7] as const;

export type AclLevel = (typeof ACL_LEVELS)[number];

/**
 * 级别数值的三个名字。**数值来源是 `ACL_LEVELS`**：按下标取元组元素，
 * `satisfies` 保证取到的仍在闭集内，类型同时收窄成字面量 1 / 3 / 7。
 *
 * 检索谓词、单节点求权、组根预置都引用这里，不再各自写一遍数字——副本漂移时
 * 症状不是编译失败，而是「同一份授权在读路径与写路径上给出不同答案」。
 */
export const READ_LEVEL = ACL_LEVELS[0] satisfies AclLevel;
export const WRITE_LEVEL = ACL_LEVELS[1] satisfies AclLevel;
export const MANAGE_LEVEL = ACL_LEVELS[2] satisfies AclLevel;

/** 继承模式。数组是唯一来源，类型从它派生（HTTP 的 `mode` 参数校验从它取）。 */
export const ACL_MODES = ['inherit', 'restricted'] as const;

export type AclMode = (typeof ACL_MODES)[number];

/** 级别守卫（`.acl.json` 与 HTTP 入参都是不可信输入）。 */
export function isAclLevel(value: unknown): value is AclLevel {
  return ACL_LEVELS.some((level) => level === value);
}

/** 效果守卫。 */
export function isAclEffect(value: unknown): value is AclEffect {
  return ACL_EFFECTS.some((effect) => effect === value);
}

/** 继承模式守卫。 */
export function isAclMode(value: unknown): value is AclMode {
  return ACL_MODES.some((mode) => mode === value);
}

export interface AclEntry {
  readonly principal: string;
  readonly level: AclLevel;
  readonly effect: AclEffect;
}

export interface AclNode {
  readonly uri: Uri;
  /** 节点所有者，形如 `user:alice`。owner 恒 manage，不受 entries 影响。 */
  readonly owner: string;
  readonly mode: AclMode;
  readonly entries: readonly AclEntry[];
}

/**
 * 架构文档 §12.1：唯一的通配主体。`group:*` 不支持。
 *
 * 导出是给 `services/acl.ts` 的撤权判定用的（它按链判断主体是否被 deny）：通配形态
 * 只有这一个，两处各写一份字符串字面量时，改一处就会让求权与撤权对同一个条目给出
 * 不同答案。
 */
export const USER_WILDCARD = 'user:*';

/** 通配主体与普通主体共用的 id 段。`user:*` 是唯一合法的通配形态。 */
const WILDCARD_ID = '*';

/**
 * 解析主体字符串。
 *
 * 只接受 `user:{id}`、`group:{id}` 与 `user:*`。`group:*` 按 §12.1 明确拒绝，
 * 其余形态统一抛 `INVALID_ARGUMENT`。
 */
export function parsePrincipal(raw: string): Principal {
  const separator = raw.indexOf(':');
  if (separator <= 0 || separator === raw.length - 1) {
    throw new ComemError(
      'INVALID_ARGUMENT',
      `主体不合法：${raw}。期望 user:{id} 或 group:{id}。`,
      { raw },
    );
  }

  const kind = raw.slice(0, separator);
  const id = raw.slice(separator + 1);

  if (kind !== 'user' && kind !== 'group') {
    throw new ComemError('INVALID_ARGUMENT', `主体不合法：${raw}。kind 只能是 user 或 group。`, {
      raw,
    });
  }
  if (id.includes(':')) {
    throw new ComemError('INVALID_ARGUMENT', `主体不合法：${raw}。id 不能包含冒号。`, { raw });
  }
  if (kind === 'group' && id === WILDCARD_ID) {
    throw new ComemError(
      'INVALID_ARGUMENT',
      '主体不合法：group:* 不受支持（架构文档 §12.1）。',
      { raw },
    );
  }

  return { kind, id };
}

/** 与 `parsePrincipal` 互逆。 */
export function formatPrincipal(principal: Principal): string {
  return `${principal.kind}:${principal.id}`;
}

/**
 * `group:{gid}` 主体。
 *
 * 组 principal 的成员可能不存在（组被删了），求值时按空集处理——组不存在时没有
 * 任何主体拿得到这条授权，不需要额外的存在性检查。
 */
export function groupPrincipal(groupId: string): string {
  return formatPrincipal({ kind: 'group', id: groupId });
}

/** `user:{uid}` 主体。 */
export function userPrincipal(userId: string): string {
  return formatPrincipal({ kind: 'user', id: userId });
}

/**
 * 校验「组的 owner」只能是具体用户主体。
 *
 * `ownerUserId` 是 `user:{uid}` 里的 uid，不是主体字符串。这里把它拼成主体再交给
 * `parsePrincipal`：空串、含冒号的形态（`group:eng`）、`group:` 前缀都由解析层
 * 拒绝，**通配主体 `*` 单独再拦一次**——`user:*` 是合法主体，但把它写成组根的
 * owner 等于给所有用户 manage。
 *
 * 服务层必须自己校验，不能假设调用方已经过 `assertValidUserId`：HTTP 路径有这层
 * 检查，但 `AclService` 是公开的服务方法，绕过路由直接调用的代码（命令、脚本、
 * 迁移）不会替它补一遍。组 owner 的两条提权路径都出在「调用方已经校验过」这个
 * 假设上。
 */
export function assertOwnerUserId(userId: string): void {
  if (userId === WILDCARD_ID) {
    throw new ComemError(
      'INVALID_ARGUMENT',
      '组 owner 不能是通配主体 user:*：它等于给所有用户 manage。',
      { userId },
    );
  }
  parsePrincipal(userPrincipal(userId));
}

/**
 * `granted` 是否覆盖 `required`（§12.1「高位包含低位」）。
 *
 * 位运算比大小表意更直接：7 & 3 === 3，7 & 1 === 1，3 & 1 === 1。
 */
export function levelSatisfies(granted: AclLevel, required: AclLevel): boolean {
  return (granted & required) === required;
}

/**
 * ACL 条目是否命中主体。`user:*` 命中所有 user 主体，不命中 group 主体。
 *
 * 导出是给 `services/acl.ts` 的 `hasDenyEntry` 用的：它回答「整条链上有没有 deny」，
 * 与 `isDenied`（单节点）用途不同，但「这个条目命中这个主体吗」是同一个判据。
 */
export function entryMatches(entryPrincipal: string, subject: string): boolean {
  if (entryPrincipal === subject) {
    return true;
  }
  return entryPrincipal === USER_WILDCARD && subject.startsWith('user:');
}

/** 本节点的直接授权级别（只取 allow 条目）。 */
function directGrants(node: AclNode, subject: string): AclLevel[] {
  const levels: AclLevel[] = [];
  for (const entry of node.entries) {
    if (entry.effect === 'allow' && entryMatches(entry.principal, subject)) {
      levels.push(entry.level);
    }
  }
  return levels;
}

/** 本节点是否存在命中主体的 deny。任意级别都算 deny（§12.2）。 */
function isDenied(node: AclNode, subject: string): boolean {
  return node.entries.some(
    (entry) => entry.effect === 'deny' && entryMatches(entry.principal, subject),
  );
}

/**
 * 计算目标节点的有效权限集合。
 *
 * `chain` 必须是从根到目标的顺序；空链返回空集，单节点链按该节点的规则求值。
 * 返回的集合只包含「主体实际拿到的级别」，不包含被 deny 或 restricted 挡掉的级别。
 */
export function effectiveAcl(
  chain: readonly AclNode[],
  subject: string,
): ReadonlySet<AclLevel> {
  let effective = new Set<AclLevel>();

  for (const node of chain) {
    // 不变量 1：owner 恒 manage，先于 deny 与 restricted 求值。
    if (node.owner === subject) {
      effective = new Set<AclLevel>([MANAGE_LEVEL]);
      continue;
    }

    // 不变量 2：同节点 deny 赢，连同继承来的权限一起清空。
    if (isDenied(node, subject)) {
      effective = new Set<AclLevel>();
      continue;
    }

    // 不变量 3：restricted 切断继承，只看本节点直接授权。
    if (node.mode === 'restricted') {
      effective = new Set<AclLevel>();
    }

    for (const level of directGrants(node, subject)) {
      effective.add(level);
    }
  }

  return effective;
}

export interface RootPresetOptions {
  /**
   * 组的所有者。为空时组根只有 `group:{gid} = write`——这个组还没有人管。
   *
   * user 根忽略这个字段：user 空间的所有者由 URI 根标识推导（§12.6），不需要
   * 额外记录。
   */
  readonly ownerUserId?: string | null;
  /** 组的默认级别；§18 的 `acl.groupDefaultLevel` 可降为 read。默认 write。 */
  readonly groupLevel?: AclLevel;
}

export interface RootPreset {
  readonly entries: readonly AclEntry[];
  /**
   * group 作用域下没有 owner：这个组还没有人管。
   *
   * 调用方（`AclService.ensureRootPreset`）用它在日志里提示「组空间暂时无人
   * 可管理」；user 根恒为 false（user 根的所有者由 URI 推导）。
   */
  readonly ownerMissing: boolean;
}

/**
 * 根预置（§12.6）。
 *
 * user 根的所有者得到 manage。group 根有两条：owner（如果存在）得到 manage，
 * 全组得到 write。没有 owner 的组只有一条——成员之间可以读写，但没有人能改
 * ACL，这正是「这个组还没人管」的状态，由 `ownerMissing` 告诉调用方。
 *
 * 两个预置都是普通 ACL 条目，只有 user 根 owner 那一条例外（owner 恒 manage，
 * 改不了）。group 的 owner 条目不是隐式规则：它必须真的写进 `.acl.json`，
 * 否则 `check(N, manage)` 只查物化表，看不到 owner 这个身份。
 *
 * 调用方传入根 URI（`uri.isRoot` 为 true）；本函数只读取 scope 与 rootId。
 */
export function rootPreset(uri: Uri, options: RootPresetOptions = {}): RootPreset {
  if (uri.scope === 'user') {
    return {
      entries: [
        {
          principal: formatPrincipal({ kind: 'user', id: uri.rootId }),
          level: MANAGE_LEVEL,
          effect: 'allow',
        },
      ],
      ownerMissing: false,
    };
  }

  const entries: AclEntry[] = [];
  const ownerUserId = options.ownerUserId ?? null;
  if (ownerUserId !== null && ownerUserId !== '') {
    entries.push({
      principal: formatPrincipal({ kind: 'user', id: ownerUserId }),
      level: MANAGE_LEVEL,
      effect: 'allow',
    });
  }
  entries.push({
    principal: formatPrincipal({ kind: 'group', id: uri.rootId }),
    level: options.groupLevel ?? WRITE_LEVEL,
    effect: 'allow',
  });

  return { entries, ownerMissing: ownerUserId === null || ownerUserId === '' };
}

