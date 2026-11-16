import type { ContentStore } from '../../adapters/fs/content-store.js';
import type { MetadataFileStore } from '../../adapters/fs/metadata-file.js';
import type { AclFileStore } from '../../adapters/fs/acl-file.js';
import { ComemError } from '../../domain/errors.js';
import type { SessionMessage } from '../../domain/session.js';
import type { Uri } from '../../domain/uri.js';
import { listArchiveUris } from '../session/archive-index.js';
import { readMessages } from '../session/messages.js';
import { DEFAULT_ARCHIVE_DIRECTORY_NAME, messagesUri, SESSIONS_DIRECTORY_NAME } from '../session/storage.js';

// Prompt budget: at most 8 independently sampled sessions, up to 1,500 user-text characters each.
const MAX_SESSIONS = 8;
const SESSION_CHARS = 1500;
// Cap filesystem work and skip unusually large raw archives before loading them.
const MAX_ARCHIVE_BYTES = 256 * 1024;

export interface PreferenceEvidence {
  readonly archive: Uri;
  readonly session: Uri;
  readonly createdAt: string;
  readonly text: string;
}

export function userEvidence(archive: Uri, messages: readonly SessionMessage[]): PreferenceEvidence[] {
  const session = archive.parent()?.parent();
  if (session == null) return [];
  const evidence: PreferenceEvidence[] = [];
  let remaining = SESSION_CHARS;
  for (const message of [...messages].reverse()) {
    if (message.role !== 'user' || !Number.isFinite(Date.parse(message.createdAt))) continue;
    const text = message.parts.flatMap((part) => part.kind === 'text' ? [part.text] : []).join('\n').trim().slice(-remaining);
    if (text === '') continue;
    evidence.push({ archive, session, createdAt: new Date(message.createdAt).toISOString(), text });
    remaining -= text.length;
    if (remaining === 0) break;
  }
  return evidence.reverse();
}

/** Derived content must not leave a subtree with its own ACL, even when the runner can read it. */
export async function sharesScopeAcl(acl: Pick<AclFileStore, 'read'>, scope: Uri, directory: Uri): Promise<boolean> {
  for (let node: Uri | null = directory; node !== null && scope.isAncestorOf(node); node = node.parent()) {
    if (await acl.read(node) !== null) return false;
  }
  return scope.equals(directory) || scope.isAncestorOf(directory);
}

export async function recentUserEvidence(
  store: ContentStore,
  acl: Pick<AclFileStore, 'read'>,
  metadata: Pick<MetadataFileStore, 'readArchive'>,
  scope: Uri,
  currentArchive?: Uri,
): Promise<PreferenceEvidence[]> {
  // Group transcripts do not establish which individual expressed a preference.
  if (scope.scope !== 'user') return [];
  const directory = scope.child(SESSIONS_DIRECTORY_NAME);
  if (!(await store.exists(directory))) return [];
  const currentSession = currentArchive?.parent()?.parent();
  const sessions = (await store.list(directory)).filter((item) => item.kind === 'directory' && !currentSession?.equals(item.uri))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, MAX_SESSIONS);
  const result: PreferenceEvidence[] = [];
  for (const session of sessions) {
    const archives = await listArchiveUris(store, session.uri.child(DEFAULT_ARCHIVE_DIRECTORY_NAME));
    const archive = archives.at(-1);
    if (archive === undefined || !(await sharesScopeAcl(acl, scope, archive)) ||
      (await metadata.readArchive(archive))?.phase1.status !== 'ready') continue;
    const uri = messagesUri(archive);
    const stat = await store.stat(uri);
    if (stat?.kind !== 'file' || stat.size > MAX_ARCHIVE_BYTES) continue;
    try {
      result.push(...userEvidence(archive, await readMessages(store, uri)));
    } catch (error) {
      if (ComemError.from(error).code !== 'NOT_FOUND') throw error;
    }
  }
  return result;
}
