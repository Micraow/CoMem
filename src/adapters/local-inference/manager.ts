/**
 * 本地推理服务的进程管理（架构文档 §18.2）。
 *
 * 只服务控制台设置页：探测本机是否具备可启动的推理服务、按固定命令启动、停止
 * **自己启动的**那个进程。请求体不参与任何决策——device / threads / 端口都不接受
 * 外部输入，命令只在这里写一份。
 *
 * 仓库根从模块位置推导，不用 `process.cwd()`：`local-inference/` 跟着仓库走，服务
 * 可能从任意工作目录启动。`src/adapters/local-inference/` 与构建后的
 * `dist/adapters/local-inference/` 深度相同，`../../..` 在两处都指向仓库根
 * （同样的理由见 `config/prompt-defaults.ts`）。
 */

import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ComemError } from '../../domain/errors.js';

import { probeHealth, waitForReady, type HealthSnapshot } from './health.js';
import {
  clearPid,
  isAlive,
  isManagedProcess,
  pidPathOf,
  readPid,
  signalProcessGroup,
  writePid,
} from './pid-file.js';
import {
  endpointOf,
  installCommandOf,
  LOCAL_INFERENCE_DIRECTORY,
  missingLabelOf,
  missingOf,
  type LocalInferenceMissing,
  type LocalInferenceStartResult,
  type LocalInferenceStatus,
} from './status.js';

/**
 * 启动后等就绪的上限。
 *
 * 比控制台 `useApi` 的 30 秒请求超时短 5 秒：模型加载实测 8 秒左右，25 秒足够；
 * 服务端等到 30 秒再回 409 时浏览器已经先断开，前端只能看到「请求超时」。
 */
const START_TIMEOUT_MS = 25_000;
const STOP_TIMEOUT_MS = 5_000;

