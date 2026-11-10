/**
 * 用户与组的身份模型（架构文档 §12.1、§12.5、§12.6）。
 *
 * 这一层只回答两个问题：一个 ID 能不能当作用户/组标识，以及一次请求的身份展开成
 * 哪些 principal。持久化在 `adapters/sqlite/user-repository.ts` 与
 * `group-repository.ts`，用例编排在 `services/identity.ts`。
 *
 * ## 为什么 ID 必须小写
 *
 * `comem://user/{uid}/...` 里的 `{uid}` 同时是磁盘目录名和权限匹配的键。`Uri` 只做
 * NFC，不做大小写折叠（§6.2），所以 `Alice` 与 `alice` 是两个不同的根；如果用户
 * 目录允许大写，同一个人的文件会出现两套路径、两套权限，而其中一套一定是错的。
 * 这与 §8.2 用 `GLOB` 而不是 `LIKE` 的理由相同：权限匹配只认二进制比较。
 *
 * ## 为什么保留名要在这里拦
 *
 * 根标识会落成 `{dataDir}/{scope}/{rootId}` 目录。`_meta` 是数据根的元数据目录
 * （§6.5 的 `_meta/comem.sqlite`），`attachments` 对应附件目录（§14 的
 * `download`）。这些名字被当成用户 ID 时，用户内容会和内部产物抢同一个地址。
 *
 * 方法名里的标识同理：`rules` 的 `{scenario}` 会落成一层目录，取 `.history` 就拼出
 * 与版本目录同址的记忆。所以「用户不可选的标识」= `domain/uri.ts` 的段保留名再
 * **加** `.history`：它是合法 URI 段（系统写版本快照要用），只是不许由用户选。
 * 差集由 `tests/unit/domain/identity.test.ts` 钉住。
 */

import { groupPrincipal, userPrincipal } from './acl.js';
import { ComemError } from './errors.js';
import { VERSION_DIRECTORY } from './node.js';
import { RESERVED_SEGMENT_NAMES } from './uri.js';

