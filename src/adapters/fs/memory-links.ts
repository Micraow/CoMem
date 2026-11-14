import type { MemoryLinkRowInput } from '../sqlite/memory-link-repository.js';
import type { ContentStore } from './content-store.js';
import type { PathLockManager } from './lock.js';
import { Uri } from '../../domain/uri.js';
import { decodeMemoryLink } from '../../domain/stored-memory-link.js';
import { parseDocument, serializeDocument } from './frontmatter.js';

export async function persistMemoryLinks(store: ContentStore, locks: Pick<PathLockManager, 'withLock'>, rows: readonly MemoryLinkRowInput[]): Promise<void> {
  const grouped = new Map<string, MemoryLinkRowInput[]>();
  for (const row of rows) grouped.set(row.fromUri, [...grouped.get(row.fromUri) ?? [], row]);
  for (const [from, links] of grouped) {
    const uri = Uri.parse(from);
    await locks.withLock(uri, 'exact', async () => {
      const document = parseDocument(Buffer.from(await store.readBytes(uri)).toString('utf8'));
      const values = document.data['memory_links'];
      const merged = new Map((Array.isArray(values) ? values : []).map((value: unknown) => {
        if (typeof value !== 'string') throw new Error('memory_links 含非字符串记录。');
        const link = decodeMemoryLink(value);
        return [JSON.stringify([link.toUri, link.matchText]), link];
      }));
      for (const row of links) {
        const link = { toUri: row.toUri, linkType: row.linkType, weight: row.weight, matchText: row.matchText, description: row.description };
        const key = JSON.stringify([link.toUri, link.matchText]);
        merged.set(key, { ...link, weight: Math.max(merged.get(key)?.weight ?? 0, link.weight) });
      }
      const text = serializeDocument(document.body, { ...document.data, memory_links: [...merged.values()].map((link) => JSON.stringify(link)) });
      if (JSON.stringify(values) === JSON.stringify([...merged.values()].map((link) => JSON.stringify(link)))) return;
      await store.writeBytes(uri, Buffer.from(text));
    });
  }
}
