/**
 * 本地推理子进程的 pid 文件（架构文档 §18.2）。
 *
 * HTTP 进程重启后不认识旧子进程，所以 pid 落在 `{dataDir}/_meta/local-inference.pid`。
 * stop 只杀这个 pid 与它的进程组，不按名字 `pkill`——用户可能在终端里手动跑着同一个
 * server.py，按名字杀会把用户自己的实例收掉。
 *
 * pid 文件只由本进程写，但 pid 会被系统复用：文件同时记录 `/proc/<pid>/stat`
 * 的启动时刻，并再次核对 cmdline。旧格式或对不上的记录一律不授权停止进程。
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { fsErrorCode } from '../../domain/errors.js';

const PID_FILE = 'local-inference.pid';
/** cmdline 里必须出现的片段：spawn 的最后一个 exec 是 `python server.py ...`。 */
const SERVER_ARGUMENT = 'server.py';

export interface PidRecord {
  readonly pid: number;
  /** `/proc/<pid>/stat` 的字段 22；pid 复用时这个值会变化。 */
  readonly startTime: string;
}

export function pidPathOf(dataDir: string): string {
  return join(dataDir, '_meta', PID_FILE);
}

export function readPid(path: string): PidRecord | null {
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (
      typeof value !== 'object' ||
      value === null ||
      !('pid' in value) ||
      !('startTime' in value) ||
      typeof value.pid !== 'number' ||
      !Number.isInteger(value.pid) ||
      value.pid <= 0 ||
      typeof value.startTime !== 'string' ||
      !/^\d+$/.test(value.startTime)
    ) {
      return null;
    }
    return { pid: value.pid, startTime: value.startTime };
  } catch {
    return null;
  }
}

export function writePid(path: string, pid: number): PidRecord | null {
  const startTime = processStartTime(pid);
  if (startTime === null) {
    return null;
  }
  const record = { pid, startTime };
  const directory = dirname(path);
  if (!existsSync(directory)) {
    mkdirSync(directory, { recursive: true });
  }
  writeFileSync(path, `${JSON.stringify(record)}\n`, 'utf8');
  return record;
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

/** pid 是否仍是我们启动的那个 server.py；无法确认时一律返回 `false`。 */
export function isManagedProcess(record: PidRecord): boolean {
  if (!isAlive(record.pid) || processStartTime(record.pid) !== record.startTime) {
    return false;
  }
  try {
    return readFileSync(`/proc/${String(record.pid)}/cmdline`, 'utf8').includes(SERVER_ARGUMENT);
  } catch {
    return false;
  }
}

function processStartTime(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${String(pid)}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
    const startTime = fields[19];
    return startTime !== undefined && /^\d+$/.test(startTime) ? startTime : null;
  } catch {
    return null;
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