/** 用户。 */
export interface User {
  /** 稳定标识，进 URI：`comem://user/{id}/...`。 */
  readonly id: string;
  readonly displayName: string;
  readonly email: string | null;
  readonly status: 'active' | 'disabled';
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** 组。 */
export interface Group {
  readonly id: string;
  readonly displayName: string;
  readonly description: string | null;
  /**
   * 组的 owner（`user:{uid}` 的 uid）。`null` 表示还没有人管这个组。
   *
   * 这是「这个组归谁管」的权威来源，不参与 ACL 求值：owner 的 manage 权限是
   * 组根 `.acl.json` 里的 `user:{owner} = manage` 条目（§12.6）。两者可能因为
   * 手工改文件而不同步，此时以文件为准——`owner_user_id` 只决定「谁能改 owner」。
   */
  readonly ownerUserId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** 组成员关系。 */
export interface GroupMember {
  readonly groupId: string;
  readonly userId: string;
  /**
   * 派生字段：`userId === group.ownerUserId` 才是 `owner`。
   *
   * 不来自 `group_member.role` 列——那一列已废弃。组的 owner 决定 ACL 里
   * `user:{owner} = manage` 怎么写，但它本身不是成员行上的属性。
   */
  readonly role: 'owner' | 'member';
  readonly addedAt: string;
}

/**
 * 一次请求的身份。
 *
 * `principals` 是**已经展开**的主体集合：`user:{uid}` + 它加入的每个组的
 * `group:{gid}`。ACL 求值只认这个集合，**不展开成员列表**（§12.5：退组立即生效
 * 靠的是「ACL 存组 principal」而不是回写快照）。
 *
 * 通配符 `user:*` 不在 `buildIdentity` 的返回值里：它由 ACL 求值侧按「主体是否以
 * `user:` 开头」处理（`domain/acl.ts` 的 `entryMatches`），不属于「这个用户加入了
 * 什么」。把它当成员写进身份会让人误以为它是一条被授予的权限。
 */
export interface Identity {
  readonly userId: string;
  readonly principals: readonly string[];
}

/**
 * 用户 ID 的合法字符：小写字母、数字、短横线、下划线、点。
 *
 * `{0,63}` 加首字符共 64 个字符，来源是 W12a 的需求定义；架构文档 §12 只规定了
 * 主体格式（`user:{uid}`），没有规定长度。64 个字符足以容纳邮箱形式的 uid，也远
 * 小于 `Uri` 单段的 255 字节上限（§6.2 规则 5），两处不冲突。
 *
 * 首字符必须是 `[a-z0-9]`：`.foo` 形式的 ID 会和元数据文件同形，`-foo` 在部分
 * 命令行工具里会被当成选项。
 */
export const USER_ID_PATTERN: RegExp = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** 组 ID 同规则。 */
export const GROUP_ID_PATTERN: RegExp = USER_ID_PATTERN;

/**
 * 数据根下的内部目录名（§6.5、§14）。
 *
 * `.` 与 `..` 已经过不了 `ID_PATTERN`，列在这里只是把「它们不是 ID」写明白。
 */
const ROOT_RESERVED_NAMES: ReadonlySet<string> = new Set(['_meta', 'attachments', '.', '..']);

/**
 * 用户不可选的标识（根 ID、记忆 identity 值）：`domain/uri.ts` 的段保留名 + `.history`。
 * 后者能当 URI 段（系统写版本快照），但不能由用户选：拼出的路径会落在版本目录里。
 */
const IDENTIFIER_RESERVED_NAMES: ReadonlySet<string> = new Set([
  ...RESERVED_SEGMENT_NAMES,
  VERSION_DIRECTORY,
]);

/** 这个标识名是不是保留名。用户输入落成路径段的每一处都必须问它。 */
export function isReservedIdentifier(name: string): boolean {
  return IDENTIFIER_RESERVED_NAMES.has(name);
}

function isReservedRootId(id: string): boolean {
  return isReservedIdentifier(id) || ROOT_RESERVED_NAMES.has(id);
}

function assertValidId(id: string, kind: 'user' | 'group'): string {
  const pattern = kind === 'user' ? USER_ID_PATTERN : GROUP_ID_PATTERN;
  if (!pattern.test(id) || isReservedRootId(id)) {
    throw new ComemError(
      'INVALID_ARGUMENT',
      `${kind === 'user' ? '用户' : '组'} ID 不合法：${String(id)}。只允许小写字母或数字开头，后接小写字母、数字、点、下划线、短横线，最长 64 个字符。`,
      { id, kind },
    );
  }
  return id;
}

/** 校验并返回规范化后的 ID；非法抛 `INVALID_ARGUMENT`。 */
export function assertValidUserId(id: string): string {
  return assertValidId(id, 'user');
}

/** 组 ID 同规则。 */
export function assertValidGroupId(id: string): string {
  return assertValidId(id, 'group');
}

/**
 * 由 userId 与组 ID 列表构造 `Identity`。**去重并排序**，保证可重放。
 *
 * 排序用默认的码点序：同一份成员关系每次展开都得到同一个数组，日志与
 * `principals IN (...)` 的绑定顺序才可复现。去重是必须的——同一个人在两个组里
 * 是两条关系，但 `group:eng` 在主体集合里只能出现一次。
 *
 * 不在这里校验 ID：这是格式化函数，`assertValidUserId` / `assertValidGroupId` 是
 * 唯一校验入口。调用方（`IdentityService.resolve`）拿到的组成员行都经过创建时
 * 校验，跑一遍正则只是给热路径加开销。
 */
export function buildIdentity(userId: string, groupIds: readonly string[]): Identity {
  const principals = new Set<string>([userPrincipal(userId)]);
  for (const groupId of groupIds) {
    principals.add(groupPrincipal(groupId));
  }
  return { userId, principals: [...principals].sort() };
}
