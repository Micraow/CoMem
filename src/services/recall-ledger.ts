/**
 * 召回账本（架构文档 §8.7）。
 *
 * 账本是**每个作用域一份** `{dataDir}/_meta/recall/{scopeKey}.recall_log.json`，
 * 条目带 `sessionId`，记录「第 N 轮给模型投喂了哪些 URI、投喂到什么粒度」。下一轮
 * 召回时，同一个会话在 `dedupTurns` 轮内投过的不重复投——否则用户连续问三个相关
 * 问题，同一段记忆会被完整注入三次，上下文浪费 2/3，模型还可能因为重复而分心。
 *
 * **文件按作用域分片，条目按会话过滤。** 去重窗口是「本会话最近几轮投过什么」，
 * 按会话隔离是正确性要求：同一用户的两个会话共用一个 `turn` 时钟会互相污染（会话
 * A 跑到第 50 轮后，会话 B 从第 1 轮开始会把 A 投过的全部 URI 当成「刚投过」，
 * 新会话前几轮召回被静默压制）。但文件不能按会话切：每个会话一个文件会产生大量
 * 小文件，而按作用域分片让并发写落在不同文件上。
 *
 * 与 §8.6 第 3 步的去重不是一回事：那里的去重是**同一次请求内**同一 URI 命中多条
 * 记录；这里的账本是**跨请求**的重复。
 *
 * ## 三条规则（§8.7）
 *
 * 1. **只记账真的给了正文的条目。** 只给了 URI 的不记——模型没看到内容，下一轮
 *    还得给。
 * 2. **轮次时钟取消息总数。** `turn = SessionService.totalMessageCount(sessionUri)`
 *    （已归档消息 ID 集合大小 + live 条数）由调用方算好传进来；这一层只消费
 *    `turn`，不认识消息。它天然不小于 live 条数，所以旧公式里的
 *    `max(totalMessageCount, liveMessages.length)` 不再需要：`max` 恒等于前者。
 * 3. **按 `turn - 4 × dedupTurns` 裁剪，上限 500 条。** 两个条件都要满足：先按
 *    轮次裁，再按条数裁（保留最新的）。
 *
 * ## 为什么通过端口读写
 *
 * `services/` 禁止 `node:fs`（架构文档 §4.2），而账本是内部产物、不属于
 * `comem://` URI 空间（`ContentStore` 的地址模型）。所以这一层只定义最小的
 * `LedgerStore` 端口，W6 的 bootstrap 用 `node:fs` 实现，测试用内存实现。
 * 原子写（临时文件 + `rename`）是实现的职责——这一层不关心字节怎么落盘。
 */

import { join } from 'node:path';

import { ComemError } from '../domain/errors.js';
import { isRecord } from '../domain/guards.js';
import type { Logger } from '../domain/log.js';
import type { ContextDetail } from '../domain/render.js';
import type { Uri } from '../domain/uri.js';

export interface RecallEntry {
  readonly uri: string;
  /**
   * 投喂时所在的会话。`null` 表示旧账本里的条目（没有这一列）：它不匹配任何
   * 会话，读取时被忽略——账本是缓存，丢一条只影响去重强度，不影响正确性。
   */
  readonly sessionId: string | null;
  readonly turn: number;
  readonly detail: ContextDetail;
}

export interface RecallLedgerData {
  readonly version: 1;
  readonly entries: readonly RecallEntry[];
}

/**
 * 账本的最小存储端口。`key` 是**绝对路径**：目录布局由账本自己决定（`dataDir` +
 * `_meta/recall/`），端口只负责读写一个路径上的文本。
 */
export interface LedgerStore {
  /** 不存在返回 `null`（不要抛错）。 */
  read(key: string): Promise<string | null>;
  /** 整体替换；实现必须保证原子性（临时文件 + `rename`）。 */
  write(key: string, text: string): Promise<void>;
  /** 删除账本；不存在不是错误（`rm -f` 语义，与 `read` 的 `null` 一致）。 */
  remove(key: string): Promise<void>;
}

export interface RecallLedgerDeps {
  readonly dataDir: string;
  readonly store: LedgerStore;
  readonly logger: Logger;
}

