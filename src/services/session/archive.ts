/**
 * 阶段一提交（架构文档 §10.1 的两阶段、§10.2 的归档边界、§6.5–6.6 的目录形状）。
 *
 * 六步顺序不能变：分配归档序号 → 写归档消息 → 写 `preparing` 元数据 → 重写 live
 * → 元数据置 `ready` → 建任务。`.done` 只在阶段二最后写，这里是唯一的完成信号。
 *
 * 重放时先找 `preparing` 的归档，读它的 `messages.jsonl`（步骤 2 是原子写，文件
 * 一定完整），再把 live 重写成「排除这些消息 ID」——两种崩溃时序下结果一致，且已经
 * 归档的消息不会被重复计数。
 *
 * 并发：`add_message` 与阶段一用同一把 `TREE` 锁（§10.6）；锁由公开方法
 * `SessionService.commitPhase1` 持有，本模块的函数都在锁内运行。
 */

import type { ArchiveMeta, ArchiveTaskPayload } from '../../domain/archive.js';
import { ComemError } from '../../domain/errors.js';
import type { SessionMessage } from '../../domain/session.js';
import type { Uri } from '../../domain/uri.js';

import { listArchiveUris, recordArchivedMessages } from './archive-index.js';
import { notifyNodeWritten } from './hooks.js';
import { readMessages, serializeMessages, sumTokens } from './messages.js';
import type { ArchivePorts, CommitPhase1Result } from './ports.js';
import {
  ARCHIVE_DIRECTORY_PREFIX,
  ARCHIVE_SEQUENCE_DIGITS,
  historyUri as historyOf,
  messagesSha256 as sha256OfMessages,
  messagesUri,
  requireSession,
} from './storage.js';

/**
 * 阶段一（§10.1）。**调用方必须已持有会话的 `TREE` 锁**。
 *
 * 六步的顺序见文件头。任何一步崩溃，下一次调用都会从 `preparing` 的归档继续。
 */
export async function commitPhase1(
  ports: ArchivePorts,
  sessionUri: Uri,
): Promise<CommitPhase1Result> {
  const historyUri = historyOf(sessionUri, ports.archiveDirectoryName);
  const interrupted = await findInterruptedArchive(ports, historyUri);
  if (interrupted !== null) {
    if (await ports.store.exists(messagesUri(interrupted))) {
      return resumeArchive(ports, sessionUri, interrupted);
    }
    // 崩溃在步骤 1 与 2 之间：只有空目录，没有消息。删掉重新分配。
    await ports.store.remove(interrupted, { recursive: true });
  }

  const session = await ports.loadSession(sessionUri);
  const keepRecentCount = ports.autoCommit.keepRecentCount;
  const archived =
    keepRecentCount <= 0
      ? session.messages
      : session.messages.slice(0, Math.max(0, session.messages.length - keepRecentCount));
  if (archived.length === 0) {
    // 空归档只会产出一个空任务：没有消息可抽取，阶段二会写一份空摘要再标记完成。
    // 拒绝比制造一个没有内容的归档更诚实。
    throw new ComemError('INVALID_ARGUMENT', `没有可归档的消息：${sessionUri.toString()}`, {
      uri: sessionUri.toString(),
      messageCount: session.messages.length,
      keepRecentCount,
    });
  }
  const retained = session.messages.slice(archived.length);

  // 步骤 1：分配归档序号。
  const archiveId = await nextArchiveId(ports, sessionUri);
  const archiveUri = historyUri.child(archiveId);

  // 步骤 2：写归档消息（原子写）。
  await ports.store.writeText(messagesUri(archiveUri), serializeMessages(archived));
  // 消息已经在归档里了：重投的同一批不能再落回 live。索引只在本进程有缓存时
  // 更新，没有缓存就等下一次 `addMessage` 从磁盘重建。
  recordArchivedMessages(ports, sessionUri, archiveUri, archived);
  const messagesSha256 = await sha256OfMessages(ports.store, messagesUri(archiveUri));
  // 归档目录里的「原始对话」也要是一个可寻址的节点：不建索引行 / 不物化权限，
  // 用户点开归档只看得到元数据（见 `SessionServiceOptions.observer`）。
  await notifyNodeWritten(ports, messagesUri(archiveUri));

  // 步骤 3：`.meta.json` 先写 `preparing`。到这里为止，归档消息已经完整落盘。
  const preparing: ArchiveMeta = {
    archiveId,
    phase1: {
      status: 'preparing',
      messagesSha256,
      archivedMessageIds: archived.map((message) => message.id),
      retainedMessageIds: retained.map((message) => message.id),
    },
    stepsDone: [],
    // 阶段一不跳过任何步骤；跳过只发生在阶段二（没有可用 LLM 时）。
    skippedSteps: [],
    taskId: null,
  };
  await ports.meta.writeArchive(archiveUri, preparing);

  // 步骤 4：重写 live 消息，只保留 keepRecentCount 条。
  await ports.store.writeText(messagesUri(sessionUri), serializeMessages(retained));
  await notifyNodeWritten(ports, messagesUri(sessionUri));

  // 步骤 5：`phase1` 置 `ready`。**不写 `.done`**——那是阶段二的最后一步。
  const ready: ArchiveMeta = { ...preparing, phase1: { ...preparing.phase1, status: 'ready' } };
  await ports.meta.writeArchive(archiveUri, ready);

  // 步骤 6：建任务，并把 taskId 回填进归档元数据。
  const task = ports.tasks.create('archive', {
    sessionUri: sessionUri.toString(),
    archiveUri: archiveUri.toString(),
    archiveId,
  } satisfies ArchiveTaskPayload);
  await ports.meta.writeArchive(archiveUri, { ...ready, taskId: task.id });

  await writeSessionMeta(ports, sessionUri, retained);
  ports.logger.info('阶段一归档完成', {
    uri: sessionUri.toString(),
    archiveUri: archiveUri.toString(),
    archivedCount: archived.length,
    taskId: task.id,
  });
  return { taskId: task.id, archiveUri, archivedCount: archived.length };
}

