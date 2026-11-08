/**
 * 会话与阶段一提交（架构文档 §10.1 的两阶段、§10.2 的归档边界、§6.5–6.6 的目录
 * 形状）。
 *
 * 这一层是**阶段一**：分配归档序号 → 写归档消息 → 写 `preparing` 元数据 → 重写
 * live 消息 → 元数据置 `ready` → 建任务。阶段二的四个步骤在 `services/commit/`，
 * 它们通过 `readArchiveMeta` / `writeArchiveMeta` 与 `TaskService` 接入。
 *
 * ## `.meta.json` 的读写不在这里
 *
 * 它是保留名（§6.2 规则 6）：`ContentStore` 拒绝写入，`Uri` 也无法把它表示成普通
 * 路径段。读写落在 `adapters/fs/metadata-file.ts` 的 `MetadataFileStore` 上，由
 * bootstrap 构造后注入本服务。`services/` 不允许值导入 `node:fs`（§4.2），这一层
 * 只做编排：什么时候写、写什么，不关心怎么落盘。
 *
 * ## 阶段一不是「写完就算」
 *
 * `.done` 只在阶段二最后写（§10.1），它是唯一的完成信号。本文件的六步里不会写
 * `.done`，也不会把 `phase1.status` 提前置 `ready`：崩溃在任何一步，磁盘上要么是
 * 「没有归档目录」，要么是「`preparing` 且 `messages.jsonl` 完整」。
 *
 * ## 重放：为什么是「补完这次归档」而不是「重新归档一次」
 *
 * 崩溃可能发生在步骤 4（重写 live 消息）之前或之后：
 *
 * - 之前：live 里还有全部消息；
 * - 之后：live 里只剩保留的消息，被归档的消息**只在** `archive_NNN/messages.jsonl`
 *   里。
 *
 * 第二种情况下从 live 重新归档会丢掉已经移走的消息。所以重放时先找 `preparing`
 * 的归档，读它的 `messages.jsonl`（步骤 2 是原子写，文件一定完整），再把 live
 * 重写成「排除这些消息 ID」——两种崩溃时序下结果一致，且已经归档的消息不会被
 * 重复计数。
 *
 * ## 并发
 *
 * `add_message` 与阶段一用同一把 `TREE` 锁（§10.6）：阶段一要「读 live → 写归档 →
 * 重写 live」，中间插进一条新消息会被重写覆盖。锁保证两者串行。
 */

import { createHash, randomUUID } from 'node:crypto';

import type { ContentStore } from '../adapters/fs/content-store.js';
import type { PathLockManager } from '../adapters/fs/lock.js';
import type { MetadataFileStore } from '../adapters/fs/metadata-file.js';
import type { PermissionRepository } from '../adapters/sqlite/permission-repository.js';
import type { ArchiveMeta, ArchiveTaskPayload } from '../domain/archive.js';
import { ComemError } from '../domain/errors.js';
import type { Logger } from '../domain/log.js';
import type {
  AutoCommitPolicy,
  ContentPart,
  MessageRole,
  Session,
  SessionMessage,
  SessionMeta,
} from '../domain/session.js';
import {
  estimateTokens,
  nextTurn,
  renderMessageText,
  shouldAutoCommit as shouldAutoCommitPolicy,
} from '../domain/session.js';
import type { Uri } from '../domain/uri.js';

import type { TaskService } from './task.js';
import type { AclAction, Authorizer } from './authorizer.js';

// 类型上移到领域层（§4.2：`services/` 与 `adapters/` 都要用它，而它是纯数据）。
// 这里 re-export，既有 import 路径不变。
export type { ArchiveTaskPayload } from '../domain/archive.js';
export type { SessionMeta } from '../domain/session.js';

/** 会话目录名（§6.5 的 `sessions/sess_xxx/`）。 */
const SESSIONS_DIRECTORY_NAME = 'sessions';

/** §6.5 的会话 ID 前缀与随机段长度（`sess_7f3a91c2`）。 */
const SESSION_ID_PREFIX = 'sess_';
const SESSION_ID_RANDOM_HEX_LENGTH = 8;

/** 归档目录名（§6.5 的 `history/`），可由配置覆盖。 */
const DEFAULT_ARCHIVE_DIRECTORY_NAME = 'history';