export interface RecallLedgerOptions {
  /** 默认 3（§18 的 `assembly.dedupTurns`） */
  readonly dedupTurns: number;
  /** 默认 500（§8.7） */
  readonly maxEntries: number;
}

/**
 * 一次投放。`detail === null` 表示只给了 URI，不入账（§8.7 规则 1）。
 *
 * 单独于 `RecallEntry` 存在：持久化的条目一定带粒度，而调用方手里的是
 * `assembly.AssembledItem`（`detail` 可为 `null`）。用同一个类型会逼调用方到处
 * 做窄化断言。
 */
export interface DeliveredItem {
  readonly uri: string;
  readonly detail: ContextDetail | null;
}

/**
 * 默认参数（§18）：`dedupTurns` 3、`maxEntries` 500。
 *
 * 集中成常量是为了让 bootstrap 只引用一处；调参仍然走配置。
 */
export const DEFAULT_RECALL_LEDGER_OPTIONS: RecallLedgerOptions = Object.freeze({
  dedupTurns: 3,
  maxEntries: 500,
});

/**
 * 裁剪倍数（§8.7 规则 3）：保留最近 `4 × dedupTurns` 轮。
 *
 * 账本的唯一用途是「`dedupTurns` 轮内不重复投」，留 4 倍余量是为了让窗口边界附近
 * 的历史还查得到（例如把 `dedupTurns` 调大后不必等账本自然淘汰）。这个 4 是
 * §8.7 写死的，不是可调参数。
 */
const PRUNE_TURN_FACTOR = 4;

/**
 * 作用域键的合法字符集：与 URI 根标识一致（`[A-Za-z0-9._@-]+`）。
 *
 * 键要拼进文件名，所以 `/`、反斜杠、控制字符必须拒绝；`..` 由下面的显式判断
 * 单独挡掉，不依赖「根标识恰好不允许」这个巧合。
 */
const SCOPE_KEY_PATTERN = /^[A-Za-z0-9._@-]+$/;

function invalidScopeKey(scopeKey: string, reason: string): ComemError {
  return new ComemError('INVALID_URI', `作用域键不合法：${reason}`, { scopeKey, reason });
}

/**
 * 路径安全校验。返回原键，方便在 `scopeKeyOf` 里直接返回。
 *
 * 这是安全边界，不是防御性编程：`scopeKey` 会拼进 `{dataDir}/_meta/recall/` 下的
 * 文件名，一个含 `..` 的键能把账本写到数据根之外。
 */
function assertScopeKey(scopeKey: string): string {
  if (scopeKey === '') {
    throw invalidScopeKey(scopeKey, '作用域键不能为空');
  }
  if (scopeKey === '.' || scopeKey === '..' || scopeKey.includes('..')) {
    throw invalidScopeKey(scopeKey, '作用域键不能包含 . 或 ..');
  }
  if (scopeKey.startsWith('.')) {
    throw invalidScopeKey(scopeKey, '作用域键不能以 . 开头');
  }
  if (!SCOPE_KEY_PATTERN.test(scopeKey)) {
    throw invalidScopeKey(scopeKey, '作用域键只能包含字母、数字、点、下划线、@ 和连字符');
  }
  return scopeKey;
}

/**
 * URI 的作用域部分：`user_alice` / `group_eng`。
 *
 * 账本文件是**每个作用域一份**，不是每个 URI 一份，也不是每个会话一份：去重的是
 * 「同一个作用域里投过哪些地址」，粒度到根标识（用户或组）就够，再细会让每个项目
 * 各存一份几乎相同的账本。会话隔离靠条目里的 `sessionId`，不靠文件切分。
 */
export function scopeKeyOf(uri: Uri): string {
  return assertScopeKey(`${uri.scope}_${uri.rootId}`);
}

function isContextDetail(value: unknown): value is ContextDetail {
  return value === 'abstract' || value === 'overview' || value === 'full';
}

