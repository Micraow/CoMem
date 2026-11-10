/**
 * 会话的生命周期：创建、按稳定 ID 复用、空闲归档、物理删除。
 *
 * 与追加 / 阶段一分离：这些入口都围绕 `.meta.json` 是否存在与 `status` 字段，
 * 不涉及 `messages.jsonl` 的内容判定。
 */

import { ComemError } from '../../domain/errors.js';
import type { Uri } from '../../domain/uri.js';

import { listArchiveUris } from './archive-index.js';
import {
  deleteSessionPermissions,
  materializeSessionPermissions,
  notifyNodeRemoved,
  notifyNodeWritten,
} from './hooks.js';
import type { SessionPorts, SessionRemoval } from './ports.js';
import {
  countMessages,
  createSessionId,
  historyUri,
  messagesUri,
  requireSession,
  SESSIONS_DIRECTORY_NAME,
} from './storage.js';

/**
 * 建会话。目录 `sessions/sess_xxx/`，写 `messages.jsonl`（空）与 `.meta.json`。
 *
 * **只创建，不重置。** 已存在的会话（`.meta.json` 在）抛 `ALREADY_EXISTS`，HTTP
 * 映射成 409。`messages.jsonl` 是会话的真相，用同 ID 再建一次就把它覆写成空文件
 * 是静默数据丢失——Hook 的 `PostToolUse` 与 `Stop` 在同一轮里各建一次，工具消息
 * 会被后一次 `Stop` 抹掉。要「已存在就复用」用 {@link ensureSession}。
 *
 * 不提供「重置」：清空消息没有合法调用方。归档走 `commitPhase1`（消息移进
 * `history/`，不丢），删除走 `removeSession`（整目录删除，可审计）。
 *
 * 判据与 `load` / `ensure` 一致：`.meta.json` 存在即会话存在。目录在、元数据不在
 * 只可能是 `create` 中途崩溃留下的空会话（先写消息、后写元数据），重建不会丢消息。
 *
 * 检查与写入持 `TREE` 锁（§10.6）：两个同 ID 的 `create` 并发时，后一个必须看到
 * 前一个写下的元数据并失败，不能把前一个刚写下的消息覆写成空文件。
 */
export async function createSession(
  ports: SessionPorts,
  scopeUri: Uri,
  principals: readonly string[],
  options: { readonly sessionId?: string } = {},
): Promise<Uri> {
  const sessionId = options.sessionId ?? createSessionId();
  const sessionUri = scopeUri.child(SESSIONS_DIRECTORY_NAME, sessionId);
  // 锁文件是会话目录的同级文件，`sessions/` 必须先存在（`acquire` 不建父目录）。
  // 目录已存在时它是幂等的，所以放在检查之前不会改变「存在」的判据。
  await ports.store.mkdir(sessionUri, { recursive: true });
  await ports.locks.withLock(sessionUri, 'tree', async () => {
    if ((await ports.meta.readSession(sessionUri)) !== null) {
      throw new ComemError('ALREADY_EXISTS', `会话已存在：${sessionUri.toString()}`, {
        uri: sessionUri.toString(),
        sessionId,
      });
    }
    // 元数据不在就是新会话（或崩溃留下的空壳）。缓存里若有同名会话的归档索引，
    // 那是上一份数据留下的，必须丢掉。
    ports.archivedMessageIndex.delete(sessionUri.toString());
    // 先写消息文件再写元数据：崩溃时留下的是「有目录、没有元数据」，`load` 按
    // NOT_FOUND 处理；反过来会留下一个声称存在、但读不出消息的会话。
    await ports.store.writeText(messagesUri(sessionUri), '');
    await ports.meta.writeSession(sessionUri, {
      sessionId,
      userId: scopeUri.rootId,
      status: 'open',
      createdAt: new Date().toISOString(),
      commitCount: 0,
      lastCommitAt: null,
      pendingTokens: 0,
    });
    // 空文件也是节点：不写索引行 / 不物化权限，`list` / `tree` / `glob` 就看不到
    // live 会话的 `messages.jsonl`（见 `SessionServiceOptions.observer`）。
    await notifyNodeWritten(ports, messagesUri(sessionUri));
  });
  // §12.4 的「写时算」：`GET /sessions` 的 `list(sessions/)` 会因为缺
  // `node_permission` 行返回空。观察者（上面的 `notifyNodeWritten`）已经物化了会话
  // 目录，这里保留是因为观察者可省略（单测），而「会话目录可列」是 `create`
  // 自己的契约。放在锁外：它要查 ACL 表，失败只记日志，不需要与创建互斥。
  await materializeSessionPermissions(ports, sessionUri, principals);
  ports.logger.info('会话已创建', { uri: sessionUri.toString() });
  return sessionUri;
}

