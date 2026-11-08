/**
 * 后台调度器（架构文档 §10.2.1 的自动提交、§11.7 的会话过期与记忆 TTL）。
 *
 * ## 为什么需要它
 *
 * `session.autoCommit.*` 的六个字段此前**没有任何生产调用点**：`SessionService` 的
 * `shouldAutoCommit` 与 `domain/session.ts` 的策略函数都写好了，但没人调。后果不是
 * 「慢」而是「永不触发」——运维把 `pendingTokenThreshold` 从 150000 调到 5000，期待
 * 更早归档，实际一条都不会自动提交。同样地，会话空闲多久该归档、记忆多久该过期，
 * 都需要一个常驻循环去扫。
 *
 * 单元测试看不出来：它们直接构造服务再同步 `await`，绕过了「谁在什么时候调它」
 * （`local/notes/decisions.md` 的 W10 一条，同一个结构性盲区）。
 *
 * ## 三个职责
 *
 * | 职责 | 判定 | 动作 |
 * |---|---|---|
 * | 自动提交 | `SessionService.shouldAutoCommit`（token / 消息数 / 空闲） | 走**现有的**阶段一 `commitPhase1` |
 * | 会话过期 | `now - 最后活动时间 >= session.expiry.idleTimeoutSeconds` | `archive`（默认）或 `delete` |
 * | TTL 清扫 | `node.expires_at < now` | `status = 'archived'`（软过期） |
 *
 * ## 幂等
 *
 * 三个动作都幂等，所以「上一轮刚做完、这一轮又被扫到」不会产生重复产物：
 * `commitPhase1` 用路径锁 + 归档序号单调（§10.2），`archive` 对已归档的会话是空操作，
 * `sweep` 的 `status <> 'archived'` 让同一条过期记忆只计数一次。间隔与重叠保护是
 * 「省一次扫描」，不是正确性前提。
 *
 * ## 为什么定时器 `unref`
 *
 * 与 `CommitRunner` 的取舍相反（那边故意不 `unref`，理由见那个文件头）：调度器是
 * **周期性维护**，不是「服务在跑」的证据。真正让进程活着的是 HTTP 服务；测试与
 * 一次性脚本（`pnpm test`、`tsx` 跑的小工具）不该为了一个每 30 秒空转一圈的定时器
 * 卡住不退出。
 *
 * ## 为什么遍历会话要碰文件系统
 *
 * 会话不是 SQLite 行：`sessions/sess_xxx/` 是磁盘目录，`.meta.json` 是真相（§7），
 * `GET /sessions` 也是列目录再逐个 `load`（`api/http/routes/sessions.ts` 的文件头）。
 * 所以「有哪些会话」只能从数据根扫出来，而这一层是唯一允许同时碰 `node:fs` 与服务
 * 的层（§4.2）。**不建 `session` 表**：那会造出第二个真相来源。
 */

import type { Dirent } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { toDiskPath } from '../adapters/fs/path.js';
import { ComemError } from '../domain/errors.js';
import type { Logger } from '../domain/log.js';
import type { Session } from '../domain/session.js';
import { Uri } from '../domain/uri.js';
import type { MemoryService } from '../services/memory.js';
import type { CommitPhase1Result, SessionRemoval } from '../services/session.js';

/**
 * 轮询间隔：30 秒。**来源未知**（架构文档没给），是经验假设。
 *
 * 依据：自动提交的判定是量级判断（阈值 150000 token / 100 条消息），30 秒的延迟相对
 * 一次对话的时长可以忽略；更短的间隔只会让每条会话每 30 秒被 `load` 一次（读整个
 * `messages.jsonl`），而没有新消息时那次读不会有任何变化。与 `CommitRunner` 的 1 秒
 * 轮询不同：那边等的是一个**已经排队**的任务（延迟直接体现为「提交跑完了没有」），
 * 这里等的是「用户不再说话」。
 */
export const DEFAULT_INTERVAL_MS = 30_000;

/** 秒 → 毫秒。空闲时长按秒配置（§18 的 `session.expiry.idleTimeoutSeconds`）。 */
const MILLISECONDS_PER_SECOND = 1000;

