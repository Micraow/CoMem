/**
 * 文件锁实现（架构文档 §10.6）。
 *
 * 锁就是一个文件：`{toDiskPath(dataDir, uri)}.comem-lock`，内容是 `LockRecord`
 * 的 JSON。为什么用文件而不是进程内 Map：四个写入口（`rm` / `mv` / `write` /
 * `session.commit`）可能来自不同进程（Hook 插件、后台任务），进程内锁看不见彼此。
 *
 * 获取循环（§10.6）：
 *
 * 1. 收集与请求路径相关的现有锁（目标自身、全部祖先、`TREE` 请求还要扫子树）；
 * 2. 有未过期的冲突 → `wait`，按 `pollIntervalMs` 轮询；
 * 3. 冲突锁都过期了 → `steal`，删掉再重试；
 * 4. 没有冲突 → 原子创建自己的锁文件，成功即持有。
 *
 * **创建必须是原子的。** 用「临时文件 + 硬链接」而不是 `writeFile(..., 'wx')`：
 * 后者先创建再写入，中间有一个空文件的窗口，读方会把它当成损坏的锁并抢走，
 * 于是两个写者同时持有同一把锁。`link` 在目标已存在时原子失败，读方永远看到
 * 完整内容；续租用 `rename` 原子替换。
 *
 * 释放校验 owner：读回锁文件，owner 不匹配就不删。这不是防呆——进程崩溃后锁
 * 会到期被抢走，原持有者的 `finally` 随后执行时不能把新持有者的锁删掉。
 */

import { randomUUID } from 'node:crypto';
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { link, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { ComemError } from '../../domain/errors.js';
import {
  acquireDecision,
  conflicts,
  createLockRecord,
  DEFAULT_LOCK_OPTIONS,
  shouldRenew,
  type LockMode,
  type LockOptions,
  type LockRecord,
} from '../../domain/lock.js';
import type { Logger } from '../../domain/log.js';
import type { Uri } from '../../domain/uri.js';
import { LOCK_FILE_SUFFIX, TEMP_FILE_PREFIX, toDiskPath } from './path.js';

/**
 * 默认获取超时，毫秒。
 *
 * 与 SQLite 的 `busy_timeout` 对齐（架构文档 §18「并发控制」）：超过这个时间还
 * 拿不到锁，说明有持有者卡死了，抛 `CONFLICT` 交给上层重试比继续挂着更有用。
 */
const DEFAULT_TIMEOUT_MS = 5000;

/** 轮询间隔，毫秒。经验值，来源未知：25ms 是文件轮询里常见的折中，再小是空转。 */
const DEFAULT_POLL_INTERVAL_MS = 25;

/** 损坏的锁文件按「已过期」处理：删掉再重试。 */
const CORRUPT_LOCK_EXPIRY = new Date(0).toISOString();

export interface LockAcquireOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  /**
   * 目标父目录不存在时先建出来，让锁文件有地方放。
   *
   * **只有写者能传。** 锁文件与目标同目录，父目录不存在时既没有可保护的内容、也
   * 没有地方放锁文件——读者此时返回空释放函数是正确的（`read` / `remove` 一个不
   * 存在的路径不该顺手造目录）。但写者会**创建**目标，两个并发的写者在「父目录还
   * 不存在」这个窗口里都拿不到锁，于是「同一时刻只有一个写者」对**新路径**不成立：
   * 两个归档同时新建同一个记忆文件时，后写者会用陈旧的字段集整份覆盖。
   */
  readonly createParentDirectory?: boolean;
}

export interface PathLockManager {
  /** 拿到锁返回释放函数；拿不到（超时）抛 `ComemError('CONFLICT')`。 */
  acquire(uri: Uri, mode: LockMode, options?: LockAcquireOptions): Promise<() => void>;

  /** 拿锁执行，结束后一定释放（含抛错）。 */
  withLock<T>(
    uri: Uri,
    mode: LockMode,
    fn: () => Promise<T>,
    options?: LockAcquireOptions,
  ): Promise<T>;

  /** 当前持有的锁数，测试用。 */
  activeCount(): number;
}