/**
 * 按调用方指定的稳定 ID 取会话；不存在就创建。
 *
 * 幂等上传（`remember` 的 `sessionId`）重跑时拿到的是同一个会话，消息由调用方
 * 按稳定 ID 去重。
 *
 * 只认元数据是否存在：`.meta.json` 是会话「存在」的判据（`load` 也按它判）。
 * `create` 先写消息、后写元数据，所以「目录在、元数据不在」只可能是崩溃留下的
 * 空会话，重新创建不会丢消息。
 *
 * **并发同 ID 是复用，不是错误。** 两个 `ensure` 可能同时看到 NOT_FOUND，随后
 * 都去 `create`；`create` 在 `TREE` 锁内看到前一个写下的元数据，抛
 * `ALREADY_EXISTS`。这里把它转成「读回已存在的会话」——竞态的胜者已经建好了，
 * 输家要做的是拿到同一个 URI，而不是把 409 抛给调用方。只捕获这一个错误码，
 * 不做重试循环。
 */
export async function ensureSession(
  ports: SessionPorts,
  scopeUri: Uri,
  sessionId: string,
  principals: readonly string[],
): Promise<Uri> {
  const sessionUri = scopeUri.child(SESSIONS_DIRECTORY_NAME, sessionId);
  try {
    await requireSession(ports.meta, sessionUri);
    return sessionUri;
  } catch (error) {
    if (!(error instanceof ComemError) || error.code !== 'NOT_FOUND') {
      throw error;
    }
  }
  try {
    return await createSession(ports, scopeUri, principals, { sessionId });
  } catch (error) {
    if (error instanceof ComemError && error.code === 'ALREADY_EXISTS') {
      // 并发 `ensure` 的胜者已经建好并写下了元数据。再读一次确认它还在
      // （例如期间被 `remove` 掉的话，NOT_FOUND 会原样抛给调用方）。
      await requireSession(ports.meta, sessionUri);
      return sessionUri;
    }
    throw error;
  }
}

/**
 * 空闲过期：把会话标记为 `archived`，**不删文件**（§11.7 的
 * `session.expiry.action: archive`）。
 *
 * 只改 `.meta.json` 的 `status`：消息、归档、`memory_diff.json` 全部原样保留。
 * 归档是可逆的（把 `status` 改回 `open` 就恢复），所以它可以是默认动作——删除
 * 不是。
 *
 * 已经是 `archived` 时是空操作（幂等）：调度器每轮都会看到这个会话，重复写一次
 * `.meta.json` 只会多一次磁盘往返与一条假日志。
 */
export async function archiveSession(
  ports: SessionPorts,
  sessionUri: Uri,
): Promise<void> {
  // **必须持 `TREE` 锁**（与 `addMessage` / `commitPhase1` 同一把）：这是
  // `.meta.json` 的读-改-写。无锁时调度器的归档会把并发提交刚写进去的
  // `commitCount` 盖回旧值，而 `nextArchiveId` 就是 `commitCount + 1`——
  // 少计一次，下一个归档就会重新分配已有的 `archive_NNN`，把上一份归档的
  // `messages.jsonl` 与元数据原子覆盖掉（归档消息永久丢失）。
  await ports.locks.withLock(sessionUri, 'tree', async () => {
    const meta = await requireSession(ports.meta, sessionUri);
    if (meta.status === 'archived') {
      return;
    }
    await ports.meta.writeSession(sessionUri, { ...meta, status: 'archived' });
    ports.logger.info('会话已归档（空闲过期）。', {
      uri: sessionUri.toString(),
      commitCount: meta.commitCount,
      pendingTokens: meta.pendingTokens,
    });
  });
}

/**
 * 物理删除整个会话目录（§11.7 的 `session.expiry.action: delete`）。
 *
 * **调用方必须先确认没有待复核记忆的来源指向这个会话**——`memory_diff.json` 只存在
 * 归档目录里，删掉之后「这条待复核记忆是哪个会话产出的」就再也追不回来。这条闸门
 * 在 `Scheduler` 里，因为只有它知道该去查哪些记忆。
 *
 * 返回删了什么，供调用方写审计日志；`.meta.json` 缺失（建了一半的会话）不是错误。
 */
export async function removeSession(
  ports: SessionPorts,
  sessionUri: Uri,
): Promise<SessionRemoval> {
  const meta = await ports.meta.readSession(sessionUri);
  const messages = await countMessages(ports.store, sessionUri);
  const archives = (await listArchiveUris(ports.store, historyUri(sessionUri, ports.archiveDirectoryName))).length;
  const removedEntries = await ports.store.remove(sessionUri, { recursive: true });
  ports.archivedMessageIndex.delete(sessionUri.toString());
  // `messages.jsonl` 有索引行（见 `SessionServiceOptions.observer`）：目录删掉之后
  // 不清理的话，`find` / `glob` 会返回一条打不开的记录。
  await notifyNodeRemoved(ports, sessionUri);
  await deleteSessionPermissions(ports, sessionUri);
  ports.logger.info('会话已删除（空闲过期）。', {
    uri: sessionUri.toString(),
    sessionId: meta?.sessionId ?? null,
    messages,
    archives,
    removedEntries,
  });
  return { sessionUri, messages, archives, removedEntries };
}
