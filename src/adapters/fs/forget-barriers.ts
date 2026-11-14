import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ComemError, fsErrorCode } from '../../domain/errors.js';
import type { Uri } from '../../domain/uri.js';
import { writeFileAtomic } from './atomic-write.js';

export class ForgetBarriers {
  constructor(private readonly dataDir: string) {}

  async record(uri: Uri): Promise<void> {
    const directory = join(this.dataDir, '_meta', 'forgotten');
    await mkdir(directory, { recursive: true });
    await writeFileAtomic(this.path(uri), JSON.stringify({ uri: uri.toString(), forgottenAt: new Date().toISOString() }),
      (error) => new ComemError('INTERNAL', '无法保存删除记录，未删除内容。', { cause: String(error) }));
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
