import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const SERVER_BUDGET_RATIO = 0.8;

export async function contextDelivery(config, sessionId, epoch) {
  const key = createHash('sha256').update(JSON.stringify([config.baseUrl, config.token, sessionId, epoch])).digest('hex');
  const path = join(config.tmpDir ?? process.env.TMPDIR ?? '/tmp', `comem-delivery-${key}.json`);
  let previousDeliveryToken;
  try { previousDeliveryToken = JSON.parse(await readFile(path, 'utf8')).token; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return {
    previousDeliveryToken,
    async accepted() {
      if (previousDeliveryToken !== undefined) await unlink(path).catch((error) => { if (error.code !== 'ENOENT') throw error; });
    },
    async delivered(token) {
      if (typeof token !== 'string') return;
      await mkdir(config.tmpDir ?? process.env.TMPDIR ?? '/tmp', { recursive: true });
      const temporary = `${path}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify({ token }), { mode: 0o600 });
      try { await rename(temporary, path); }
      catch (error) { await unlink(temporary).catch(() => {}); throw error; }
    },
  };
}

export function contextBudget(http) {
  const remaining = http.remainingMs?.();
  return remaining === undefined ? undefined : Math.max(1, Math.floor(remaining * SERVER_BUDGET_RATIO));
}