/** §10.2 的归档序号：`archive_001`、`archive_002`…… */
const ARCHIVE_DIRECTORY_PREFIX = 'archive_';
const ARCHIVE_SEQUENCE_DIGITS = 3;
const ARCHIVE_DIRECTORY_PATTERN = /^archive_(\d+)$/;

/** `messages.jsonl` 文件名（§6.5）。 */
const MESSAGES_FILE_NAME = 'messages.jsonl';

/**
 * 稳定消息 ID 的分隔符。
 *
 * 用 NUL：它不会出现在角色名或 ISO 时间串里，正文里出现同样的字符也不会让
 * `("ab", "c")` 与 `("a", "bc")` 拼出同一个摘要。
 */
const MESSAGE_ID_SEPARATOR = '\u0000';

/** §12.1：write = 3（建会话是写操作）。 */
const WRITE: AclAction = 3;

export interface SessionServiceOptions {
  readonly store: ContentStore;
  /** 目录摘要文件；阶段二生成归档摘要时用（本 wave 不读它，保留装配位）。 */
  readonly metadata: MetadataFileStore;
  readonly locks: PathLockManager;
  readonly tasks: TaskService;
  readonly logger: Logger;
  /**
   * 元数据文件（`.meta.json`）的读写。
   *
   * 实例由 bootstrap 构造注入（§4.2：`services/` 不 `new` 适配器）。这里要的是
   * 具体类型而不是接口——§4.4 明确不为只有一个实现的存储建端口。
   */
  readonly meta: MetadataFileStore;
  readonly config: {
    readonly autoCommit: AutoCommitPolicy;
    /** §6.5 的 `history/`；默认 `history` */
    readonly archiveDirectoryName?: string;
  };
  /**
   * 写后物化权限（§12.4）。
   *
   * `create` 直接写 `ContentStore`，不经过 `FileSystemService` 的观察者，所以
   * `node_permission` 里没有会话目录的行。`GET /sessions` 的 `list` 是纯 SQL 过滤
   * ——会话建成功了，列表里却没有。
   *
   * 可选是给「只关心提交管线」的调用方（单测、只读脚本）留的：不注入就整体跳过，
   * 而不是每次 `create` 都打一次必定失败的求权。生产装配（`container.ts`）总是
   * 注入。
   */
  readonly authorizer?: Authorizer;
  /**
   * 物化权限的清理端口（删除会话时用）。
   *
   * 会话 `create` 物化了 `node_permission` 行（见 `#materialize`），而
   * `node_permission` 没有指向 `node` 的外键级联。删除会话目录之后这些行会留下来
   * ——会话 ID 可以由调用方指定（`POST /sessions` 的 `sessionId`），重建同名会话会
   * 继承上一轮的授权行。删除必须显式清。
   *
   * 可选：不注入时跳过清理（只关心提交管线的调用方，例如单测）。
   */
  readonly permissions?: Pick<PermissionRepository, 'deleteSubtree'>;
}

export interface CommitPhase1Result {
  readonly taskId: string;
  readonly archiveUri: Uri;
  /** 归档了多少条消息 */
  readonly archivedCount: number;
}

/**
 * 物理删除一个会话之后「删了什么」的审计记录（架构文档 §11.7 的
 * `session.expiry.action: delete`）。
 *
 * 删除是不可逆的，日志必须能回答「删掉的会话里有什么」：只有 URI 的话，事后无法判断
 * 那次删除是否误伤（丢的是不是一段有内容的对话）。
 */
