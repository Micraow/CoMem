/**
 * 主体展开：`user:alice` + 所属组 → 查询用的 principals 数组。
 *
 * 退组立即生效（§12.5）靠的就是「每次重新展开」：ACL 里存的是 `group:{gid}` 这个
 * 字符串，不展开成成员列表，所以成员变化不需要回写任何授权。`user:*` 只对 user
 * 主体生效（§12.1），单独追加在末尾。
 */

import { USER_WILDCARD, parsePrincipal, userScopeOf } from '../../domain/acl.js';
import { ComemError } from '../../domain/errors.js';

export function resolvePrincipals(
  subject: string,
  groups: readonly string[],
): readonly string[] {
  userScopeOf(subject, '调用方身份');

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
