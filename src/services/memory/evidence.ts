import { invalidArgument } from '../../domain/errors.js';
import type { SessionMessage } from '../../domain/session.js';
import type { MemoryDocument } from './document.js';
import type { ForgetBarriers } from '../../adapters/fs/forget-barriers.js';
import type { Uri } from '../../domain/uri.js';
import type { MemoryStructure } from '../../domain/memory-structure.js';

export function evidenceTime(messages: readonly SessionMessage[]): string | undefined {
  const times = messages.filter((message) => message.role !== 'system')
    .map((message) => Date.parse(message.createdAt)).filter(Number.isFinite);
  return times.length === 0 ? undefined : new Date(Math.max(...times)).toISOString();
}

export function evidenceTimestamp(value: unknown): string | null {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
}

export function assertCurrentEvidence(existing: MemoryDocument | null, incoming: string | undefined): void {
  if (incoming === undefined) return;
  const timestamp = evidenceTimestamp(incoming);
  if (timestamp === null) throw invalidArgument('记忆材料的时间必须是有效时间戳。', { reason: 'invalid_evidence_time' });
  if (existing?.evidenceAt != null && timestamp < existing.evidenceAt) {
    throw invalidArgument('较早的材料不能覆盖或删除较新的记忆。', { reason: 'stale_evidence', evidenceAt: timestamp, currentEvidenceAt: existing.evidenceAt });
  }
}

export async function assertRememberable(barriers: ForgetBarriers | undefined, uri: Uri, provenance: { readonly evidenceAt?: string } | undefined, structure?: MemoryStructure): Promise<void> {
  if (provenance === undefined) return;
  const cutoffs = await Promise.all([barriers?.cutoff(uri), ...[structure?.entityId, ...structure?.entityRefs ?? []]
    .filter((id): id is string => id !== undefined).map((id) => barriers?.entityCutoff(id))]);
  const cutoff = cutoffs.filter((value): value is string => value != null).sort().at(-1);
  if (cutoff != null && (provenance.evidenceAt === undefined || Date.parse(provenance.evidenceAt) <= Date.parse(cutoff))) {
    throw invalidArgument('已删除的记忆不能由删除前的材料重新生成。', { reason: 'forgotten_evidence' });
  }
}