function parseEntry(value: unknown): RecallEntry {
  if (!isRecord(value)) {
    throw new Error('条目不是对象');
  }
  const { uri, sessionId, turn, detail } = value;
  if (typeof uri !== 'string' || uri === '') {
    throw new Error('条目缺少 uri');
  }
  // `sessionId` 是后加的列：缺失的旧条目按「不匹配任何会话」处理（`null`），
  // 不抛错——账本是缓存，丢一条只影响去重强度。
  if (sessionId !== undefined && (typeof sessionId !== 'string' || sessionId === '')) {
    throw new Error('条目的 sessionId 不合法');
  }
  if (typeof turn !== 'number' || !Number.isInteger(turn) || turn < 0) {
    throw new Error('条目的 turn 必须是非负整数');
  }
  if (!isContextDetail(detail)) {
    throw new Error('条目的 detail 不合法');
  }
  return { uri, sessionId: sessionId === undefined ? null : sessionId, turn, detail };
}

/** 账本文件的结构校验。坏数据一律抛，由 `load` 决定怎么降级。 */
function parseLedger(text: string): RecallLedgerData {
  const raw: unknown = JSON.parse(text);
  if (!isRecord(raw) || raw.version !== 1 || !Array.isArray(raw.entries)) {
    throw new Error('账本结构不合法');
  }
  return { version: 1, entries: raw.entries.map(parseEntry) };
}

function resolveOptions(options: RecallLedgerOptions): RecallLedgerOptions {
  const { dedupTurns, maxEntries } = options;
  if (!Number.isInteger(dedupTurns) || dedupTurns < 0) {
    throw new ComemError('INVALID_ARGUMENT', 'dedupTurns 必须是非负整数。', { dedupTurns });
  }
  if (!Number.isInteger(maxEntries) || maxEntries <= 0) {
    throw new ComemError('INVALID_ARGUMENT', 'maxEntries 必须是正整数。', { maxEntries });
  }
  return options;
}

function assertTurn(turn: number): void {
  if (!Number.isInteger(turn) || turn < 0) {
    throw new ComemError('INVALID_ARGUMENT', 'turn 必须是非负整数。', { turn });
  }
}

/**
 * 会话标识校验。
 *
 * 空串会让「没有 `sessionId` 的旧条目」与「当前会话」在过滤时混淆，而混淆的表现
 * 是「去重静默失效」——正是这一层要消灭的那类失效。所以在入口挡住。
 */
function assertSessionId(sessionId: string): void {
  if (sessionId === '') {
    throw new ComemError('INVALID_ARGUMENT', 'sessionId 不能为空。', { sessionId });
  }
}

/** 空账本。每次新建，避免调用方拿到共享的可变数组。 */
function emptyLedger(): RecallLedgerData {
  return { version: 1, entries: [] };
}

export class RecallLedger {
  readonly #dataDir: string;
  readonly #store: LedgerStore;
  readonly #logger: Logger;

  constructor(deps: RecallLedgerDeps) {
    this.#dataDir = deps.dataDir;
    this.#store = deps.store;
    this.#logger = deps.logger;
  }

  /** 读账本；文件不存在返回空账本。损坏的账本按空处理（只记 warn）。 */
  async #load(scopeKey: string): Promise<RecallLedgerData> {
    const key = assertScopeKey(scopeKey);
    const text = await this.#store.read(this.#pathOf(key));
    if (text === null) {
      return emptyLedger();
    }

