import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runIngest } from '../../../src/commands/ingest.js';

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'comem-ingest-config-'));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(tempDir, { recursive: true, force: true });
});

describe('pnpm ingest 的配置入口', () => {
  /**
   * 回归：`--config` 必须被读。dry-run 只报数，坏配置要在建容器 / 读源之前就报错。
   */
  it('--config 坏 YAML 必须报错，不能静默用默认值', async () => {
    vi.stubEnv('COMEM_DATA_DIR', join(tempDir, 'data'));
    const bad = join(tempDir, 'bad.yaml');
    await writeFile(bad, 'not: [valid', 'utf8');

    await expect(
      runIngest({
        argv: ['--config', bad],
        source: 'claude-code',
        dryRun: true,
      }),
    ).rejects.toThrow(/YAML/);
  });
});
