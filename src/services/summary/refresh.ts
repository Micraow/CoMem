/**
 * 目录摘要刷新的 single-flight 与尾批（架构文档 §9.3）。
 *
 * 一个目录的模型生成不能放在路径锁里，所以并发通知在锁释放后可能同时看见旧快照。
 * 本模块只串行化**同一个目录**：第一个请求生成，期间到达的请求并入尾批；生成输入
 * 没有变化时尾批直接消费，不重复调用模型。不同目录仍可并行；同一目录的并发调用
 * 中只有一个负责继续传播祖先，避免把一份 L0 变化重复计入父目录。
 */

import { errorMessage } from '../../domain/errors.js';
import type { Uri } from '../../domain/uri.js';

import { consumePendingChanges, readFreshness, writePendingChanges } from './freshness.js';
import {
  generatePreparedSummary,
  prepareSummaryInput,
  summaryInputDigest,
  type GeneratedDirectorySummary,
} from './generation.js';
import { persistSummary, withDirectoryLock } from './persist.js';
import type { SummaryContext } from './ports.js';
import { claimRefresh, type RecomputeClaim } from './refresh-claim.js';

export type DirectoryRefreshOutcome = 'changed' | 'unchanged' | 'stale';

export interface DirectoryRefreshResult {
  readonly outcome: DirectoryRefreshOutcome;
  /** 同目录并发调用中只有这个调用负责把变化继续传播到父目录。 */
  readonly propagate: boolean;
}

interface RefreshState {
  pendingChanges: number;
  force: boolean;
  propagationOwner: boolean;
  promise: Promise<DirectoryRefreshOutcome>;
}

export class SummaryRefreshCoordinator {
  readonly #ports: SummaryContext;
  readonly #states = new Map<string, RefreshState>();

  constructor(ports: SummaryContext) {
    this.#ports = ports;
  }

  /** 记录一次已知的内容变化并刷新目录；同目录并发请求共享一次生成。 */
  invalidate(directoryUri: Uri, changes = 1): Promise<DirectoryRefreshResult> {
    return this.#schedule(directoryUri, changes, false);
  }

  /** 显式重建忽略新鲜度阈值；输入未变时仍可并入正在进行的生成。 */
  force(directoryUri: Uri): Promise<DirectoryRefreshResult> {
    return this.#schedule(directoryUri, 0, true);
  }

  #schedule(
    directoryUri: Uri,
    changes: number,
    force: boolean,
  ): Promise<DirectoryRefreshResult> {
    const key = directoryUri.toString();
    const active = this.#states.get(key);
    if (active !== undefined) {
      const ownsPropagation = changes > 0 && !active.propagationOwner;
      if (ownsPropagation) {
        active.propagationOwner = true;
      }
      active.pendingChanges += changes;
      active.force ||= force;
      return active.promise.then((outcome) => ({
        outcome,
        propagate: ownsPropagation && outcome === 'changed',
      }));
    }

    const state: RefreshState = {
      pendingChanges: changes,
      force,
      propagationOwner: changes > 0,
      promise: Promise.resolve('stale' as const),
    };
    state.promise = Promise.resolve()
      .then(() => this.#run(directoryUri, state))
      .finally(() => {
        if (this.#states.get(key) === state) {
          this.#states.delete(key);
        }
      });
    this.#states.set(key, state);
    return state.promise.then((outcome) => ({
      outcome,
      propagate: changes > 0 && outcome === 'changed',
    }));
  }

  async #run(directoryUri: Uri, state: RefreshState): Promise<DirectoryRefreshOutcome> {
    const key = directoryUri.toString();
    for (;;) {
      const changes = state.pendingChanges;
      const force = state.force;
      state.pendingChanges = 0;
      state.force = false;

      let claim: RecomputeClaim;
      try {
        claim = await claimRefresh(this.#ports, directoryUri, changes, force);
      } catch (error) {
        this.#retainPending(directoryUri, state, changes);
        throw error;
      }
      if (!claim.recompute) {
        if (state.pendingChanges === 0 && !state.force) {
          this.#states.delete(key);
          return claim.outcome;
        }
        continue;
      }

      let generated: GeneratedDirectorySummary;
      let outcome: 'changed' | 'unchanged';
      try {
        const prepared = await prepareSummaryInput(this.#ports, directoryUri);
        if (!force && claim.persistedInputDigest === prepared.inputDigest) {
          let consumed = false;
          await withDirectoryLock(this.#ports.locks, directoryUri, async () => {
            const currentDigest = readFreshness(this.#ports.db, key).inputDigest;
            if (currentDigest !== prepared.inputDigest) {
              return;
            }
            consumePendingChanges(this.#ports.db, key, claim.snapshotPending);
            consumed = true;
          });
          if (!consumed) {
            continue;
          }
          if (state.pendingChanges === 0 && !state.force) {
            this.#states.delete(key);
            return claim.previous === null ? 'stale' : 'unchanged';
          }
          continue;
        }

        generated = await generatePreparedSummary(this.#ports, prepared);
        outcome = await withDirectoryLock(this.#ports.locks, directoryUri, () =>
          persistSummary(
            this.#ports,
            directoryUri,
            generated.summary,
            generated.inputDigest,
            claim.snapshotPending,
            claim.previous,
          ),
        );
      } catch (error) {
        this.#retainPending(directoryUri, state);
        throw error;
      }

      if (state.pendingChanges === 0 && !state.force) {
        this.#states.delete(key);
        return outcome;
      }

      // 尾批来自生成期间的写。提示输入和已完成生成相同，说明它们已覆盖在这份结果里。
      // digest 读取期间仍可能有新通知；只有尾批快照没变时才能丢弃它。
      const tailChanges = state.pendingChanges;
      const tailForce = state.force;
      const currentDigest = await summaryInputDigest(this.#ports, directoryUri);
      if (
        state.pendingChanges === tailChanges
        && state.force === tailForce
        && currentDigest === generated.inputDigest
      ) {
        state.pendingChanges = 0;
        state.force = false;
        this.#states.delete(key);
        return outcome;
      }
    }
  }

  /** 生成 / 落盘失败时，把尚未持久化的尾批写回数据库；它不能覆盖原始异常。 */
  #retainPending(
    directoryUri: Uri,
    state: RefreshState,
    unsavedChanges = 0,
  ): void {
    const changes = unsavedChanges + state.pendingChanges;
    state.pendingChanges = 0;
    state.force = false;
    if (changes === 0) {
      return;
    }
    try {
      const uri = directoryUri.toString();
      const current = readFreshness(this.#ports.db, uri).pendingChanges;
      writePendingChanges(this.#ports.db, uri, current + changes);
    } catch (error) {
      this.#ports.logger.error('摘要失败后保留待刷新计数也失败，已忽略。', {
        uri: directoryUri.toString(),
        error: errorMessage(error),
      });
    }
  }
}