export interface SessionRemoval {
  readonly sessionUri: Uri;
  /** 没归档的消息数（`messages.jsonl` 里的行数） */
  readonly messages: number;
  /** `history/` 下的归档目录数 */
  readonly archives: number;
  /** 磁盘上实际删除的条目数（`rm -rf` 的计数） */
  readonly removedEntries: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMessageRole(value: unknown): value is SessionMessage['role'] {
  return value === 'user' || value === 'assistant' || value === 'system' || value === 'tool';
}

/** 磁盘上的 `messages.jsonl` 是本模块自己写的；内容不合法说明数据被改坏了，是程序缺陷。 */
function corruptDocument(uri: Uri, reason: string): ComemError {
  return new ComemError('INTERNAL', `会话文件内容不合法：${uri.toString()}（${reason}）`, {
    uri: uri.toString(),
    reason,
  });
}

function toSessionMessage(value: unknown, uri: Uri): SessionMessage {
  if (!isRecord(value)) {
    throw corruptDocument(uri, '消息不是对象');
  }
  const id = value['id'];
  const role = value['role'];
  const parts = value['parts'];
  const createdAt = value['createdAt'];
  const turn = value['turn'];
  if (typeof id !== 'string' || typeof createdAt !== 'string') {
    throw corruptDocument(uri, '消息的 id / createdAt 不是字符串');
  }
  if (!isMessageRole(role)) {
    throw corruptDocument(uri, '消息的 role 不是合法角色');
  }
  if (!Array.isArray(parts)) {
    throw corruptDocument(uri, '消息的 parts 不是数组');
  }
  if (typeof turn !== 'number' || !Number.isInteger(turn) || turn < 1) {
    throw corruptDocument(uri, '消息的 turn 不是正整数');
  }
  // `parts` 是判别联合，逐项校验等于把领域定义抄一遍；写入侧只接受 `SessionMessage`，
  // 这里确认它是数组即可（§4.2 不鼓励在服务层重写领域校验）。
  return { id, role, parts: parts as readonly ContentPart[], createdAt, turn };
}

/** 一条消息一行（JSONL，§6.5）。空会话是空文件，不是 `[]`。 */
function serializeMessages(messages: readonly SessionMessage[]): string {
  if (messages.length === 0) {
    return '';
  }
  return `${messages.map((message) => JSON.stringify(message)).join('\n')}\n`;
}

function parseMessages(raw: string, uri: Uri): readonly SessionMessage[] {
  const messages: SessionMessage[] = [];
  for (const line of raw.split('\n')) {
    if (line.trim() === '') {
      continue;
    }
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw corruptDocument(uri, 'messages.jsonl 有一行不是合法 JSON');
    }
    messages.push(toSessionMessage(value, uri));
  }
  return messages;
}

/** 未提交的估算 token 数（§10.2.1 的阈值判断用）。 */
function sumTokens(messages: readonly SessionMessage[]): number {
  let total = 0;
  for (const message of messages) {
    total += estimateTokens(renderMessageText(message));
  }
  return total;
}

function archiveSequence(name: string): number {
  return Number(ARCHIVE_DIRECTORY_PATTERN.exec(name)?.[1] ?? '0');
}

/**
 * 消息的稳定 ID：`sha256(role + \0 + text + \0 + createdAt)`。
 *
 * 与 `remember`（`api/mcp/tools/remember.ts` 的 `messageId`）同一个公式——两条
 * 导入路径可能落进同一个会话，公式一漂就互相看不见对方的去重。
 *
 * 为什么要稳定 ID：游标只在消息落盘之后前进，进程死在「写完消息、游标没写」之间
 * 时重跑会从同一个游标再读一遍。ID 每次随机时服务端没有任何判据能认出「这条已经
 * 落过盘」，只能整批重复追加。有了稳定 ID，调用方按「会话已有的 ID」去重即可。
 *
 * **`createdAt` 是幂等键的一部分**：源日志没有时间戳时调用方只能填当前时刻，
 * 重跑会得到不同的 ID，去重失效。这是已知窗口，写进 §18「并发控制」。
 *
 * 分隔符用 NUL：它不出现在角色名或 ISO 时间串里，正文里出现同样的字符也不会让
 * `("ab", "c")` 与 `("a", "bc")` 拼出同一个摘要。
 */
export function stableMessageId(
  role: MessageRole,
  text: string,
  createdAt: string,
): string {
  return createHash('sha256').update([role, text, createdAt].join(MESSAGE_ID_SEPARATOR)).digest('hex');
}

function createSessionId(): string {
  return `${SESSION_ID_PREFIX}${randomUUID().replaceAll('-', '').slice(0, SESSION_ID_RANDOM_HEX_LENGTH)}`;
}

export class SessionService {
  readonly #store: ContentStore;
  readonly #locks: PathLockManager;
  readonly #tasks: TaskService;
  readonly #logger: Logger;
  readonly #meta: MetadataFileStore;
  readonly #autoCommit: AutoCommitPolicy;
  readonly #archiveDirectoryName: string;
  readonly #authorizer: Authorizer | undefined;
  readonly #permissions: Pick<PermissionRepository, 'deleteSubtree'> | undefined;

