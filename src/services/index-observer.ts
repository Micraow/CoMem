/**
 * 节点写入后的索引维护（Observer 模式，架构文档 §9.3、§12.3）。
 *
 * `FileSystemService` 是内容的唯一写入口，`node` / `node_fts` / `node_permission` 都是
 * 派生数据（§7：文件是真相，索引是派生）。节点落盘后必须通知它们，否则「写成功了
 * 但读不到」。
 *
 * ## 三件事
 *
 * 1. **写检索索引**（`index.upsert`）——不写检索看不到；
 * 2. **物化权限**（`acl.materializeNode`）——不物化则默认 deny，节点对所有人不可见；
 * 3. **摘要失效**（`summary.markStale`）——正文变了，父目录摘要要重算。
 *
 * ## 为什么从磁盘读回，不用调用方的参数
 *
 * `write` / `mkdir` 的入参只是「请求」，写成功之后磁盘才是真相：`write` 会在正文
 * 前面拼回 frontmatter，`mkdir` 会把父目录一并建出来。用入参构造 `IndexRecord` 等于
 * 索引里存一份调用方以为的内容，`bodyDigest` 与 `SummaryService.#bodyDigest` 的
 * 比较会永远不等，每次写都触发一次假失效。
 *
 * ## 为什么用 `markStale` 而不是 `invalidate`
 *
 * 这一步的顺序是「写索引 → 物化权限 → 摘要失效」。等摘要失效被调用时，索引里已经是
 * 新的 `body_digest` 了，`invalidate` 的「正文没变不传播」比较必然相等，整条传播链
 * 会被**静默跳过**——文件写了、目录摘要永远不重算，而且不报错。`markStale` 跳过这个
 * 比较，直接按「内容确实变了」传播。W6 的批量路径踩过同一个坑，见
 * `local/notes/decisions.md`「批量写入的摘要失效必须用 markStale」。
 *
 * ## 为什么摘要失效要延后到锁释放之后
 *
 * `onNodeWritten` / `onNodeRemoved` 是在 `FileSystemService` 的**路径锁里面**被调用的
 * （`write` 持文件的 `EXACT`、`mkdir` / `remove` 持 `TREE`）。摘要生成自己也要拿目录的
 * `EXACT` 锁，而 `TREE` 与同路径 / 祖先路径的 `EXACT` 互斥（§10.6）——同步调用会自己
 * 等自己 5 秒然后 `CONFLICT`。W6 的批量路径也踩过：`ResourceService` / `SkillService`
 * 都是「锁释放后再投递摘要失效」。
 *
 * 所以摘要失效用 `setImmediate` 推到当前宏任务的微任务队列之后（那时 `withLock` 的
 * `finally` 已经释放锁），并记进 `#pending`：`drain()` 给测试与 `close()` 一个确定的
 * 汇合点。归档 / 抽取 / 合并 / 摘要本来就算**异步阶段**（§17.2），不占阻塞开销。
 *
 * ## 目录行的 `level` 是 L0
 *
 * 目录没有 L2 正文，它可检索的文本就是 L0 摘要（§8.1）。`SummaryService` 的
 * `#indexRecord` 也用 L0 并保留已有行的 level，两边必须一致，否则第一次生成摘要
 * 之后 level 会从 L2 悄悄变成 L0。
 *
 * ## 观察者抛错不能拖垮写操作
 *
 * 文件已经落盘，回滚反而丢数据；派生数据靠对账修复（§7）。`FileSystemService` 已经
 * 捕获了异常，这里**再自己 try/catch** 的目的不是兜底，而是让日志能定位到 URI——
 * 上层只有一个「观察者失败」的泛化消息，串不起是哪条路径。
 */

import type { ContentStore } from '../adapters/fs/content-store.js';
import type { NodeRepository } from '../adapters/sqlite/node-repository.js';
import type { PermissionRepository } from '../adapters/sqlite/permission-repository.js';
import type { Logger } from '../domain/log.js';
import type { ContextType, NodeStatus } from '../domain/node.js';
import { stableDigest } from '../domain/node.js';
import type { IndexRecord, RetrievalIndex } from '../domain/retrieval.js';
import type { Uri } from '../domain/uri.js';

import type { AclService } from './acl.js';
import type { NodeWriteObserver } from './filesystem.js';
import type { SummaryService } from './summary.js';

/** §6.5 的四个上下文目录名（复数）→ §8.1 的 `context_type`（单数）。 */
const CONTEXT_TYPE_BY_DIRECTORY: Readonly<Record<string, ContextType>> = {
  memories: 'memory',
  resources: 'resource',
  skills: 'skill',
  sessions: 'session',
};

