/**
 * `history/` 下的归档目录列表与「已归档消息 ID → 归档 URI」索引。
 *
 * 索引是进程内可变状态，由 `SessionService` 持有（`ports.archivedMessageIndex`）：
 * 这里只负责懒加载与增量写入，不新建缓存。
 */

import type { ContentStore } from '../../adapters/fs/content-store.js';
import type { SessionMessage } from '../../domain/session.js';
import type { Uri } from '../../domain/uri.js';

import type { SessionPorts } from './ports.js';
import {
  archiveSequence,
  ARCHIVE_DIRECTORY_PATTERN,
  historyUri,
} from './storage.js';

/** `history/` 下的归档目录，按序号升序。 */
export async function listArchiveUris(
  store: ContentStore,
  historyUri: Uri,
): Promise<readonly Uri[]> {
  if (!(await store.exists(historyUri))) {
    return [];
  }
  const entries = await store.list(historyUri);
  return entries
    .filter((entry) => entry.kind === 'directory' && ARCHIVE_DIRECTORY_PATTERN.test(entry.uri.name))
    .map((entry) => entry.uri)
    .sort((left, right) => archiveSequence(left.name) - archiveSequence(right.name));
}

/**
 * 已归档消息 ID → 归档目录 URI。按会话懒加载。
 *
 * 只读归档元数据的 `archivedMessageIds`，不解析归档的 `messages.jsonl`——后者只在
 * 真的重投了一条已归档消息时读一次，用来把原消息（含原 turn）原样返回。
 *
 * 缓存是进程内的。当前架构里同一个会话只有一个写入方（本服务）：hook 的 `Stop`
 * worker 通过 HTTP 回到本进程，`ingest` 命令只写自己新建的随机会话。绕过本服务
 * 手改磁盘会让索引过期，与 `.meta.json` 里 `pendingTokens` 是缓存同一类假设。
 */
export async function loadArchivedMessageIndex(
  ports: SessionPorts,
  sessionUri: Uri,
): Promise<Map<string, Uri>> {
  const key = sessionUri.toString();
  const cached = ports.archivedMessageIndex.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const index = new Map<string, Uri>();
  for (const archiveUri of await listArchiveUris(ports.store, historyUri(sessionUri, ports.archiveDirectoryName))) {
    const meta = await ports.meta.readArchive(archiveUri);
    for (const id of meta?.phase1.archivedMessageIds ?? []) {
      index.set(id, archiveUri);
    }
  }
  ports.archivedMessageIndex.set(key, index);
  return index;
}

/** 归档写盘之后把消息 ID 记进进程内索引；索引还没建时留给下一次懒加载。 */
export function recordArchivedMessages(
  ports: SessionPorts,
  sessionUri: Uri,
  archiveUri: Uri,
  archived: readonly SessionMessage[],
): void {
  const index = ports.archivedMessageIndex.get(sessionUri.toString());
  if (index === undefined) {
    return;
  }
  for (const message of archived) {
    index.set(message.id, archiveUri);
  }
}
