/**
 * 会话与阶段一提交（架构文档 §10.1 的两阶段、§10.2 的归档边界、§6.5–6.6 的目录
 * 形状）。
 *
 * 这一层是**阶段一**：分配归档序号 → 写归档消息 → 写 `preparing` 元数据 → 重写
 * live 消息 → 元数据置 `ready` → 建任务。阶段二的五个步骤在 `services/commit/`，
 * 归档元数据通过 `readArchiveMeta` 读回，写入在 `#meta.writeArchive`，由 `TaskService` 接入。
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
import type { NodeWriteObserver } from './filesystem.js';
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
  /**
   * 节点写入 / 删除的派生数据维护（§12.4 的「写时算」、§9.3 的索引维护）。
   *
   * `messages.jsonl` 是本服务直接写 `ContentStore` 的：它不经过
   * `FileSystemService` 的观察者，`node` / `node_fts` / `node_permission` 里都没有
   * 这一行。`list` / `tree` / `glob` 的权限过滤是**纯 SQL 查询**——文件在磁盘上，
   * 归档目录里却只剩元数据，用户点开归档看不到「原始对话」。
   *
   * 注入的是 `IndexObserver`（不是整个 `FileSystemService`）：它从磁盘读回内容再
   * 建记录，与普通写路径同一份实现，摘要失效与嵌入也一并排期。
   *
   * 可选：不注入时整体跳过（只关心提交管线的单测不造一个观察者）。
   */
  readonly observer?: Pick<NodeWriteObserver, 'onNodeWritten' | 'onNodeRemoved'>;
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
 * **这是唯一实现**：`remember`（`api/mcp/tools/remember.ts`）与 `ingest`
 * （`services/ingest.ts`）都直接 import 它，不在各自文件里重算。服务端去重按 ID
 * 判等，两份实现各写一遍时公式一漂，两边写进去的消息就互相看不见对方的去重。
 *
 * 为什么放在服务层而不是 `domain/session.ts`：它是纯函数，规则上属于领域，但
 * sha256 要用 `node:crypto`，而 `domain/` 的 lint 规则禁止任何 `node:*` import
 * （`eslint.config.js` 的 `DOMAIN_MESSAGE`）。为一个函数在 `services/` 单开模块
 * 也没必要——本文件已经是权威实现，调用方与 `stableMessageId` 的既有 import
 * 路径都不变。
 *
 * 为什么要稳定 ID：游标只在消息落盘之后前进，进程死在「写完消息、游标没写」之间
 * 时重跑会从同一个游标再读一遍。ID 每次随机时服务端没有任何判据能认出「这条已经
 * 落过盘」，只能整批重复追加。有了稳定 ID，调用方按「会话已有的 ID」去重即可。
 *
 * **`createdAt` 是幂等键的一部分**：源日志没有时间戳时调用方只能填当前时刻，
 * 重跑会得到不同的 ID，去重失效。这是已知窗口，写进 §18「并发控制」。
 * `remember.ts` 的 `createdAtOf` 就保留这个行为（缺省取当前时刻），不在这里兜。
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
  readonly #observer: Pick<NodeWriteObserver, 'onNodeWritten' | 'onNodeRemoved'> | undefined;
  /**
   * 已归档消息 ID → 归档目录 URI（按会话）。`addMessage` 的幂等判据要用它。
   *
   * 懒加载：每个会话第一次写入时读一遍归档元数据；提交时增量更新。见
   * {@link SessionService.addMessage}。
   */
  readonly #archivedMessageIndex = new Map<string, Map<string, Uri>>();

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
    this.#observer = options.observer;
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
      // 元数据不在就是新会话（或崩溃留下的空壳）。缓存里若有同名会话的归档索引，
      // 那是上一份数据留下的，必须丢掉。
      this.#archivedMessageIndex.delete(sessionUri.toString());
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
      // 空文件也是节点：不写索引行 / 不物化权限，`list` / `tree` / `glob` 就看不到
      // live 会话的 `messages.jsonl`（见 `SessionServiceOptions.observer`）。
      await this.#notifyWritten(this.#messagesUri(sessionUri));
    });
    // §12.4 的「写时算」：`GET /sessions` 的 `list(sessions/)` 会因为缺
    // `node_permission` 行返回空。观察者（上面的 `#notifyWritten`）已经物化了会话
    // 目录，这里保留是因为观察者可省略（单测），而「会话目录可列」是 `create`
    // 自己的契约。放在锁外：它要查 ACL 表，失败只记日志，不需要与创建互斥。
    await this.#materialize(sessionUri, principals);
    this.#logger.info('会话已创建', { uri: sessionUri.toString() });
    return sessionUri;
  }

  /**
   * 按调用方指定的稳定 ID 取会话；不存在就创建。
   *
   * 幂等上传（`remember` 的 `sessionId`）重跑时拿到的是同一个会话，消息由调用方
   * 按稳定 ID 去重。
   *
   * 只认元数据是否存在：`.meta.json` 是会话「存在」的判据（`load` 也按它判）。
   * `create` 先写消息、后写元数据，所以「目录在、元数据不在」只可能是崩溃留下的
   * 空会话，重新创建不会丢消息。
   *
   * **并发同 ID 是复用，不是错误。** 两个 `ensure` 可能同时看到 NOT_FOUND，随后
   * 都去 `create`；`create` 在 `TREE` 锁内看到前一个写下的元数据，抛
   * `ALREADY_EXISTS`。这里把它转成「读回已存在的会话」——竞态的胜者已经建好了，
   * 输家要做的是拿到同一个 URI，而不是把 409 抛给调用方。只捕获这一个错误码，
   * 不做重试循环。
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
      if (!(error instanceof ComemError) || error.code !== 'NOT_FOUND') {
        throw error;
      }
    }
    try {
      return await this.create(scopeUri, principals, { sessionId });
    } catch (error) {
      if (error instanceof ComemError && error.code === 'ALREADY_EXISTS') {
        // 并发 `ensure` 的胜者已经建好并写下了元数据。再读一次确认它还在
        // （例如期间被 `remove` 掉的话，NOT_FOUND 会原样抛给调用方）。
        await this.#requireSession(sessionUri);
        return sessionUri;
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
   * 会话的**累计**消息数：已归档消息（去重后的 ID）数 + live 条数。
   *
   * 时钟语义见 §8.7：`turn = totalMessageCount(sessionUri)`，调用方直接拿这个返回值
   * 当 `turn`，不再自己取 `max`。归档之后消息已经移出 live，只数 live 会让时钟在
   * 每次提交后归零（`commitPhase1` 默认 `keepRecentCount = 0`，live 变空），所以这里
   * 把已归档 ID 数与 live 条数相加。它是**派生量**，天然 `>= live 条数`——原先写成
   * `max(totalMessageCount, liveMessages.length)`，但 `max` 恒等于前一项，没有信息量，
   * 已从调用点去掉。
   *
   * 归档部分复用 `addMessage` 幂等用的那份索引（`#loadArchivedMessageIndex`）：
   * 每个会话第一次调用读一次归档元数据，之后 O(1)；提交 / 补完归档时增量更新。
   * live 部分仍要读一次 `messages.jsonl`（与 `load` 相同），它最多是提交阈值那么多条。
   *
   * **不要用 `Session.messageCount` 替代。** 那个字段是「未提交的 live 条数」，
   * `shouldAutoCommit` 的消息数阈值依赖这个语义；本方法是独立的累计时钟。
   *
   * **也不要用 `SessionMessage.turn`。** 那个字段是消息在当前 live 窗口内的序号
   * （`nextTurn` = `messages.length + 1`），提交之后新消息从 1 重新编号，同样会倒退。
   * 账本要的「会话累计轮次」只有本方法算得出来。
   *
   * **与 `load` 的一处差异（有意）：本方法不检查 `.meta.json`。** `load` 以元数据
   * 是否存在判「会话存在」，这里只读 `messages.jsonl` 与归档元数据。`create` 先写
   * 消息、后写元数据，崩溃留下的空壳（有 `messages.jsonl`、无 `.meta.json`）在
   * `load` 里是 `NOT_FOUND`，在这里能算出 live 条数。调用方只需要「会话不可读时
   * 别让检索失败」，两种判据的差异不影响去重。
   *
   * **崩溃窗口。** `commitPhase1` 在写归档元数据之前就把归档消息 ID 记进进程内索引
   * （见 `#recordArchivedMessages` 的调用点）。那一步之后、元数据落盘之前失败而进程
   * 继续运行时，本方法会多算这一批；重启后从元数据重建则少算，时钟可能回落一批。
   * 只出现在提交失败路径上。
   *
   * **已知限制：会话 `remove` 后用同一 ID 重建，累计数从 0 重来。** 归档索引随
   * `remove` / `create` 一起清掉（见 `#archivedMessageIndex` 的两个删除点），而召回
   * 账本里的条目按 `sessionId` 留着（只有删 user / group 才清）。旧条目在新会话
   * `turn` 追上旧值时，会短暂重新落进去重窗口，压掉新会话从没投过的 URI。修它要
   * 让会话删除依赖账本端口并按会话清账本，为一个边缘场景引入跨服务依赖不划算，
   * 因此记录为限制。
   *
   * 索引是进程内缓存，与 `addMessage` 的幂等索引共用同一个假设：当前架构不支持
   * 多进程写同一个 `dataDir`，否则会漏计已归档消息。
   */
  async totalMessageCount(sessionUri: Uri): Promise<number> {
    const archived = (await this.#loadArchivedMessageIndex(sessionUri)).size;
    const live = (await this.#readMessages(this.#messagesUri(sessionUri))).length;
    return archived + live;
  }

  /**
   * 追加消息。**必须持 `TREE` 锁**（§10.6：`commit` 与 `add_message` 不丢消息）。
   *
   * 轮次时钟由 `nextTurn` 按消息总数算（§8.7），不接受调用方传入。
   *
   * ## 幂等：同一会话内 ID 相同的消息只留一条
   *
   * 采集侧的游标只在消息落盘之后前进（`integrations/lib/cursor.mjs`）：进程被杀、
   * 请求超时、跨进程锁过期时，同一批消息会被重投。重投是**正常恢复路径**，所以
   * 重复提交返回已经落盘的那条消息（保留它原来的 turn），不写正文、不改 turn、
   * 不抛 409。
   *
   * 判据是消息 ID：它由调用方生成（宿主 uuid 或 `stableMessageId`），同一条宿主
   * 消息重投时 ID 不变。空串不是身份——拿它去重会把互不相关的消息合并成一条，
   * 所以在入口拒绝。正文不参与判据：ID 相同就是同一条消息。
   *
   * **已归档的消息也算。** 提交之后消息移进 `history/archive_NNN/`，只查 live 会把
   * 重投的那一批当成新消息再追加一遍。归档消息 ID 在归档元数据的
   * `archivedMessageIds` 里；本服务按会话在进程内缓存「ID → 归档 URI」，每个会话
   * 第一次写入时读一次元数据（不解析归档的 `messages.jsonl`），提交时增量更新。
   * live 的检查没有额外 IO：写路径本来就要把整个 `messages.jsonl` 读出来重写。
   *
   * ## 追加成功时把会话状态改回 `open`
   *
   * `archive()`（空闲过期）把状态置 `archived`，调度器对 `status === 'archived'`
   * 的会话直接跳过（`bootstrap/scheduler.ts` 的 `#autoCommit` 入口）。消息进来了
   * 就是活跃会话：不清状态的话，只依赖自动提交的客户端复用一个已归档会话后，新
   * 消息会一直停在 live、永远不会被归档。状态与 `pendingTokens` 在同一次
   * `writeSession` 里落盘。归档失败不是会话状态（`task.status` 表达它），所以这里
   * 不需要复位别的值。
   *
   * **重复消息不重置状态。** 没有新内容进来，重放一条已经落盘的消息不该让一个
   * 已过期归档的会话重新变活跃；这也保住了「重复提交零写入」的幂等契约。
   */
  async addMessage(
    sessionUri: Uri,
    message: Omit<SessionMessage, 'turn'>,
  ): Promise<SessionMessage> {
    return this.#locks.withLock(sessionUri, 'tree', async () => {
      const meta = await this.#requireSession(sessionUri);
      if (message.id === '') {
        throw new ComemError('INVALID_ARGUMENT', '消息 ID 不能为空。', {
          uri: sessionUri.toString(),
        });
      }
      const messages = await this.#readMessages(this.#messagesUri(sessionUri));
      const existing = messages.find((item) => item.id === message.id);
      if (existing !== undefined) {
        this.#logger.debug('消息已存在，跳过追加。', {
          uri: sessionUri.toString(),
          id: message.id,
          turn: existing.turn,
        });
        return existing;
      }
      const archiveUri = (await this.#loadArchivedMessageIndex(sessionUri)).get(message.id);
      if (archiveUri !== undefined) {
        const original = (await this.#readMessages(this.#messagesUri(archiveUri))).find(
          (item) => item.id === message.id,
        );
        if (original === undefined) {
          throw corruptDocument(
            this.#messagesUri(archiveUri),
            '归档元数据记了这条消息，归档的 messages.jsonl 里却没有',
          );
        }
        this.#logger.debug('消息已归档，跳过追加。', {
          uri: sessionUri.toString(),
          id: message.id,
          archiveUri: archiveUri.toString(),
          turn: original.turn,
        });
        return original;
      }
      const appended: SessionMessage = { ...message, turn: nextTurn(messages) };
      const next = [...messages, appended];
      await this.#store.writeText(this.#messagesUri(sessionUri), serializeMessages(next));
      await this.#meta.writeSession(sessionUri, {
        ...meta,
        // 追加消息把已归档会话重新激活。归档失败不是会话状态：它表达在
        // `task.status` 上，不走这里。
        status: meta.status === 'archived' ? 'open' : meta.status,
        pendingTokens: sumTokens(next),
      });
      await this.#notifyWritten(this.#messagesUri(sessionUri));
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
    this.#archivedMessageIndex.delete(sessionUri.toString());
    // `messages.jsonl` 有索引行（见 `SessionServiceOptions.observer`）：目录删掉之后
    // 不清理的话，`find` / `glob` 会返回一条打不开的记录。
    await this.#notifyRemoved(sessionUri);
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
    // 消息已经在归档里了：重投的同一批不能再落回 live。索引只在本进程有缓存时
    // 更新，没有缓存就等下一次 `addMessage` 从磁盘重建。
    this.#recordArchivedMessages(sessionUri, archiveUri, archived);
    const messagesSha256 = await this.#sha256(this.#messagesUri(archiveUri));
    // 归档目录里的「原始对话」也要是一个可寻址的节点：不建索引行 / 不物化权限，
    // 用户点开归档只看得到元数据（见 `SessionServiceOptions.observer`）。
    await this.#notifyWritten(this.#messagesUri(archiveUri));

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
    await this.#notifyWritten(this.#messagesUri(sessionUri));

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
    this.#recordArchivedMessages(sessionUri, archiveUri, archived);
    // 崩溃可能停在「归档消息写完、索引行没写」之间：补完时把归档节点补上。
    await this.#notifyWritten(this.#messagesUri(archiveUri));
    const live = await this.#readMessages(this.#messagesUri(sessionUri));
    const archivedMessageIds = new Set(archived.map((message) => message.id));
    const retained = live.filter((message) => !archivedMessageIds.has(message.id));

    // 步骤 4 重放：已经归档的消息从 live 里去掉。
    await this.#store.writeText(this.#messagesUri(sessionUri), serializeMessages(retained));
    await this.#notifyWritten(this.#messagesUri(sessionUri));

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

  /**
   * 通知「`messages.jsonl` 已写入」。
   *
   * 与 `FileSystemService.#notifyWritten` 同一时序：先落盘、再通知。观察者失败只记
   * 日志——文件已经是真相，回滚反而丢数据；索引与权限是派生数据，靠对账修复（§7）。
   */
  async #notifyWritten(messagesUri: Uri): Promise<void> {
    const observer = this.#observer;
    if (observer === undefined) {
      return;
    }
    try {
      await observer.onNodeWritten(messagesUri, 'file');
    } catch (error) {
      this.#logger.error('会话消息写入后维护索引失败，已忽略。', {
        uri: messagesUri.toString(),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** 通知「会话目录已删除」。失败语义与 {@link #notifyWritten} 相同。 */
  async #notifyRemoved(sessionUri: Uri): Promise<void> {
    const observer = this.#observer;
    if (observer === undefined) {
      return;
    }
    try {
      await observer.onNodeRemoved(sessionUri);
    } catch (error) {
      this.#logger.error('会话删除后清理索引失败，已忽略。', {
        uri: sessionUri.toString(),
        error: error instanceof Error ? error.message : String(error),
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

  /**
   * 已归档消息 ID → 归档目录 URI。按会话懒加载。
   *
   * 只读归档元数据的 `archivedMessageIds`，不解析归档的 `messages.jsonl`——后者只在
   * 真的重投了一条已归档消息时读一次，用来把原消息（含原 turn）原样返回。
   *
   * 缓存是进程内的。当前架构里同一个会话只有一个写入方（本服务）：hook 的 `Stop`
   * worker 通过 HTTP 回到本进程，`ingest` 命令只写自己新建的随机会话。绕过本服务
   * 手改磁盘会让索引过期，与 `.meta.json` 里 `pendingTokens` 是缓存同一类假设。
   */
  async #loadArchivedMessageIndex(sessionUri: Uri): Promise<Map<string, Uri>> {
    const key = sessionUri.toString();
    const cached = this.#archivedMessageIndex.get(key);
    if (cached !== undefined) {
      return cached;
    }
    const index = new Map<string, Uri>();
    for (const archiveUri of await this.#listArchives(this.#historyUri(sessionUri))) {
      const meta = await this.#meta.readArchive(archiveUri);
      for (const id of meta?.phase1.archivedMessageIds ?? []) {
        index.set(id, archiveUri);
      }
    }
    this.#archivedMessageIndex.set(key, index);
    return index;
  }

  /** 归档写盘之后把消息 ID 记进进程内索引；索引还没建时留给下一次懒加载。 */
  #recordArchivedMessages(
    sessionUri: Uri,
    archiveUri: Uri,
    archived: readonly SessionMessage[],
  ): void {
    const index = this.#archivedMessageIndex.get(sessionUri.toString());
    if (index === undefined) {
      return;
    }
    for (const message of archived) {
      index.set(message.id, archiveUri);
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
