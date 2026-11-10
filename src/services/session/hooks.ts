/**
 * 会话写路径的副作用：物化权限、清理权限、通知索引观察者。
 *
 * 这些原本是 `SessionService` 的私有方法。失败语义都是「只记日志、不回滚」：文件已经
 * 是真相，派生数据靠对账修复（§7）。
 */

import type { PermissionRepository } from '../../adapters/sqlite/permission-repository.js';
import { WRITE_LEVEL } from '../../domain/acl.js';
import type { Logger } from '../../domain/log.js';
import type { Uri } from '../../domain/uri.js';

import type { Authorizer } from '../authorizer.js';
import type { NodeWriteObserver } from '../filesystem.js';

export interface HookPorts {
  readonly logger: Logger;
  readonly authorizer: Authorizer | undefined;
  readonly permissions: Pick<PermissionRepository, 'deleteSubtree'> | undefined;
  readonly observer: Pick<NodeWriteObserver, 'onNodeWritten' | 'onNodeRemoved'> | undefined;
}

/**
 * 为新会话目录物化权限（§12.4 的「写时算」）。
 *
 * `InheritingAuthorizer` 的写路径在缺行时先 `materializeNode` 再求权，所以调一次
 * `assert` 就是「从父目录复制一份有效权限」。
 *
 * 失败只记日志：目录与 `messages.jsonl` 已经落盘，回滚反而丢数据（§7 的同一
 * 原则）；下一次 `GET /sessions/{id}` 的读路径还会补一次。
 */
export async function materializeSessionPermissions(
  ports: HookPorts,
  sessionUri: Uri,
  principals: readonly string[],
): Promise<void> {
  const authorizer = ports.authorizer;
  if (authorizer === undefined) {
    return;
  }
  try {
    await authorizer.assert(sessionUri, WRITE_LEVEL, principals);
  } catch (error) {
    ports.logger.error('会话目录权限物化失败，已忽略。', {
      uri: sessionUri.toString(),
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * 通知「`messages.jsonl` 已写入」。
 *
 * 与 `FileSystemService.#notifyWritten` 同一时序：先落盘、再通知。观察者失败只记
 * 日志——文件已经是真相，回滚反而丢数据；索引与权限是派生数据，靠对账修复（§7）。
 */
export async function notifyNodeWritten(
  ports: HookPorts,
  messagesUri: Uri,
): Promise<void> {
  const observer = ports.observer;
  if (observer === undefined) {
    return;
  }
  try {
    await observer.onNodeWritten(messagesUri, 'file');
  } catch (error) {
    ports.logger.error('会话消息写入后维护索引失败，已忽略。', {
      uri: messagesUri.toString(),
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** 通知「会话目录已删除」。失败语义与 {@link notifyNodeWritten} 相同。 */
export async function notifyNodeRemoved(
  ports: HookPorts,
  sessionUri: Uri,
): Promise<void> {
  const observer = ports.observer;
  if (observer === undefined) {
    return;
  }
  try {
    await observer.onNodeRemoved(sessionUri);
  } catch (error) {
    ports.logger.error('会话删除后清理索引失败，已忽略。', {
      uri: sessionUri.toString(),
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * 清掉被删会话的物化权限行。
 *
 * 失败只记日志：目录已经删掉了，回滚不回来；残留的权限行是派生数据，靠对账修复
 * （§7）。抛出去只会让「删除成功」变成一个错误响应，而删除其实已经完成。
 */
export async function deleteSessionPermissions(
  ports: HookPorts,
  sessionUri: Uri,
): Promise<void> {
  const permissions = ports.permissions;
  if (permissions === undefined) {
    return;
  }
  try {
    permissions.deleteSubtree(sessionUri.toString());
  } catch (error) {
    ports.logger.error('删除会话后清理物化权限失败，已忽略。', {
      uri: sessionUri.toString(),
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}
