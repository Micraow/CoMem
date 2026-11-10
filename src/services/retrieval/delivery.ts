/**
 * 负责：交付侧的记账——跨轮去重的时钟、召回账本读写的窗口、访问计数（§8.7、§11.7）。
 * 不负责：检索与组装本身；账本 / 访问计数写失败只记 warn，不影响检索结果。
 */

import type { AssembledItem } from '../../domain/assembly.js';
import { ComemError } from '../../domain/errors.js';
import type { Logger } from '../../domain/log.js';
import { Uri } from '../../domain/uri.js';

import { DEFAULT_RECALL_LEDGER_OPTIONS, scopeKeyOf, type RecallLedger } from '../recall-ledger.js';
import type { SessionService } from '../session.js';
import { sessionUriOf } from './intent.js';
import type { ContextOptions, DeliveryClock, SearchServiceDeps } from './types.js';

/** 交付记账的依赖。账本与会话缺省时各走「不做跨轮去重」的分支。 */
export interface DeliveryTrackerDeps {
  readonly ledger: SearchServiceDeps['ledger'];
  readonly sessions: SearchServiceDeps['sessions'];
  readonly logger: Logger;
  readonly recordAccess: SearchServiceDeps['recordAccess'];
  /** `retrieval.assembly.dedupTurns`：跨轮去重的窗口（轮）。 */
  readonly dedupTurns: number;
}

export class DeliveryTracker {
  readonly #ledger: Pick<RecallLedger, 'recentlyDelivered' | 'record'> | undefined;
  readonly #sessions: Pick<SessionService, 'load' | 'totalMessageCount'> | undefined;
  readonly #logger: Logger;
  readonly #recordAccess: SearchServiceDeps['recordAccess'];
  readonly #dedupTurns: number;

  constructor(deps: DeliveryTrackerDeps) {
    this.#ledger = deps.ledger;
    this.#sessions = deps.sessions;
    this.#logger = deps.logger;
    this.#recordAccess = deps.recordAccess;
    this.#dedupTurns = deps.dedupTurns;
  }

