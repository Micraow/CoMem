import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

function epochPath(config, sessionId) {
  const key = createHash('sha256').update(`${config.baseUrl}\0${sessionId}`).digest('hex');
  return join(config.tmpDir, `comem-context-${key}.json`);
}

export async function contextEpoch(config, sessionId, reset = false) {
  const path = epochPath(config, sessionId);
  if (!reset) {
    try {
      return JSON.parse(await readFile(path, 'utf8')).epoch;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return 'default';
    }
  }
  const epoch = randomUUID();
  await mkdir(config.tmpDir, { recursive: true });
  const temporary = `${path}.${epoch}.tmp`;
  await writeFile(temporary, JSON.stringify({ epoch }), { mode: 0o600 });
  await rename(temporary, path);
  return epoch;
}
