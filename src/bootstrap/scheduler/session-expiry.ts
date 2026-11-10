/**
 * 会话过期：空闲多久算过期、过期后归档还是删除。
 *
 * 删除不是「把目录删掉」这么简单：`archive_NNN/memory_diff.json` 是「这条待复核记忆
 * 来自哪个会话」的唯一线索（§6.6），删掉会话就再也追不回来。所以删除前必须确认这个
 * 会话产出的记忆没有一条还是 `pending`。
 */

import { errorMessage } from '../../domain/errors.js';
import type { Logger } from '../../domain/log.js';
import type { Session } from '../../domain/session.js';
import { Uri } from '../../domain/uri.js';

import type { SessionOutcome, SessionRoundPorts } from './contracts.js';
import { MILLISECONDS_PER_SECOND } from '../../domain/time.js';
import { memoryUrisOf, readMemoryDiff } from './memory-diff.js';

/**
 * 会话空闲了多少秒。
 *
 * 基准是「最后一条消息的时间」，没有消息时退回「上次提交时间」（提交之后 live
 * 会变空，而那次提交本身就是最后活动）。两者都没有时返回 `null`——一个从没写进
 * 任何东西、也从没提交过的会话没有「空闲」的参照点，按「不过期」处理。
 */
export function idleSecondsOf(logger: Logger, session: Session, now: Date): number | null {
  const basis = session.messages.at(-1)?.createdAt ?? session.lastCommitAt;
  if (basis === null) {
    return null;
  }
  const timestamp = Date.parse(basis);
  if (Number.isNaN(timestamp)) {
    logger.warn('会话的最后活动时间不合法，跳过过期判定。', {
      uri: session.uri.toString(),
      value: basis,
    });
    return null;
  }
  return (now.getTime() - timestamp) / MILLISECONDS_PER_SECOND;
}

/** 过期一个会话：`archive` 直接归档；`delete` 先确认没有待复核记忆，再物理删除。 */
export async function expireSession(
  ports: SessionRoundPorts,
  sessionUri: Uri,
  idleSeconds: number,
): Promise<SessionOutcome> {
  if (ports.expiry.action === 'archive') {
    await ports.sessions.archive(sessionUri);
    ports.logger.info('会话空闲过期，已归档。', {
      uri: sessionUri.toString(),
      idleSeconds,
      idleTimeoutSeconds: ports.expiry.idleTimeoutSeconds,
    });
    return 'archived';
  }

  let pending: readonly string[];
  try {
    pending = await pendingMemoryUris(ports, sessionUri);
  } catch (error) {
    // 读不出「这个会话产出了哪些记忆」就证明不了删除安全。保守跳过。
    ports.logger.warn('会话的内存产出清单读不出来，跳过删除。', {
      uri: sessionUri.toString(),
      error: errorMessage(error),
    });
    return 'skipped';
  }
  if (pending.length > 0) {
    ports.logger.warn('会话空闲过期，但它产出的记忆仍在待复核，跳过删除。', {
      uri: sessionUri.toString(),
      idleSeconds,
      pendingMemoryUris: pending,
    });
    return 'skipped';
  }

  const removal = await ports.sessions.remove(sessionUri);
  ports.logger.info('会话空闲过期，已删除。', {
    uri: removal.sessionUri.toString(),
    idleSeconds,
    messages: removal.messages,
    archives: removal.archives,
    removedEntries: removal.removedEntries,
  });
  return 'deleted';
}

/**
 * 这个会话的归档产出里，哪些记忆**现在**还是 `pending`。
 *
 * 关联只有一条：`archive_NNN/memory_diff.json` 记下了每次归档写入了哪些记忆
 * （§6.6）。它就在会话目录里，所以「删掉会话」等于删掉「这条待复核记忆是哪个会话
 * 产出的」这唯一线索——那些记忆还没复核，删了就追不回来。
 */
async function pendingMemoryUris(ports: SessionRoundPorts, sessionUri: Uri): Promise<readonly string[]> {
  const pending = new Set<string>();
  for (const archiveUri of await ports.sessions.listArchives(sessionUri)) {
    const diff = await readMemoryDiff(ports.dataDir, archiveUri);
    if (diff === null) {
      // 阶段二没跑完（或没跑过）的归档没有清单：那时也不可能有记忆被写出来。
      continue;
    }
    for (const rawUri of memoryUrisOf(diff, archiveUri)) {
      const memoryUri = Uri.tryParse(rawUri);
      if (memoryUri === null) {
        ports.logger.warn('memory_diff.json 里的 URI 不合法，跳过。', {
          archiveUri: archiveUri.toString(),
          uri: rawUri,
        });
        continue;
      }
      const record = await ports.memories.read(memoryUri);
      if (record !== null && record.status === 'pending') {
        pending.add(rawUri);
      }
    }
  }
  return [...pending];
}
