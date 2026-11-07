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

export type AclEffect = 'allow' | 'deny';

/** 权限级别（§12.1）：read = 1、write = 3、manage = 7，高位包含低位。 */
export type AclLevel = 1 | 3 | 7;

export type AclMode = 'inherit' | 'restricted';

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

/** 架构文档 §12.1：manage 的位值；用常量避免规则里散落魔法数字。 */
const MANAGE_LEVEL: AclLevel = 7;

/** 架构文档 §12.6：组根预置的级别是 write。 */
const WRITE_LEVEL: AclLevel = 3;

/** 架构文档 §12.1：唯一的通配主体。`group:*` 不支持。 */
const USER_WILDCARD = 'user:*';

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
  if (kind === 'group' && id === '*') {
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
 * `granted` 是否覆盖 `required`（§12.1「高位包含低位」）。
 *
 * 位运算比大小表意更直接：7 & 3 === 3，7 & 1 === 1，3 & 1 === 1。
 */
export function levelSatisfies(granted: AclLevel, required: AclLevel): boolean {
  return (granted & required) === required;
}

/** ACL 条目是否命中主体。`user:*` 命中所有 user 主体，不命中 group 主体。 */
function entryMatches(entryPrincipal: string, subject: string): boolean {
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

/**
 * 主体在目标节点上是否满足所需级别（§12.2 的 `check`）。
 *
 * 有效集合里只要有一个级别覆盖 `required` 就算通过——manage 自动覆盖 read/write。
 */
export function checkAction(
  chain: readonly AclNode[],
  subject: string,
  required: AclLevel,
): boolean {
  for (const level of effectiveAcl(chain, subject)) {
    if (levelSatisfies(level, required)) {
      return true;
    }
  }
  return false;
}

/**
 * 根预置（§12.6）。
 *
 * user 根的所有者得到 manage，group 根的全组得到 write。两个预置都是普通 ACL 条目，
 * 只有 user 根 owner 那一条例外（owner 恒 manage，改不了）。
 *
 * 调用方传入根 URI（`uri.isRoot` 为 true）；本函数只读取 scope 与 rootId。
 */
export function rootPreset(uri: Uri): readonly AclEntry[] {
  if (uri.scope === 'user') {
    return [
      {
        principal: formatPrincipal({ kind: 'user', id: uri.rootId }),
        level: MANAGE_LEVEL,
        effect: 'allow',
      },
    ];
  }

  return [
    {
      principal: formatPrincipal({ kind: 'group', id: uri.rootId }),
      level: WRITE_LEVEL,
      effect: 'allow',
    },
  ];
}

/** 只有 manage 能改 ACL（§12.2 第 3 条）。`setAcl` 的前置检查。 */
export function canModifyAcl(chain: readonly AclNode[], subject: string): boolean {
  return checkAction(chain, subject, MANAGE_LEVEL);
}

/**
 * 请求级 ACL 缓存容器（§12.3）。
 *
 * 架构文档要求「每请求维护一份 `Map<uri, Acl>`，请求结束丢弃」。这里只提供容器，
 * 不提供全局单例：每次请求调用 `createAclCache()` 拿一份新的，避免跨请求串权限。
 */
export interface AclCache {
  get(uri: Uri, subject: string): ReadonlySet<AclLevel> | undefined;
  set(uri: Uri, subject: string, value: ReadonlySet<AclLevel>): void;
  clear(): void;
}

export function createAclCache(): AclCache {
  const cache = new Map<string, ReadonlySet<AclLevel>>();

  // URI 不能包含控制字符，用 NUL 拼接不会和主体串冲突。
  const key = (uri: Uri, subject: string): string => `${uri.toString()}\u0000${subject}`;

  return {
    get(uri, subject) {
      return cache.get(key(uri, subject));
    },
    set(uri, subject, value) {
      cache.set(key(uri, subject), value);
    },
    clear() {
      cache.clear();
    },
  };
}