    try {
      return parseLedger(text);
    } catch (error) {
      // 账本是去重辅助，不是真相来源：损坏时丢一份账本只会多投一次，抛错会让
      // 整轮召回失败。记 warn 让运维能发现磁盘问题。
      this.#logger.warn('召回账本损坏，按空账本处理', {
        scopeKey: key,
        reason: error instanceof Error ? error.message : String(error),
      });
      return emptyLedger();
    }
  }

  /** 写账本。原子性由 `LedgerStore` 实现保证。 */
  async #save(scopeKey: string, data: RecallLedgerData): Promise<void> {
    const key = assertScopeKey(scopeKey);
    await this.#store.write(this.#pathOf(key), `${JSON.stringify(data, null, 2)}\n`);
  }

  /**
   * 删掉一个作用域的账本（删账号 / 组时调用）。
   *
   * **为什么必须删。** 账本记录的是「哪个会话在第 N 轮投喂过哪些 URI」。账号被删、
   * 同 ID 重建之后，新的会话 ID 通常不同，`recentlyDelivered` 的会话过滤会让旧条目
   * 不匹配——但这不是保证：会话 ID 可以由调用方指定（`POST /sessions` 的
   * `sessionId`），测试环境重置、导入工具复用 ID 都会让新账号的第一轮召回被旧账本
   * 静默压制（第一次召回返回空）。
   *
   * 账本是缓存，删除的代价只是「多投一次」；留着则会让一个已经被删除的账号把去重
   * 状态带进新生命周期。删除与 `purgeSubtree` 同源：账号不存在了，它命名空间里的
   * 派生产物都不该继续有效。
   */
  async remove(scopeKey: string): Promise<void> {
    const key = assertScopeKey(scopeKey);
    await this.#store.remove(this.#pathOf(key));
  }

  /**
   * 追加本轮投放，并裁剪。
   *
   * 只记 `detail !== null` 的条目（§8.7 规则 1），条目带上本次的 `sessionId`。
   * 裁剪顺序是「先轮次、再条数」：先丢掉早于 `turn - 4 × dedupTurns` 的记录，
   * 再在剩下的里面保留最新的 `maxEntries` 条。
   */
  async record(
    scopeKey: string,
    sessionId: string,
    turn: number,
    items: readonly DeliveredItem[],
    options: RecallLedgerOptions,
  ): Promise<void> {
    const key = assertScopeKey(scopeKey);
    assertSessionId(sessionId);
    assertTurn(turn);
    const { dedupTurns, maxEntries } = resolveOptions(options);

    const current = await this.#load(key);
    const cutoff = turn - PRUNE_TURN_FACTOR * dedupTurns;
    const kept = current.entries.filter((entry) => entry.turn > cutoff);

    const delivered: RecallEntry[] = [];
    for (const item of items) {
      if (item.detail === null) {
        continue;
      }
      delivered.push({ uri: item.uri, sessionId, turn, detail: item.detail });
    }

    // 按 turn 升序稳定排序后再截尾：turn 可能乱序到达（重放、补录），保留「最新的」
    // 必须按 turn 判断，不能按数组位置。
    const merged = [...kept, ...delivered].sort((a, b) => a.turn - b.turn);
    const capped = merged.length > maxEntries ? merged.slice(merged.length - maxEntries) : merged;

    await this.#save(key, { version: 1, entries: capped });
  }

  /**
   * 上一轮投过的 URI 集合，供 `assembly` 的 `excludedUris` 使用。
   *
   * 过滤是三个条件的合取：
   *
   * ```
   * entry.sessionId === sessionId && entry.turn > turn - dedupTurns && entry.turn <= turn
   * ```
   *
   * - **会话相等**：同一作用域下的另一个会话投过什么与本次无关。少了它，会话 A
   *   跑到第 50 轮后，会话 B 从第 1 轮开始会把 A 投过的全部 URI 当成「刚投过」，
   *   新会话前几轮召回被静默压制。
   * - **下界 `entry.turn > turn - dedupTurns`**（严格大于）：第 `turn - dedupTurns`
   *   轮投过的应该还能再投。「`dedupTurns` 轮内」数的是间隔，投在 `turn - dedupTurns`
   *   的那一条距当前正好 `dedupTurns` 轮，已经出了窗口。`dedupTurns = 0` 时窗口为空，
   *   等价于关掉去重。
   * - **上界 `entry.turn <= turn`**：比当前轮次更晚的记录不属于「刚投过」，不过滤
   *   会把未来轮次的投放当成历史，同样静默压制。
   *
   * 旧账本里的条目没有 `sessionId`（解析成 `null`），`null === sessionId` 恒假，
   * 自然被忽略。
   */
  async recentlyDelivered(
    scopeKey: string,
    sessionId: string,
    turn: number,
    options: RecallLedgerOptions,
  ): Promise<ReadonlySet<string>> {
    const key = assertScopeKey(scopeKey);
    assertSessionId(sessionId);
    assertTurn(turn);
    const { dedupTurns } = resolveOptions(options);

    const data = await this.#load(key);
    const windowStart = turn - dedupTurns;
    return new Set(
      data.entries
        .filter(
          (entry) =>
            entry.sessionId === sessionId && entry.turn > windowStart && entry.turn <= turn,
        )
        .map((entry) => entry.uri),
    );
  }

  #pathOf(scopeKey: string): string {
    return join(this.#dataDir, '_meta', 'recall', `${scopeKey}.recall_log.json`);
  }
}
