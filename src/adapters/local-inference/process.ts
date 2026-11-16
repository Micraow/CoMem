/**
 * 本地推理子进程的 OS 边界（架构文档 §18.2）。
 *
 * 只负责 spawn、记录可核验的进程身份、等待就绪与停止已核验的进程组。启动前置条件
 * 和端口冲突由 `manager.ts` 判断；这里不读请求，也不决定使用哪个模型或设备。
 */

import { spawn } from 'node:child_process';

import { ComemError } from '../../domain/errors.js';

import { waitForReady, type HealthSnapshot } from './health.js';
import {
  clearPid,
  isAlive,
  isManagedProcess,
  readPid,
  signalProcessGroup,
  writePid,
} from './pid-file.js';

const SPAWN_ERROR_WAIT_MS = 50;
const STOP_TIMEOUT_MS = 5_000;
const FORCE_STOP_TIMEOUT_MS = 1_000;
const EXIT_POLL_INTERVAL_MS = 100;

interface ExitState {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface ProcessLaunchOptions {
  readonly directory: string;
  readonly pidPath: string;
  readonly endpoint: string;
  readonly timeoutMs: number;
  readonly spawnArgs: readonly string[];
}

export interface ProcessLaunchResult {
  readonly pid: number;
  readonly health: HealthSnapshot | null;
  readonly reason: string | null;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function launchInferenceProcess(
  options: ProcessLaunchOptions,
): Promise<ProcessLaunchResult> {
  const exit: ExitState = { code: null, signal: null };
  const child = spawn('nice', options.spawnArgs, {
    cwd: options.directory,
    detached: true,
    stdio: 'ignore',
  });
  const spawnError: { message: string | null } = { message: null };
  child.once('error', (error) => {
    spawnError.message = error.message;
  });
  if (child.pid === undefined) {
    await delay(SPAWN_ERROR_WAIT_MS);
    throw new ComemError('INTERNAL', '无法启动本地推理服务：启动命令没有跑起来。', {
      error: spawnError.message ?? 'spawn 没有返回进程号',
    });
  }
  const pid = child.pid;
  if (writePid(options.pidPath, pid) === null) {
    signalProcessGroup(pid, 'SIGKILL');
    clearPid(options.pidPath);
    throw new ComemError(
      'INTERNAL',
      '无法记录本地推理服务的进程身份，已停止刚启动的进程。',
      { started: false, ready: false, pid },
    );
  }
  child.once('exit', (code, signal) => {
    exit.code = code;
    exit.signal = signal;
  });
  child.unref();

  const health = await waitForReady(options.endpoint, options.timeoutMs, pid, isAlive);
  if (health !== null) {
    return { pid, health, reason: null };
  }
  const reason =
    exit.code !== null || exit.signal !== null
      ? `进程已退出（${exit.signal === null ? `退出码 ${String(exit.code)}` : `信号 ${exit.signal}`}）。`
      : `等待 ${String(Math.round(options.timeoutMs / 1_000))} 秒后仍未就绪。`;
  // 存活但未就绪的进程仍归控制台管理；清掉 pid 会让它变成不可停止的孤儿。
  if (!isAlive(pid)) {
    clearPid(options.pidPath);
  }
  return { pid, health: null, reason };
}

/** 停止 pid 文件里已核验归属的进程组。无法核验时只清陈旧记录。 */
export async function stopManagedProcess(pidPath: string): Promise<boolean> {
  const record = readPid(pidPath);
  if (record === null) {
    clearPid(pidPath);
    return false;
  }
  if (!isManagedProcess(record)) {
    clearPid(pidPath);
    return false;
  }
  signalProcessGroup(record.pid, 'SIGTERM');
  const stopped = await waitExit(record.pid, STOP_TIMEOUT_MS);
  if (!stopped && isManagedProcess(record)) {
    signalProcessGroup(record.pid, 'SIGKILL');
    await waitExit(record.pid, FORCE_STOP_TIMEOUT_MS);
  }
  clearPid(pidPath);
  return true;
}

async function waitExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) {
      return true;
    }
    await delay(EXIT_POLL_INTERVAL_MS);
  }
  return !isAlive(pid);
}
