/**
 * 事件去重（架构文档 §15.4 第 1 层）。
 *
 * 宿主可能把同一个 hook 事件重复投递，同一个 `eventId` 在 500ms 窗口内只处理一次。
 *
 * ## 为什么必须有落盘实现
 *
 * §15.4 写的是「内存 Map + 时间戳」，但 §15.8 又规定每个 hook 是独立进程——
 * 内存 Map 出了进程就没了，跨进程重复投递一条也挡不住。所以：
 *
 * - `EventDeduper` 是纯内存实现，行为与 §15.4 一致，单进程内（未来的常驻守护
 *   进程）直接用它；
 * - `FileEventDeduper` 把窗口落在 `{tmpdir}/comem-events.json`，hook 进程用它。
 *
 * 写入是「读 → 合并 → 原子 rename」，两个进程同时写会有一方丢更新——最坏结果是
 * 少去重一次（重复处理），不是丢事件。§15.4 的取向是「宁可重复不能丢」，这个
 * 降级方向是对的。
 *
 * ## 宿主不提供 eventId 时不去重
 *
 * Claude Code 的 `Stop` 载荷里没有事件 ID，而两轮合法的 `Stop` 载荷可以完全一样
 * （同一个 transcript）。拿载荷哈希当 ID 会把第二轮当成重复事件吞掉——那是丢消息。
 * 所以 `eventId` 为 `null`/`undefined` 时一律放行，重投由游标兜底（第 2 层）。
 */

import { readFile, rename, writeFile } from 'node:fs/promises';

import { ComemHookError } from './http.mjs';

/** 去重窗口。500ms 来自架构文档 §15.4。 */
export const DEDUP_WINDOW_MS = 500;

/** 内存条目的上限。经验值：窗口 500ms，正常并发远到不了这个量级，超了直接清空。 */
const MAX_ENTRIES = 1000;

export class EventDeduper {
  /**
   * @param {{ windowMs?: number, now?: () => number }} [options]
   */
  constructor(options = {}) {
    this.windowMs = options.windowMs ?? DEDUP_WINDOW_MS;
    this.now = options.now ?? Date.now;
    this.entries = new Map();
  }

  /**
   * `true` 表示「这条事件该处理」，同时记下时间戳；`false` 表示窗口内重复。
   *
   * 没有 `eventId` 时永远返回 `true`（见文件头）。
   *
   * @param {string | null | undefined} eventId
   * @returns {boolean}
   */
  accept(eventId) {
    if (typeof eventId !== 'string' || eventId === '') {
      return true;
    }
    const now = this.now();
    this.prune(now);
    const seenAt = this.entries.get(eventId);
    if (seenAt !== undefined && now - seenAt < this.windowMs) {
      return false;
    }
    this.entries.set(eventId, now);
    return true;
  }

  prune(now) {
    if (this.entries.size < MAX_ENTRIES) {
      for (const [eventId, seenAt] of this.entries) {
        if (now - seenAt >= this.windowMs) {
          this.entries.delete(eventId);
        }
      }
      return;
    }
    this.entries.clear();
  }
}

/**
 * 把窗口落在文件里的去重器。每个 hook 进程构造一次，`accept` 是异步的。
 */
export class FileEventDeduper {
  /**
   * @param {string} file
   * @param {{ windowMs?: number, now?: () => number }} [options]
   */
  constructor(file, options = {}) {
    this.file = file;
    this.deduper = new EventDeduper(options);
  }

  /**
   * @param {string | null | undefined} eventId
   * @returns {Promise<boolean>}
   */
  async accept(eventId) {
    if (typeof eventId !== 'string' || eventId === '') {
      return true;
    }
    const now = Date.now();
    const records = await this.read(now);

    // 先按文件里的记录判断，再交给内存去重器——前者跨进程，后者兜住同进程多次调用。
    const seen = records.some(
      (record) => record.eventId === eventId && now - record.seenAt < DEDUP_WINDOW_MS,
    );
    if (seen || !this.deduper.accept(eventId)) {
      return false;
    }

    records.push({ eventId, seenAt: now });
    await this.write(records);
    return true;
  }

  async read(now) {
    let text;
    try {
      text = await readFile(this.file, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') {
        return [];
      }
      throw new ComemHookError(`读取事件去重文件失败：${this.file}`, {
        code: 'HOOK_INVALID_CONFIG',
        cause: error,
      });
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      // 文件被写坏（并发写、磁盘满）。丢掉重来：最坏是少去重一次，不是丢事件。
      return [];
    }
    if (!Array.isArray(parsed)) {
      return [];
    }
    const records = [];
    for (const record of parsed) {
      if (
        typeof record === 'object' &&
        record !== null &&
        typeof record.eventId === 'string' &&
        typeof record.seenAt === 'number' &&
        now - record.seenAt < DEDUP_WINDOW_MS
      ) {
        records.push({ eventId: record.eventId, seenAt: record.seenAt });
      }
    }
    return records;
  }

  async write(records) {
    const temporary = `${this.file}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(records), 'utf8');
    await rename(temporary, this.file);
  }
}