interface ExitState {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface LocalInferenceManagerOptions {
  readonly dataDir: string;
  /** `providers.embedding.baseUrl`；空串用默认 8089。 */
  readonly baseUrl: string;
  /** 测试用：覆盖仓库根，避免测试启动仓库里真实的 Python 进程。 */
  readonly repoRoot?: string;
  /** 测试用：缩短等待时间。 */
  readonly startTimeoutMs?: number;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export class LocalInferenceManager {
  readonly #dir: string;
  readonly #pidPath: string;
  readonly #endpoint: string;
  readonly #startTimeoutMs: number;
  #starting: Promise<LocalInferenceStartResult> | null = null;

  constructor(options: LocalInferenceManagerOptions) {
    const repoRoot = options.repoRoot ?? fileURLToPath(new URL('../../..', import.meta.url));
    this.#dir = join(repoRoot, LOCAL_INFERENCE_DIRECTORY);
    this.#pidPath = pidPathOf(options.dataDir);
    this.#endpoint = endpointOf(options.baseUrl);
    this.#startTimeoutMs = options.startTimeoutMs ?? START_TIMEOUT_MS;
  }

  async status(): Promise<LocalInferenceStatus> {
    const missing = missingOf(this.#dir);
    const available = missing.every((item) => item === 'rerank-model');
    const health = available ? await probeHealth(this.#endpoint) : null;
    const running = health?.ready === true;
    return {
      available,
      running,
      endpoint: this.#endpoint,
      dimension: running ? health.dimension : null,
      backend: running ? health.backend : null,
      device: running ? health.device : null,
      model: running ? health.model : null,
      missing,
      startCommand: available ? null : installCommandOf(missing),
    };
  }

  start(): Promise<LocalInferenceStartResult> {
    if (this.#starting !== null) {
      return this.#starting;
    }
    const running = this.#startOnce();
    this.#starting = running;
    running.then(
      () => {
        this.#starting = null;
      },
      () => {
        this.#starting = null;
      },
    );
    return running;
  }

  async stop(): Promise<void> {
    const pid = readPid(this.#pidPath);
    if (pid === null) {
      return;
    }
    // pid 可能是别的进程复用出来的：只清文件，不杀。
    if (!isManagedProcess(pid)) {
      clearPid(this.#pidPath);
      return;
    }
    signalProcessGroup(pid, 'SIGTERM');
    if (!(await this.#waitExit(pid, STOP_TIMEOUT_MS))) {
      signalProcessGroup(pid, 'SIGKILL');
      await this.#waitExit(pid, 1_000);
    }
    clearPid(this.#pidPath);
  }

  async #startOnce(): Promise<LocalInferenceStartResult> {
    const missing = missingOf(this.#dir);
    if (missing.some((item) => item !== 'rerank-model')) {
      throw new ComemError(
        'INVALID_ARGUMENT',
        `本机无法启动本地推理服务，缺少：${missing.map((item) => missingLabelOf(item)).join('、')}。`,
        { missing, startCommand: installCommandOf(missing) },
      );
    }

    const current = await probeHealth(this.#endpoint);
    if (current?.ready === true) {
      return this.#readyResult(current);
    }

    const existing = readPid(this.#pidPath);
    if (existing !== null && isManagedProcess(existing)) {
      // 上一条 start 已经拉起进程、还在加载：等它，不再 spawn 第二个去抢端口。
      const health = await waitForReady(this.#endpoint, this.#startTimeoutMs, existing, isAlive);
      if (health !== null) {
        return this.#readyResult(health);
      }
      throw this.#notReady(existing, `已有进程（pid ${String(existing)}）没有进入就绪状态。`);
    }
    clearPid(this.#pidPath);

    const exit: ExitState = { code: null, signal: null };
    const child = spawn('nice', this.#spawnArgs(missing), {
      cwd: this.#dir,
      detached: true,
      stdio: 'ignore',
    });
    const spawnError: { message: string | null } = { message: null };
    child.once('error', (error) => {
      spawnError.message = error.message;
    });
    if (child.pid === undefined) {
      await delay(50);
      throw new ComemError('INTERNAL', '无法启动本地推理服务：启动命令没有跑起来。', {
        error: spawnError.message ?? 'spawn 没有返回进程号',
      });
    }
    const pid = child.pid;
    writePid(this.#pidPath, pid);
    child.once('exit', (code, signal) => {
      exit.code = code;
      exit.signal = signal;
    });
    child.unref();

    const health = await waitForReady(this.#endpoint, this.#startTimeoutMs, pid, isAlive);
    if (health !== null) {
      return this.#readyResult(health);
    }
    const reason =
      exit.code !== null || exit.signal !== null
        ? `进程已退出（${exit.signal === null ? `退出码 ${String(exit.code)}` : `信号 ${exit.signal}`}）。`
        : `等待 ${String(Math.round(this.#startTimeoutMs / 1_000))} 秒后仍未就绪。`;
    clearPid(this.#pidPath);
    throw this.#notReady(pid, reason);
  }

  #spawnArgs(missing: readonly LocalInferenceMissing[]): readonly string[] {
    const args = [
      '-n',
      '10',
      'taskset',
      '-c',
      '0-5',
      '.venv/bin/python',
      'server.py',
      '--device',
      'cpu',
      '--threads',
      '6',
    ];
    // 重排模型缺失不阻止 embedding 启动：server.py 支持只加载一个模型。
    return missing.includes('rerank-model') ? [...args, '--no-rerank'] : args;
  }

  #readyResult(health: HealthSnapshot): LocalInferenceStartResult {
    return {
      started: true,
      ready: true,
      endpoint: this.#endpoint,
      dimension: health.dimension,
    };
  }

  #notReady(pid: number, reason: string): ComemError {
    return new ComemError('CONFLICT', `本地推理服务已启动，但没有在限定时间内就绪：${reason}`, {
      started: true,
      ready: false,
      reason,
      pid,
    });
  }

  async #waitExit(pid: number, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!isAlive(pid)) {
        return true;
      }
      await delay(100);
    }
    return !isAlive(pid);
  }
}
