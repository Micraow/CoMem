import { randomUUID } from 'node:crypto';
import type { SkippedMemoryOperation } from '../../../domain/archive.js';
import type { MemoryStructure } from '../../../domain/memory-structure.js';
import { getMemoryType } from '../../../domain/memory-types/index.js';
import type { Uri } from '../../../domain/uri.js';
import { renderMemoryUri } from '../../memory/document.js';
import { NEW_PAGE_ID_START, type ExtractPage } from '../../prompts/extract.js';
import { Uri as MemoryUri } from '../../../domain/uri.js';
import type { MemoryRecord } from '../../memory/query.js';

export async function reuseEntityIdentities(
  structures: readonly (readonly [string, MemoryStructure])[], read?: (uri: Uri) => Promise<MemoryRecord | null>,
): Promise<readonly (readonly [string, MemoryStructure])[]> {
  if (read === undefined) return structures;
  const replacements = new Map<string, string>();
  for (const [uri, structure] of structures) {
    if (structure.entityId === undefined) continue;
    const existing = await read(MemoryUri.parse(uri));
    if (existing?.entityId !== undefined) replacements.set(structure.entityId, existing.entityId);
  }
  return structures.map(([uri, structure]) => [uri, { ...structure,
    ...(structure.entityId === undefined ? {} : { entityId: replacements.get(structure.entityId) ?? structure.entityId }),
    ...(structure.entityRefs === undefined ? {} : { entityRefs: structure.entityRefs.map((id) => replacements.get(id) ?? id) }),
  }]);
}

interface EntityOperation {
  readonly kind: string;
  readonly pageId: number;
  readonly type?: string;
  readonly identity?: Readonly<Record<string, string>>;
  readonly entityPages?: readonly number[];
}

export function resolveEntityAssignments(
  operations: readonly EntityOperation[], pages: ReadonlyMap<number, ExtractPage>,
  accepted: ReadonlyMap<string, string>, skipped: SkippedMemoryOperation[], scope: Uri,
): readonly (readonly [string, MemoryStructure])[] {
  const targets = new Map<number, { uri: string; type: string; id?: string }>();
  const structures = new Map<string, MemoryStructure>();
  const deleted = new Set(operations.filter((op) => op.kind === 'delete').map((op) => op.pageId));
  for (const page of pages.values()) {
    if (!deleted.has(page.pageId)) targets.set(page.pageId, { uri: page.uri, type: page.memoryType, id: page.entityId });
  }
  for (const op of operations) {
    if (op.kind !== 'upsert' || op.type === undefined || op.identity === undefined) continue;
    const schema = getMemoryType(op.type);
    if (schema === undefined) continue;
    let uri: string;
    try { uri = renderMemoryUri(scope, schema, op.identity).toString(); } catch { continue; }
    if (accepted.get(uri) !== op.type || deleted.has(op.pageId)) continue;
    const existing = targets.get(op.pageId);
    if (op.pageId < NEW_PAGE_ID_START && existing?.uri !== uri) continue;
    if (existing !== undefined && existing.uri !== uri) {
      skipped.push({ memoryType: op.type, reasonCode: 'duplicate_entity_page', reason: `编号 ${op.pageId} 指向多个目标，未建立实体引用。` });
      targets.delete(op.pageId);
      continue;
    }
    const knownId = [...pages.values()].find((page) => page.uri === uri)?.entityId;
    const id = op.type === 'entities' ? existing?.id ?? knownId ?? structures.get(uri)?.entityId ?? randomUUID() : undefined;
    targets.set(op.pageId, { uri, type: op.type, id });
    if (id !== undefined) structures.set(uri, { ...structures.get(uri), entityId: id });
  }
  for (const op of operations) {
    const target = targets.get(op.pageId);
    if (op.kind !== 'upsert' || op.entityPages === undefined || target === undefined || !accepted.has(target.uri)) continue;
    const refs: string[] = [];
    let invalid = false;
    for (const pageId of op.entityPages) {
      const entity = targets.get(pageId);
      if (entity?.type !== 'entities' || entity.id === undefined) {
        skipped.push({ memoryType: target.type, reasonCode: 'invalid_entity_page', reason: `编号 ${pageId} 不是已确认的实体页面，保留原有引用。` });
        invalid = true;
        break;
      }
      refs.push(entity.id);
    }
    if (!invalid) structures.set(target.uri, { ...structures.get(target.uri), entityRefs: [...new Set(refs)] });
  }
  return [...structures];
}
