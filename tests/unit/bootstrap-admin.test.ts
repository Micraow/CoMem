/**
 * 引导端口的数据库侧行为（§12.7）。
 *
 * HTTP 层的三种真值状态在 `tests/integration/api/bootstrap.test.ts`；这里测「无用户」
 * 这个 `createContainer` 到不了的状态，以及令牌比较的恒定时间契约。
 */

import { describe, expect, it } from 'vitest';

import { openDatabase, runMigrations } from '../../src/adapters/sqlite/database.js';
import { createBootstrapAccess } from '../../src/bootstrap/container/bootstrap-admin.js';
import type { Logger } from '../../src/domain/log.js';

import { NullLogger } from '../helpers/null-logger.js';

function openMemory(): ReturnType<typeof openDatabase> {
  const db = openDatabase(':memory:');
  runMigrations(db);
  return db;
}

function insertUserWithoutPassword(
  db: ReturnType<typeof openDatabase>,
  id = 'local',
): void {
  db.prepare(
    'INSERT INTO app_user (id, display_name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
  ).run(id, id, 'active', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
}

describe('BootstrapAccess.hasPassword 的三态', () => {
  it('无用户 → false；有用户无密码 → false；有用户有密码 → true', async () => {
    const db = openMemory();
    const access = createBootstrapAccess(db, new NullLogger(), 'known-token');

    // 1. 无用户
    expect(access.hasPassword()).toBe(false);

    // 2. 有用户、没设密码
    insertUserWithoutPassword(db);
    expect(access.hasPassword()).toBe(false);

    // 3. 有用户、设过密码（引导管理员写入的唯一入口）
    expect(await access.installFirstAdmin('local', 'long-password')).toBe(true);
    expect(access.hasPassword()).toBe(true);
    db.close();
  });

  it('installFirstAdmin 只在没有密码时成功一次', async () => {
    const db = openMemory();
    insertUserWithoutPassword(db);
    const access = createBootstrapAccess(db, new NullLogger(), 'known-token');

    expect(await access.installFirstAdmin('local', 'long-password')).toBe(true);
    expect(await access.installFirstAdmin('local', 'another-password')).toBe(false);
    db.close();
  });
});

describe('一次性初始化令牌', () => {
  it('匹配返回 true；长度不等 / 缺失 / 空串返回 false', () => {
    const db = openMemory();
    const access = createBootstrapAccess(db, new NullLogger(), 'known-token');

    expect(access.verifySetupToken('known-token')).toBe(true);
    expect(access.verifySetupToken('known-toke')).toBe(false);
    expect(access.verifySetupToken('known-tokenX')).toBe(false);
    expect(access.verifySetupToken('')).toBe(false);
    expect(access.verifySetupToken(undefined)).toBe(false);
    db.close();
  });

  it('只在还没有密码时打印令牌', async () => {
    const printed: string[] = [];
    const logger: Logger = {
      debug: () => {},
      info: (message) => printed.push(message),
      warn: () => {},
      error: () => {},
    };
    const db = openMemory();
    insertUserWithoutPassword(db);

    // 新装：部署者要从日志里抄一次（容器部署没有回环来源）。
    const access = createBootstrapAccess(db, logger, 'known-token');
    expect(printed).toEqual([
      '初始化令牌：known-token（用于首次创建管理员账号；创建完成后失效）',
    ]);

    // 已经有密码：初始化完成，不再打印。
    expect(await access.installFirstAdmin('local', 'long-password')).toBe(true);
    createBootstrapAccess(db, logger, 'known-token');
    expect(printed).toHaveLength(1);
    db.close();
  });
});