/** 会话目录名（§6.5 的 `sessions/sess_xxx/`，与 `services/session.ts` 同一个布局）。 */
const SESSIONS_DIRECTORY_NAME = 'sessions';

/** 两个作用域根（§6.3）。组空间与个人空间同构。 */
const SCOPE_DIRECTORY_NAMES = ['user', 'group'] as const;

/** `archive_NNN/` 里记录「这次归档抽出了哪些记忆」的文件名（§6.6 的保留名）。 */
const MEMORY_DIFF_FILE_NAME = 'memory_diff.json';

/** 空转的一轮：上一轮还没跑完，或调度器已停止。 */
const SKIPPED_RESULT: SchedulerTickResult = Object.freeze({
  skipped: true,
  scanned: 0,
  committed: 0,
  expired: 0,
  deleted: 0,
  ttlArchived: 0,
});

/**
 * 自动提交与会话过期要用到的 `SessionService` 面。
 *
 * 只列真正调用的方法：`SessionService` 的结构满足它，而单测可以只实现这一小块
 * （§4.4 不为只有一个实现的类型建接口——这里的接口是**消费方契约**，不是存储端口）。
 */
export interface SessionAutoCommitPort {
  load(sessionUri: Uri): Promise<Session>;
  shouldAutoCommit(session: Session, now: Date): boolean;
  commitPhase1(sessionUri: Uri): Promise<CommitPhase1Result>;
  /** `history/` 下的归档目录。删除前的待复核记忆检查要用。 */
  listArchives(sessionUri: Uri): Promise<readonly Uri[]>;
  archive(sessionUri: Uri): Promise<void>;
  remove(sessionUri: Uri): Promise<SessionRemoval>;
}

/** TTL 清扫端口（`TtlService` 的结构子集）。 */
export interface TtlPort {
  sweep(options?: { readonly limit?: number }): Promise<{ readonly expired: number }>;
}

/** 删除会话前检查「这个会话产出的记忆是否仍待复核」用的记忆读端口。 */
export type PendingMemoryPort = Pick<MemoryService, 'read'>;

/** `session.expiry.*`（§18）。`idleTimeoutSeconds = 0` 表示关。 */
export interface SchedulerExpiry {
  readonly idleTimeoutSeconds: number;
  readonly action: 'archive' | 'delete';
}

export interface SchedulerOptions {
  /** 轮询间隔，默认 `DEFAULT_INTERVAL_MS`（30 秒）。 */
  readonly intervalMs?: number;
  readonly logger: Logger;
  /** 数据根。会话目录由它扫出来（见文件头「为什么遍历会话要碰文件系统」）。 */
  readonly dataDir: string;
  readonly sessions: SessionAutoCommitPort;
  readonly ttl: TtlPort;
  readonly memories: PendingMemoryPort;
  readonly expiry: SchedulerExpiry;
  /** `memory.ttl.sweepBatchSize`：每轮最多清扫多少条。 */
  readonly ttlSweepBatchSize: number;
  /** 注入时钟（测试用）；默认 `() => new Date()`。 */
  readonly now?: () => Date;
}

export interface SchedulerTickResult {
  /** 上一轮还没跑完（或已停止），这一轮什么都没做 */
  readonly skipped: boolean;
  /** 扫到的会话数（含被跳过的「建了一半」的会话） */
  readonly scanned: number;
  readonly committed: number;
  /** 过期处理掉的会话数（归档 + 删除） */
  readonly expired: number;
  /** 其中真的被物理删除的 */
  readonly deleted: number;
  /** 这一轮被 TTL 归档的节点数 */
  readonly ttlArchived: number;
}

/** 单个会话这一轮的结局。`scanned` 之外只关心「做了什么」。 */
type SessionOutcome = 'skipped' | 'committed' | 'archived' | 'deleted';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function fsErrorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return null;
  }
  const code: unknown = error.code;
  return typeof code === 'string' ? code : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 从 `memory_diff.json` 里读出「这次归档写入了哪些记忆」。
 *
 * 只取 `operations.adds` / `operations.updates` 的 URI：`deletes` 指向的记忆已经
 * 没了，没有「还在待复核」这回事；`skippedOperations` 没有 URI（它们没写成）。
 *
 * 形状不对时抛 `INTERNAL`：这个文件只由 `MemoryMergeStep` 写，磁盘上的内容不合法
 * 说明数据被改坏了。调用方（`#expireSession`）按「无法证明安全」处理——**不删**。
 */
