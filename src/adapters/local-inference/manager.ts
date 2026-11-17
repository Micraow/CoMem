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

import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ComemError } from '../../domain/errors.js';

import {
  hasEndpointListener,
  probeHealth,
  waitForReady,
  type HealthSnapshot,
} from './health.js';
import { clearPid, isAlive, isManagedProcess, pidPathOf, readPid } from './pid-file.js';
import { launchInferenceProcess, stopManagedProcess } from './process.js';
import {
  installCommandOf,
  LOCAL_INFERENCE_DIRECTORY,
  LOCAL_INFERENCE_ENDPOINT,
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

export interface LocalInferenceManagerOptions {
  readonly dataDir: string;
  /** 测试用：覆盖仓库根，避免测试启动仓库里真实的 Python 进程。 */
  readonly repoRoot?: string;
  /** 测试用：覆盖固定本地地址，避免占用真实 8089。 */
  readonly endpoint?: string;
  /** 测试用：缩短等待时间。 */
  readonly startTimeoutMs?: number;
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
    this.#endpoint = options.endpoint ?? LOCAL_INFERENCE_ENDPOINT;
    this.#startTimeoutMs = options.startTimeoutMs ?? START_TIMEOUT_MS;
  }

  async status(): Promise<LocalInferenceStatus> {
    const missing = missingOf(this.#dir);
    const available = missing.every((item) => item === 'rerank-model');
    const health = await probeHealth(this.#endpoint);
    const running = health?.ready === true;
    const pid = readPid(this.#pidPath);
    const managed = pid !== null && isManagedProcess(pid);
    return {
      available,
      running,
      managed,
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
    if (!(await stopManagedProcess(this.#pidPath))) {
      throw this.#notManaged();
    }
  }

  async #startOnce(): Promise<LocalInferenceStartResult> {
    const current = await probeHealth(this.#endpoint);
    const record = readPid(this.#pidPath);
    if (current?.ready === true) {
      if (record !== null && isManagedProcess(record)) {
        return this.#readyResult(current);
      }
      throw this.#listenerConflict(true);
    }

    if (record !== null && isManagedProcess(record)) {
      // 上一条 start 已经拉起进程、还在加载：等它，不再 spawn 第二个去抢端口。
      const health = await waitForReady(this.#endpoint, this.#startTimeoutMs, record.pid, isAlive);
      if (health !== null) {
        return this.#readyResult(health);
      }
      throw this.#notReady(record.pid, `已有进程（pid ${String(record.pid)}）没有进入就绪状态。`);
    }
    clearPid(this.#pidPath);

    const missing = missingOf(this.#dir);
    if (missing.some((item) => item !== 'rerank-model')) {
      throw new ComemError(
        'INVALID_ARGUMENT',
        `本机无法启动本地推理服务，缺少：${missing.map((item) => missingLabelOf(item)).join('、')}。`,
        { missing, startCommand: installCommandOf(missing) },
      );
    }

    if (await hasEndpointListener(this.#endpoint)) {
      throw this.#listenerConflict(false);
    }

    const launched = await launchInferenceProcess({
      directory: this.#dir,
      pidPath: this.#pidPath,
      endpoint: this.#endpoint,
      timeoutMs: this.#startTimeoutMs,
      spawnArgs: this.#spawnArgs(missing),
    });
    if (launched.health !== null) {
      return this.#readyResult(launched.health);
    }
    throw this.#notReady(launched.pid, launched.reason ?? '进程没有进入就绪状态。');
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

  #listenerConflict(ready: boolean): ComemError {
    return new ComemError(
      'CONFLICT',
      `本地地址 ${this.#endpoint} 已有${ready ? '可用' : ''}服务，但不是由此控制台启动；未启动或停止该服务。`,
      { started: false, ready, reason: 'endpoint_in_use' },
    );
  }

  #notManaged(): ComemError {
    return new ComemError(
      'CONFLICT',
      '没有找到由此控制台启动的本地推理服务；未停止其他进程。',
      { stopped: false, reason: 'not_managed' },
    );
  }
}
