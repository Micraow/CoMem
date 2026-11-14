import { invalidArgument } from './errors.js';
import { decodeMemoryLink } from './stored-memory-link.js';

export interface MemoryStructure {
  readonly entityId?: string;
  readonly entityRefs?: readonly string[];
  readonly links?: readonly string[];
}

function entityId(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw invalidArgument('实体编号必须是 UUID。', { reason: 'invalid_entity_id' });
  }
  return value.toLowerCase();
}

export function memoryStructure(data: Readonly<Record<string, unknown>>): MemoryStructure {
  const refs = data['entity_refs'];
  const links = data['memory_links'];
  if (refs !== undefined && (!Array.isArray(refs) || refs.some((value) => typeof value !== 'string'))) {
    throw invalidArgument('entity_refs 必须是实体编号数组。', {});
  }
  if (links !== undefined && (!Array.isArray(links) || links.some((value) => typeof value !== 'string'))) {
    throw invalidArgument('memory_links 必须是字符串数组。', {});
  }
  for (const link of (links ?? []) as string[]) decodeMemoryLink(link);
  return {
    ...(data['entity_id'] === undefined ? {} : { entityId: entityId(data['entity_id']) }),
    ...(refs === undefined ? {} : { entityRefs: [...new Set((refs as string[]).map(entityId))] }),
    ...(links === undefined ? {} : { links: links as string[] }),
  };
}
