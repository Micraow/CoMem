/**
 * 会话服务的选项与跨文件端口。
 *
 * 这些类型原本与 `SessionService` 同文件。拆开以后，生命周期、追加、阶段一归档三组
 * 函数共用一个显式端口对象；可变状态（`archivedMessageIndex`）不从端口里新建，由
 * `SessionService` 持有后传进来。
 */

import type { ContentStore } from '../../adapters/fs/content-store.js';
import type { PathLockManager } from '../../adapters/fs/lock.js';
import type { MetadataFileStore } from '../../adapters/fs/metadata-file.js';
import type { PermissionRepository } from '../../adapters/sqlite/permission-repository.js';
import type { AutoCommitPolicy, Session } from '../../domain/session.js';
import type { Logger } from '../../domain/log.js';
import type { Uri } from '../../domain/uri.js';

import type { Authorizer } from '../authorizer.js';
import type { NodeWriteObserver } from '../filesystem.js';
import type { TaskService } from '../task.js';

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
   * 会话 `create` 物化了 `node_permission` 行（见 `materializeSessionPermissions`），
   * 而 `node_permission` 没有指向 `node` 的外键级联。删除会话目录之后这些行会留下来
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

/** 已归档消息 ID → 归档目录 URI（按会话）。 */
export type ArchivedMessageIndex = Map<string, Map<string, Uri>>;

/** 生命周期 / 追加 / 归档函数共享的已解析端口。 */
export interface SessionPorts {
  readonly store: ContentStore;
  readonly locks: PathLockManager;
  readonly tasks: TaskService;
  readonly logger: Logger;
  readonly meta: MetadataFileStore;
  readonly autoCommit: AutoCommitPolicy;
  readonly archiveDirectoryName: string;
  readonly authorizer: Authorizer | undefined;
  readonly permissions: Pick<PermissionRepository, 'deleteSubtree'> | undefined;
  readonly observer: Pick<NodeWriteObserver, 'onNodeWritten' | 'onNodeRemoved'> | undefined;
  /** 可变：由 `SessionService` 持有，跨函数只读引用同一份。 */
  readonly archivedMessageIndex: ArchivedMessageIndex;
}

/** 阶段一额外需要读 live 会话；由 `SessionService.load` 提供，避免复制它的语义。 */
export interface ArchivePorts extends SessionPorts {
  readonly loadSession: (sessionUri: Uri) => Promise<Session>;
}