  /**
   * 跨轮去重的时钟（§8.7）。
   *
   * `turn` 取会话的**累计**消息数（`SessionService.totalMessageCount`：已归档
   * 去重 ID 数 + live 条数）。**不要用 `Session.messageCount`**：那是 live 未提交
   * 条数，`commitPhase1` 默认 `keepRecentCount = 0`，提交后 live 清空、时钟归零，
   * 账本读侧的 `entry.turn <= turn` 会把提交前的条目当成「未来轮次」排除——跨轮
   * 去重静默失效，刚投过的记忆下一轮再投一次。
   *
   * **没有 `sessionId` 时不返回时钟**：没有东西能推进 `turn`，用一个常量会让账本
   * 在 500 条之后永久排除所有候选——静默失效，比不做跨轮去重更糟。
   */
  async clock(options: ContextOptions): Promise<DeliveryClock | undefined> {
    if (options.sessionId === undefined || this.#sessions === undefined) {
      return undefined;
    }

    let sessionUri: Uri;
    try {
      sessionUri = sessionUriOf(options.subject, options.sessionId);
    } catch (error) {
      this.#logger.warn('会话 ID 无法归属到调用方，本次不做跨轮去重', {
        sessionId: options.sessionId,
        code: ComemError.from(error).code,
      });
      return undefined;
    }

    try {
      return {
        scopeKey: scopeKeyOf(sessionUri),
        sessionId: options.sessionId,
        turn: await this.#sessions.totalMessageCount(sessionUri),
      };
    } catch (error) {
      // 会话不存在 / ID 写错时 `totalMessageCount` 与 `load` 一样抛 `NOT_FOUND`。
      // 这只影响去重，不该让整次检索失败。
      this.#logger.warn('会话不可读，本次不做跨轮去重', {
        sessionId: options.sessionId,
        code: ComemError.from(error).code,
      });
      return undefined;
    }
  }

  /**
   * 把本次真正投给模型的条目写回账本（§8.7 规则 1）。
   *
   * **写失败只记 warn**：账本是去重辅助，不是真相来源。一次磁盘写失败不该让已经
   * 组装好的上下文丢掉——那等于用「去重账本坏了」惩罚当前这一轮。
   */
  async delivered(
    clock: DeliveryClock | undefined,
    items: readonly AssembledItem[],
  ): Promise<void> {
    const ledger = this.#ledger;
    if (clock === undefined || ledger === undefined) {
      return;
    }
    try {
      await ledger.record(clock.scopeKey, clock.sessionId, clock.turn, items, {
        dedupTurns: this.#dedupTurns,
        maxEntries: DEFAULT_RECALL_LEDGER_OPTIONS.maxEntries,
      });
    } catch (error) {
      const failure = ComemError.from(error);
      this.#logger.warn('召回账本写入失败', {
        scopeKey: clock.scopeKey,
        sessionId: clock.sessionId,
        turn: clock.turn,
        items: items.length,
        code: failure.code,
        message: failure.message,
      });
    }
  }

  /**
   * 把「这次真正进入调用方上下文的条目」记一次访问（§11.7 的滑动窗口输入、§17.5
   * 的热度输入）。**与 `hotnessWeight` 无关**：权重只决定热度要不要进排序，
   * `last_accessed_at` 还决定 TTL 从什么时候起算。
   *
   * **入参是交付物，不是检索过程。** 两条形态各自的交付物不同：`find` /
   * `mode=list` 交付命中列表（列表本身就是交付物），`mode=context` 交付组装后的
   * 注入块（`AssemblyResult.items`）。后者不传候选集——被预算截断、被配额挤掉、
   * 被跨轮去重排除的条目没有进入调用方的上下文，记了就是把从未被注入的记忆窗口
   * 推后（滑动窗口退化成「被搜到过就永不过期」）。
   *
   * **不 await**：检索是只读路径，让调用方等写入会把它变成写路径；写失败只记 warn，
   * 不该让检索失败——访问统计不是检索正确性的一部分。
   *
   * **代价是「一个写事务」而不是「每条一个事务」**：`recordAccess` 对整批 URI 只
   * `BEGIN IMMEDIATE` 一次、只预编译一条 `UPDATE`，50 条命中是 50 次 `run`。实测
   * （Node 26.13 + `node:sqlite`，WAL 文件库，两次测量）50 条约 0.8–0.9 ms、200 条
   * 约 1.2–1.3 ms（中位数，含提交）。同一 URI 在入参里先按 `Set` 去重，所以「5 条
   * TypedQuery 命中同一条」只算一次访问。
   */
  recordHits(hits: readonly { readonly uri: string }[]): void {
    const record = this.#recordAccess;
    if (record === undefined || hits.length === 0) {
      return;
    }
    const uris = [...new Set(hits.map((hit) => hit.uri))];
    void (async () => {
      try {
        await record(uris);
      } catch (error) {
        const failure = ComemError.from(error);
        this.#logger.warn('访问计数写入失败', {
          uris: uris.length,
          code: failure.code,
          message: failure.message,
        });
      }
    })();
  }

  /** 跨轮去重：账本里 `dedupTurns` 轮内投过的 URI（§8.7）。 */
  async excluded(
    clock: DeliveryClock | undefined,
  ): Promise<ReadonlySet<string> | undefined> {
    if (clock === undefined) {
      return undefined;
    }
    if (this.#ledger === undefined) {
      throw new ComemError(
        'INVALID_ARGUMENT',
        '跨轮去重需要注入召回账本（SearchServiceDeps.ledger）。',
        { scopeKey: clock.scopeKey, sessionId: clock.sessionId, turn: clock.turn },
      );
    }
    return this.#ledger.recentlyDelivered(clock.scopeKey, clock.sessionId, clock.turn, {
      dedupTurns: this.#dedupTurns,
      maxEntries: DEFAULT_RECALL_LEDGER_OPTIONS.maxEntries,
    });
  }
}
