import type { ContentStore } from '../../adapters/fs/content-store.js';
import { resolveMemoryTarget } from '../../domain/consolidation.js';
import { Uri } from '../../domain/uri.js';
import { getMemoryType } from '../../domain/memory-types/index.js';
import { parseMemoryDocument, serializeMemoryDocument } from './document.js';

export async function updateMovedMemory(store: ContentStore, uri: Uri): Promise<void> {
  const stat = await store.stat(uri);
  if (stat?.kind === 'directory') {
    for (const entry of await store.list(uri)) await updateMovedMemory(store, entry.uri);
    return;
  }
  if (stat === null || !uri.segments.includes('memories') || uri.segments.includes('.history')) return;
  const raw = Buffer.from(await store.readBytes(uri)).toString('utf8');
  const document = parseMemoryDocument(raw);
  if (document === null) return;
  const schema = getMemoryType(document.memoryType);
  if (schema === undefined) return;
  const segments = uri.segments;
  const root = Uri.parse(`comem://${uri.scope}/${uri.rootId}`);
  const scope = segments[0] === 'projects' ? root.child('projects', segments[1] ?? '') : root;
  const target = resolveMemoryTarget(scope, uri);
  if (target?.schema.type !== schema.type) return;
  await store.writeBytes(uri, Buffer.from(serializeMemoryDocument({ ...document, uri, schema,
    fields: { ...document.fields, ...target.identity } })));
}
