/**
 * 会话服务的编排层：公开 API 留在类上，具体职责在 `services/session/` 的模块里。
 *
 * - 创建 / 复用 / 空闲归档 / 删除 → `lifecycle.ts`
 * - 追加与幂等 → `append.ts`
 * - 阶段一归档 → `archive.ts`（列表与索引在 `archive-index.ts`）
 * - `.meta.json` / `messages.jsonl` 读取 → `storage.ts` / `messages.ts`
 * - 权限物化与索引通知 → `hooks.ts`
 *
 * 可变状态只有 `#archivedMessageIndex`：它必须跟着服务实例走，跨模块只传引用。
 */

import type { ArchiveMeta } from '../../domain/archive.js';
import type { Session, SessionMessage } from '../../domain/session.js';
import { shouldAutoCommit as shouldAutoCommitPolicy } from '../../domain/session.js';
import type { Uri } from '../../domain/uri.js';

import { commitPhase1 } from './archive.js';
import { loadArchivedMessageIndex, listArchiveUris } from './archive-index.js';
import { appendMessage } from './append.js';
import { archiveSession, createSession, ensureSession, removeSession } from './lifecycle.js';
import { readMessages, sumTokens } from './messages.js';
import type {
  ArchivePorts,
  CommitPhase1Result,
  SessionPorts,
  SessionRemoval,
  SessionServiceOptions,
} from './ports.js';
import {
  DEFAULT_ARCHIVE_DIRECTORY_NAME,
  historyUri,
  messagesUri,
  requireSession,
} from './storage.js';

export class SessionService {
  readonly #store: SessionPorts['store'];
  readonly #locks: SessionPorts['locks'];
  readonly #tasks: SessionPorts['tasks'];
  readonly #logger: SessionPorts['logger'];
  readonly #meta: SessionPorts['meta'];
  readonly #autoCommit: SessionPorts['autoCommit'];
  readonly #archiveDirectoryName: string;
  readonly #authorizer: SessionPorts['authorizer'];
  readonly #permissions: SessionPorts['permissions'];
  readonly #observer: SessionPorts['observer'];
  /**
   * 已归档消息 ID → 归档目录 URI（按会话）。`addMessage` 的幂等判据要用它。
   *
   * 懒加载：每个会话第一次写入时读一遍归档元数据；提交时增量更新。见
   * {@link SessionService.addMessage}。
   */
  readonly #archivedMessageIndex: SessionPorts['archivedMessageIndex'] = new Map();

  constructor(options: SessionServiceOptions) {
    this.#store = options.store;
    this.#locks = options.locks;
    this.#tasks = options.tasks;
    this.#logger = options.logger;
    this.#meta = options.meta;
    this.#autoCommit = options.config.autoCommit;
    this.#archiveDirectoryName =
      options.config.archiveDirectoryName ?? DEFAULT_ARCHIVE_DIRECTORY_NAME;
    this.#authorizer = options.authorizer;
    this.#permissions = options.permissions;
    this.#observer = options.observer;
  }

