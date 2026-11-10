/**
 * 追加消息（`add_message` / `POST /sessions/{id}/messages`）。
 *
 * 与阶段一共用会话的 `TREE` 锁（§10.6：`commit` 与 `add_message` 不丢消息）。
 */

import { ComemError } from '../../domain/errors.js';
import type { SessionMessage } from '../../domain/session.js';
import { nextTurn } from '../../domain/session.js';
import type { Uri } from '../../domain/uri.js';

import { loadArchivedMessageIndex } from './archive-index.js';
import { notifyNodeWritten } from './hooks.js';
import {
  corruptDocument,
  readMessages,
  serializeMessages,
  sumTokens,
} from './messages.js';
import type { SessionPorts } from './ports.js';
import { messagesUri, requireSession } from './storage.js';

/**
 * 追加消息。**必须持 `TREE` 锁**（§10.6：`commit` 与 `add_message` 不丢消息）。
 *
 * 轮次时钟由 `nextTurn` 按消息总数算（§8.7），不接受调用方传入。
 *
 * ## 幂等：同一会话内 ID 相同的消息只留一条
 *
 * 采集侧的游标只在消息落盘之后前进（`integrations/lib/cursor.mjs`）：进程被杀、
 * 请求超时、跨进程锁过期时，同一批消息会被重投。重投是**正常恢复路径**，所以
 * 重复提交返回已经落盘的那条消息（保留它原来的 turn），不写正文、不改 turn、
 * 不抛 409。
 *
 * 判据是消息 ID：它由调用方生成（宿主 uuid 或 `stableMessageId`），同一条宿主
 * 消息重投时 ID 不变。空串不是身份——拿它去重会把互不相关的消息合并成一条，
 * 所以在入口拒绝。正文不参与判据：ID 相同就是同一条消息。
 *
 * **已归档的消息也算。** 提交之后消息移进 `history/archive_NNN/`，只查 live 会把
 * 重投的那一批当成新消息再追加一遍。归档消息 ID 在归档元数据的
 * `archivedMessageIds` 里；本服务按会话在进程内缓存「ID → 归档 URI」，每个会话
 * 第一次写入时读一次元数据（不解析归档的 `messages.jsonl`），提交时增量更新。
 * live 的检查没有额外 IO：写路径本来就要把整个 `messages.jsonl` 读出来重写。
 *
 * ## 追加成功时把会话状态改回 `open`
 *
 * `archiveSession`（空闲过期）把状态置 `archived`，调度器对 `status === 'archived'`
 * 的会话直接跳过（`bootstrap/scheduler.ts` 的 `#autoCommit` 入口）。消息进来了
 * 就是活跃会话：不清状态的话，只依赖自动提交的客户端复用一个已归档会话后，新
 * 消息会一直停在 live、永远不会被归档。状态与 `pendingTokens` 在同一次
 * `writeSession` 里落盘。归档失败不是会话状态（`task.status` 表达它），所以这里
 * 不需要复位别的值。
 *
 * **重复消息不重置状态。** 没有新内容进来，重放一条已经落盘的消息不该让一个
 * 已过期归档的会话重新变活跃；这也保住了「重复提交零写入」的幂等契约。
 */
export async function appendMessage(
  ports: SessionPorts,
  sessionUri: Uri,
  message: Omit<SessionMessage, 'turn'>,
): Promise<SessionMessage> {
  return ports.locks.withLock(sessionUri, 'tree', async () => {
    const meta = await requireSession(ports.meta, sessionUri);
    if (message.id === '') {
      throw new ComemError('INVALID_ARGUMENT', '消息 ID 不能为空。', {
        uri: sessionUri.toString(),
      });
    }
    const messages = await readMessages(ports.store, messagesUri(sessionUri));
    const existing = messages.find((item) => item.id === message.id);
    if (existing !== undefined) {
      ports.logger.debug('消息已存在，跳过追加。', {
        uri: sessionUri.toString(),
        id: message.id,
        turn: existing.turn,
      });
      return existing;
    }
    const archiveUri = (await loadArchivedMessageIndex(ports, sessionUri)).get(message.id);
    if (archiveUri !== undefined) {
      const original = (await readMessages(ports.store, messagesUri(archiveUri))).find(
        (item) => item.id === message.id,
      );
      if (original === undefined) {
        throw corruptDocument(
          messagesUri(archiveUri),
          '归档元数据记了这条消息，归档的 messages.jsonl 里却没有',
        );
      }
      ports.logger.debug('消息已归档，跳过追加。', {
        uri: sessionUri.toString(),
        id: message.id,
        archiveUri: archiveUri.toString(),
        turn: original.turn,
      });
      return original;
    }
    const appended: SessionMessage = { ...message, turn: nextTurn(messages) };
    const next = [...messages, appended];
    await ports.store.writeText(messagesUri(sessionUri), serializeMessages(next));
    await ports.meta.writeSession(sessionUri, {
      ...meta,
      // 追加消息把已归档会话重新激活。归档失败不是会话状态：它表达在
      // `task.status` 上，不走这里。
      status: meta.status === 'archived' ? 'open' : meta.status,
      pendingTokens: sumTokens(next),
    });
    await notifyNodeWritten(ports, messagesUri(sessionUri));
    return appended;
  });
}
