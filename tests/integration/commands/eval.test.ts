import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runEval } from '../../../src/commands/eval.js';

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'comem-eval-config-'));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(tempDir, { recursive: true, force: true });
});

describe('pnpm eval 的配置入口', () => {
  /**
   * 回归：配置必须在读数据集、建任何容器之前加载。坏 YAML 不能等到第一个变体
   * 建容器时才报，更不能被当成「没有配置文件」。
   */
  it('--config 坏 YAML 必须报错，不能静默用默认值', async () => {
    vi.stubEnv('COMEM_DATA_DIR', join(tempDir, 'data'));
    const bad = join(tempDir, 'bad.yaml');
    await writeFile(bad, 'not: [valid', 'utf8');

    await expect(
      runEval({
        datasetPath: join(tempDir, 'missing-dataset.yaml'),
        k: 1,
        engines: ['fts5'],
        rerank: false,
        argv: ['--config', bad],
      }),
    ).rejects.toThrow(/YAML/);
  });

  /**
   * `--data-dir` 对 eval 没有意义（每个变体都跑在临时数据根里）。明确拒绝，
   * 不静默忽略——静默忽略会让人以为评估写进了自己的数据根。
   */
  it('--data-dir 被明确拒绝，而不是静默忽略', async () => {
    vi.stubEnv('COMEM_DATA_DIR', join(tempDir, 'data'));

    await expect(
      runEval({
        datasetPath: join(tempDir, 'missing-dataset.yaml'),
        k: 1,
        engines: ['fts5'],
        rerank: false,
        argv: ['--data-dir', join(tempDir, 'other-data')],
      }),
    ).rejects.toThrow(/--data-dir/);
  });
});