  #ports(): SessionPorts {
    return {
      store: this.#store,
      locks: this.#locks,
      tasks: this.#tasks,
      logger: this.#logger,
      meta: this.#meta,
      autoCommit: this.#autoCommit,
      archiveDirectoryName: this.#archiveDirectoryName,
      authorizer: this.#authorizer,
      permissions: this.#permissions,
      observer: this.#observer,
      archivedMessageIndex: this.#archivedMessageIndex,
    };
  }

  #archivePorts(): ArchivePorts {
    return { ...this.#ports(), loadSession: (sessionUri) => this.load(sessionUri) };
  }

  /** 建会话。只创建，不重置；判据与失败语义见 `lifecycle.createSession`。 */
  async create(
    scopeUri: Uri,
    principals: readonly string[],
    options: { readonly sessionId?: string } = {},
  ): Promise<Uri> {
    return createSession(this.#ports(), scopeUri, principals, options);
  }

  /** 按调用方指定的稳定 ID 取会话；不存在就创建。见 `lifecycle.ensureSession`。 */
  async ensure(
    scopeUri: Uri,
    sessionId: string,
    principals: readonly string[],
  ): Promise<Uri> {
    return ensureSession(this.#ports(), scopeUri, sessionId, principals);
  }

  /** 读会话（含消息）。不存在抛 `NOT_FOUND`。 */
  async load(sessionUri: Uri): Promise<Session> {
    const meta = await requireSession(this.#meta, sessionUri);
    const messages = await readMessages(this.#store, messagesUri(sessionUri));
    return {
      id: meta.sessionId,
      uri: sessionUri,
      status: meta.status,
      messages,
      // 未提交的消息就是 live 里的全部消息：归档之后它们已经移走。
      messageCount: messages.length,
      // `pendingTokens` 从消息重算，不读元数据里的缓存值——消息文件是真相，
      // 元数据里的那一份是给「不读消息就能判断」的调用方用的（§6.6）。
      pendingTokens: sumTokens(messages),
      lastCommitAt: meta.lastCommitAt,
    };
  }

  /**
   * 会话的**累计**消息数：已归档消息（去重后的 ID）数 + live 条数。
   *
   * 时钟语义见 §8.7：`turn = totalMessageCount(sessionUri)`。归档之后消息已经移出
   * live，只数 live 会让时钟在每次提交后归零，所以这里把已归档 ID 数与 live 条数
   * 相加。归档部分复用 `addMessage` 幂等用的那份索引（`archive-index.ts`）；live
   * 部分仍要读一次 `messages.jsonl`。
   *
   * **不要用 `Session.messageCount` 替代。** 那个字段是「未提交的 live 条数」，
   * `shouldAutoCommit` 的消息数阈值依赖这个语义；本方法是独立的累计时钟。
   *
   * **也不要用 `SessionMessage.turn`。** 那个字段是消息在当前 live 窗口内的序号
   * （`nextTurn` = `messages.length + 1`），提交之后新消息从 1 重新编号，同样会
   * 倒退。
   *
   * **与 `load` 的一处差异（有意）：本方法不检查 `.meta.json`。** `create` 先写
   * 消息、后写元数据，崩溃留下的空壳在 `load` 里是 `NOT_FOUND`，在这里能算出
   * live 条数。调用方只需要「会话不可读时别让检索失败」。
   *
   * **崩溃窗口 / 已知限制**见原实现说明：索引在写归档元数据之前更新，提交失败
   * 路径上可能多算一批；`remove` 后用同一 ID 重建，累计数从 0 重来。
   */
  async totalMessageCount(sessionUri: Uri): Promise<number> {
    const archived = (await loadArchivedMessageIndex(this.#ports(), sessionUri)).size;
    const live = (await readMessages(this.#store, messagesUri(sessionUri))).length;
    return archived + live;
  }

  /** 追加消息，按消息 ID 幂等。见 `append.appendMessage`。 */
  async addMessage(
    sessionUri: Uri,
    message: Omit<SessionMessage, 'turn'>,
  ): Promise<SessionMessage> {
    return appendMessage(this.#ports(), sessionUri, message);
  }

  /** 阶段一（§10.1）。**全程持 `TREE` 锁**；六步顺序见 `archive.ts`。 */
  async commitPhase1(sessionUri: Uri): Promise<CommitPhase1Result> {
    return this.#locks.withLock(sessionUri, 'tree', () =>
      commitPhase1(this.#archivePorts(), sessionUri),
    );
  }

  /** 阶段二的状态查询（`.meta.json` 的 `stepsDone`）。归档不存在返回 `null`。 */
  async readArchiveMeta(archiveUri: Uri): Promise<ArchiveMeta | null> {
    return this.#meta.readArchive(archiveUri);
  }

  /** 自动提交判定（§10.2.1）。纯判定，不提交。 */
  shouldAutoCommit(session: Session, now: Date): boolean {
    return shouldAutoCommitPolicy(session, this.#autoCommit, now);
  }

  /** `history/` 下的归档目录，按序号升序。过期判定与审计日志要用它。 */
  async listArchives(sessionUri: Uri): Promise<readonly Uri[]> {
    return listArchiveUris(
      this.#store,
      historyUri(sessionUri, this.#archiveDirectoryName),
    );
  }

  /** 空闲过期：标记 `archived`，不删文件。见 `lifecycle.archiveSession`。 */
  async archive(sessionUri: Uri): Promise<void> {
    return archiveSession(this.#ports(), sessionUri);
  }

  /** 物理删除整个会话目录。见 `lifecycle.removeSession`。 */
  async remove(sessionUri: Uri): Promise<SessionRemoval> {
    return removeSession(this.#ports(), sessionUri);
  }
}
