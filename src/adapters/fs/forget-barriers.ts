import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ComemError, fsErrorCode } from '../../domain/errors.js';
import type { Uri } from '../../domain/uri.js';
import { writeFileAtomic } from './atomic-write.js';
import type { ContentStore } from './content-store.js';
import { parseDocument } from './frontmatter.js';

export class ForgetBarriers {
  constructor(private readonly dataDir: string) {}

  async record(uri: Uri, store?: ContentStore): Promise<void> {
    const directory = join(this.dataDir, '_meta', 'forgotten');
    await mkdir(directory, { recursive: true });
    await writeFileAtomic(this.path(uri), JSON.stringify({ uri: uri.toString(), forgottenAt: new Date().toISOString() }),
      (error) => new ComemError('INTERNAL', '无法保存删除记录，未删除内容。', { cause: String(error) }));
    if (store !== undefined) await this.recordEntities(uri, store);
  }

  private async recordEntities(uri: Uri, store: ContentStore): Promise<void> {
    const stat = await store.stat(uri);
    if (stat === null) return;
    if (stat.kind === 'directory') {
      for (const entry of await store.list(uri)) await this.recordEntities(entry.uri, store);
      return;
    }
    const data = parseDocument(Buffer.from(await store.readBytes(uri)).toString('utf8')).data;
    if (data['memory_type'] !== 'entities' || typeof data['entity_id'] !== 'string') return;
    const id = data['entity_id'];
    await writeFileAtomic(this.entityPath(id), JSON.stringify({ entityId: id, forgottenAt: new Date().toISOString() }),
      (error) => new ComemError('INTERNAL', '无法保存实体删除记录，未删除内容。', { cause: String(error) }));
  }

  async entityCutoff(id: string): Promise<string | null> {
    try {
      const record: unknown = JSON.parse(await readFile(this.entityPath(id), 'utf8'));
      if (typeof record !== 'object' || record === null || !('forgottenAt' in record) ||
        typeof record.forgottenAt !== 'string' || !Number.isFinite(Date.parse(record.forgottenAt))) {
        throw new ComemError('INTERNAL', '实体删除记录损坏，自动记忆写入已停止。');
      }
      return new Date(record.forgottenAt).toISOString();
    } catch (error) { if (fsErrorCode(error) === 'ENOENT') return null; throw error; }
  }

  private entityPath(id: string): string {
    return join(this.dataDir, '_meta', 'forgotten', `entity-${createHash('sha256').update(id.toLowerCase()).digest('hex')}.json`);
  }

  async cutoff(uri: Uri): Promise<string | null> {
    let latest: string | null = null;
    for (let current: Uri | null = uri; current !== null; current = current.parent()) {
      try {
        const record: unknown = JSON.parse(await readFile(this.path(current), 'utf8'));
        if (typeof record !== 'object' || record === null || !('forgottenAt' in record) ||
            typeof record.forgottenAt !== 'string' || !Number.isFinite(Date.parse(record.forgottenAt))) {
          throw new ComemError('INTERNAL', '删除记录损坏，自动记忆写入已停止。');
        }
        const timestamp = new Date(record.forgottenAt).toISOString();
        if (latest === null || timestamp > latest) latest = timestamp;
      } catch (error) { if (fsErrorCode(error) !== 'ENOENT') throw error; }
    }
    return latest;
  }

  private path(uri: Uri): string {
    return join(this.dataDir, '_meta', 'forgotten', `${createHash('sha256').update(uri.toString()).digest('hex')}.json`);
  }
}
