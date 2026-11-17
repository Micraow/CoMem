import { Uri } from '../../domain/uri.js';
import type { MemoryRecord } from '../memory.js';

/** 产生本次经验的归档、实际引用的案例，以及案例自己的归档来源。 */
export function experienceSources(
  cases: readonly MemoryRecord[],
  currentArchive: Uri,
): readonly Uri[] {
  return [...new Set([
    currentArchive.toString(),
    ...cases.flatMap((record) => [
      record.uri.toString(),
      ...record.sources,
    ]),
  ])].flatMap((source) => {
    const uri = Uri.tryParse(source);
    return uri === null ? [] : [uri];
  });
}
