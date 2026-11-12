/**
 * 本地推理子进程的 pid 文件（架构文档 §18.2）。
 *
 * HTTP 进程重启后不认识旧子进程，所以 pid 落在 `{dataDir}/_meta/local-inference.pid`。
 * stop 只杀这个 pid 与它的进程组，不按名字 `pkill`——用户可能在终端里手动跑着同一个
 * server.py，按名字杀会把用户自己的实例收掉。
 *
 * pid 文件只由本进程写，但 pid 会被系统复用：`isManagedProcess` 再看一眼
 * `/proc/<pid>/cmdline`，对不上就只清文件。
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { fsErrorCode } from '../../domain/errors.js';

const PID_FILE = 'local-inference.pid';
/** cmdline 里必须出现的片段：spawn 的最后一个 exec 是 `python server.py ...`。 */
const SERVER_ARGUMENT = 'server.py';

export function pidPathOf(dataDir: string): string {
  return join(dataDir, '_meta', PID_FILE);
}

export function readPid(path: string): number | null {
  try {
    const pid = Number(readFileSync(path, 'utf8').trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export function writePid(path: string, pid: number): void {
  const directory = dirname(path);
  if (!existsSync(directory)) {
    mkdirSync(directory, { recursive: true });
  }
  writeFileSync(path, `${String(pid)}\n`, 'utf8');
}

export function clearPid(path: string): void {
  rmSync(path, { force: true });
}

/** 进程是否还活着。`EPERM` 视为活着（还在，只是不归我们杀）。 */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return fsErrorCode(error) !== 'ESRCH';
  }
}

/** pid 是否仍是我们启动的那个 server.py。没有 `/proc` 时只能信任 pid 文件。 */
export function isManagedProcess(pid: number): boolean {
  if (!isAlive(pid)) {
    return false;
  }
  try {
    return readFileSync(`/proc/${String(pid)}/cmdline`, 'utf8').includes(SERVER_ARGUMENT);
  } catch {
    return true;
  }
}

/** 只对进程组发信号；没有进程组（非 detached）时退回单进程。 */
export function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // 已经退出：调用方按存活检查收尾。
    }
  }
}
