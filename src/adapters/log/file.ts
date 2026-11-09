/**
 * 错误日志文件（架构文档 §17.8、§18 的 `logging.file`）。
 *
 * 装饰器形态：**所有**调用原样转给 `inner`（标准输出），只有 `error` 及以上额外
 * 追加进 `filePath`。配置里留空 `logging.file` 时压根不构造它，所以「只写 stdout」
 * 不需要开关。
 *
 * ## 为什么不用 `appendFileSync`
 *
 * `adapters/` 允许 `node:fs`，但同步写在事件循环上阻塞。日志是旁路，不能因为磁盘
 * 慢就把请求拖慢。用异步 `appendFile`，并串行化写入保证行序。
 *
 * ## 失败必须降级
 *
 * 磁盘满、权限、路径被当成目录——日志写不进去时业务照常跑。第一次失败记一条
 * `warn`（走 `inner`），之后静默：失败时再写日志会递归，而且同一故障刷屏只会把
 * 真正的错误挤出去。
 *
 * ## 轮转
 *
 * 写之前 `stat` 一次，超过 `maxBytes` 就 `rename` 成 `${filePath}.1`（覆盖旧文件）。
 * 只留一份历史：`error.log` 是排障用的，`.1` 够回答「上一次崩在哪」。轮转失败不
 * 抛错——rename 失败时继续往原文件追加，总比丢日志好。
 *
 * 每条错误日志一行 JSON（§17.8），与 `ConsoleLogger` 同形：
 * `{...fields, level, time, msg}`。
 */

import { appendFile, mkdir, rename, stat } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { LogFields, Logger } from '../../domain/log.js';

/**
 * 单文件上限默认值：10MB（10 × 1024 × 1024）。
 *
 * 经验值，来源未知：架构文档 §18 只给了「填路径则额外写 error.log」，没给轮转阈值。
 * 10MB 在「一周错误日志」与「单个文件还能用编辑器打开」之间取了个中间值。
 */
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;

/** 轮转后的历史文件名后缀。只留一份（架构文档未规定份数）。 */
const ROTATED_FILE_SUFFIX = '.1';

/** 文件不存在（首次写入）不算错误，`stat` 失败时靠它区分「没有文件」和「真故障」。 */
function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

export interface FileLoggerOptions {
  readonly inner: Logger;
  readonly filePath: string;
  /** 单文件上限，默认 10MB，超了轮转成 `.1`。经验值，来源未知 */
  readonly maxBytes?: number;
}

export class FileLogger implements Logger {
  readonly #inner: Logger;
  readonly #filePath: string;
  readonly #maxBytes: number;
  /** 串行化写入：`appendFile` 之间没有顺序保证，靠 promise 链排队。 */
  #queue: Promise<void> = Promise.resolve();
  #directoryReady = false;
  #degraded = false;

  constructor(options: FileLoggerOptions) {
    this.#inner = options.inner;
    this.#filePath = options.filePath;
    this.#maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  }

  debug(message: string, fields?: LogFields): void {
    this.#inner.debug(message, fields);
  }

  info(message: string, fields?: LogFields): void {
    this.#inner.info(message, fields);
  }

  warn(message: string, fields?: LogFields): void {
    this.#inner.warn(message, fields);
  }

  error(message: string, fields?: LogFields): void {
    // 先落 inner：即使下面的文件写入排队失败，标准输出也已经拿到了这一行。
    this.#inner.error(message, fields);
    const record = { ...fields, level: 'error', time: new Date().toISOString(), msg: message };
    this.#enqueue(`${JSON.stringify(record)}\n`);
  }

  /**
   * 等已排队的写入落盘（`Logger.flush` 的可选方法，优雅退出用）。
   *
   * 永远 resolve：写日志失败不是调用方的错误（失败已经在 `#degrade` 里记过）。
   */
  async flush(): Promise<void> {
    await this.#queue;
  }

  #enqueue(line: string): void {
    this.#queue = this.#queue
      .then(async () => {
        await this.#ensureDirectory();
        await this.#rotateIfNeeded();
        await appendFile(this.#filePath, line, 'utf8');
      })
      .catch((error: unknown) => {
        this.#degrade(error);
      });
  }

  async #ensureDirectory(): Promise<void> {
    if (this.#directoryReady) {
      return;
    }
    await mkdir(dirname(this.#filePath), { recursive: true });
    this.#directoryReady = true;
  }

  async #rotateIfNeeded(): Promise<void> {
    let size: number;
    try {
      size = (await stat(this.#filePath)).size;
    } catch (error) {
      if (isNotFound(error)) {
        return;
      }
      throw error;
    }
    if (size <= this.#maxBytes) {
      return;
    }
    try {
      // rename 覆盖旧 `.1`：只留一份历史，目录不会无限增长。
      await rename(this.#filePath, `${this.#filePath}${ROTATED_FILE_SUFFIX}`);
    } catch {
      // 轮转失败不抛：继续往原文件追加，总比把这条日志丢掉好。
    }
  }

  #degrade(error: unknown): void {
    if (this.#degraded) {
      return;
    }
    this.#degraded = true;
    this.#inner.warn('写入 error.log 失败，日志只输出到标准输出。', {
      filePath: this.#filePath,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
