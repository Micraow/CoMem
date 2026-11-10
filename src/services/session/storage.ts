/**
 * 会话目录形状与 `.meta.json` / `messages.jsonl` 的读取辅助。
 *
 * 路径常量集中在这里：`services/session/` 下多个模块都要拼 `history/` 与
 * `messages.jsonl`，各写一份时目录名一漂就互相看不见。
 */

import { createHash, randomUUID } from 'node:crypto';

import type { ContentStore } from '../../adapters/fs/content-store.js';
import type { MetadataFileStore } from '../../adapters/fs/metadata-file.js';
import { ComemError } from '../../domain/errors.js';
import type { SessionMeta } from '../../domain/session.js';
import type { Uri } from '../../domain/uri.js';

import { readMessages } from './messages.js';

/** 会话目录名（§6.5 的 `sessions/sess_xxx/`）。 */
export const SESSIONS_DIRECTORY_NAME = 'sessions';

/** §6.5 的会话 ID 前缀与随机段长度（`sess_7f3a91c2`）。 */
const SESSION_ID_PREFIX = 'sess_';
const SESSION_ID_RANDOM_HEX_LENGTH = 8;

/** 归档目录名（§6.5 的 `history/`），可由配置覆盖。 */
export const DEFAULT_ARCHIVE_DIRECTORY_NAME = 'history';

/** §10.2 的归档序号：`archive_001`、`archive_002`…… */
export const ARCHIVE_DIRECTORY_PREFIX = 'archive_';
export const ARCHIVE_SEQUENCE_DIGITS = 3;
export const ARCHIVE_DIRECTORY_PATTERN = /^archive_(\d+)$/;

/** `messages.jsonl` 文件名（§6.5）。 */
const MESSAGES_FILE_NAME = 'messages.jsonl';

export function createSessionId(): string {
  return `${SESSION_ID_PREFIX}${randomUUID().replaceAll('-', '').slice(0, SESSION_ID_RANDOM_HEX_LENGTH)}`;
}

export function archiveSequence(name: string): number {
  return Number(ARCHIVE_DIRECTORY_PATTERN.exec(name)?.[1] ?? '0');
}

export function historyUri(sessionUri: Uri, archiveDirectoryName: string): Uri {
  return sessionUri.child(archiveDirectoryName);
}

export function messagesUri(directoryUri: Uri): Uri {
  return directoryUri.child(MESSAGES_FILE_NAME);
}

export async function requireSession(
  metadata: MetadataFileStore,
  sessionUri: Uri,
): Promise<SessionMeta> {
  const meta = await metadata.readSession(sessionUri);
  if (meta === null) {
    throw new ComemError('NOT_FOUND', `会话不存在：${sessionUri.toString()}`, {
      uri: sessionUri.toString(),
    });
  }
  return meta;
}

/** 未归档的消息数；`messages.jsonl` 缺失按 0（建了一半的会话）。 */
export async function countMessages(
  store: ContentStore,
  sessionUri: Uri,
): Promise<number> {
  try {
    return (await readMessages(store, messagesUri(sessionUri))).length;
  } catch (error) {
    if (error instanceof ComemError && error.code === 'NOT_FOUND') {
      return 0;
    }
    throw error;
  }
}

/**
 * `messages.jsonl` 的 sha256。阶段二读回来先校验它（§10.1）。
 *
 * `node:crypto` 可以用：它是纯计算，不碰文件系统。`services/` 的分层规则只禁
 * `node:fs` / `node:sqlite`（§4.2），哈希算法本身没有 IO。
 */
export async function messagesSha256(
  store: ContentStore,
  messagesUri: Uri,
): Promise<string> {
  const bytes = await store.readBytes(messagesUri);
  return createHash('sha256').update(bytes).digest('hex');
}
