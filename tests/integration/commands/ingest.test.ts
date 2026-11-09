import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
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

  /**
   * `ingest.enabled` 默认 false。开关的**关闭**分支此前没有任何测试：服务层与命令
   * 层的用例都在配置里显式写了 `enabled: true`。关着时必须在建容器 / 写库 / 读源
   * 之前拒绝——先建库再报错会留下一个「看起来导入过」的 `_meta/`，那正是把
   * 「没生效」伪装成正常状态。
   */
  it('ingest.enabled 默认 false 时拒绝真正导入，且不创建数据根', async () => {
    const configPath = join(tempDir, 'config.yaml');
    await writeFile(configPath, ['ingest:', '  enabled: false'].join('\n'), 'utf8');
    const dataDir = join(tempDir, 'data');

    await expect(
      runIngest({ configPath, dataDir, source: 'claude-code' }),
    ).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
      details: { field: 'ingest.enabled' },
    });

    await expect(stat(dataDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
