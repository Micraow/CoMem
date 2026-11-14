import { invalidArgument } from './errors.js';
import { Uri } from './uri.js';

export interface StoredMemoryLink {
  readonly toUri: string;
  readonly linkType: string;
  readonly weight: number;
  readonly matchText: string;
  readonly description: string;
}

export function decodeMemoryLink(value: string): StoredMemoryLink {
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed !== 'object' || parsed === null || !('toUri' in parsed) || typeof parsed.toUri !== 'string' ||
    Uri.tryParse(parsed.toUri) === null || !('linkType' in parsed) || typeof parsed.linkType !== 'string' ||
    !('weight' in parsed) || typeof parsed.weight !== 'number' || !Number.isFinite(parsed.weight) ||
    !('matchText' in parsed) || typeof parsed.matchText !== 'string' ||
    !('description' in parsed) || typeof parsed.description !== 'string') {
    throw invalidArgument('memory_links 含无效的关联记录。', {});
  }
  return { toUri: parsed.toUri, linkType: parsed.linkType, weight: parsed.weight,
    matchText: parsed.matchText, description: parsed.description };
}