  constructor(options: SessionServiceOptions) {
    this.#store = options.store;
    this.#locks = options.locks;
    this.#tasks = options.tasks;
    this.#logger = options.logger;
    this.#meta = options.meta;
    this.#autoCommit = options.config.autoCommit;
    this.#archiveDirectoryName = options.config.archiveDirectoryName ?? DEFAULT_ARCHIVE_DIRECTORY_NAME;
    this.#authorizer = options.authorizer;
    this.#permissions = options.permissions;
  }

  /**
   * 建会话。目录 `sessions/sess_xxx/`，写 `messages.jsonl`（空）与 `.meta.json`。
   *
   * **只创建，不重置。** 已存在的会话（`.meta.json` 在）抛 `ALREADY_EXISTS`，HTTP
   * 映射成 409。`messages.jsonl` 是会话的真相，用同 ID 再建一次就把它覆写成空文件
   * 是静默数据丢失——Hook 的 `PostToolUse` 与 `Stop` 在同一轮里各建一次，工具消息
   * 会被后一次 `Stop` 抹掉。要「已存在就复用」用 {@link ensure}。
   *
   * 不提供「重置」：清空消息没有合法调用方。归档走 `commitPhase1`（消息移进
   * `history/`，不丢），删除走 `remove`（整目录删除，可审计）。
   *
   * 判据与 `load` / `ensure` 一致：`.meta.json` 存在即会话存在。目录在、元数据不在
   * 只可能是 `create` 中途崩溃留下的空会话（先写消息、后写元数据），重建不会丢消息。
   *
   * 检查与写入持 `TREE` 锁（§10.6）：两个同 ID 的 `create` 并发时，后一个必须看到
   * 前一个写下的元数据并失败，不能把前一个刚写下的消息覆写成空文件。
   */
  async create(
    scopeUri: Uri,
    principals: readonly string[],
    options: { readonly sessionId?: string } = {},
  ): Promise<Uri> {
    const sessionId = options.sessionId ?? createSessionId();
    const sessionUri = scopeUri.child(SESSIONS_DIRECTORY_NAME, sessionId);
    // 锁文件是会话目录的同级文件，`sessions/` 必须先存在（`acquire` 不建父目录）。
    // 目录已存在时它是幂等的，所以放在检查之前不会改变「存在」的判据。
    await this.#store.mkdir(sessionUri, { recursive: true });
    await this.#locks.withLock(sessionUri, 'tree', async () => {
      if ((await this.#meta.readSession(sessionUri)) !== null) {
        throw new ComemError('ALREADY_EXISTS', `会话已存在：${sessionUri.toString()}`, {
          uri: sessionUri.toString(),
          sessionId,
        });
      }
      // 先写消息文件再写元数据：崩溃时留下的是「有目录、没有元数据」，`load` 按
      // NOT_FOUND 处理；反过来会留下一个声称存在、但读不出消息的会话。
      await this.#store.writeText(this.#messagesUri(sessionUri), '');
      await this.#meta.writeSession(sessionUri, {
        sessionId,
        userId: scopeUri.rootId,
        status: 'open',
        createdAt: new Date().toISOString(),
        commitCount: 0,
        lastCommitAt: null,
        pendingTokens: 0,
      });
    });
    // §12.4 的「写时算」：会话目录与 `messages.jsonl` 都没有经过观察者。不物化的话
    // `GET /sessions` 的 `list(sessions/)` 会因为缺 `node_permission` 行返回空。
    // 放在锁外：它要查 ACL 表，失败只记日志，不需要与创建互斥。
    await this.#materialize(sessionUri, principals);
    this.#logger.info('会话已创建', { uri: sessionUri.toString() });
    return sessionUri;
  }

  /**
   * 按调用方指定的稳定 ID 取会话；不存在就创建。
   *
   * 幂等上传（`remember` 的 `sessionId`）重跑时拿到的是同一个会话，消息由调用方
   * 自己按稳定 ID 去重。
   *
   * 只认元数据是否存在：`.meta.json` 是会话「存在」的判据（`load` 也按它判）。
   * `create` 先写消息、后写元数据，所以「目录在、元数据不在」只可能是崩溃留下的
   * 空会话，重新创建不会丢消息。
   */
  async ensure(
    scopeUri: Uri,
    sessionId: string,
    principals: readonly string[],
  ): Promise<Uri> {
    const sessionUri = scopeUri.child(SESSIONS_DIRECTORY_NAME, sessionId);
    try {
      await this.#requireSession(sessionUri);
      return sessionUri;
    } catch (error) {
      if (error instanceof ComemError && error.code === 'NOT_FOUND') {
        return this.create(scopeUri, principals, { sessionId });
      }
      throw error;
    }
  }

  /** 读会话（含消息）。不存在抛 `NOT_FOUND`。 */
  async load(sessionUri: Uri): Promise<Session> {
    const meta = await this.#requireSession(sessionUri);
    const messages = await this.#readMessages(this.#messagesUri(sessionUri));
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
   * 追加消息。**必须持 `TREE` 锁**（§10.6：`commit` 与 `add_message` 不丢消息）。
   *
   * 轮次时钟由 `nextTurn` 按消息总数算（§8.7），不接受调用方传入。
   */
  async addMessage(
    sessionUri: Uri,
    message: Omit<SessionMessage, 'turn'>,
  ): Promise<SessionMessage> {
    return this.#locks.withLock(sessionUri, 'tree', async () => {
      const meta = await this.#requireSession(sessionUri);
      const messages = await this.#readMessages(this.#messagesUri(sessionUri));
      const appended: SessionMessage = { ...message, turn: nextTurn(messages) };
      const next = [...messages, appended];
      await this.#store.writeText(this.#messagesUri(sessionUri), serializeMessages(next));
      await this.#meta.writeSession(sessionUri, { ...meta, pendingTokens: sumTokens(next) });
      return appended;
    });
  }

  /**
   * 阶段一（§10.1）。**全程持 `TREE` 锁**。
   *
   * 六步的顺序不能变：归档消息先落盘，`.meta.json` 先写 `preparing`，live 重写之
   * 后才置 `ready`，最后才建任务。任何一步崩溃，下一次调用都会从 `preparing` 的
   * 归档继续（见文件头）。
   */
  async commitPhase1(sessionUri: Uri): Promise<CommitPhase1Result> {
    return this.#locks.withLock(sessionUri, 'tree', () => this.#commitPhase1(sessionUri));
  }

  /** 阶段二的状态查询（`.meta.json` 的 `stepsDone`）。归档不存在返回 `null`。 */
  async readArchiveMeta(archiveUri: Uri): Promise<ArchiveMeta | null> {
    return this.#meta.readArchive(archiveUri);
  }

  /** 写归档元数据（提交管线用）。 */
  async writeArchiveMeta(archiveUri: Uri, meta: ArchiveMeta): Promise<void> {
    return this.#meta.writeArchive(archiveUri, meta);
  }

  /** 自动提交判定（§10.2.1）。纯判定，不提交。 */
  shouldAutoCommit(session: Session, now: Date): boolean {
    return shouldAutoCommitPolicy(session, this.#autoCommit, now);
  }

  /** `history/` 下的归档目录，按序号升序。过期判定与审计日志要用它。 */
  async listArchives(sessionUri: Uri): Promise<readonly Uri[]> {
    return this.#listArchives(this.#historyUri(sessionUri));
  }

  /**
   * 空闲过期：把会话标记为 `archived`，**不删文件**（§11.7 的
   * `session.expiry.action: archive`）。
   *
   * 只改 `.meta.json` 的 `status`：消息、归档、`memory_diff.json` 全部原样保留。
   * 归档是可逆的（把 `status` 改回 `open` 就恢复），所以它可以是默认动作——删除
   * 不是。
   *
   * 已经是 `archived` 时是空操作（幂等）：调度器每轮都会看到这个会话，重复写一次
   * `.meta.json` 只会多一次磁盘往返与一条假日志。
   */
  async archive(sessionUri: Uri): Promise<void> {
    // **必须持 `TREE` 锁**（与 `addMessage` / `commitPhase1` 同一把）：这是
    // `.meta.json` 的读-改-写。无锁时调度器的归档会把并发提交刚写进去的
    // `commitCount` 盖回旧值，而 `#nextArchiveId` 就是 `commitCount + 1`——
    // 少计一次，下一个归档就会重新分配已有的 `archive_NNN`，把上一份归档的
    // `messages.jsonl` 与元数据原子覆盖掉（归档消息永久丢失）。
    await this.#locks.withLock(sessionUri, 'tree', async () => {
      const meta = await this.#requireSession(sessionUri);
      if (meta.status === 'archived') {
        return;
      }
      await this.#meta.writeSession(sessionUri, { ...meta, status: 'archived' });
      this.#logger.info('会话已归档（空闲过期）。', {
        uri: sessionUri.toString(),
        commitCount: meta.commitCount,
        pendingTokens: meta.pendingTokens,
      });
    });
  }

  /**
   * 物理删除整个会话目录（§11.7 的 `session.expiry.action: delete`）。
   *
   * **调用方必须先确认没有待复核记忆的来源指向这个会话**——`memory_diff.json` 只存在
   * 归档目录里，删掉之后「这条待复核记忆是哪个会话产出的」就再也追不回来。这条闸门
   * 在 `Scheduler` 里，因为只有它知道该去查哪些记忆。
   *
   * 返回删了什么，供调用方写审计日志；`.meta.json` 缺失（建了一半的会话）不是错误。
   */
  async remove(sessionUri: Uri): Promise<SessionRemoval> {
    const meta = await this.#meta.readSession(sessionUri);
    const messages = await this.#countMessages(sessionUri);
    const archives = (await this.#listArchives(this.#historyUri(sessionUri))).length;
    const removedEntries = await this.#store.remove(sessionUri, { recursive: true });
    await this.#deletePermissions(sessionUri);
    this.#logger.info('会话已删除（空闲过期）。', {
      uri: sessionUri.toString(),
      sessionId: meta?.sessionId ?? null,
      messages,
      archives,
      removedEntries,
    });
    return { sessionUri, messages, archives, removedEntries };
  }

  async #commitPhase1(sessionUri: Uri): Promise<CommitPhase1Result> {
    const historyUri = this.#historyUri(sessionUri);
    const interrupted = await this.#findInterruptedArchive(historyUri);
    if (interrupted !== null) {
      if (await this.#store.exists(this.#messagesUri(interrupted))) {
        return this.#resumeArchive(sessionUri, interrupted);
      }
      // 崩溃在步骤 1 与 2 之间：只有空目录，没有消息。删掉重新分配。
      await this.#store.remove(interrupted, { recursive: true });
    }

    const session = await this.load(sessionUri);
    const keepRecentCount = this.#autoCommit.keepRecentCount;
    const archived =
      keepRecentCount <= 0
        ? session.messages
        : session.messages.slice(0, Math.max(0, session.messages.length - keepRecentCount));
    if (archived.length === 0) {
      // 空归档只会产出一个空任务：没有消息可抽取，阶段二会写一份空摘要再标记完成。
      // 拒绝比制造一个没有内容的归档更诚实。
      throw new ComemError('INVALID_ARGUMENT', `没有可归档的消息：${sessionUri.toString()}`, {
        uri: sessionUri.toString(),
        messageCount: session.messages.length,
        keepRecentCount,
      });
    }
    const retained = session.messages.slice(archived.length);

    // 步骤 1：分配归档序号。
    const archiveId = await this.#nextArchiveId(sessionUri);
    const archiveUri = historyUri.child(archiveId);

    // 步骤 2：写归档消息（原子写）。
    await this.#store.writeText(this.#messagesUri(archiveUri), serializeMessages(archived));
    const messagesSha256 = await this.#sha256(this.#messagesUri(archiveUri));

    // 步骤 3：`.meta.json` 先写 `preparing`。到这里为止，归档消息已经完整落盘。
    const preparing: ArchiveMeta = {
      archiveId,
      phase1: {
        status: 'preparing',
        messagesSha256,
        archivedMessageIds: archived.map((message) => message.id),
        retainedMessageIds: retained.map((message) => message.id),
      },
      stepsDone: [],
      // 阶段一不跳过任何步骤；跳过只发生在阶段二（没有可用 LLM 时）。
      skippedSteps: [],
      taskId: null,
    };
    await this.#meta.writeArchive(archiveUri, preparing);

    // 步骤 4：重写 live 消息，只保留 keepRecentCount 条。
    await this.#store.writeText(this.#messagesUri(sessionUri), serializeMessages(retained));

    // 步骤 5：`phase1` 置 `ready`。**不写 `.done`**——那是阶段二的最后一步。
    const ready: ArchiveMeta = { ...preparing, phase1: { ...preparing.phase1, status: 'ready' } };
    await this.#meta.writeArchive(archiveUri, ready);

    // 步骤 6：建任务，并把 taskId 回填进归档元数据。
    const task = this.#tasks.create('archive', {
      sessionUri: sessionUri.toString(),
      archiveUri: archiveUri.toString(),
      archiveId,
    } satisfies ArchiveTaskPayload);
    await this.#meta.writeArchive(archiveUri, { ...ready, taskId: task.id });

    await this.#writeSessionMeta(sessionUri, retained);
    this.#logger.info('阶段一归档完成', {
      uri: sessionUri.toString(),
      archiveUri: archiveUri.toString(),
      archivedCount: archived.length,
      taskId: task.id,
    });
    return { taskId: task.id, archiveUri, archivedCount: archived.length };
  }

  /**
   * 补完一次停在 `preparing` 的归档。
   *
   * 读归档的 `messages.jsonl`（步骤 2 已经原子写完，内容完整），把 live 重写成
   * 「排除这些消息 ID」，再写 `ready` 与任务。不重新分配序号：这个归档目录就是
   * 这次提交的产物。
   */
  async #resumeArchive(sessionUri: Uri, archiveUri: Uri): Promise<CommitPhase1Result> {
    const archiveId = archiveUri.name;
    const archived = await this.#readMessages(this.#messagesUri(archiveUri));
    const messagesSha256 = await this.#sha256(this.#messagesUri(archiveUri));
    const live = await this.#readMessages(this.#messagesUri(sessionUri));
    const archivedMessageIds = new Set(archived.map((message) => message.id));
    const retained = live.filter((message) => !archivedMessageIds.has(message.id));

    // 步骤 4 重放：已经归档的消息从 live 里去掉。
    await this.#store.writeText(this.#messagesUri(sessionUri), serializeMessages(retained));

    // 步骤 5 重放。
    const existing = await this.#meta.readArchive(archiveUri);
    const ready: ArchiveMeta = {
      archiveId,
      phase1: {
        status: 'ready',
        messagesSha256,
        archivedMessageIds: [...archivedMessageIds],
        retainedMessageIds: retained.map((message) => message.id),
      },
      stepsDone: existing?.stepsDone ?? [],
      // 补完归档时保留已经记录过的跳过原因：阶段二可能已经跑过并跳过了某几步。
      skippedSteps: existing?.skippedSteps ?? [],
      taskId: existing?.taskId ?? null,
    };
    await this.#meta.writeArchive(archiveUri, ready);

    // 步骤 6 重放：任务已经建过就复用，不再造第二个。
    let taskId = ready.taskId;
    if (taskId === null) {
      const task = this.#tasks.create('archive', {
        sessionUri: sessionUri.toString(),
        archiveUri: archiveUri.toString(),
        archiveId,
      } satisfies ArchiveTaskPayload);
      taskId = task.id;
      await this.#meta.writeArchive(archiveUri, { ...ready, taskId });
    }

    await this.#writeSessionMeta(sessionUri, retained);
    this.#logger.warn('补完了中断的归档。', {
      uri: sessionUri.toString(),
      archiveUri: archiveUri.toString(),
      archivedCount: archived.length,
      taskId,
    });
    return { taskId, archiveUri, archivedCount: archived.length };
  }

  /**
   * 找停在 `preparing` 的归档（或只有目录、没有元数据的归档）。
   *
   * 取序号最小的一个：正常崩溃只会留下一个，出现多个说明磁盘状态被手工改过，
   * 从最早的开始补才能保持归档顺序。
   */
  async #findInterruptedArchive(historyUri: Uri): Promise<Uri | null> {
    for (const archiveUri of await this.#listArchives(historyUri)) {
      const meta = await this.#meta.readArchive(archiveUri);
      if (meta === null || meta.phase1.status === 'preparing') {
        return archiveUri;
      }
    }
    return null;
  }

  /** `history/` 下的归档目录，按序号升序。 */
  async #listArchives(historyUri: Uri): Promise<readonly Uri[]> {
    if (!(await this.#store.exists(historyUri))) {
      return [];
    }
    const entries = await this.#store.list(historyUri);
    return entries
      .filter((entry) => entry.kind === 'directory' && ARCHIVE_DIRECTORY_PATTERN.test(entry.uri.name))
      .map((entry) => entry.uri)
      .sort((left, right) => archiveSequence(left.name) - archiveSequence(right.name));
  }

  /**
   * 下一个归档序号：会话的 `commitCount + 1`（§10.2「单调递增，从不复用」）。
   *
   * **不能用「`history/` 里的最大序号 + 1」**：删掉最新的归档目录之后，那个编号会
   * 被下一次提交重新分配。归档编号是归档的身份证——`memory_diff.json`、任务
   * payload、控制台的归档列表都按它引用，复用会让两条不同的归档指向同一个名字。
   *
   * 计数器放在 `.meta.json` 的 `commitCount` 里：它是文件，删库不丢（§7），而且
   * 本来就随每次提交递增，不需要另存一份。`history/` 目录仍然可以随时重建。
   */
  async #nextArchiveId(sessionUri: Uri): Promise<string> {
    const meta = await this.#requireSession(sessionUri);
    return `${ARCHIVE_DIRECTORY_PREFIX}${String(meta.commitCount + 1).padStart(
      ARCHIVE_SEQUENCE_DIGITS,
      '0',
    )}`;
  }

  async #writeSessionMeta(sessionUri: Uri, retained: readonly SessionMessage[]): Promise<void> {
    const meta = await this.#requireSession(sessionUri);
    await this.#meta.writeSession(sessionUri, {
      ...meta,
      commitCount: meta.commitCount + 1,
      lastCommitAt: new Date().toISOString(),
      pendingTokens: sumTokens(retained),
    });
  }

  /**
   * 为新会话目录物化权限（§12.4 的「写时算」）。
   *
   * `InheritingAuthorizer` 的写路径在缺行时先 `materializeNode` 再求权，所以调一次
   * `assert` 就是「从父目录复制一份有效权限」。
   *
   * 失败只记日志：目录与 `messages.jsonl` 已经落盘，回滚反而丢数据（§7 的同一
   * 原则）；下一次 `GET /sessions/{id}` 的读路径还会补一次。
   */
  async #materialize(sessionUri: Uri, principals: readonly string[]): Promise<void> {
    const authorizer = this.#authorizer;
    if (authorizer === undefined) {
      return;
    }
    try {
      await authorizer.assert(sessionUri, WRITE, principals);
    } catch (error) {
      this.#logger.error('会话目录权限物化失败，已忽略。', {
        uri: sessionUri.toString(),
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async #requireSession(sessionUri: Uri): Promise<SessionMeta> {
    const meta = await this.#meta.readSession(sessionUri);
    if (meta === null) {
      throw new ComemError('NOT_FOUND', `会话不存在：${sessionUri.toString()}`, {
        uri: sessionUri.toString(),
      });
    }
    return meta;
  }

  /** 未归档的消息数；`messages.jsonl` 缺失按 0（建了一半的会话）。 */
  async #countMessages(sessionUri: Uri): Promise<number> {
    try {
      return (await this.#readMessages(this.#messagesUri(sessionUri))).length;
    } catch (error) {
      if (error instanceof ComemError && error.code === 'NOT_FOUND') {
        return 0;
      }
      throw error;
    }
  }

  /**
   * 清掉被删会话的物化权限行。
   *
   * 失败只记日志：目录已经删掉了，回滚不回来；残留的权限行是派生数据，靠对账修复
   * （§7）。抛出去只会让「删除成功」变成一个错误响应，而删除其实已经完成。
   */
  async #deletePermissions(sessionUri: Uri): Promise<void> {
    const permissions = this.#permissions;
    if (permissions === undefined) {
      return;
    }
    try {
      permissions.deleteSubtree(sessionUri.toString());
    } catch (error) {
      this.#logger.error('删除会话后清理物化权限失败，已忽略。', {
        uri: sessionUri.toString(),
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async #readMessages(messagesUri: Uri): Promise<readonly SessionMessage[]> {
    const document = await this.#store.readText(messagesUri);
    return parseMessages(document.text, messagesUri);
  }

  /**
   * `messages.jsonl` 的 sha256。阶段二读回来先校验它（§10.1）。
   *
   * `node:crypto` 可以用：它是纯计算，不碰文件系统。`services/` 的分层规则只禁
   * `node:fs` / `node:sqlite`（§4.2），哈希算法本身没有 IO。
   */
  async #sha256(messagesUri: Uri): Promise<string> {
    const bytes = await this.#store.readBytes(messagesUri);
    return createHash('sha256').update(bytes).digest('hex');
  }

  #historyUri(sessionUri: Uri): Uri {
    return sessionUri.child(this.#archiveDirectoryName);
  }

  #messagesUri(directoryUri: Uri): Uri {
    return directoryUri.child(MESSAGES_FILE_NAME);
  }
}