/**
 * 认不出的目录按 `resource` 处理（与 `SummaryService.contextTypeOf` 同一份兜底）。
 *
 * 为什么不是 `memory`：`memory` 会进复核闸门与记忆合并的输入，一个普通的
 * `projects/` 目录被当成记忆比被当成资料更危险。
 */
const DEFAULT_CONTEXT_TYPE: ContextType = 'resource';

/** 文件是可检索的原文（§8.5 的 L2）；目录是它的 L0 摘要（见文件头）。 */
const DOCUMENT_LEVEL = 'L2';
const DIRECTORY_LEVEL = 'L0';

/** frontmatter 分隔符与 BOM，与 `adapters/fs/frontmatter.ts` 同一套字面量。 */
const FRONTMATTER_DELIMITER = '---';
const BYTE_ORDER_MARK = '\uFEFF';

/** 记忆文件的 frontmatter 键（§6.6、`services/memory.ts` 的序列化格式）。 */
const MEMORY_TYPE_KEY = 'memory_type';
const STATUS_KEY = 'status';

export interface IndexObserverDeps {
  readonly store: ContentStore;
  readonly index: RetrievalIndex;
  readonly acl: AclService;
  readonly summary: SummaryService;
  readonly nodes: NodeRepository;
  /**
   * 删除时清掉子树的物化权限行。
   *
   * 任务草图里没有这一项，但 `AclService.materializeNode(parent)` 只重写父节点自己的
   * 行（`PermissionRepository.replaceNode`），被删节点的 `node_permission` 行会留下来
   * ——那张表没有指向 `node` 的外键级联。删一行权限要靠 `deleteSubtree`。
   */
  readonly permissions: Pick<PermissionRepository, 'deleteSubtree'>;
  readonly logger: Logger;
}

interface FrontmatterFields {
  readonly memoryType: string | null;
  readonly status: NodeStatus | null;
}

function isNodeStatus(value: string): value is NodeStatus {
  return value === 'active' || value === 'pending' || value === 'archived';
}

/** 去掉成对的双引号（`services/memory.ts` 只在需要时加双引号 + JSON 转义）。 */
function unquoteScalar(value: string): string {
  if (value.length < 2 || !value.startsWith('"') || !value.endsWith('"')) {
    return value;
  }
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === 'string' ? parsed : value;
  } catch {
    return value;
  }
}

/**
 * 从原始文件内容里取记忆文件的 frontmatter 字段。
 *
 * `ContentStore.readText` 只把摘要三列映射成 `DocumentFrontmatter`，`memory_type` /
 * `status` 读不出来。而 `services/` 只能 `import type` 引用适配层（§4.2），值导入
 * `parseDocument` 会越界，所以这里按记忆文件的格式（`key: scalar` 一行一个）维护一份
 * 最小解析——与 `services/memory.ts` 的 `parseFrontmatterLines` 同一取舍。
 *
 * 只取两个键，不追求完整 YAML：记忆文件由服务写入，块标量、锚点、多文档都不在
 * 支持范围内。解析不出来时返回 `null`，由调用方决定兜底。
 */
function parseFrontmatterFields(raw: string): FrontmatterFields {
  const text = raw.startsWith(BYTE_ORDER_MARK) ? raw.slice(BYTE_ORDER_MARK.length) : raw;
  const firstLineBreak = text.indexOf('\n');
  const firstLine = (firstLineBreak < 0 ? text : text.slice(0, firstLineBreak)).replace(/\r$/, '');
  if (firstLine !== FRONTMATTER_DELIMITER || firstLineBreak < 0) {
    return { memoryType: null, status: null };
  }

  const lines = text.slice(firstLineBreak + 1).split('\n');
  const closingIndex = lines.findIndex(
    (line) => line.replace(/\r$/, '') === FRONTMATTER_DELIMITER,
  );
  if (closingIndex < 0) {
    return { memoryType: null, status: null };
  }

  const fields = new Map<string, string>();
  for (const line of lines.slice(0, closingIndex)) {
    const separator = line.indexOf(':');
    if (separator <= 0) {
      continue;
    }
    fields.set(
      line.slice(0, separator).trim(),
      unquoteScalar(line.slice(separator + 1).trim()),
    );
  }

  const memoryType = fields.get(MEMORY_TYPE_KEY);
  const status = fields.get(STATUS_KEY);
  return {
    memoryType: memoryType === undefined || memoryType === '' ? null : memoryType,
    status: status !== undefined && isNodeStatus(status) ? status : null,
  };
}

