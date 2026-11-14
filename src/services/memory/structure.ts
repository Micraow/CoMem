import { randomUUID } from 'node:crypto';
import { invalidArgument } from '../../domain/errors.js';
import { memoryStructure, type MemoryStructure } from '../../domain/memory-structure.js';

export function nextMemoryStructure(type: string, existing: MemoryStructure | null, incoming?: MemoryStructure): MemoryStructure {
  const checked = memoryStructure({
    ...(incoming?.entityId === undefined ? {} : { entity_id: incoming.entityId }),
    ...(incoming?.entityRefs === undefined ? {} : { entity_refs: incoming.entityRefs }),
    ...(incoming?.links === undefined ? {} : { memory_links: incoming.links }),
  });
  if (checked.entityId !== undefined && type !== 'entities') throw invalidArgument('只有实体记忆可以分配实体编号。', {});
  if (existing?.entityId !== undefined && checked.entityId !== undefined && existing.entityId !== checked.entityId) {
    throw invalidArgument('已有实体编号不能被替换。', { reason: 'entity_identity_conflict' });
  }
  return {
    ...(existing?.entityId === undefined ? {} : { entityId: existing.entityId }),
    ...(existing?.entityRefs === undefined ? {} : { entityRefs: existing.entityRefs }),
    ...(existing?.links === undefined ? {} : { links: existing.links }),
    ...checked,
    ...(type === 'entities' ? { entityId: existing?.entityId ?? checked.entityId ?? randomUUID() } : {}),
  };
}
