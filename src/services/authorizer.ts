/**
 * 授权端口（架构文档 §12.4）。
 *
 * `FileSystemService` 的每个出口都要过这个接口：`read` / `stat` / `list` / `tree`
 * 要 read，`write` / `edit` / `mkdir` 要 write，`remove` / `move` 要 manage。
 * 真实实现是 W4 的 `AclService`（ACL 求值走 `domain/acl.ts`），这里只定形状。
 *
 * 为什么 `assert` 和 `check` 都要有：读路径用 `check` 得到布尔值再决定「跳过还是
 * 报错」，写路径用 `assert` 直接抛 `PERMISSION_DENIED`。两者语义不同，不能合并成
 * 一个返回布尔值的方法让调用方各自 if。
 *
 * ## 身份是参数，不是构造期绑定
 *
 * 三个方法都收 `principals`：一次请求展开后的主体集合（`user:{uid}` +
 * `group:{gid}` + `user:*`）。装配期绑定身份是 v1 单用户的遗留——服务图只有
 * 一份，而多用户部署里每个请求的身份不同。把它改成参数，求值层就不需要「每请求
 * 一份服务图」。
 *
 * **不传 principals 的调用点不存在**：没有默认值，漏传在类型检查期就报错。
 *
 * 列表语义（§12.4）：无权限节点**完全不出现**，不返回「存在但无权」的占位。
 * 文件名和摘要本身就是信息，占位等于泄露。
 */

import type { AclLevel } from '../domain/acl.js';
import { ComemError } from '../domain/errors.js';
import type { Uri } from '../domain/uri.js';

/** 与 `domain/acl.ts` 的 `AclLevel` 一致（§12.1：read = 1、write = 3、manage = 7）。 */
export type AclAction = AclLevel;

export interface Authorizer {
  /** 单个节点求权。 */
  check(uri: Uri, action: AclAction, principals: readonly string[]): Promise<boolean>;

  /**
   * 批量求权，返回有权限的 URI 字符串集合。
   *
   * 用字符串集合而不是 `Uri` 集合：调用方大多刚从 `ContentStore` 拿到字符串形态的
   * 节点标识，用 `Uri.toString()` 查表不用每次重建值对象。
   */
  filterReadable(
    uris: readonly Uri[],
    principals: readonly string[],
  ): Promise<ReadonlySet<string>>;

  /** 求权失败抛 `PERMISSION_DENIED` 的便捷包装。 */
  assert(uri: Uri, action: AclAction, principals: readonly string[]): Promise<void>;
}

/** 级别的人类可读名，只用于错误消息。 */
const ACTION_LABEL: Readonly<Record<AclAction, string>> = Object.freeze({
  1: 'read',
  3: 'write',
  7: 'manage',
});

/**
 * `assert` 的标准错误。
 *
 * 消息是中文完整句子，带 URI 与所需级别——用户看到的就是这一句，
 * 不放错误码堆栈。
 */
export function permissionDenied(uri: Uri, action: AclAction): ComemError {
  return new ComemError(
    'PERMISSION_DENIED',
    `没有权限：${uri.toString()} 需要 ${ACTION_LABEL[action]}（${action}）级别。`,
    { uri: uri.toString(), action },
  );
}
