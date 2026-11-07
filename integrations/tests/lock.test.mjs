/**
 * 跨进程会话锁（架构文档 §15.4 第 3 层）。
 *
 * 三个不变量：并发互斥、过期可抢、`finally` 释放。
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { test } from 'node:test';

import { ComemHookError } from '../lib/http.mjs';
import { sessionLockPath, withSessionLock } from '../lib/lock.mjs';

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'comem-lock-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function sleep(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

test('并发互斥：两个持有者不会重叠', async () => {
  await withTempDir(async (dir) => {
    let active = 0;
    let maxActive = 0;

    async function critical() {
      return withSessionLock(
        'cc-1',
        async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await sleep(20);
          active -= 1;
        },
        { dir },
      );
    }

    await Promise.all([critical(), critical(), critical()]);
    assert.equal(maxActive, 1);
    assert.equal(active, 0);
  });
});

test('不同会话的锁互不影响', async () => {
  await withTempDir(async (dir) => {
    let active = 0;
    let maxActive = 0;

    async function critical(sessionId) {
      return withSessionLock(
        sessionId,
        async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await sleep(20);
          active -= 1;
        },
        { dir },
      );
    }

    await Promise.all([critical('cc-1'), critical('cc-2')]);
    assert.equal(maxActive, 2);
  });
});

test('过期锁可以被抢走（进程崩在 finally 之前）', async () => {
  await withTempDir(async (dir) => {
    const file = sessionLockPath('cc-1', dir);
    await writeFile(
      file,
      JSON.stringify({ pid: 999_999, startedAt: Date.now() - 60_000, expiresAt: Date.now() - 1 }),
      'utf8',
    );

    let ran = false;
    await withSessionLock(
      'cc-1',
      async () => {
        ran = true;
      },
      { dir, waitMs: 500 },
    );
    assert.equal(ran, true);
  });
});

test('等锁超时抛 HOOK_LOCK_TIMEOUT', async () => {
  await withTempDir(async (dir) => {
    const file = sessionLockPath('cc-1', dir);
    await writeFile(
      file,
      JSON.stringify({ pid: process.pid, startedAt: Date.now(), expiresAt: Date.now() + 60_000 }),
      'utf8',
    );

    await assert.rejects(
      () => withSessionLock('cc-1', async () => {}, { dir, waitMs: 80 }),
      (error) => {
        assert.ok(error instanceof ComemHookError);
        assert.equal(error.code, 'HOOK_LOCK_TIMEOUT');
        return true;
      },
    );
  });
});

test('fn 抛错时锁照样释放', async () => {
  await withTempDir(async (dir) => {
    await assert.rejects(() =>
      withSessionLock(
        'cc-1',
        async () => {
          throw new Error('boom');
        },
        { dir },
      ),
    );

    // 锁文件已经被 finally 删掉：下一次能立刻拿到。
    let ran = false;
    await withSessionLock(
      'cc-1',
      async () => {
        ran = true;
      },
      { dir, waitMs: 100 },
    );
    assert.equal(ran, true);
  });
});

test('会话 ID 里的路径字符被替换，锁文件不会跑出目录', async () => {
  await withTempDir(async (dir) => {
    const file = sessionLockPath('../../etc/passwd', dir);
    assert.equal(dirname(file), dir);
    assert.equal(basename(file).includes('/'), false);
  });
});
