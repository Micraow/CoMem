import { z } from 'zod';
import { ComemError } from '../../domain/errors.js';
import { preferencesMemoryType } from '../../domain/memory-types/preferences.js';
import type { Uri } from '../../domain/uri.js';
import { renderMemoryUri, type MemoryWriteResult } from '../memory.js';
import type { PreferenceEvidence } from './evidence.js';
import type { DreamerServiceDeps } from './types.js';

export const inferenceSchema = z.object({
  topic: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u).max(64),
  condition: z.string(),
  preference: z.string(),
  evidence: z.array(z.object({ id: z.number().int().positive(), quote: z.string() })),
});

export async function writeInferences(
  deps: DreamerServiceDeps,
  scope: Uri,
  candidates: readonly z.infer<typeof inferenceSchema>[],
  evidence: readonly PreferenceEvidence[],
  authorize: (uri: Uri) => Promise<boolean>,
  dryRun: boolean,
  currentArchive?: Uri,
): Promise<{ writes: MemoryWriteResult[]; previews: string[] }> {
  const writes: MemoryWriteResult[] = [];
  const previews: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const condition = candidate.condition.trim();
    const preference = candidate.preference.trim();
    const citations = candidate.evidence.map(({ id, quote }) => ({ entry: evidence[id - 1], quote: quote.trim() }));
    if (!condition || !preference || citations.some(({ entry, quote }) => !quote || !entry?.text.includes(quote))) continue;
    const supports = citations.flatMap(({ entry }) => entry === undefined ? [] : [entry]);
    const normalize = (text: string) => text.replace(/\s+/gu, ' ').trim().toLowerCase();
    const independent = citations.some((left) => citations.some((right) => left.entry !== undefined && right.entry !== undefined &&
      !left.entry.session.equals(right.entry.session) && normalize(left.entry.text) !== normalize(right.entry.text) &&
      normalize(left.quote) !== normalize(right.quote)));
    if (!independent) continue;
    if (currentArchive !== undefined && !supports.some(({ archive }) => archive.equals(currentArchive))) continue;
    const topic = `inferred-${candidate.topic}`;
    const uri = renderMemoryUri(scope, preferencesMemoryType, { topic });
    if (seen.has(topic)) continue;
    seen.add(topic);
    if (!(await authorize(uri))) continue;
    const explicit = renderMemoryUri(scope, preferencesMemoryType, { topic: candidate.topic });
    if (await deps.stat.stat(explicit) !== null) continue;
    const existing = await deps.stat.stat(uri);
    if (existing !== null) {
      // A retry after the file write can still account for it in this archive's diff.
      if (currentArchive !== undefined && existing.kind === 'file') {
        const record = await deps.memory.read(uri);
        if (record?.memoryType === preferencesMemoryType.type && record.sources.includes(currentArchive.toString())) {
          const content = record.fields['content'];
          if (typeof content === 'string') writes.push({ uri, memoryType: record.memoryType, created: true, written: false, before: null, after: content });
        }
      }
      continue;
    }
    if (dryRun) {
      previews.push(uri.toString());
      continue;
    }
    const sources = [...new Map(supports.map(({ archive }) => [archive.toString(), archive])).values()];
    const evidenceAt = supports.map(({ createdAt }) => createdAt).sort()[0];
    const content = `推断偏好（需以用户明确表达为准）\n\n适用条件：${condition}\n\n${preference}\n\n证据：\n${citations.map(({ entry, quote }) => `- ${entry?.archive.toString()}：${JSON.stringify(quote)}`).join('\n')}`;
    try {
      const write = await deps.memory.upsertMemory(scope, preferencesMemoryType, {
        uri, reviewRequired: true, provenance: { sources, evidenceAt },
        update: (current) => Object.keys(current).length === 0 ? { topic, content } : null,
      });
      if (write.written) {
        writes.push(write);
        try {
          await deps.archive?.links.addLinks(uri, sources.map((toUri) => ({ toUri, linkType: 'derived_from' as const })));
        } catch (error) {
          deps.logger.error('Dreamer 溯源索引写入失败，可从 sources 重建。', { uri: uri.toString(), error: ComemError.from(error).message });
        }
      }
    } catch (error) {
      const failure = ComemError.from(error);
      if (failure.details?.['reason'] !== 'forgotten_evidence') {
        throw new ComemError(failure.code, failure.message, { ...failure.details, preferenceAdds: writes.map(({ uri: written }) => written.toString()) });
      }
    }
  }
  return { writes, previews };
}
