/**
 * 跨进程会话锁（架构文档 §15.4 第 3 层）。
 *
 * 同一个 session 的多个 hook 进程会并发（两次 `Stop` 挨得很近、`PreCompact` 与
 * `Stop` 交错）。游标是「读 → 判断 → 写」的复合操作，不串行化就会两边都从同一个
 * 游标开始，把同一批消息投两遍。
 *
 * 锁文件是 `{tmpdir}/comem-{sessionId}.lock`，用 `wx` 打开（`O_CREAT | O_EXCL`，
 * 原子创建）。
 *
 * ## 过期而不是心跳
 *
 * hook 进程崩在 `finally` 之前，锁文件会留下。方案是给锁一个 `expiresAt`：超过
 * 就被后来者抢走。不做心跳——hook 的典型寿命是几十毫秒，为它维护一个定时器不值。
 *
 * PID 不参与判定：PID 会被复用，`kill(pid, 0)` 对「上一个进程恰好是同一个 PID」
 * 会给出错误的结论。过期时间是单调的，没有这个问题。
 */

import { open, readFile, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import { resolveTempDir } from './config.mjs';
import { ComemHookError } from './http.mjs';

/**
 * 等锁的上限。
 *
 * 2000 是经验值，没有架构来源。上下界都由 §15.9 的 hook 预算推出：进程启动
 * 30–50ms、检索 20–100ms，等锁不能吃掉一整个 hook 超时；但太短会在正常争用时
 * 误报超时（一次 `PreCompact` 的提交要几秒，`Stop` 必须能等到它）。
 */
export const LOCK_WAIT_MS = 2000;

/**
 * 锁的存活时间。
 *
 * 10000 是经验值。它必须大于一次正常 hook 的寿命（§15.9 的阻塞预算 60–180ms），
 * 又要小到崩溃后不长期挡住会话。10 秒是「提交管线里一次 LLM 调用」的量级
 * （`rewriteTimeoutMs = 30000` 的三分之一），留了余量。
 */
export const LOCK_STALE_MS = 10_000;

/** 轮询间隔。经验值：hook 寿命是几十毫秒，25ms 的粒度足够且不会空转。 */
const LOCK_POLL_MS = 25;

function sessionFileName(sessionId) {
  // 会话 ID 来自宿主载荷，可能是任意字符串。只允许文件名安全字符，其余换成 `_`。
  const safe = sessionId.replace(/[^A-Za-z0-9_.-]/g, '_');
  return `comem-${safe}.lock`;
}

export function sessionLockPath(sessionId, dir = resolveTempDir()) {
  return join(dir, sessionFileName(sessionId));
}

function sleep(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

async function isExpired(file, staleMs, now) {
  try {
    const text = await readFile(file, 'utf8');
    const record = JSON.parse(text);
    if (typeof record.expiresAt === 'number') {
      return now >= record.expiresAt;
    }
  } catch {
    // 文件存在旧内容或内容不完整（持有者刚创建、还没写完）。退回 mtime 判断。
  }
  try {
    const info = await stat(file);
    return now - info.mtimeMs >= staleMs;
  } catch {
    // 已经被别人清掉了：下一轮循环会重新尝试创建。
    return true;
  }
}

async function acquire(file, waitMs, staleMs) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const now = Date.now();
    try {
      const handle = await open(file, 'wx');
      try {
        const record = { pid: process.pid, startedAt: now, expiresAt: now + staleMs };
        await handle.writeFile(JSON.stringify(record), 'utf8');
      } finally {
        await handle.close();
      }
      return;
    } catch (error) {
      if (error.code !== 'EEXIST') {
        throw new ComemHookError(`创建会话锁失败：${file}`, {
          code: 'HOOK_INVALID_CONFIG',
          cause: error,
        });
      }
    }

    if (Date.now() >= deadline) {
      throw new ComemHookError(`等待会话锁超时：${file}（${waitMs}ms）`, {
        code: 'HOOK_LOCK_TIMEOUT',
      });
    }

    if (await isExpired(file, staleMs, now)) {
      // 过期锁：删掉重抢。删失败说明别人刚抢到，交给下一轮；这里必须退避，
      // 否则「文件不可删」会变成不带 sleep 的死循环。
      await unlink(file).catch(() => {});
    }
    await sleep(LOCK_POLL_MS);
  }
}

async function release(file) {
  // 锁可能已经被过期清理逻辑抢走并重建。只删自己创建的路径，且删失败不报错。
  await unlink(file).catch(() => {});
}

/**
 * 串行化同一个 session 的操作。`fn` 抛错时锁照样释放（`finally`）。
 *
 * @template T
 * @param {string} sessionId
 * @param {() => Promise<T>} fn
 * @param {{ dir?: string, waitMs?: number, staleMs?: number }} [options]
 * @returns {Promise<T>}
 */
export async function withSessionLock(sessionId, fn, options = {}) {
  const file = sessionLockPath(sessionId, options.dir ?? resolveTempDir());
  await acquire(file, options.waitMs ?? LOCK_WAIT_MS, options.staleMs ?? LOCK_STALE_MS);
  try {
    return await fn();
  } finally {
    await release(file);
  }
}
