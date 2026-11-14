import type { DatabaseSync } from 'node:sqlite';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { ContentStore } from '../../adapters/fs/content-store.js';
import type { PathLockManager } from '../../adapters/fs/lock.js';
import type { Logger } from '../../domain/log.js';
import { errorMessage } from '../../domain/errors.js';
import { persistMemoryLinks } from '../../adapters/fs/memory-links.js';
import type { MemoryLinkRowInput } from '../../adapters/sqlite/memory-link-repository.js';
import { text } from '../../adapters/sqlite/row.js';
import { Uri } from '../../domain/uri.js';
import { parseDocument } from '../../adapters/fs/frontmatter.js';
import { decodeMemoryLink } from '../../domain/stored-memory-link.js';
import { writeFileAtomic } from '../../adapters/fs/atomic-write.js';
import { randomUUID } from 'node:crypto';

export async function migrateMemoryLinks(db: DatabaseSync, dataDir: string, store: ContentStore, locks: PathLockManager, logger: Logger): Promise<void> {
  if (db.prepare('SELECT 1 FROM memory_structure_migration WHERE id = 1').get() !== undefined) return;
  const rows: MemoryLinkRowInput[] = db.prepare("SELECT * FROM memory_link WHERE link_type <> 'derived_from' ORDER BY from_uri, to_uri, match_text")
    .all().map((row) => ({ fromUri: text(row['from_uri']), toUri: text(row['to_uri']), linkType: text(row['link_type']),
      weight: Number(row['weight']), matchText: text(row['match_text']), description: text(row['description']) }));
  if (rows.length === 0) { db.prepare('INSERT INTO memory_structure_migration VALUES (1, ?)').run(new Date().toISOString()); return; }
  const pending = new Set<string>();
  for (const from of new Set(rows.map((row) => row.fromUri))) {
    if (db.prepare('SELECT 1 FROM memory_link_migrated WHERE uri = ?').get(from) !== undefined) continue;
    try {
      const data = parseDocument(Buffer.from(await store.readBytes(Uri.parse(from))).toString('utf8')).data;
      const values = data['memory_links'];
      const links = Array.isArray(values) ? values.map((value: unknown) => decodeMemoryLink(String(value))) : [];
      if (rows.filter((row) => row.fromUri === from).some((row) => !links.some((link) =>
        link.toUri === row.toUri && link.matchText === row.matchText && link.linkType === row.linkType && link.description === row.description && link.weight >= row.weight))) pending.add(from);
      else db.prepare('INSERT OR IGNORE INTO memory_link_migrated VALUES (?)').run(from);
    } catch { pending.add(from); }
  }
  if (pending.size === 0) { db.prepare('INSERT INTO memory_structure_migration VALUES (1, ?)').run(new Date().toISOString()); return; }
  const directory = join(dataDir, '_meta', 'migration');
  await mkdir(directory, { recursive: true });
  const name = `memory-links-${randomUUID()}.json`;
  const backup = join(directory, name);
  await writeFileAtomic(backup, JSON.stringify({ format: 'comem.memory-links.v1', links: rows }, null, 2), (error) => new Error(errorMessage(error)));
  const failures = [];
  for (const from of pending) {
    try {
      await persistMemoryLinks(store, locks, rows.filter((row) => row.fromUri === from));
      db.prepare('INSERT OR IGNORE INTO memory_link_migrated VALUES (?)').run(from);
    }
    catch (error) { failures.push({ uri: from, error: errorMessage(error) }); }
  }
  if (failures.length > 0) logger.warn('部分旧关联无法迁入记忆文件，原数据库与完整导出已保留。', { backup, failures });
  else {
    db.prepare('INSERT INTO memory_structure_migration VALUES (1, ?)').run(new Date().toISOString());
    logger.info('旧关联已保存在记忆文件。', { backup, count: rows.length });
  }
}
