/**
 * 纯求值：链上的 owner、主体集合、级别代表值与 deny 判定。
 *
 * 这里只依赖 `domain/`：输入是已经读好的 `AclNode` 链，输出是集合或布尔值，
 * 没有 IO、没有适配器类型。链的读取在 `snapshot.ts`，行物化在 `materialize.ts`。
 */

import { READ_LEVEL, entryMatches } from '../../domain/acl.js';
import type { AclLevel, AclNode } from '../../domain/acl.js';
import type { Uri } from '../../domain/uri.js';

/**
 * 节点的所有者。
 *
 * user 空间的所有者是根标识对应的用户（§12.6 的根预置就是它），**恒 manage**。
 * group 空间没有单个所有者：组员拿到的是根预置的 write，如果把 `group:{gid}`
 * 当成每个节点的 owner，write 预设就永远收不回去（§12.6「写死会让组空间无法
 * 降级成只读」）。空串不是合法主体（`parsePrincipal` 要求 `user:` / `group:`），
 * 不会和任何 subject 相等。
 */
export function ownerOf(uri: Uri): string {
  return uri.scope === 'user' ? `user:${uri.rootId}` : '';
}

/** 链上出现过的全部主体：owner + 每条授权（allow 与 deny 都算）。 */
export function collectPrincipals(chain: readonly AclNode[]): readonly string[] {
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
export function maxLevel(levels: ReadonlySet<AclLevel>): AclLevel {
  let max: AclLevel = READ_LEVEL;
  for (const level of levels) {
    if (level > max) {
      max = level;
    }
  }
  return max;
}

/** 链上是否有命中主体的 deny 条目。命中即该主体在目标节点上被拒绝（§12.2）。 */
export function hasDenyEntry(chain: readonly AclNode[], subject: string): boolean {
  return chain.some((node) =>
    node.entries.some(
      (entry) => entry.effect === 'deny' && entryMatches(entry.principal, subject),
    ),
  );
}
