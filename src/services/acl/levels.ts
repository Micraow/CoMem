/**
 * 磁盘级别名与领域级别之间的映射（读 `.acl.json` / 写 `.acl.json` 各一个方向）。
 *
 * 映射只在这两个方向发生，集中在这里是为了让「磁盘格式加了级别名」在类型上
 * 立刻编译失败，而不是在某一侧静默吞掉一条授权。
 */

import type { AclFileEntry } from '../../adapters/fs/acl-file.js';
import { ComemError } from '../../domain/errors.js';
import type { AclEntry, AclLevel } from '../../domain/acl.js';

/** 磁盘级别名 → 领域级别。映射只在这一个方向发生（写 `.acl.json` 时）。 */
export function levelName(level: AclLevel): AclFileEntry['level'] {
  switch (level) {
    case 1:
      return 'read';
    case 3:
      return 'write';
    case 7:
      return 'manage';
    default: {
      // 类型上不可达（`AclLevel` 加了成员时这一行编译失败）。运行时脏数据在写盘
      // 之前挡掉——写进 `undefined` 会被 `JSON.stringify` 静默删键，读回来时那一条
      // 授权就消失了。
      const exhaustive: never = level;
      throw new ComemError('INVALID_ARGUMENT', `ACL 级别不合法：${String(exhaustive)}`, {
        level: exhaustive,
      });
    }
  }
}

/** 领域级别 → 磁盘级别名。映射只在读 `.acl.json` 时发生。 */
export function levelByName(name: AclFileEntry['level']): AclLevel {
  switch (name) {
    case 'read':
      return 1;
    case 'write':
      return 3;
    case 'manage':
      return 7;
    default: {
      // 磁盘格式加了级别名时这里编译失败。手改的 `.acl.json` 走到这里说明写盘前
      // 的校验被绕过了，按程序缺陷处理。
      const exhaustive: never = name;
      throw new ComemError('INTERNAL', `ACL 文件里的级别名不合法：${String(exhaustive)}`, {
        level: exhaustive,
      });
    }
  }
}

export function fromAclFileEntry(entry: AclFileEntry): AclEntry {
  return { principal: entry.principal, level: levelByName(entry.level), effect: entry.effect };
}