export interface PathLockManagerOptions {
  readonly dataDir: string;
  readonly logger: Logger;
  readonly lockOptions?: LockOptions;
  /** 默认 5000ms */
  readonly defaultTimeoutMs?: number;
  /** 轮询间隔，默认 25ms */
  readonly pollIntervalMs?: number;
}

interface ExistingLock {
  readonly path: string;
  readonly record: LockRecord;
}

type LockFileState =
  | { readonly kind: 'missing' }
  | { readonly kind: 'corrupt'; readonly raw: string }
  | { readonly kind: 'record'; readonly record: LockRecord };

/** 本进程创建的锁文件（路径 → owner），进程退出时兜底清理。 */
const processLocks = new Map<string, string>();

let exitHookInstalled = false;

/**
 * 与锁文件同目录的临时文件名。
 *
 * 用 `path.ts` 的 `TEMP_FILE_PREFIX` 而不是自己拼：`ContentStore.list` 只跳过
 * 这个前缀，自己拼的名字会在写入瞬间漏进目录列表。
 */
function temporaryPathFor(lockPath: string): string {
  return join(dirname(lockPath), `${TEMP_FILE_PREFIX}${randomUUID()}`);
}

function isErrnoCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

function isLockRecord(value: unknown): value is LockRecord {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  const { owner, mode, uri, expiresAt, renewedAt } = record;
  return (
    typeof owner === 'string' &&
    (mode === 'exact' || mode === 'tree') &&
    typeof uri === 'string' &&
    typeof expiresAt === 'string' &&
    typeof renewedAt === 'string' &&
    Number.isFinite(Date.parse(expiresAt))
  );
}

function parseLockState(raw: string): LockFileState {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { kind: 'corrupt', raw };
  }
  return isLockRecord(value) ? { kind: 'record', record: value } : { kind: 'corrupt', raw };
}

/** 损坏的锁文件：URI 无法解析，按「与所有请求冲突且已过期」处理，删除后重试。 */
function corruptLockRecord(): LockRecord {
  return {
    owner: '',
    mode: 'exact',
    uri: '',
    expiresAt: CORRUPT_LOCK_EXPIRY,
    renewedAt: CORRUPT_LOCK_EXPIRY,
  };
}

async function readLockState(lockPath: string): Promise<LockFileState> {
  let raw: string;
  try {
    raw = await readFile(lockPath, 'utf8');
  } catch (error) {
    if (isErrnoCode(error, 'ENOENT')) {
      return { kind: 'missing' };
    }
    throw error;
  }
  return parseLockState(raw);
}

function readLockStateSync(lockPath: string): LockFileState {
  let raw: string;
  try {
    raw = readFileSync(lockPath, 'utf8');
  } catch (error) {
    if (isErrnoCode(error, 'ENOENT')) {
      return { kind: 'missing' };
    }
    throw error;
  }
  return parseLockState(raw);
}

function timeoutError(uri: Uri, mode: LockMode, timeoutMs: number): ComemError {
  return new ComemError(
    'CONFLICT',
    `获取路径锁超时：${uri.toString()} 已等待 ${timeoutMs} 毫秒（模式 ${mode}）。`,
    { uri: uri.toString(), mode, timeoutMs },
  );
}

function abortedError(uri: Uri, mode: LockMode): ComemError {
  return new ComemError('CONFLICT', `获取路径锁已取消：${uri.toString()}（模式 ${mode}）。`, {
    uri: uri.toString(),
    mode,
  });
}

function assertNotAborted(signal: AbortSignal | undefined, uri: Uri, mode: LockMode): void {
  if (signal?.aborted === true) {
    throw abortedError(uri, mode);
  }
}

/**
 * 目标自身的锁、全部祖先的锁，以及（`TREE` 时）子树的锁。
 *
 * 祖先必须看：`TREE(resources/foo)` 持有期间，写 `resources/foo/bar.md` 的
 * `EXACT` 请求只能通过祖先锁文件发现冲突。
 *
 * 子树必须看：`rm -r resources/foo` 在别人正在写 `resources/foo/bar.md` 时
 * 应该等，不能直接删。每路径一个锁文件做不到全局原子，但能挡住绝大部分交错。
 */
