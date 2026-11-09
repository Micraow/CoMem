import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createPathLockManager, type PathLockManager } from '../../../src/adapters/fs/lock.js';
import type { LockRecord } from '../../../src/domain/lock.js';
import type { Logger } from '../../../src/domain/log.js';
import { Uri } from '../../../src/domain/uri.js';

interface RecordingLogger extends Logger {
  readonly warnings: string[];
}

function createLogger(): RecordingLogger {
  const warnings: string[] = [];
  const logger: RecordingLogger = {
    debug: () => undefined,
    info: () => undefined,
    warn: (message) => {
      warnings.push(message);
    },
    error: () => undefined,
    warnings,
  };
  return logger;
}

const FILE_URI = Uri.parse('comem://user/alice/foo.md');
const OTHER_URI = Uri.parse('comem://user/alice/other.md');
const TREE_URI = Uri.parse('comem://user/alice/foo');
const CHILD_URI = Uri.parse('comem://user/alice/foo/bar.md');

let tempDir: string;
let logger: RecordingLogger;
let manager: PathLockManager;

function lockPathFor(uri: Uri): string {
  return join(tempDir, uri.scope, uri.rootId, ...uri.segments) + '.comem-lock';
}

function readRecord(uri: Uri): LockRecord {
  return JSON.parse(readFileSync(lockPathFor(uri), 'utf8')) as LockRecord;
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'comem-lock-'));
  // 锁文件与目标同目录，父目录必须先存在。
  mkdirSync(join(tempDir, 'user', 'alice'), { recursive: true });
  logger = createLogger();
  manager = createPathLockManager({
    dataDir: tempDir,
    logger,
    pollIntervalMs: 5,
    defaultTimeoutMs: 2000,
  });
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('acquire', () => {
  it('锁文件是 {path}.comem-lock，内容是 LockRecord', async () => {
    const release = await manager.acquire(FILE_URI, 'exact');
    const lockPath = lockPathFor(FILE_URI);

    expect(existsSync(lockPath)).toBe(true);
    const record = readRecord(FILE_URI);
    expect(record.mode).toBe('exact');
    expect(record.uri).toBe(FILE_URI.toString());
    expect(record.owner).not.toBe('');
    expect(Date.parse(record.expiresAt)).toBeGreaterThan(Date.now());
    expect(manager.activeCount()).toBe(1);

    release();
    expect(existsSync(lockPath)).toBe(false);
    expect(manager.activeCount()).toBe(0);
  });

  it('两个无关的 EXACT 写可以同时持有', async () => {
    const releaseFile = await manager.acquire(FILE_URI, 'exact');
    const releaseOther = await manager.acquire(OTHER_URI, 'exact', { timeoutMs: 100 });

    expect(manager.activeCount()).toBe(2);

    releaseFile();
    releaseOther();
    expect(manager.activeCount()).toBe(0);
  });

  it('TREE 锁挡住子路径的 EXACT 写', async () => {
    const release = await manager.acquire(TREE_URI, 'tree');

    await expect(manager.acquire(CHILD_URI, 'exact', { timeoutMs: 50 })).rejects.toMatchObject({
      code: 'CONFLICT',
    });

    release();
    const releaseChild = await manager.acquire(CHILD_URI, 'exact', { timeoutMs: 100 });
    releaseChild();
  });

  it('超时抛 CONFLICT，消息里带 URI 与等待时长', async () => {
    const release = await manager.acquire(FILE_URI, 'exact');

    try {
      await manager.acquire(FILE_URI, 'exact', { timeoutMs: 30 });
      throw new Error('期望抛出 CONFLICT');
    } catch (error) {
      expect(error).toMatchObject({ code: 'CONFLICT' });
      expect((error as Error).message).toContain(FILE_URI.toString());
      expect((error as Error).message).toContain('30');
    } finally {
      release();
    }
  });

  it('等待中取消抛 CONFLICT，不留下排队状态', async () => {
    const release = await manager.acquire(FILE_URI, 'exact');
    const controller = new AbortController();

    const pending = manager.acquire(FILE_URI, 'exact', {
      signal: controller.signal,
      timeoutMs: 2000,
    });
    setTimeout(() => controller.abort(), 20);

    await expect(pending).rejects.toMatchObject({ code: 'CONFLICT' });

    release();
    const releaseAgain = await manager.acquire(FILE_URI, 'exact', { timeoutMs: 100 });
    releaseAgain();
  });

  it('释放校验 owner：锁文件被别人改过就不删', async () => {
    const release = await manager.acquire(FILE_URI, 'exact');
    const lockPath = lockPathFor(FILE_URI);
    const record = readRecord(FILE_URI);

    writeFileSync(lockPath, JSON.stringify({ ...record, owner: 'someone-else' }), 'utf8');
    release();

    expect(existsSync(lockPath)).toBe(true);
    expect(logger.warnings.some((message) => message.includes('持有者'))).toBe(true);
  });
});

describe('withLock', () => {
  it('并发 20 个同 URI 的 withLock 串行执行', async () => {
    let running = 0;
    let peak = 0;
    const order: number[] = [];

    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        manager.withLock(FILE_URI, 'exact', async () => {
          running += 1;
          peak = Math.max(peak, running);
          await delay(1);
          order.push(index);
          running -= 1;
        }),
      ),
    );

    expect(peak).toBe(1);
    expect(order).toHaveLength(20);
    expect(manager.activeCount()).toBe(0);
    expect(existsSync(lockPathFor(FILE_URI))).toBe(false);
  });

  it('fn 抛错也释放锁', async () => {
    await expect(
      manager.withLock(FILE_URI, 'exact', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(manager.activeCount()).toBe(0);
    expect(existsSync(lockPathFor(FILE_URI))).toBe(false);

    const release = await manager.acquire(FILE_URI, 'exact', { timeoutMs: 100 });
    release();
  });
});