/**
 * 补完一次停在 `preparing` 的归档。
 *
 * 读归档的 `messages.jsonl`（步骤 2 已经原子写完，内容完整），把 live 重写成
 * 「排除这些消息 ID」，再写 `ready` 与任务。不重新分配序号：这个归档目录就是
 * 这次提交的产物。
 */
async function resumeArchive(
  ports: ArchivePorts,
  sessionUri: Uri,
  archiveUri: Uri,
): Promise<CommitPhase1Result> {
  const archiveId = archiveUri.name;
  const archived = await readMessages(ports.store, messagesUri(archiveUri));
  const messagesSha256 = await sha256OfMessages(ports.store, messagesUri(archiveUri));
  recordArchivedMessages(ports, sessionUri, archiveUri, archived);
  // 崩溃可能停在「归档消息写完、索引行没写」之间：补完时把归档节点补上。
  await notifyNodeWritten(ports, messagesUri(archiveUri));
  const live = await readMessages(ports.store, messagesUri(sessionUri));
  const archivedMessageIds = new Set(archived.map((message) => message.id));
  const retained = live.filter((message) => !archivedMessageIds.has(message.id));

  // 步骤 4 重放：已经归档的消息从 live 里去掉。
  await ports.store.writeText(messagesUri(sessionUri), serializeMessages(retained));
  await notifyNodeWritten(ports, messagesUri(sessionUri));

  // 步骤 5 重放。
  const existing = await ports.meta.readArchive(archiveUri);
  const ready: ArchiveMeta = {
    archiveId,
    phase1: {
      status: 'ready',
      messagesSha256,
      archivedMessageIds: [...archivedMessageIds],
      retainedMessageIds: retained.map((message) => message.id),
    },
    stepsDone: existing?.stepsDone ?? [],
    // 补完归档时保留已经记录过的跳过原因：阶段二可能已经跑过并跳过了某几步。
    skippedSteps: existing?.skippedSteps ?? [],
    taskId: existing?.taskId ?? null,
  };
  await ports.meta.writeArchive(archiveUri, ready);

  // 步骤 6 重放：任务已经建过就复用，不再造第二个。
  let taskId = ready.taskId;
  if (taskId === null) {
    const task = ports.tasks.create('archive', {
      sessionUri: sessionUri.toString(),
      archiveUri: archiveUri.toString(),
      archiveId,
    } satisfies ArchiveTaskPayload);
    taskId = task.id;
    await ports.meta.writeArchive(archiveUri, { ...ready, taskId });
  }

  await writeSessionMeta(ports, sessionUri, retained);
  ports.logger.warn('补完了中断的归档。', {
    uri: sessionUri.toString(),
    archiveUri: archiveUri.toString(),
    archivedCount: archived.length,
    taskId,
  });
  return { taskId, archiveUri, archivedCount: archived.length };
}

/**
 * 找停在 `preparing` 的归档（或只有目录、没有元数据的归档）。
 *
 * 取序号最小的一个：正常崩溃只会留下一个，出现多个说明磁盘状态被手工改过，
 * 从最早的开始补才能保持归档顺序。
 */
async function findInterruptedArchive(
  ports: ArchivePorts,
  historyUri: Uri,
): Promise<Uri | null> {
  for (const archiveUri of await listArchiveUris(ports.store, historyUri)) {
    const meta = await ports.meta.readArchive(archiveUri);
    if (meta === null || meta.phase1.status === 'preparing') {
      return archiveUri;
    }
  }
  return null;
}

/**
 * 下一个归档序号：会话的 `commitCount + 1`（§10.2「单调递增，从不复用」）。
 *
 * **不能用「`history/` 里的最大序号 + 1」**：删掉最新的归档目录之后，那个编号会
 * 被下一次提交重新分配。归档编号是归档的身份证——`memory_diff.json`、任务
 * payload、控制台的归档列表都按它引用，复用会让两条不同的归档指向同一个名字。
 *
 * 计数器放在 `.meta.json` 的 `commitCount` 里：它是文件，删库不丢（§7），而且
 * 本来就随每次提交递增，不需要另存一份。`history/` 目录仍然可以随时重建。
 */
async function nextArchiveId(ports: ArchivePorts, sessionUri: Uri): Promise<string> {
  const meta = await requireSession(ports.meta, sessionUri);
  return `${ARCHIVE_DIRECTORY_PREFIX}${String(meta.commitCount + 1).padStart(
    ARCHIVE_SEQUENCE_DIGITS,
    '0',
  )}`;
}

async function writeSessionMeta(
  ports: ArchivePorts,
  sessionUri: Uri,
  retained: readonly SessionMessage[],
): Promise<void> {
  const meta = await requireSession(ports.meta, sessionUri);
  await ports.meta.writeSession(sessionUri, {
    ...meta,
    commitCount: meta.commitCount + 1,
    lastCommitAt: new Date().toISOString(),
    pendingTokens: sumTokens(retained),
  });
}
