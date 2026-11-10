import type { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { NullLogger } from '../../helpers/null-logger.js';
import { openDatabase, runMigrations } from '../../../src/adapters/sqlite/database.js';
import { GroupRepository } from '../../../src/adapters/sqlite/group-repository.js';
import { UserRepository } from '../../../src/adapters/sqlite/user-repository.js';
import { ComemError } from '../../../src/domain/errors.js';
import { setGroupOwner } from '../../../src/commands/group-owner.js';

const NOW = new Date('2026-11-08T00:00:00.000Z');
const LOGGER = new NullLogger();

let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'comem-group-owner-'));
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

function openDb(): DatabaseSync {
  mkdirSync(join(dataDir, '_meta'), { recursive: true });
  const db = openDatabase(join(dataDir, '_meta', 'comem.sqlite'));
  runMigrations(db);
  return db;
}

/** 预置用户与一个没有 owner 的组（模拟「owner 被删掉」之后的状态）。 */
function seed(): void {
  const db = openDb();
  try {
    const users = new UserRepository({ db, logger: LOGGER });
    const groups = new GroupRepository({ db, logger: LOGGER });
    for (const id of ['alice', 'bob']) {
      users.create({ id, displayName: id, email: null, status: 'active' }, NOW);
    }
    groups.create({ id: 'eng', displayName: 'eng', description: null, ownerUserId: null }, NOW);
  } finally {
    db.close();
  }
}

function ownerOf(groupId: string): string | null {
  const db = openDb();
  try {
    return new GroupRepository({ db, logger: LOGGER }).get(groupId)?.ownerUserId ?? null;
  } finally {
    db.close();
  }
}

function aclPath(): string {
  return join(dataDir, 'group', 'eng', '.acl.json');
}

async function readAcl(): Promise<{
  readonly mode: string;
  readonly entries: readonly { readonly principal: string; readonly level: string }[];
}> {
  return JSON.parse(await readFile(aclPath(), 'utf8')) as {
    readonly mode: string;
    readonly entries: readonly { readonly principal: string; readonly level: string }[];
  };
}

function run(groupId: string, userId: string): Promise<{ readonly groupId: string; readonly userId: string }> {
  return setGroupOwner(groupId, userId, { env: { ...process.env, COMEM_DATA_DIR: dataDir } });
}

describe('pnpm group:owner', () => {
  it('没有 ACL 文件时写出组根预置：owner 得到 manage，组得到 write', async () => {
    seed();

    const result = await run('eng', 'alice');

    expect(result).toEqual({ groupId: 'eng', userId: 'alice' });
    expect(ownerOf('eng')).toBe('alice');
    expect(await readAcl()).toEqual({
      mode: 'inherit',
      entries: expect.arrayContaining([
        { principal: 'user:alice', level: 'manage', effect: 'allow' },
        { principal: 'group:eng', level: 'write', effect: 'allow' },
      ]),
    });
  });

  /**
   * 恢复路径：owner 被删之后组根只剩 `group:{gid} = write`。
   *
   * `ensureRootPreset` 的幂等判断是「文件里有没有 `group:{gid}` 这一条」，正常组
   * 一定已经有——所以命令必须用 `setGroupOwner` 补 owner 条目，否则恢复是个空操作。
   */
  it('owner 为 NULL 的组：补上 manage 条目并保留现有条目', async () => {
    seed();
    mkdirSync(join(dataDir, 'group', 'eng'), { recursive: true });
    await writeFile(
      aclPath(),
      `${JSON.stringify(
        {
          mode: 'inherit',
          entries: [{ principal: 'group:eng', level: 'write', effect: 'allow' }],
        },
        null,
        2,
      )}\n`,
      'utf8',
    );

    await run('eng', 'alice');

    expect(ownerOf('eng')).toBe('alice');
    expect(await readAcl()).toEqual({
      mode: 'inherit',
      entries: expect.arrayContaining([
        { principal: 'group:eng', level: 'write', effect: 'allow' },
        { principal: 'user:alice', level: 'manage', effect: 'allow' },
      ]),
    });
  });

  it('拒绝通配主体与非 user 格式，且不写库、不写盘', async () => {
    seed();

    await expect(run('eng', '*')).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    } satisfies Partial<ComemError>);
    await expect(run('eng', 'group:eng')).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    } satisfies Partial<ComemError>);

    expect(ownerOf('eng')).toBeNull();
    await expect(readFile(aclPath(), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('组或用户不存在抛 NOT_FOUND', async () => {
    seed();

    await expect(run('missing', 'alice')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    } satisfies Partial<ComemError>);
    await expect(run('eng', 'missing')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    } satisfies Partial<ComemError>);
  });
});

/**
 * 回归：`--config` / `--data-dir` 曾经被静默忽略。
 *
 * 命令自己拼 `loadConfig({...})` 时漏了 `argv`，两个 flag 都回落到「当前目录的
 * `config.yaml` + 环境变量推导的数据根」——给错误的数据根改 owner，不报错。
 */
describe('pnpm group:owner 的配置入口', () => {
  it('--config 坏 YAML 必须报错，不能静默用默认值', async () => {
    seed();
    const bad = join(dataDir, 'bad.yaml');
    await writeFile(bad, 'not: [valid', 'utf8');

    await expect(
      setGroupOwner('eng', 'alice', {
        argv: ['--config', bad],
        env: { ...process.env, COMEM_DATA_DIR: dataDir },
      }),
    ).rejects.toThrow(/YAML/);
    // 报错发生在写库之前。
    expect(ownerOf('eng')).toBeNull();
  });

  it('--data-dir 覆盖 COMEM_DATA_DIR：owner 写到 --data-dir 指向的数据根', async () => {
    seed();
    const fromEnv = join(dataDir, 'from-env');

    await setGroupOwner('eng', 'alice', {
      argv: ['--data-dir', dataDir],
      env: { ...process.env, COMEM_DATA_DIR: fromEnv },
    });

    expect(ownerOf('eng')).toBe('alice');
  });
});