async function collectExistingLocks(
  lockPath: string,
  dataDir: string,
  candidate: LockRecord,
): Promise<ExistingLock[]> {
  const paths = [lockPath, ...ancestorLockPaths(lockPath, dataDir)];
  if (candidate.mode === 'tree') {
    paths.push(...(await descendantLockPaths(lockPath)));
  }

  const existing: ExistingLock[] = [];
  for (const path of paths) {
    const state = await readLockState(path);
    if (state.kind === 'record' && conflicts(state.record, candidate)) {
      existing.push({ path, record: state.record });
    } else if (state.kind === 'corrupt') {
      existing.push({ path, record: corruptLockRecord() });
    }
  }
  return existing;
}

/** 从锁文件路径往上走到数据根，返回每一层的锁文件路径（不含数据根自身）。 */
function ancestorLockPaths(lockPath: string, dataDir: string): string[] {
  const root = resolve(dataDir);
  const paths: string[] = [];
  let current = dirname(lockPath);
  while (current !== root && current.startsWith(`${root}${sep}`)) {
    paths.push(`${current}${LOCK_FILE_SUFFIX}`);
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return paths;
}

/** 目标路径下所有锁文件。目标不存在或不是目录时返回空。 */
async function descendantLockPaths(lockPath: string): Promise<string[]> {
  const targetPath = lockPath.slice(0, -LOCK_FILE_SUFFIX.length);
  try {
    const entries = await readdir(targetPath, { recursive: true, withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(LOCK_FILE_SUFFIX))
      .map((entry) => join(entry.parentPath, entry.name));
  } catch (error) {
    if (isErrnoCode(error, 'ENOENT') || isErrnoCode(error, 'ENOTDIR')) {
      return [];
    }
    throw error;
  }
}

/**
 * 原子创建锁文件：先写临时文件，再硬链接到目标。
 * 目标已存在时 `link` 抛 `EEXIST`，返回 `false`。
 */
async function createLockFile(lockPath: string, record: LockRecord): Promise<boolean> {
  const temporary = temporaryPathFor(lockPath);
  await writeFile(temporary, JSON.stringify(record), 'utf8');
  try {
    await link(temporary, lockPath);
    return true;
  } catch (error) {
    if (isErrnoCode(error, 'EEXIST')) {
      return false;
    }
    throw error;
  } finally {
    await rm(temporary, { force: true });
  }
}

function renewLockFile(
  lockPath: string,
  record: LockRecord,
  uri: Uri,
  lockOptions: LockOptions,
  logger: Logger,
): void {
  const state = readLockStateSync(lockPath);
  if (state.kind !== 'record' || state.record.owner !== record.owner) {
    return;
  }
  const now = new Date();
  if (!shouldRenew(state.record, now, lockOptions)) {
    return;
  }

  const next = createLockRecord(record.owner, record.mode, uri, now, lockOptions);
  const temporary = temporaryPathFor(lockPath);
  try {
    writeFileSync(temporary, JSON.stringify(next), 'utf8');
    renameSync(temporary, lockPath);
  } catch (error) {
    logger.warn('路径锁续租失败。', {
      uri: uri.toString(),
      lockPath,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    rmSync(temporary, { force: true });
  }
}

/** 释放：owner 不匹配就不删。 */
function releaseLockFile(lockPath: string, owner: string, uri: Uri, logger: Logger): void {
  let state: LockFileState;
  try {
    state = readLockStateSync(lockPath);
  } catch (error) {
    logger.warn('路径锁释放时读取失败，未删除锁文件。', {
      uri: uri.toString(),
      lockPath,
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  if (state.kind === 'missing') {
    return;
  }
  if (state.kind === 'corrupt') {
    logger.warn('路径锁文件内容损坏，未删除锁文件。', { uri: uri.toString(), lockPath });
    return;
  }
  if (state.record.owner !== owner) {
    logger.warn('路径锁的持有者已变化，未删除锁文件。', {
      uri: uri.toString(),
      lockPath,
      expectedOwner: owner,
      actualOwner: state.record.owner,
    });
    return;
  }
  rmSync(lockPath, { force: true });
}

/** 进程退出兜底：清理本进程创建的锁文件。 */
function installExitHook(): void {
  if (exitHookInstalled) {
    return;
  }
  exitHookInstalled = true;
  process.once('exit', () => {
    for (const [lockPath, owner] of processLocks) {
      try {
        const state = readLockStateSync(lockPath);
        if (state.kind === 'record' && state.record.owner !== owner) {
          continue;
        }
        rmSync(lockPath, { force: true });
      } catch {
        // 进程正在退出，没有补救手段。
      }
    }
    processLocks.clear();
  });
}

export function createPathLockManager(options: PathLockManagerOptions): PathLockManager {
  const dataDir = resolve(options.dataDir);
  const lockOptions = options.lockOptions ?? DEFAULT_LOCK_OPTIONS;
  const defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const logger = options.logger;

  /**
   * 同一进程内同一锁路径的获取排队。
   *
   * 没有它，两个协程会各自读锁文件、各自看到「不存在」、各自尝试创建——虽然
   * `link` 只让一个成功，但失败的会空转一轮，而 `withLock` 的语义是「排队」。
   * 值是一条「前一个持有者释放后才 settle」的 Promise 链。
   */
  const queue = new Map<string, Promise<void>>();
  const active = new Set<string>();

  // 续租检查周期取续租窗口本身：每 `renewSeconds` 检查一次，剩余不足时重写。
  const renewIntervalMs = Math.max(1, lockOptions.renewSeconds * 1000);

  async function acquire(
    uri: Uri,
    mode: LockMode,
    acquireOptions: LockAcquireOptions = {},
  ): Promise<() => void> {
    const lockPath = `${toDiskPath(dataDir, uri)}${LOCK_FILE_SUFFIX}`;
    const timeoutMs = acquireOptions.timeoutMs ?? defaultTimeoutMs;
    const signal = acquireOptions.signal;
    const deadline = Date.now() + timeoutMs;

    assertNotAborted(signal, uri, mode);
    installExitHook();

    const previous = queue.get(lockPath) ?? Promise.resolve();
    let openQueue = (): void => {};
    const gate = new Promise<void>((resolveGate) => {
      openQueue = resolveGate;
    });
    const tail = previous.then(() => gate);
    queue.set(lockPath, tail);

    let released = false;
    const releaseQueue = (): void => {
      openQueue();
      if (queue.get(lockPath) === tail) {
        queue.delete(lockPath);
      }
    };

    let acquired = false;
    try {
      await waitForTurn(previous, deadline, signal, uri, mode, timeoutMs);

      while (true) {
        assertNotAborted(signal, uri, mode);
        const now = new Date();
        const record = createLockRecord(createOwner(), mode, uri, now, lockOptions);
        const existing = await collectExistingLocks(lockPath, dataDir, record);
        const decisions = existing.map((entry) => acquireDecision(entry.record, now));

        if (decisions.includes('wait')) {
          const remaining = deadline - Date.now();
          if (remaining <= 0) {
            throw timeoutError(uri, mode, timeoutMs);
          }
          await sleep(Math.min(pollIntervalMs, remaining), signal, uri, mode);
          continue;
        }

        if (decisions.includes('steal')) {
          for (const [index, entry] of existing.entries()) {
            if (decisions[index] !== 'steal') {
              continue;
            }
            await rm(entry.path, { force: true });
          }
          continue;
        }

        // 目标父目录不存在时目标本身必然不存在：没有内容需要保护，也没有地方放锁文件。
        // 返回空释放函数，避免 `read` / `remove` 一个不存在的路径时创建目录；写者传
        // `createParentDirectory` 时先把目录建出来，否则新路径的并发创建无锁可拿
        // （见 `LockAcquireOptions.createParentDirectory`）。
        // 这一步必须在冲突检查之后：祖先的 `TREE` 锁即使目标还不存在也要等。
        if (!(await ensureLockDirectory(lockPath, acquireOptions.createParentDirectory === true))) {
          return () => {};
        }

        let created: boolean;
        try {
          created = await createLockFile(lockPath, record);
        } catch (error) {
          if (isErrnoCode(error, 'ENOENT')) {
            // 父目录在检查之后被删了：目标随之消失，没有可保护的内容。
            return () => {};
          }
          throw error;
        }
        if (!created) {
          continue;
        }

        acquired = true;
        active.add(lockPath);
        processLocks.set(lockPath, record.owner);

        const timer = setInterval(() => {
          renewLockFile(lockPath, record, uri, lockOptions, logger);
        }, renewIntervalMs);
        // 不 unref 进程退不出去：定时器会让事件循环一直有活。
        timer.unref();

        const release = (): void => {
          if (released) {
            return;
          }
          released = true;
          clearInterval(timer);
          releaseLockFile(lockPath, record.owner, uri, logger);
          active.delete(lockPath);
          processLocks.delete(lockPath);
          releaseQueue();
        };
        return release;
      }
    } finally {
      if (!acquired) {
        releaseQueue();
      }
    }
  }

  return {
    acquire,

    async withLock<T>(
      uri: Uri,
      mode: LockMode,
      fn: () => Promise<T>,
      options: LockAcquireOptions = {},
    ): Promise<T> {
      const release = await acquire(uri, mode, options);
      try {
        return await fn();
      } finally {
        release();
      }
    },

    activeCount(): number {
      return active.size;
    },
  };
}

function createOwner(): string {
  return `${process.pid}-${randomUUID()}`;
}

/**
 * 保证锁文件所在目录存在。
 *
 * 返回 `false` 表示「没有地方放锁文件」，调用方按「无需加锁」处理（空释放函数）：
 * 路径的某个祖先节点是文件时目标不可能是可写文件，硬造目录只会把一个 409 变成
 * 一个 ENOENT。
 */
async function ensureLockDirectory(lockPath: string, createParent: boolean): Promise<boolean> {
  const parent = dirname(lockPath);
  if (await directoryExists(parent)) {
    return true;
  }
  if (!createParent) {
    return false;
  }
  try {
    await mkdir(parent, { recursive: true });
  } catch (error) {
    if (!isErrnoCode(error, 'EEXIST') && !isErrnoCode(error, 'ENOTDIR')) {
      throw error;
    }
  }
  return directoryExists(parent);
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch (error) {
    if (isErrnoCode(error, 'ENOENT') || isErrnoCode(error, 'ENOTDIR')) {
      return false;
    }
    throw error;
  }
}

/**
 * 等进程内排队轮到自己。
 *
 * 只在 `previous` 上等会漏掉超时与取消：排在前面的持有者卡死时，后来的获取方
 * 会一直挂着。这里与超时/取消信号赛跑，谁先到用谁。
 */
async function waitForTurn(
  previous: Promise<void>,
  deadline: number,
  signal: AbortSignal | undefined,
  uri: Uri,
  mode: LockMode,
  timeoutMs: number,
): Promise<void> {
  assertNotAborted(signal, uri, mode);

  const cleanups: (() => void)[] = [];
  const guard = new Promise<never>((_resolve, reject) => {
    const timer = setTimeout(
      () => reject(timeoutError(uri, mode, timeoutMs)),
      Math.max(0, deadline - Date.now()),
    );
    timer.unref();
    const onAbort = (): void => reject(abortedError(uri, mode));
    signal?.addEventListener('abort', onAbort, { once: true });
    cleanups.push(() => clearTimeout(timer));
    cleanups.push(() => signal?.removeEventListener('abort', onAbort));
  });

  try {
    await Promise.race([previous, guard]);
  } finally {
    for (const cleanup of cleanups) {
      cleanup();
    }
  }
}

async function sleep(
  ms: number,
  signal: AbortSignal | undefined,
  uri: Uri,
  mode: LockMode,
): Promise<void> {
  try {
    await delay(ms, undefined, signal === undefined ? {} : { signal });
  } catch (error) {
    if (isErrnoCode(error, 'ABORT_ERR') || (error instanceof Error && error.name === 'AbortError')) {
      throw abortedError(uri, mode);
    }
    throw error;
  }
}