/** §6.3：`projects/{pid}/` 先剥一层，再按段名推 `context_type`。 */
function contextTypeOf(uri: Uri): ContextType {
  const segments = uri.segments[0] === 'projects' ? uri.segments.slice(2) : uri.segments;
  const head = segments[0];
  if (head === undefined) {
    return DEFAULT_CONTEXT_TYPE;
  }
  return CONTEXT_TYPE_BY_DIRECTORY[head] ?? DEFAULT_CONTEXT_TYPE;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class IndexObserver implements NodeWriteObserver {
  readonly #store: ContentStore;
  readonly #index: RetrievalIndex;
  readonly #acl: AclService;
  readonly #summary: SummaryService;
  readonly #nodes: NodeRepository;
  readonly #permissions: Pick<PermissionRepository, 'deleteSubtree'>;
  readonly #logger: Logger;
  /** 已排期但未完成的摘要失效任务（见文件头「延后」）。 */
  readonly #pending = new Set<Promise<void>>();

  constructor(deps: IndexObserverDeps) {
    this.#store = deps.store;
    this.#index = deps.index;
    this.#acl = deps.acl;
    this.#summary = deps.summary;
    this.#nodes = deps.nodes;
    this.#permissions = deps.permissions;
    this.#logger = deps.logger;
  }

  async onNodeWritten(uri: Uri, kind: 'file' | 'directory'): Promise<void> {
    try {
      await this.#indexNode(uri, kind);
      await this.#materializeAncestors(uri);
    } catch (error) {
      // 写操作已经成功，异常不能往上传（§7：派生数据靠对账修复）。URI 进日志是
      // 为了让「哪条路径没进索引」可查。
      this.#logger.error('节点写入后维护索引失败，已忽略。', {
        uri: uri.toString(),
        kind,
        error: errorMessage(error),
      });
    }
  }

  async onNodeRemoved(uri: Uri): Promise<void> {
    try {
      await this.#index.deleteByUri(uri.toString(), { recursive: true });
      // 物化权限没有外键级联（见 `IndexObserverDeps.permissions`），子树的行要显式删。
      this.#permissions.deleteSubtree(uri.toString());

      const parent = uri.parent();
      if (parent !== null) {
        // 父目录的物化行要重算：删掉子项之后，它自己的有效权限可能变了。
        await this.#acl.materializeNode(parent);
        // 删子项同样是「父目录的 L0 变了」，摘要要重算（延后到锁释放后）。
        this.#scheduleSummaryInvalidation(parent);
      }
    } catch (error) {
      this.#logger.error('节点删除后清理索引失败，已忽略。', {
        uri: uri.toString(),
        error: errorMessage(error),
      });
    }
  }

  /**
   * 等全部已排期的摘要失效完成。
   *
   * 测试要一个确定点（写完之后摘要到底是「已重算」还是「已标脏」）；`close()` 要它
   * 来保证 `db.close()` 之后没有任务还在写库。
   */
  async drain(): Promise<void> {
    while (this.#pending.size > 0) {
      await Promise.all([...this.#pending]);
    }
  }

  /**
   * 一个节点的索引行。
   *
   * `stat` 为 `null` 说明写完之后节点已经不在了（并发删除、或名字是产物），按删除
   * 处理：留一行指向不存在文件的索引，`read` 会 404，而 `find` 会命中一条打不开的
   * 记录——两者都不如直接清掉。
   */
  /**
   * 给磁盘上刚被自动建出来的祖先目录补物化权限。
   *
   * `ContentStore.writeText` 写 `.../memories/preferences/code-style.md` 时会顺手
   * `mkdir -p` 出 `memories/` 和 `preferences/`，但观察者只收到文件 URI。这两个目录
   * 因此没有 `node_permission` 行，而 `filterReadable` 是纯 SQL 查询——它们会在
   * `list` / `tree` 里**整个消失**，用户看到的目录树是断的。
   *
   * 逐级 `materializeNode` 是幂等的（行已存在就是覆盖成同样的值），代价是每次写
   * 多 O(depth) 条 UPSERT。depth 通常 3–6，换「目录树不断」是划算的。
   */
  async #materializeAncestors(uri: Uri): Promise<void> {
    let current = uri.parent();
    while (current !== null) {
      await this.#acl.materializeNode(current);
      current = current.parent();
    }
  }

  async #indexNode(uri: Uri, kind: 'file' | 'directory'): Promise<void> {
    const stat = await this.#store.stat(uri);
    if (stat === null) {
      this.#logger.warn('节点写入后已不可寻址，按删除清理索引。', { uri: uri.toString() });
      await this.#index.deleteByUri(uri.toString(), { recursive: true });
      this.#permissions.deleteSubtree(uri.toString());
      return;
    }

    const contextType = contextTypeOf(uri);
    const record =
      kind === 'file'
        ? await this.#documentRecord(uri, contextType, stat.size, stat.updatedAt)
        : this.#directoryRecord(uri, contextType, stat.size, stat.updatedAt);

    await this.#index.upsert([record]);
    // 物化要在索引之后：`materializeNode` 从 `node` 表读 kind 决定链的起点。
    await this.#acl.materializeNode(uri);

    // 摘要失效的目标是父目录：新增 / 修改一个子项（文件或目录）都会改变父目录的 L1
    // 输入。根节点没有父目录，但它自己的 L0 也不需要重算（没有上级摘要用它）。
    const parent = uri.parent();
    if (parent !== null) {
      this.#scheduleSummaryInvalidation(parent);
    }
  }

  /**
   * 排期一次摘要失效。见文件头「为什么延后」。
   *
   * 失败只记日志：摘要失效是派生数据的后台维护，不能反过来让写操作失败。
   */
  #scheduleSummaryInvalidation(directory: Uri): void {
    const task = new Promise<void>((resolve) => {
      // `setImmediate` 而不是 `queueMicrotask`：`withLock` 的 `finally` 在微任务里
      // 释放锁，微任务会排在它前面。
      setImmediate(resolve);
    })
      .then(() => this.#summary.markStale(directory))
      .then(
        () => undefined,
        (error: unknown) => {
          this.#logger.error('摘要失效投递失败，已忽略。', {
            directory: directory.toString(),
            error: errorMessage(error),
          });
        },
      );
    this.#pending.add(task);
    void task.then(() => {
      this.#pending.delete(task);
    });
  }

  async #documentRecord(
    uri: Uri,
    contextType: ContextType,
    size: number,
    updatedAt: string,
  ): Promise<IndexRecord> {
    const document = await this.#store.readText(uri);
    const fields = await this.#readFrontmatterFields(uri, contextType);
    const existing = this.#nodes.get(uri.toString());

    return {
      uri: uri.toString(),
      parentUri: uri.parent()?.toString() ?? '',
      scope: uri.scope,
      kind: 'document',
      contextType,
      // frontmatter 是记忆类型的唯一真相；读不出来时保留索引里的旧值（重写一个
      // 没有 frontmatter 的文件不应该把 memory_type 抹掉）。
      memoryType: fields.memoryType ?? existing?.memoryType ?? null,
      level: DOCUMENT_LEVEL,
      abstract: document.frontmatter?.summary ?? null,
      content: document.text,
      bodyDigest: stableDigest(document.text),
      size,
      updatedAt,
      // 复核闸门（§11.6）在 frontmatter 的 status 上；没有就是 active。
      status: fields.status ?? existing?.status ?? 'active',
    };
  }

  #directoryRecord(
    uri: Uri,
    contextType: ContextType,
    size: number,
    updatedAt: string,
  ): IndexRecord {
    const existing = this.#nodes.get(uri.toString());
    return {
      uri: uri.toString(),
      parentUri: uri.parent()?.toString() ?? '',
      scope: uri.scope,
      kind: 'directory',
      contextType: existing?.contextType ?? contextType,
      memoryType: existing?.memoryType ?? null,
      level: DIRECTORY_LEVEL,
      // 目录的可检索文本是它的 L0 摘要，由 `SummaryService` 写；目录本身没有正文。
      abstract: null,
      content: '',
      bodyDigest: stableDigest(''),
      size,
      updatedAt,
      status: existing?.status ?? 'active',
    };
  }

  /**
   * 记忆文件的 `memory_type` / `status`。
   *
   * 只有 `contextType === 'memory'` 的文件才有这两个键，其它文件连原始字节都不用
   * 再读一遍——`readText` 已经把正文与摘要拿回来了。
   */
  async #readFrontmatterFields(uri: Uri, contextType: ContextType): Promise<FrontmatterFields> {
    if (contextType !== 'memory') {
      return { memoryType: null, status: null };
    }
    const bytes = await this.#store.readBytes(uri);
    return parseFrontmatterFields(Buffer.from(bytes).toString('utf8'));
  }
}
