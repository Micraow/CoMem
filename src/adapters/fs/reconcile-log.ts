/**
 * 对账日志的读写（架构文档 §10.6「索引双写补偿」）。
 *
 * 日志在 `_meta/reconcile.log`，一行一个 JSON。写侧是追加，读侧要能容忍坏行，
 * 清理时要**原子重写**——直接截断再写会在崩溃窗口里丢掉还没重放的记录。
 *
 * ## 并发：同一进程内追加与重写串行
 *
 * 重放与写路径会同时碰这个文件：重放读完快照、正在重做索引时，`add_resource`
 * 可能又追加了一条新失败。如果重放结束时直接拿旧快照覆盖文件，新记录就没了。
 *
 * 这里用一条 Promise 队列把 `append` / `read` / `compact` 串起来，但**不覆盖整个
 * 重放过程**——重放本身是慢操作（逐条写索引），持有队列会让写路径的对账记录排队。
 * 正确做法是：重放结束时 `compact` 在队列里**重新读一次文件**，只摘掉已知解决的
 * 行；重放期间追加的行自然会被读进来并保留。
 *
 * 队列只管本进程。多进程共享同一个数据根不在 v1 的支持范围（SQLite 与路径锁也
 * 没按多进程设计），这一点写进 `docs/operations.md` 的已知限制。
 */

import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { fsErrorCode } from '../../domain/errors.js';
import type { Logger } from '../../domain/log.js';
import {
  parseReconcileEntry,
  reconcileEntryKey,
  type ReconcileEntry,
  type ReconcileLogSnapshot,
} from '../../domain/reconcile.js';

/** 元数据目录（§6.5 的 `_meta/`）。 */
const META_DIRECTORY = '_meta';
const RECONCILE_LOG_FILE = 'reconcile.log';

/** 重写用的临时文件名。同目录 rename 才是原子的（跨设备 rename 会退化成复制）。 */
const TEMP_FILE_SUFFIX = '.tmp';

export interface ReconcileLogOptions {
  readonly dataDir: string;
  readonly logger: Logger;
}

export interface ReconcileCompactResult {
  /** 重写后留下的行数（含重放期间新追加的） */
  readonly kept: number;
  /** 按已解决集合摘掉的行数 */
  readonly removed: number;
  /** 坏行被丢弃的数量 */
  readonly corruptDropped: number;
}

export class ReconcileLog {
  readonly #dataDir: string;
  readonly #logger: Logger;
  /** 串行队列；失败不阻断后续操作。 */
  #queue: Promise<void> = Promise.resolve();

  constructor(options: ReconcileLogOptions) {
    this.#dataDir = options.dataDir;
    this.#logger = options.logger;
  }

  /** 追加一行。目录不存在时创建。 */
  async append(entry: ReconcileEntry): Promise<void> {
    await this.#enqueue(async () => {
      const path = this.#path();
      await mkdir(dirname(path), { recursive: true });
      await appendFile(path, `${JSON.stringify(entry)}\n`, 'utf8');
    });
  }

  /** 读全部有效行；不存在按空文件处理。 */
  async read(): Promise<ReconcileLogSnapshot> {
    return this.#enqueue(() => this.#readNow());
  }

  /**
   * 原子重写：只保留**当前文件里**不属于 `resolvedKeys` 的有效行。
   *
   * 关键点是「当前文件里」——这个方法的读取发生在队列内，也就是重放结束之后。
   * 重放期间新追加的失败记录会参与这次读取，因此不会被覆盖；只有已知解决的行
   * 与坏行被摘掉。坏行没有重放价值，留在文件里只会让每次启动都再报一次 warn。
   */
  async compact(resolvedKeys: ReadonlySet<string>): Promise<ReconcileCompactResult> {
    return this.#enqueue(async () => {
      const snapshot = await this.#readNow();
      if (snapshot.entries.length === 0 && snapshot.corrupt.length === 0) {
        // 空日志不重写：启动与每 30 秒一轮都会调到这里，没东西可清时不该碰磁盘。
        return { kept: 0, removed: 0, corruptDropped: 0 };
      }
      const kept = snapshot.entries.filter((entry) => !resolvedKeys.has(reconcileEntryKey(entry)));
      const path = this.#path();
      await mkdir(dirname(path), { recursive: true });
      const temporary = `${path}${TEMP_FILE_SUFFIX}`;
      await writeFile(temporary, kept.map((entry) => `${JSON.stringify(entry)}\n`).join(''), 'utf8');
      await rename(temporary, path);
      const result: ReconcileCompactResult = {
        kept: kept.length,
        removed: snapshot.entries.length - kept.length,
        corruptDropped: snapshot.corrupt.length,
      };
      this.#logger.debug('对账日志已重写。', { ...result });
      return result;
    });
  }

  #path(): string {
    return join(this.#dataDir, META_DIRECTORY, RECONCILE_LOG_FILE);
  }

  async #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(operation, operation);
    // 队列本身不保留错误：一次追加失败不能让后续读 / 重写永远拒绝。
    this.#queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async #readNow(): Promise<ReconcileLogSnapshot> {
    let raw: string;
    try {
      raw = await readFile(this.#path(), 'utf8');
    } catch (error) {
      if (fsErrorCode(error) === 'ENOENT') {
        return { entries: [], corrupt: [] };
      }
      throw error;
    }

    const entries: ReconcileEntry[] = [];
    const corrupt: { line: number; reason: string }[] = [];
    const lines = raw.split('\n');
    for (const [index, line] of lines.entries()) {
      const trimmed = line.trim();
      if (trimmed === '') {
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed) as unknown;
      } catch {
        corrupt.push({ line: index + 1, reason: '不是合法 JSON' });
        continue;
      }
      const entry = parseReconcileEntry(parsed);
      if (entry === null) {
        corrupt.push({ line: index + 1, reason: '缺少 op / uri / error / at 字段' });
        continue;
      }
      entries.push(entry);
    }
    return { entries, corrupt };
  }
}
