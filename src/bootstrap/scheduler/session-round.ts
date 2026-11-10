/**
 * 单个会话在一轮里的处理：先看要不要自动提交，再看要不要按空闲过期。
 *
 * 自动提交走的是**现有的**阶段一 `commitPhase1`（§10.2.1），不在这里另造归档流程；
 * 过期判定见 `session-expiry.ts`。一个会话失败不能让其它会话的自动提交停掉，所以
 * 入口是 `processSessionSafely`。
 */

import { ComemError, errorMessage } from '../../domain/errors.js';
import type { Session } from '../../domain/session.js';
import type { Uri } from '../../domain/uri.js';

import type { CommitPhase1Result } from '../../services/session.js';

import type { SessionAutoCommitPort, SessionOutcome, SessionRoundPorts } from './contracts.js';
import { expireSession, idleSecondsOf } from './session-expiry.js';

export async function processSessionSafely(
  ports: SessionRoundPorts,
  sessionUri: Uri,
  now: Date,
): Promise<SessionOutcome> {
  try {
    return await processSession(ports, sessionUri, now);
  } catch (error) {
    ports.logger.error('会话调度失败，已跳过。', {
      uri: sessionUri.toString(),
      error: errorMessage(error),
    });
    return 'skipped';
  }
}

/** 读会话；「建了一半」（有目录、没有 `.meta.json`）返回 `null`，不是错误。 */
async function loadSession(sessions: SessionAutoCommitPort, sessionUri: Uri): Promise<Session | null> {
  try {
    return await sessions.load(sessionUri);
  } catch (error) {
    if (error instanceof ComemError && error.code === 'NOT_FOUND') {
      return null;
    }
    throw error;
  }
}

/**
 * 单个会话的判定与动作。只被 `processSessionSafely` 调用：异常隔离在那一层，这里
 * 让错误正常抛出。
 */
async function processSession(
  ports: SessionRoundPorts,
  sessionUri: Uri,
  now: Date,
): Promise<SessionOutcome> {
  const session = await loadSession(ports.sessions, sessionUri);
  if (session === null || session.status === 'archived') {
    // 建了一半的会话，或已经归档过的会话：不再自动提交。
    return 'skipped';
  }

  if (ports.sessions.shouldAutoCommit(session, now)) {
    let committed: CommitPhase1Result;
    try {
      committed = await ports.sessions.commitPhase1(sessionUri);
    } catch (error) {
      if (error instanceof ComemError && error.code === 'INVALID_ARGUMENT') {
        // `keepRecentCount` 覆盖了全部消息：没有可归档的内容，等更多消息进来就好。
        // 这不是错误（一条超长消息也会满足 token 阈值），按 error 记会每 30 秒刷
        // 一行，把真正的故障埋掉。
        ports.logger.debug('会话没有可归档的消息，跳过本轮。', {
          uri: sessionUri.toString(),
          messageCount: session.messageCount,
          reason: error.message,
        });
        return 'skipped';
      }
      throw error;
    }
    ports.logger.info('会话已自动提交。', {
      uri: sessionUri.toString(),
      archiveUri: committed.archiveUri.toString(),
      archivedCount: committed.archivedCount,
      taskId: committed.taskId,
      pendingTokens: session.pendingTokens,
      messageCount: session.messageCount,
    });
    return 'committed';
  }

  const idleSeconds = idleSecondsOf(ports.logger, session, now);
  if (idleSeconds === null || idleSeconds < ports.expiry.idleTimeoutSeconds) {
    return 'skipped';
  }
  // 0 = 关。必须显式判断：`idleSeconds >= 0` 恒为真，漏掉这一行会让「关」变成
  // 「所有会话每轮都过期」。
  if (ports.expiry.idleTimeoutSeconds <= 0) {
    return 'skipped';
  }

  return expireSession(ports, sessionUri, idleSeconds);
}