function memoryUrisOf(value: unknown, archiveUri: Uri): readonly string[] {
  const corrupt = (reason: string): ComemError =>
    new ComemError('INTERNAL', `memory_diff.json 内容不合法：${archiveUri.toString()}（${reason}）`, {
      uri: archiveUri.toString(),
      reason,
    });

  if (!isRecord(value)) {
    throw corrupt('不是对象');
  }
  const operations = value['operations'];
  if (!isRecord(operations)) {
    throw corrupt('operations 不是对象');
  }

  const uris: string[] = [];
  for (const key of ['adds', 'updates'] as const) {
    const entries = operations[key];
    if (!Array.isArray(entries)) {
      throw corrupt(`operations.${key} 不是数组`);
    }
    for (const entry of entries) {
      const uri = isRecord(entry) ? entry['uri'] : undefined;
      if (typeof uri !== 'string') {
        throw corrupt(`operations.${key}[] 缺少字符串 uri`);
      }
      uris.push(uri);
    }
  }
  return uris;
}

export class Scheduler {
  readonly #logger: Logger;
  readonly #dataDir: string;
  readonly #sessions: SessionAutoCommitPort;
  readonly #ttl: TtlPort;
  readonly #memories: PendingMemoryPort;
  readonly #expiry: SchedulerExpiry;
  readonly #ttlSweepBatchSize: number;
  readonly #now: () => Date;
  readonly #intervalMs: number;

  #timer: NodeJS.Timeout | null = null;
  /** 在途的一轮；`stop()` 要等它收尾（见下方注释）。 */
  #inFlight: Promise<SchedulerTickResult> | null = null;
  /** 停止之后定时器可能已经触发过：`tick()` 用这个标记不再开新的一轮。 */
  #stopped = false;

  constructor(options: SchedulerOptions) {
    this.#logger = options.logger;
    this.#dataDir = options.dataDir;
    this.#sessions = options.sessions;
    this.#ttl = options.ttl;
    this.#memories = options.memories;
    this.#expiry = options.expiry;
    this.#ttlSweepBatchSize = options.ttlSweepBatchSize;
    this.#now = options.now ?? (() => new Date());
    this.#intervalMs = Math.max(1, options.intervalMs ?? DEFAULT_INTERVAL_MS);
  }

  /** 定时器是否在跑。`stop()` 之后是 `false`；重复 `start()` 不会起第二个。 */
  get started(): boolean {
    return this.#timer !== null;
  }

