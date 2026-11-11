import type { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { MockInstance } from 'vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NullLogger } from '../../helpers/null-logger.js';
import { openDatabase, runMigrations } from '../../../src/adapters/sqlite/database.js';
import { UserRepository } from '../../../src/adapters/sqlite/user-repository.js';
import { setPassword } from '../../../src/commands/password.js';

const NOW = new Date('2026-11-08T00:00:00.000Z');
const LOGGER = new NullLogger();

let dataDir: string;
let stderr: MockInstance;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'comem-password-'));
  // 默认 `auth.enabled: false` 时成功的用例都会打印警告；统一接住，断言放在
  // 需要它的用例里（否则 `pnpm test` 的输出会被这条警告刷屏）。
  stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dataDir, { recursive: true, force: true });
});

function openDb(): DatabaseSync {
  mkdirSync(join(dataDir, '_meta'), { recursive: true });
  const db = openDatabase(join(dataDir, '_meta', 'comem.sqlite'));
  runMigrations(db);
  return db;
}

function seed(): void {
  const db = openDb();
  try {
    new UserRepository({ db, logger: LOGGER }).create(
      { id: 'alice', displayName: 'alice', email: null, status: 'active' },
      NOW,
    );
  } finally {
    db.close();
  }
}

function passwordHash(): string | null {
  const db = openDb();
  try {
    return new UserRepository({ db, logger: LOGGER }).getPasswordHash('alice');
  } finally {
    db.close();
  }
}

describe('pnpm password', () => {
  /**
   * 回归：`--config` 曾经被静默忽略。
   *
   * 命令自己拼 `loadConfig({...})` 时漏了 `argv`，`--config` 回落到当前目录的
   * `config.yaml`，坏 YAML 永远读不到——用户以为配置生效了。
   */
  it('--config 坏 YAML 必须报错，不能静默用默认值', async () => {
    seed();
    const bad = join(dataDir, 'bad.yaml');
    await writeFile(bad, 'not: [valid', 'utf8');

    await expect(
      setPassword('alice', 'new-password', {
        argv: ['--config', bad],
        env: { ...process.env, COMEM_DATA_DIR: dataDir },
      }),
    ).rejects.toThrow(/YAML/);
    // 报错发生在写库之前：密码没有被改成坏配置里的值。
    expect(passwordHash()).toBeNull();
  });

  /**
   * 回归：`--data-dir` 同样只从 `argv` 读。漏传时密码会写到默认数据根，
   * 也就是「给生产库设测试密码」。
   */
  it('--data-dir 覆盖 COMEM_DATA_DIR：密码写到 --data-dir 指向的数据根', async () => {
    seed();
    const fromEnv = join(dataDir, 'from-env');

    await setPassword('alice', 'new-password', {
      argv: ['--data-dir', dataDir],
      env: { ...process.env, COMEM_DATA_DIR: fromEnv },
    });

    expect(passwordHash()).not.toBeNull();
    // 环境变量指向的数据根一分没写。
    expect(existsSync(join(fromEnv, '_meta', 'comem.sqlite'))).toBe(false);
  });

  /**
   * 回归：数据根还没初始化时，`openDatabase` 只报 `unable to open database file`，
   * 不指向任何下一步；而文档「建第一个账号」的第一步就是这条命令。
   */
  it('数据根还没有 _meta 目录时报「先启动一次服务」', async () => {
    await expect(
      setPassword('alice', 'new-password', {
        env: { ...process.env, COMEM_DATA_DIR: dataDir },
      }),
    ).rejects.toThrow(/数据根还没有初始化.*先启动一次服务/);
    // 报错发生在建库之前：命令不替人建目录，也不留下半初始化的数据根。
    expect(existsSync(join(dataDir, '_meta'))).toBe(false);
  });

  it('用户不存在时给出创建账号的下一步', async () => {
    seed();

    await expect(
      setPassword('bob', 'new-password', {
        env: { ...process.env, COMEM_DATA_DIR: dataDir },
      }),
    ).rejects.toThrow(/用户不存在：bob.*POST \/admin\/users/);
  });

  /**
   * `auth.enabled: false` 时登录端点 404。命令静默成功会让人以为「设好密码就能
   * 登录」，然后在 `/login` 上找不到原因。
   */
  it('auth.enabled: false 时写入密码并打印警告', async () => {
    seed();
    stderr.mockClear();

    await setPassword('alice', 'new-password', {
      env: { ...process.env, COMEM_DATA_DIR: dataDir },
    });

    expect(passwordHash()).not.toBeNull();
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining('认证未启用（auth.enabled = false）'),
    );
  });

  it('auth.enabled: true 时不打印警告', async () => {
    seed();
    const configPath = join(dataDir, 'config.yaml');
    await writeFile(configPath, 'auth:\n  enabled: true\n', 'utf8');
    stderr.mockClear();

    await setPassword('alice', 'new-password', {
      path: configPath,
      env: { ...process.env, COMEM_DATA_DIR: dataDir },
    });

    expect(passwordHash()).not.toBeNull();
    expect(stderr).not.toHaveBeenCalled();
  });
});