  /** 开始轮询。幂等：重复调用不会起第二个定时器。 */
  start(): void {
    if (this.#timer !== null) {
      return;
    }
    this.#stopped = false;
    this.#timer = setInterval(() => {
      // `tick()` 内部兜底所有异常（见 `#runOnce` 的调用点），这里不会产生
      // 未处理的 rejection。
      void this.tick();
    }, this.#intervalMs);
    // 不阻止进程退出（见文件头「为什么定时器 unref」）。
    this.#timer.unref();
  }

  /**
   * 停止轮询，并**等在途的一轮跑完**再返回。
   *
   * 在途的一轮不打断：一次自动提交可能停在「归档消息已写、live 还没重写」的
   * `preparing` 状态（§10.1），下次重放能补完，但这一次的产物就是半成品。等它跑完，
   * 代价是退出慢几百毫秒。`AbortController` 在这里没有用武之地——**没有一步是可以
   * 安全中断的**，中断只会把「等一下」换成「下次补」。
   */
  async stop(): Promise<void> {
    this.#stopped = true;
    const wasRunning = this.#timer !== null || this.#inFlight !== null;
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    const inFlight = this.#inFlight;
    if (inFlight !== null) {
      this.#logger.info('等待在途的调度轮次收尾。', {});
      await inFlight;
    }
    // 从来没启动过（配置全关）时不说「已停止」：那会让启动日志里的
    // 「调度器未启动」看起来自相矛盾。
    if (wasRunning) {
      this.#logger.info('调度器已停止。', {});
    }
  }

  /**
   * 跑一轮（生产由 `start()` 的定时器调；测试直接 `await tick()` 拿确定点）。
   *
   * **不抛错**：轮询失败只记日志，下一轮还会再试——数据库被锁、某个会话的
   * `.meta.json` 被改坏，这些都是自愈的；抛出去会让定时器停在一个没人接的
   * rejection 上。
   */
  async tick(): Promise<SchedulerTickResult> {
    if (this.#stopped || this.#inFlight !== null) {
      // 上一轮还没跑完。不是错误：一次提交要写归档、建任务，30 秒仍可能重叠。
      return SKIPPED_RESULT;
    }

    const running = this.#runOnce().catch((error: unknown) => {
      this.#logger.error('调度轮次失败，下一轮重试。', { error: errorMessage(error) });
      return SKIPPED_RESULT;
    });
    this.#inFlight = running;
    try {
      return await running;
    } finally {
      this.#inFlight = null;
    }
  }

  async #runOnce(): Promise<SchedulerTickResult> {
    const now = this.#now();
    const sessionUris = await this.#discoverSessionUris();

    let committed = 0;
    let expired = 0;
    let deleted = 0;

    // 逐个会话处理：一个会话的文件坏了不能让其它会话的自动提交停掉。
    for (const sessionUri of sessionUris) {
      const outcome = await this.#processSessionSafely(sessionUri, now);
      if (outcome === 'committed') {
        committed += 1;
      } else if (outcome === 'archived' || outcome === 'deleted') {
        expired += 1;
        deleted += outcome === 'deleted' ? 1 : 0;
      }
    }

    const ttlArchived = await this.#sweepTtl();

    const result: SchedulerTickResult = {
      skipped: false,
      scanned: sessionUris.length,
      committed,
      expired,
      deleted,
      ttlArchived,
    };
    this.#logRound(result);
    return result;
  }

  async #processSessionSafely(sessionUri: Uri, now: Date): Promise<SessionOutcome> {
    try {
      return await this.#processSession(sessionUri, now);
    } catch (error) {
      this.#logger.error('会话调度失败，已跳过。', {
        uri: sessionUri.toString(),
        error: errorMessage(error),
      });
      return 'skipped';
    }
  }

  /** 读会话；「建了一半」（有目录、没有 `.meta.json`）返回 `null`，不是错误。 */
  async #loadSession(sessionUri: Uri): Promise<Session | null> {
    try {
      return await this.#sessions.load(sessionUri);
    } catch (error) {
      if (error instanceof ComemError && error.code === 'NOT_FOUND') {
        return null;
      }
      throw error;
    }
  }

  /**
   * 会话空闲了多少秒。
   *
   * 基准是「最后一条消息的时间」，没有消息时退回「上次提交时间」（提交之后 live
   * 会变空，而那次提交本身就是最后活动）。两者都没有时返回 `null`——一个从没写进
   * 任何东西、也从没提交过的会话没有「空闲」的参照点，按「不过期」处理。
   */
  #idleSecondsOf(session: Session, now: Date): number | null {
    const basis = session.messages.at(-1)?.createdAt ?? session.lastCommitAt;
    if (basis === null) {
      return null;
    }
    const timestamp = Date.parse(basis);
    if (Number.isNaN(timestamp)) {
      this.#logger.warn('会话的最后活动时间不合法，跳过过期判定。', {
        uri: session.uri.toString(),
        value: basis,
      });
      return null;
    }
    return (now.getTime() - timestamp) / MILLISECONDS_PER_SECOND;
  }

  async #processSession(sessionUri: Uri, now: Date): Promise<SessionOutcome> {
    const session = await this.#loadSession(sessionUri);
    if (session === null || session.status === 'archived') {
      // 建了一半的会话，或已经归档过的会话：不再自动提交。
      return 'skipped';
    }

    if (this.#sessions.shouldAutoCommit(session, now)) {
      let committed: CommitPhase1Result;
      try {
        committed = await this.#sessions.commitPhase1(sessionUri);
      } catch (error) {
        if (error instanceof ComemError && error.code === 'INVALID_ARGUMENT') {
          // `keepRecentCount` 覆盖了全部消息：没有可归档的内容，等更多消息进来就好。
          // 这不是错误（一条超长消息也会满足 token 阈值），按 error 记会每 30 秒刷
          // 一行，把真正的故障埋掉。
          this.#logger.debug('会话没有可归档的消息，跳过本轮。', {
            uri: sessionUri.toString(),
            messageCount: session.messageCount,
            reason: error.message,
          });
          return 'skipped';
        }
        throw error;
      }
      this.#logger.info('会话已自动提交。', {
        uri: sessionUri.toString(),
        archiveUri: committed.archiveUri.toString(),
        archivedCount: committed.archivedCount,
        taskId: committed.taskId,
        pendingTokens: session.pendingTokens,
        messageCount: session.messageCount,
      });
      return 'committed';
    }

    const idleSeconds = this.#idleSecondsOf(session, now);
    if (idleSeconds === null || idleSeconds < this.#expiry.idleTimeoutSeconds) {
      return 'skipped';
    }
    // 0 = 关。必须显式判断：`idleSeconds >= 0` 恒为真，漏掉这一行会让「关」变成
    // 「所有会话每轮都过期」。
    if (this.#expiry.idleTimeoutSeconds <= 0) {
      return 'skipped';
    }

    return this.#expireSession(sessionUri, idleSeconds);
  }

  async #expireSession(sessionUri: Uri, idleSeconds: number): Promise<SessionOutcome> {
    if (this.#expiry.action === 'archive') {
      await this.#sessions.archive(sessionUri);
      this.#logger.info('会话空闲过期，已归档。', {
        uri: sessionUri.toString(),
        idleSeconds,
        idleTimeoutSeconds: this.#expiry.idleTimeoutSeconds,
      });
      return 'archived';
    }

    let pending: readonly string[];
    try {
      pending = await this.#pendingMemoryUris(sessionUri);
    } catch (error) {
      // 读不出「这个会话产出了哪些记忆」就证明不了删除安全。保守跳过。
      this.#logger.warn('会话的内存产出清单读不出来，跳过删除。', {
        uri: sessionUri.toString(),
        error: errorMessage(error),
      });
      return 'skipped';
    }
    if (pending.length > 0) {
      this.#logger.warn('会话空闲过期，但它产出的记忆仍在待复核，跳过删除。', {
        uri: sessionUri.toString(),
        idleSeconds,
        pendingMemoryUris: pending,
      });
      return 'skipped';
    }

    const removal = await this.#sessions.remove(sessionUri);
    this.#logger.info('会话空闲过期，已删除。', {
      uri: removal.sessionUri.toString(),
      idleSeconds,
      messages: removal.messages,
      archives: removal.archives,
      removedEntries: removal.removedEntries,
    });
    return 'deleted';
  }

  /**
   * 这个会话的归档产出里，哪些记忆**现在**还是 `pending`。
   *
   * 关联只有一条：`archive_NNN/memory_diff.json` 记下了每次归档写入了哪些记忆
   * （§6.6）。它就在会话目录里，所以「删掉会话」等于删掉「这条待复核记忆是哪个会话
   * 产出的」这唯一线索——那些记忆还没复核，删了就追不回来。
   */
  async #pendingMemoryUris(sessionUri: Uri): Promise<readonly string[]> {
    const pending = new Set<string>();
    for (const archiveUri of await this.#sessions.listArchives(sessionUri)) {
      const diff = await this.#readMemoryDiff(archiveUri);
      if (diff === null) {
        // 阶段二没跑完（或没跑过）的归档没有清单：那时也不可能有记忆被写出来。
        continue;
      }
      for (const rawUri of memoryUrisOf(diff, archiveUri)) {
        const memoryUri = Uri.tryParse(rawUri);
        if (memoryUri === null) {
          this.#logger.warn('memory_diff.json 里的 URI 不合法，跳过。', {
            archiveUri: archiveUri.toString(),
            uri: rawUri,
          });
          continue;
        }
        const record = await this.#memories.read(memoryUri);
        if (record !== null && record.status === 'pending') {
          pending.add(rawUri);
        }
      }
    }
    return [...pending];
  }

  /** 读归档的 `memory_diff.json`；不存在返回 `null`（正常状态：阶段二还没跑）。 */
  async #readMemoryDiff(archiveUri: Uri): Promise<unknown | null> {
    const path = join(toDiskPath(this.#dataDir, archiveUri), MEMORY_DIFF_FILE_NAME);
    let raw: string;
    try {
      raw = await readFile(path, 'utf8');
    } catch (error) {
      if (fsErrorCode(error) === 'ENOENT') {
        return null;
      }
      throw error;
    }
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      throw new ComemError('INTERNAL', `memory_diff.json 不是合法 JSON：${archiveUri.toString()}`, {
        uri: archiveUri.toString(),
      });
    }
  }

  async #sweepTtl(): Promise<number> {
    try {
      const { expired } = await this.#ttl.sweep({ limit: this.#ttlSweepBatchSize });
      return expired;
    } catch (error) {
      // 清扫失败不能让整轮失败：自动提交与过期判定已经做完了。
      this.#logger.error('TTL 清扫失败，下一轮重试。', { error: errorMessage(error) });
      return 0;
    }
  }

  /**
   * 数据根下所有会话的 URI，按字符串升序。
   *
   * 两层目录：`{user,group}/<rootId>/sessions/<sessionId>`。`rootId` 与 `sessionId`
   * 来自磁盘（可能被手工改过），所以每个都要过 `Uri.parse` 的校验；不合法时记
   * warn 并跳过——为一个人工放错名字的目录让整轮调度失败不值得。
   */
  async #discoverSessionUris(): Promise<readonly Uri[]> {
    const uris: Uri[] = [];
    for (const scope of SCOPE_DIRECTORY_NAMES) {
      for (const rootId of await this.#listDirectories(join(this.#dataDir, scope))) {
        const sessionsDirectory = join(this.#dataDir, scope, rootId, SESSIONS_DIRECTORY_NAME);
        for (const sessionId of await this.#listDirectories(sessionsDirectory)) {
          const uri = this.#parseSessionUri(scope, rootId, sessionId);
          if (uri !== null) {
            uris.push(uri);
          }
        }
      }
    }
    return uris.sort((left, right) => (left.toString() < right.toString() ? -1 : 1));
  }

  #parseSessionUri(scope: (typeof SCOPE_DIRECTORY_NAMES)[number], rootId: string, sessionId: string): Uri | null {
    try {
      return Uri.parse(`comem://${scope}/${rootId}/${SESSIONS_DIRECTORY_NAME}/${sessionId}`);
    } catch (error) {
      this.#logger.warn('数据根下的会话目录名不合法，已跳过。', {
        scope,
        rootId,
        sessionId,
        reason: errorMessage(error),
      });
      return null;
    }
  }

  /** 直接子目录名（只要目录）；目录不存在返回空数组。 */
  async #listDirectories(directory: string): Promise<readonly string[]> {
    let entries: readonly Dirent[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      const code = fsErrorCode(error);
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        return [];
      }
      throw error;
    }
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  }

  /**
   * 每轮的摘要。
   *
   * 空转记 `debug`：30 秒一轮，一天 2880 轮，全打 `info` 会把真正的动作埋掉。有动作
   * 时（提交了、过期了、清了 TTL）记 `info`——那条才是运维要看的。
   */
  #logRound(result: SchedulerTickResult): void {
    const summary = {
      scanned: result.scanned,
      committed: result.committed,
      expired: result.expired,
      deleted: result.deleted,
      ttlArchived: result.ttlArchived,
    };
    if (result.committed + result.expired + result.ttlArchived === 0) {
      this.#logger.debug('调度轮次完成（无动作）。', summary);
      return;
    }
    this.#logger.info('调度轮次完成。', summary);
  }
}
