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
 * ## 这里只写「节点自身那一行」
 *
 * 一个目录在索引里最多两行（§8.5、`0004_node_level_rows.sql`）：L0 行是节点自身
 * 的行（`abstract` = L0 摘要），L1 行是概览正文的附加检索行。观察者只写 L0 行——
 * 它拿不到概览正文（概览由 `SummaryService` 生成、落盘、再写索引），写 L1 行等于
 * 每次 `mkdir` 都把概览抹掉。
 *
 * 两条写入路径的 `level` 必须一致：`SummaryService.#indexRecord` 也写 L0 并保留
 * 已有行的 level，否则第一次生成摘要之后 level 会从 L2 悄悄变成 L0，L1 行也会与
 * 它错位。
 *
 * **移动会丢掉 L1 行**（`onNodeMoved` 按磁盘重建，磁盘上没有「概览已进索引」这件
 * 事）。丢的是派生数据：目标目录的 L0 行同样在这一步被写成空摘要，两条都在下一次
 * 摘要重算时恢复。索引是派生数据（§7），不在移动路径上读摘要文件，是为了让一次
 * 移动不变成 N 次摘要在锁内重新落盘。
 *
 * ## 观察者抛错不能拖垮写操作
 *
 * 文件已经落盘，回滚反而丢数据；派生数据靠对账修复（§7）。`FileSystemService` 已经
 * 捕获了异常，这里**再自己 try/catch** 的目的不是兜底，而是让日志能定位到 URI——
 * 上层只有一个「观察者失败」的泛化消息，串不起是哪条路径。
 *
 * **「靠对账修复」的前提是这条路径自己写对账记录。** 三条失败路径各自留下重放器
 * 看得懂的记录（与 `ResourceService` / `SkillService` 共用 `reconcile-record.ts`）：
 *
 * | 失败 | 记录 | 重放动作 |
 * |---|---|---|
 * | 节点索引行（`#writeIndexRecord`） | `op: 'index'` + 该文件 URI | 从磁盘重建索引行 |
 * | 移动后目标子树批量写（`#writeMovedRecords`） | `op: 'index'` + 每个目标文件 URI | 同上 |
 * | 权限物化（`#materializePermission`） | `op: 'permission'` + 节点 URI | `materializeNode` |
 *
 * 目录型节点的索引行只记日志（重放器只重建文件，目录目标会被判 `not-a-file` 后移出），
 * 所以那条 message 也不写「已记录」。其余不记的形态与原因见架构文档 §10.6「仍然无法
 * 重放的形态」：读盘失败（构造不出记录）、索引**删除**失败（重放器没有「删一条过期行」
 * 这个动作，写了也只能被移出日志）。
 */

import type { ContentStore } from '../adapters/fs/content-store.js';
import type {
  EmbeddingRepository,
  EmbeddingRow,
} from '../adapters/sqlite/embedding-repository.js';
import type { NodeRepository } from '../adapters/sqlite/node-repository.js';
import type { PermissionRepository } from '../adapters/sqlite/permission-repository.js';
import type { Logger } from '../domain/log.js';
import type { ContextType, NodeStatus } from '../domain/node.js';
import { contextTypeOf, isNodeStatus, stableDigest } from '../domain/node.js';
import { parseValidityInstant } from '../domain/retrieval.js';
import type { IndexRecord, RetrievalIndex } from '../domain/retrieval.js';
import { Uri } from '../domain/uri.js';

import type { AclService } from './acl.js';
import type { EmbeddingService } from './embedding.js';
import type { NodeWriteObserver } from './filesystem.js';
import {
  recordIndexFailures,
  recordPermissionFailure,
  type ReconcileLogAppender,
} from './reconcile-record.js';
import type { SummaryService } from './summary.js';

/** 文件是可检索的原文（§8.5 的 L2）；目录是它的 L0 摘要（见文件头）。 */
const DOCUMENT_LEVEL = 'L2';
const DIRECTORY_LEVEL = 'L0';

/** frontmatter 分隔符与 BOM，与 `adapters/fs/frontmatter.ts` 同一套字面量。 */
const FRONTMATTER_DELIMITER = '---';
const BYTE_ORDER_MARK = '\uFEFF';

/** 记忆文件的 frontmatter 键（§6.6、`services/memory.ts` 的序列化格式）。 */
const MEMORY_TYPE_KEY = 'memory_type';
const STATUS_KEY = 'status';
/** 有效区间（W98）：只读，交给 `node.valid_from` / `node.valid_until`。 */
const VALID_FROM_KEY = 'valid_from';
const VALID_UNTIL_KEY = 'valid_until';

/**
 * 嵌入队列的合并窗口，毫秒。
 *
 * **为什么需要窗口而不是 `setImmediate`。** 排期的目的有两个：把嵌入推到
 * `withLock` 的 `finally` 之后（不能在路径锁里打网络），以及**把同一段时间里产生
 * 的记录合成一批**。`setImmediate` 只做到第一个——一次导入是「写一条 → await →
 * 写一条」，每次 `await` 都会让出事件循环，`setImmediate` 的回调在两次写之间就
 * 跑掉了，队列里永远只有一条，「按 `maxBatchSize` 分批」退化成「每条一次请求」。
 * 这正是这个 wave 修的缺陷。
 *
 * **批量收益的主要来源不是这个窗口，是 `#scheduleEmbedding` 里「攒满一批立刻发」
 * 那一条。** 窗口只负责两件事：把并发写入（`Promise.all` 批量提交）攒成一批，
 * 以及在导入的尾巴上把不满一批的余数送出去。窗口调大能让余数等得更久，但**不会**
 * 让稳态的请求数更优——稳态由「攒满即发」决定。
 *
 * 50 毫秒的来源：本机一次写入（`writeText` + 索引 upsert + 物化权限）实测约
 * 12 毫秒（`local/bench/embedding-stage.ts` 的缓存重跑：64 条 788 毫秒），
 * 50 毫秒覆盖约 4 条并发写入的突发。再大只会让「空闲之后的第一条」多等，而嵌入
 * 本来就在写操作的异步阶段（§17.2），不在用户的阻塞路径上。
 *
 * `drain()` 会**提前**触发它，所以测试与 `close()` 不必等满 50 毫秒。
 */
const EMBED_COALESCE_MS = 50;

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
  /**
   * 写失败时追加对账记录（`op: 'index'` / `op: 'permission'`，§10.6）。
   *
   * 必填：内容写路径（`FileSystemService` 的 `write` / `mkdir`、`MemoryService`
   * 的字节写、会话消息落盘）全部经过这里。不注入时失败就只剩一行日志，
   * 「文件在、检索不到」永远不会自愈——那正是这个依赖要修掉的形态。生产装配注入
   * `adapters/fs/reconcile-log.ts` 的实例，与重放器是同一个对象。
   */
  readonly reconcile: ReconcileLogAppender;
  /**
   * 嵌入服务（§8.1 的 `node_embedding`、§17.2 的异步阶段）。
   *
   * 可选是给「只关心检索索引」的调用方（存量测试、只读脚本）留的：不注入就
   * 完全不产生嵌入调用，而不是每次写入都打一次必定降级的网络。生产装配
   * （`bootstrap/container.ts`）总是注入。
   *
   * `maxBatchSize` 与 `available` 是批量排期要用的：前者决定队列怎么切片，后者让
   * 「供应商整体不可用」时不再二分重试（切分只会放大请求数）。
   */
  readonly embedding?: Pick<EmbeddingService, 'embed' | 'model' | 'maxBatchSize' | 'available'>;
  /**
   * 向量仓储。与 `embedding` 成对出现；只注入一个时嵌入阶段整体跳过。
   *
   * 生产装配只在 `providers.embedding.type !== 'disabled'` 时注入：默认配置下
   * `node_embedding` 表根本没有建（`ensureSchema` 也不会跑），注入一个删不掉的
   * 仓储只会让每次删除都记一条 `no such table`。
   */
  readonly embeddings?: EmbeddingRepository;
}

export interface FrontmatterFields {
  readonly memoryType: string | null;
  readonly status: NodeStatus | null;
  /** 有效区间的起点（`valid_from`），UTC 形态；缺键/不可解析时是 `null` = 无界。 */
  readonly validFrom: string | null;
  /** 有效区间的终点（`valid_until`）；`null` = 仍然有效。 */
  readonly validUntil: string | null;
}

/** 没有 frontmatter、或不是记忆文件时的空结果。 */
const EMPTY_FRONTMATTER_FIELDS: FrontmatterFields = {
  memoryType: null,
  status: null,
  validFrom: null,
  validUntil: null,
};

/**
 * 手改的数值标量（`valid_from: 123`）不是时间串。
 *
 * 与 `services/memory.ts` 的 `PLAIN_NUMBER` 同一形态：那边把普通标量解析成
 * number / boolean，这边只有原始字符串，必须自己认出「这一行不是字符串」。不认的
 * 话 `valid_from: 2026` 在这里是字符串 `"2026"`、在 `memory.ts` 是数字 2026（读作
 * 无界）、在 `reindex` 是 YAML 整数 2026（同样无界）——同一份文件出现两个有效期，
 * 而 `reindex` 会把整列覆盖成后者。三处的一致由
 * `tests/integration/services/frontmatter-validity-consistency.test.ts` 对拍。
 */
const PLAIN_NUMBER = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/;

/** frontmatter 的原始标量 → 有效区间。带引号的数字是字符串，不加引号的不是。 */
function parseValidityField(raw: string | undefined): string | null {
  if (raw === undefined) {
    return null;
  }
  if (!raw.startsWith('"') && PLAIN_NUMBER.test(raw)) {
    return null;
  }
  return parseValidityInstant(unquoteScalar(raw));
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
 * 导出给 `services/reconcile.ts`：对账重放从磁盘重建索引行时也必须带 `valid_*`，
 * 否则一次重放会把已失效的历史版本写成「无界」（NULL）——历史版本重新变成有效。
 * 重放不能再写第四份解析器：同一份文件在写路径、`read`、`reindex` 与重放之间必须
 * 给出同一组有效期。
 *
 * `ContentStore.readText` 只把摘要三列映射成 `DocumentFrontmatter`，`memory_type` /
 * `status` 读不出来。而 `services/` 只能 `import type` 引用适配层（§4.2），值导入
 * `parseDocument` 会越界，所以这里按记忆文件的格式（`key: scalar` 一行一个）维护一份
 * 最小解析——与 `services/memory.ts` 的 `parseFrontmatterLines` 同一取舍。
 *
 * 只取四个键（`memory_type` / `status` / `valid_from` / `valid_until`），不追求完整
 * YAML：记忆文件由服务写入，块标量、锚点、多文档都不在支持范围内。解析不出来时
 * 返回 `null`，由调用方决定兜底。
 */
export function parseFrontmatterFields(raw: string): FrontmatterFields {
  const text = raw.startsWith(BYTE_ORDER_MARK) ? raw.slice(BYTE_ORDER_MARK.length) : raw;
  const firstLineBreak = text.indexOf('\n');
  const firstLine = (firstLineBreak < 0 ? text : text.slice(0, firstLineBreak)).replace(/\r$/, '');
  if (firstLine !== FRONTMATTER_DELIMITER || firstLineBreak < 0) {
    return EMPTY_FRONTMATTER_FIELDS;
  }

  const lines = text.slice(firstLineBreak + 1).split('\n');
  const closingIndex = lines.findIndex(
    (line) => line.replace(/\r$/, '') === FRONTMATTER_DELIMITER,
  );
  if (closingIndex < 0) {
    return EMPTY_FRONTMATTER_FIELDS;
  }

  // 存**原始标量**而不是去引号后的值：有效期要区分「`"123"`（字符串）」
  // 与「`123`（数字）」，去引号之后就分不出来了。
  const fields = new Map<string, string>();
  for (const line of lines.slice(0, closingIndex)) {
    const separator = line.indexOf(':');
    if (separator <= 0) {
      continue;
    }
    fields.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
  }

  const scalar = (key: string): string | null => {
    const raw = fields.get(key);
    return raw === undefined ? null : unquoteScalar(raw);
  };

  const memoryType = scalar(MEMORY_TYPE_KEY);
  const status = scalar(STATUS_KEY);
  return {
    memoryType: memoryType === null || memoryType === '' ? null : memoryType,
    status: status !== null && isNodeStatus(status) ? status : null,
    validFrom: parseValidityField(fields.get(VALID_FROM_KEY)),
    validUntil: parseValidityField(fields.get(VALID_UNTIL_KEY)),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 队列里的一条待嵌入记录。
 *
 * `digest` 是 `stableDigest(text)`，进队列时就算好：它既用来「正文没变就跳过」，
 * 也用来把「同一段正文挂在两个 URI 下」合并成一个供应商输入。
 */
interface PendingEmbedding {
  readonly uri: string;
  readonly text: string;
  readonly digest: string;
}

/** 同一份正文对应的所有 URI（一次嵌入写回多行）。 */
interface EmbeddingGroup {
  readonly text: string;
  readonly uris: readonly string[];
}

/** 一批里实际涉及多少个节点（去重后的输入数不等于 URI 数）。 */
function countUris(entries: readonly (readonly [string, EmbeddingGroup])[]): number {
  let total = 0;
  for (const [, group] of entries) {
    total += group.uris.length;
  }
  return total;
}

export class IndexObserver implements NodeWriteObserver {
  readonly #store: ContentStore;
  readonly #index: RetrievalIndex;
  readonly #acl: AclService;
  readonly #summary: SummaryService;
  readonly #nodes: NodeRepository;
  readonly #permissions: Pick<PermissionRepository, 'deleteSubtree'>;
  readonly #logger: Logger;
  readonly #reconcile: ReconcileLogAppender;
  readonly #embedding: Pick<
    EmbeddingService,
    'embed' | 'model' | 'maxBatchSize' | 'available'
  > | undefined;
  readonly #embeddings: EmbeddingRepository | undefined;
  /** 已排期但未完成的摘要失效 / 嵌入任务（见文件头「延后」）。 */
  readonly #pending = new Set<Promise<void>>();
  /** 等待 flush 的嵌入记录。见 `#enqueueEmbedding`。 */
  readonly #embedQueue: PendingEmbedding[] = [];
  /** 合并窗口的定时器；`drain()` 会提前触发它。 */
  #embedTimer: NodeJS.Timeout | null = null;
  /** 正在跑的 flush；同一时刻只有一个（见 `#startEmbeddingFlush`）。 */
  #embedFlush: Promise<void> | null = null;

  constructor(deps: IndexObserverDeps) {
    this.#store = deps.store;
    this.#index = deps.index;
    this.#acl = deps.acl;
    this.#summary = deps.summary;
    this.#nodes = deps.nodes;
    this.#permissions = deps.permissions;
    this.#logger = deps.logger;
    this.#reconcile = deps.reconcile;
    // 两个依赖必须成对：只给一个时嵌入阶段无法完成，整体跳过比半途抛错清楚。
    this.#embedding = deps.embedding;
    this.#embeddings = deps.embeddings;
  }

  async onNodeWritten(uri: Uri, kind: 'file' | 'directory'): Promise<void> {
    try {
      await this.#indexNode(uri, kind);
      await this.#materializeAncestors(uri);
    } catch (error) {
      // 写操作已经成功，异常不能往上传（§7：文件是真相）。索引写失败与权限物化
      // 失败分别由 `#writeIndexRecord` / `#materializePermission` 记了对账记录
      // （重放器都能修）；走到这里的是**读盘失败**——连 `IndexRecord` 都构造不出来，
      // 重放同样没有输入，只能留日志。
      this.#logger.error('节点写入后维护派生数据失败，已忽略。', {
        uri: uri.toString(),
        kind,
        error: errorMessage(error),
      });
    }
  }

  async onNodeRemoved(uri: Uri): Promise<void> {
    const key = uri.toString();
    const details = { uri: key };

    await this.#isolate('节点删除后清理索引失败，已忽略。', details, () =>
      this.#index.deleteByUri(key, { recursive: true }),
    );
    // 物化权限没有外键级联（见 `IndexObserverDeps.permissions`），子树的行要显式删。
    await this.#isolate('节点删除后清理物化权限失败，已忽略。', details, () => {
      this.#permissions.deleteSubtree(key);
    });
    // 向量同理：`node_embedding` 也没有外键，删节点不清理会留下指向不存在
    // 文件的向量行——`find` 会命中一条打不开的记录。
    await this.#isolate('节点删除后清理向量失败，已忽略。', details, () => {
      this.#embeddings?.deleteByUri(key, { recursive: true });
    });

    const parent = uri.parent();
    if (parent === null) {
      return;
    }
    // 父目录的物化行要重算：删掉子项之后，它自己的有效权限可能变了。失败要留
    // `op: 'permission'` 记录——被删节点自己记了也会被重放器按「目标已不存在」
    // 移出，能修的只有父目录。
    await this.#materializePermission(parent);
    // 删子项同样是「父目录的 L0 变了」，摘要要重算（延后到锁释放后）。
    this.#scheduleSummaryInvalidation(parent);
  }

  /**
   * 移动 / 改名后的派生数据重建。
   *
   * `FileSystemService.move` 只调这一个通知。分两次通知（`onNodeRemoved(from)` +
   * `onNodeWritten(to)`）时，子项一条都不会重建：`onNodeRemoved` 把整棵子树的
   * `node` / `node_permission` / `node_embedding` 删掉，`onNodeWritten` 只写回
   * 目标节点自己。移动一个非空目录之后，子文件在磁盘上还在，但 `tree` 只剩一个
   * 空目录、`find` 搜不到、`list` 因为缺 `node_permission` 行返回空——而且不报错。
   *
   * **一次遍历**：目标子树只从磁盘走一遍，索引用**一次** `upsert` 写完
   * （`node` 与 `node_fts` 在同一个事务里）。逐节点调 `onNodeWritten` 会产生
   * N 次索引事务与 N 次摘要失效。
   *
   * **摘要失效只投给源与目标的父目录**（去重后各一次）：子项的正文没有变，把它们
   * 的祖先链全部标脏只会让整条链白算一遍。
   *
   * 每个派生存储各一步 try/catch：默认配置（`providers.embedding.type ===
   * 'disabled'`，`node_embedding` 表不存在）下向量清理必然抛错，一个 try 包住全部
   * 会把物化权限与摘要失效一起跳过（`local/notes/refactor-plan.md` 的 P1-1）。
   */
  async onNodeMoved(from: Uri, to: Uri): Promise<void> {
    const details = { from: from.toString(), to: to.toString() };

    const records = await this.#subtreeRecords(to, details);
    if (records === null) {
      return;
    }

    // 索引：删掉源前缀的整棵子树，再一次性写回目标前缀的整棵子树。**两步分开**，
    // 因为它们的重放语义不同：写失败可以对账（目标文件在磁盘上，重放器能重建），
    // 删失败没有可表达的操作（重放器只会补齐存在的节点，不会删掉一条过期行）。
    const sourceCleared = await this.#isolate(
      '节点移动后删除源子树索引失败，已忽略。',
      details,
      () => this.#index.deleteByUri(details.from, { recursive: true }),
    );
    if (sourceCleared) {
      await this.#writeMovedRecords(records, details);
    }

    // 物化权限：源前缀的行没有外键级联，要显式删；目标前缀逐节点物化。
    await this.#isolate('节点移动后清理源路径的物化权限失败，已忽略。', details, () => {
      this.#permissions.deleteSubtree(details.from);
    });
    // `ContentStore.move` 会 `mkdir -p` 出目标路径的祖先，它们同样没有行。
    await this.#materializeAncestors(to);
    for (const record of records) {
      const uri = Uri.parse(record.uri);
      await this.#materializePermission(uri);
      // 反查表也要按新 URI 重建：`deleteSubtree(from)` 把源子树的 `acl_entry` 删了，
      // 而 `materializeNode` 只写 `node_permission`。少了这一步，删账号时
      // `purgePrincipal` 找不到那个目录，文件里的授权撤不掉，同 ID 重建就继承旧权限。
      //
      // 只处理目录：文件没有自己的 `.acl.json`（§6.7），读它只会多一次必然的
      // ENOENT。目标侧没有文件的节点由 `syncEntriesFromFile` 直接跳过——按文件
      // 为准，没有文件就没有直接授权。
      if (record.kind === 'directory') {
        await this.#isolate(
          '节点移动后重建授权反查失败，已忽略。',
          { uri: record.uri },
          async () => {
            await this.#acl.syncEntriesFromFile(uri);
          },
        );
      }
    }

    // 向量：移动不改正文，旧向量按新 URI 重新挂上，不重新调模型。
    await this.#isolate('节点移动后重挂向量失败，已忽略。', details, () => {
      this.#rekeyEmbeddings(details.from, details.to, records);
    });

    // 摘要失效：源与目标的父目录各一次。同一个父目录只投递一次。
    const parents = new Map<string, Uri>();
    for (const parent of [from.parent(), to.parent()]) {
      if (parent !== null) {
        parents.set(parent.toString(), parent);
      }
    }
    for (const parent of parents.values()) {
      this.#scheduleSummaryInvalidation(parent);
    }
  }

  /**
   * 等全部已排期的摘要失效与嵌入完成。
   *
   * 测试要一个确定点（写完之后摘要到底是「已重算」还是「已标脏」）；`close()` 要它
   * 来保证 `db.close()` 之后没有任务还在写库。
   *
   * **嵌入队列的契约**：返回时队列已空，每个排队项要么写进了 `node_embedding`，
   * 要么已降级（记了日志）。所以这里要**提前触发**合并窗口，而不是等 50 毫秒。
   * 循环里再触发一次是因为 `await` 期间可能又有新的写入进队列。
   */
  async drain(): Promise<void> {
    for (;;) {
      this.#flushEmbeddingsNow();
      if (this.#pending.size === 0) {
        return;
      }
      await Promise.all([...this.#pending]);
    }
  }

  /**
   * 派生数据的一步维护：失败只记这一步的日志，不跳过后续步骤。
   *
   * 一个 `try` 包住「索引 → 权限 → 向量 → 父摘要」时，任何一步抛错都会让后面的
   * 步骤全部跳过，而日志里只有一行泛化消息。默认配置（`providers.embedding.type
   * === 'disabled'`，`node_embedding` 表不存在）正好会踩中：删除节点时向量清理
   * 抛 `no such table`，父目录的物化权限与摘要失效静默丢失。
   */
  async #isolate(
    message: string,
    details: Readonly<Record<string, string>>,
    run: () => Promise<void> | void,
  ): Promise<boolean> {
    try {
      await run();
      return true;
    } catch (error) {
      this.#logger.error(message, { ...details, error: errorMessage(error) });
      return false;
    }
  }

  /**
   * 目标路径整棵子树的索引记录。
   *
   * 从磁盘读（§7：文件是真相），与 `onNodeWritten` 用同一套 `#documentRecord` /
   * `#directoryRecord`，保证移动后的行与「在新路径上写一次」完全一致。
   * `ContentStore.list` 已经跳过临时文件、锁文件与元数据产物，不需要再过滤一遍。
   *
   * 读盘失败时返回 `null` 而不是空数组：空数组会把整棵子树的索引**删掉**再什么
   * 都不写，比保留旧行（至少 `reindex` 能修）更糟。
   */
  async #subtreeRecords(
    root: Uri,
    details: Readonly<Record<string, string>>,
  ): Promise<readonly IndexRecord[] | null> {
    const records: IndexRecord[] = [];
    try {
      await this.#collectRecords(root, records);
    } catch (error) {
      this.#logger.error('节点移动后读取目标子树失败，索引未重建。', {
        ...details,
        error: errorMessage(error),
      });
      return null;
    }
    return records;
  }

  async #collectRecords(uri: Uri, records: IndexRecord[]): Promise<void> {
    const stat = await this.#store.stat(uri);
    if (stat === null) {
      return;
    }
    const contextType = contextTypeOf(uri);
    records.push(
      stat.kind === 'file'
        ? await this.#documentRecord(uri, contextType, stat.size, stat.updatedAt)
        : this.#directoryRecord(uri, contextType, stat.size, stat.updatedAt),
    );
    if (stat.kind !== 'directory') {
      return;
    }
    for (const child of await this.#store.list(uri)) {
      await this.#collectRecords(child.uri, records);
    }
  }

  /**
   * 把源前缀的向量行按目标前缀重新挂上。
   *
   * 移动不改变正文，向量不需要重算（重算要调模型，而且换不出不同的结果）。`vec0`
   * 不支持 UPSERT（见 `EmbeddingRepository.upsert`），所以是「读旧行 → 删旧前缀 →
   * 插新行」，旧 URI 由新 URI 按前缀替换推出来。
   */
  #rekeyEmbeddings(from: string, to: string, records: readonly IndexRecord[]): void {
    const embeddings = this.#embeddings;
    if (embeddings === undefined) {
      return;
    }
    const oldUris = records.map((record) => `${from}${record.uri.slice(to.length)}`);
    const byOldUri = new Map(embeddings.getMany(oldUris).map((row) => [row.uri, row]));

    const rekeyed: EmbeddingRow[] = [];
    for (const [index, record] of records.entries()) {
      const row = byOldUri.get(oldUris[index] ?? '');
      if (row !== undefined) {
        rekeyed.push({ ...row, uri: record.uri });
      }
    }

    embeddings.deleteByUri(from, { recursive: true });
    embeddings.upsert(rekeyed);
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
      await this.#materializePermission(current);
      current = current.parent();
    }
  }

  /**
   * 物化一个节点的权限；失败时留一条 `op: 'permission'` 的记录（§10.6）。
   *
   * 重放器能修这类失败（`AclService.materializeNode` 幂等），所以不再只是日志。
   * `uri` 必须是磁盘上仍然存在的节点：删掉的节点重放器会按「目标已不存在」移出
   * 日志，删除路径因此记父目录（见 `onNodeRemoved`）。
   *
   * 失败**不抛**：后续的权限物化与摘要失效是彼此独立的派生数据，一个节点失败
   * 不该让整条祖先链静默丢行（与 `#writeIndexRecord` 同一个取舍）。
   */
  async #materializePermission(uri: Uri): Promise<void> {
    try {
      await this.#acl.materializeNode(uri);
    } catch (error) {
      const reason = errorMessage(error);
      this.#logger.error('节点权限物化失败，已记录待重放。', {
        uri: uri.toString(),
        error: reason,
      });
      await recordPermissionFailure(
        this.#reconcile,
        this.#logger,
        uri.toString(),
        reason,
        new Date().toISOString(),
      );
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

    await this.#writeIndexRecord(record);
    // 物化要在索引之后：`materializeNode` 从 `node` 表读 kind 决定链的起点。
    await this.#materializePermission(uri);

    // 嵌入是派生数据的派生（§7）：正文变了才重算，且推到锁释放之后（见文件头
    // 「为什么摘要失效要延后到锁释放之后」——嵌入要打网络，更不能在锁里做）。
    if (kind === 'file') {
      this.#scheduleEmbedding(uri, record.content);
    }

    // 摘要失效的目标是父目录：新增 / 修改一个子项（文件或目录）都会改变父目录的 L1
    // 输入。根节点没有父目录，但它自己的 L0 也不需要重算（没有上级摘要用它）。
    const parent = uri.parent();
    if (parent !== null) {
      this.#scheduleSummaryInvalidation(parent);
    }
  }

  /**
   * 写节点自己的索引行；失败时留一条 `op: 'index'` 的对账记录，**不抛出**。
   *
   * **不抛出的原因**是后面还有派生数据要维护：`materializeNode` 不跟着做，节点在
   * `node_permission` 里没有行，权限过滤是纯 SQL 查询——重放补上索引行之后 `find`
   * 仍然搜不到（默认 deny）。`ResourceService` / `SkillService` 的批量路径是同一个
   * 取舍（见它们「索引失败时仍然要物化」的注释）。
   *
   * **只有文件记录对账**：重放器按文件重建索引行（`ReconcileService.#reindex`），
   * 目录目标会被当成 `not-a-file` 移出日志。为目录写一条重放不动的记录，等于把
   * 「修不了」伪装成「已排队」。
   *
   * 精确到 URI：`#indexNode` 每次只写一行，失败的那一行就是 `record.uri`，不存在
   * 「整批失败只知道批里有哪些 URI」的模糊地带。
   */
  async #writeIndexRecord(record: IndexRecord): Promise<void> {
    try {
      await this.#index.upsert([record]);
    } catch (error) {
      const reason = errorMessage(error);
      if (record.kind !== 'document') {
        // 目录行不进对账：重放器只按文件重建，目录目标会被判 `not-a-file` 后移出。
        // 消息里不能说「已记录」——那会让运维在日志里看到一条并不存在的记录。
        this.#logger.error('节点写入后目录索引行写入失败，已忽略。', {
          uri: record.uri,
          error: reason,
        });
        return;
      }
      this.#logger.error('节点写入后索引写入失败，已记录待重放。', {
        uri: record.uri,
        error: reason,
      });
      await recordIndexFailures(
        this.#reconcile,
        this.#logger,
        [record.uri],
        reason,
        new Date().toISOString(),
      );
    }
  }

  /**
   * 移动后目标子树的索引行。
   *
   * 批量 `upsert` 失败时记录的是**目标** URI：`records` 里的 `uri` 就是新位置
   * （源前缀磁盘上已经没有了，记源 URI 会被重放器按「目标已不存在」移出，等于没记）。
   * 只记文件——重放器不重建目录行（见 `#writeIndexRecord`）。
   *
   * 与 `#writeIndexRecord` 一样不抛出：后面的物化权限、向量重挂与摘要失效都还要跑，
   * 否则「移动之后目标子树在磁盘上、在索引里不存在、权限表也空着」会同时发生。
   */
  async #writeMovedRecords(
    records: readonly IndexRecord[],
    details: Readonly<Record<string, string>>,
  ): Promise<void> {
    try {
      await this.#index.upsert(records);
    } catch (error) {
      const reason = errorMessage(error);
      const replayable = records
        .filter((record) => record.kind === 'document')
        .map((record) => record.uri);
      if (replayable.length === 0) {
        this.#logger.error('节点移动后目录索引行写入失败，已忽略。', {
          ...details,
          count: records.length,
          error: reason,
        });
        return;
      }
      this.#logger.error('节点移动后重建索引失败，已记录待重放。', {
        ...details,
        count: records.length,
        documents: replayable.length,
        error: reason,
      });
      await recordIndexFailures(
        this.#reconcile,
        this.#logger,
        replayable,
        reason,
        new Date().toISOString(),
      );
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

  /**
   * 一条记录进嵌入队列。
   *
   * **为什么不在这里直接调模型。** 一次导入是「写一条 → await → 写一条」，
   * 每条各调一次供应商就是「单条 1140ms × N」。集中到 `#flushEmbeddings` 之后，
   * 一个合并窗口里排队的 N 条按 `maxBatchSize` 切成 `ceil(N / maxBatchSize)` 次
   * 请求（见 `EMBED_COALESCE_MS` 的说明）。
   *
   * **为什么先算 digest。** 它同时承担两件事：`node_embedding` 的「正文没变就
   * 跳过」，以及「同一段正文出现在两个 URI 下只嵌一次」（见 `#embedRecords`）。
   *
   * 没配供应商（`type: disabled`，默认值）时静默跳过：这是「不做语义检索」的
   * 正常配置，不是降级。每次写都记 warn 只会把真正的故障淹掉。
   */
  #scheduleEmbedding(uri: Uri, text: string): void {
    const embedding = this.#embedding;
    const embeddings = this.#embeddings;
    if (embedding === undefined || embeddings === undefined || text === '') {
      return;
    }
    if (embedding.model === null) {
      return;
    }

    this.#embedQueue.push({ uri: uri.toString(), text, digest: stableDigest(text) });
    // 已经有 flush 在跑：`#flushEmbeddings` 的循环会吃掉新到的记录。
    if (this.#embedFlush !== null) {
      return;
    }
    // 攒满一批立刻发。这是「N 条记录 → ceil(N / maxBatchSize) 次请求」的直接
    // 来源；只靠定时器时，一次导入会在窗口边界上切出很多不满的批。
    if (this.#embedQueue.length >= embedding.maxBatchSize) {
      this.#flushEmbeddingsNow();
      return;
    }
    // 不满一批：等合并窗口，把零散写入攒成一批。
    if (this.#embedTimer !== null) {
      return;
    }
    this.#embedTimer = setTimeout(() => {
      this.#embedTimer = null;
      this.#startEmbeddingFlush();
    }, EMBED_COALESCE_MS);
  }

  /**
   * 把合并窗口提前到此刻（`drain()` 用）。
   *
   * 没有排期时是空操作；有排期时取消定时器并立刻开始 flush。
   */
  #flushEmbeddingsNow(): void {
    if (this.#embedTimer !== null) {
      clearTimeout(this.#embedTimer);
      this.#embedTimer = null;
    }
    this.#startEmbeddingFlush();
  }

  /**
   * 启动一次 flush。同一时刻只有一个。
   *
   * 任务进 `#pending`，`drain()` 因此能等它；失败的日志要带得上「哪一批」，所以
   * 这里只兜住「flush 自己抛了」——**单个记录**的失败在 `#embedChunk` 里已经
   * 降级成日志，不会再往上抛。
   */
  #startEmbeddingFlush(): void {
    if (this.#embedFlush !== null || this.#embedQueue.length === 0) {
      return;
    }
    const task = this.#flushEmbeddings();
    this.#embedFlush = task;
    this.#pending.add(task);
    void task.then(
      () => {
        this.#pending.delete(task);
      },
      (error: unknown) => {
        this.#pending.delete(task);
        this.#logger.error('嵌入批次失败，已忽略。', { error: errorMessage(error) });
      },
    );
  }

  /**
   * 排空队列。
   *
   * 循环是必需的：`await` 期间写路径可能继续入队（`#scheduleEmbedding` 看到
   * `#embedFlush !== null` 就不会再开定时器，只能由这里接着吃）。`finally` 里清
   * `#embedFlush` 而不是在 `.then` 里清，是为了让「while 退出」与「允许新 flush」
   * 之间没有 await——否则这段时间入队的记录会永远留在队列里。
   */
  async #flushEmbeddings(): Promise<void> {
    try {
      while (this.#embedQueue.length > 0) {
        const records = this.#embedQueue.splice(0, this.#embedQueue.length);
        await this.#embedRecords(records);
      }
    } finally {
      this.#embedFlush = null;
    }
  }

  /**
   * 把一批记录按 `maxBatchSize` 切片交给供应商。
   *
   * 两步去重，各解决一件事：
   *
   * 1. **按 URI 去重**：`node_embedding` 里已经是同一个 `(model, contentDigest)`
   *    的节点不用重嵌——重复写同一份正文不该重复调模型。
   * 2. **按 digest 去重**：同一段正文挂在两个 URI 下时只占一个输入位，结果写回
   *    两行。这是「两个 URI 共享正文」从「嵌两次」变成「嵌一次」的地方。
   *
   * 去重之后才切片：切的是**供应商真正要看的输入数**，不是记录数。
   */
  async #embedRecords(records: readonly PendingEmbedding[]): Promise<void> {
    const embedding = this.#embedding;
    const embeddings = this.#embeddings;
    const model = embedding?.model;
    if (embedding === undefined || embeddings === undefined || model === null || model === undefined) {
      return;
    }

    const existing = new Map(
      embeddings.getMany(records.map((record) => record.uri)).map((row) => [row.uri, row]),
    );
    const groups = new Map<string, { text: string; uris: string[] }>();
    for (const record of records) {
      const row = existing.get(record.uri);
      if (row !== undefined && row.model === model && row.contentDigest === record.digest) {
        continue;
      }
      const group = groups.get(record.digest);
      if (group === undefined) {
        groups.set(record.digest, { text: record.text, uris: [record.uri] });
      } else {
        group.uris.push(record.uri);
      }
    }

    const entries = [...groups.entries()];
    const batchSize = embedding.maxBatchSize;
    for (let start = 0; start < entries.length; start += batchSize) {
      await this.#embedChunk(entries.slice(start, start + batchSize), model);
    }
  }

  /**
   * 一次供应商调用。**失败隔离**在这里。
   *
   * 顺序靠 `#embedding.embed` 的契约保证：`vectors[i]` 与 `texts[i]` 一一对应
   * （供应商返回的 `data[].index` 由 `adapters/llm/embedding-provider.ts` 的
   * `embedMany` 按 `index` 排好，不假设响应数组顺序）。所以这里按下标写回，
   * 不需要在服务层再对一次。
   *
   * 失败隔离分两种：
   *
   * - **整批降级**（供应商挂了、限流、超时）：这一批的记录跳过，记一条 warn。
   *   其它批不受影响，这与批量之前「一条失败只影响它自己」的语义在**批**这一级
   *   上一致。
   * - **单条坏输入**（超长、非法字符，供应商回 400）：不能让它把同批 64 条一起
   *   丢掉。降级时**二分重试**，把失败收敛到那条记录自己；剩下的一半照常写入。
   *
   * 二分不会放大请求数：供应商整体不可用时 `embedding.available` 会转成 `false`
   * （熔断打开且仍在冷却），下面的前置判断让整棵子树直接跳过，不打网络。所以
   * 「供应商挂了」最多打出 `FAILURE_THRESHOLD` 次（5 次）真实请求，而不是
   * `2N - 1` 次。
   */
  async #embedChunk(
    entries: readonly (readonly [string, EmbeddingGroup])[],
    model: string,
  ): Promise<void> {
    const embedding = this.#embedding;
    const embeddings = this.#embeddings;
    if (embedding === undefined || embeddings === undefined || entries.length === 0) {
      return;
    }

    if (!embedding.available) {
      this.#logger.warn('嵌入不可用，跳过本批记录', {
        records: countUris(entries),
        reason: '熔断打开或未配置供应商。',
      });
      return;
    }

    const outcome = await embedding.embed(entries.map(([, group]) => group.text));
    if (!outcome.degraded) {
      const rows: EmbeddingRow[] = [];
      for (const [offset, entry] of entries.entries()) {
        const [digest, group] = entry;
        const vector = outcome.vectors[offset];
        if (vector === undefined) {
          continue;
        }
        for (const uri of group.uris) {
          rows.push({ uri, model, contentDigest: digest, vector });
        }
      }
      if (rows.length > 0) {
        embeddings.upsert(rows);
        this.#logger.debug('嵌入写入', { records: rows.length });
      }
      return;
    }

    // 一条坏输入不能拖掉整批：二分重试，让失败收敛到它自己。
    if (entries.length > 1) {
      const middle = Math.ceil(entries.length / 2);
      await this.#embedChunk(entries.slice(0, middle), model);
      await this.#embedChunk(entries.slice(middle), model);
      return;
    }

    const only = entries[0];
    this.#logger.warn('嵌入降级，跳过写入', {
      uris: only?.[1].uris ?? [],
      reason: outcome.reason ?? '没有返回向量。',
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
      // 有效期从 frontmatter 读，**不做「保留索引旧值」的兜底**：缺键 / 不可解析
      // 就是无界。保留旧值会让一条删掉 `valid_until` 的记忆永远停在旧终点上，
      // 而「缺键 = 一直有效」是这一步的约定。
      validFrom: fields.validFrom,
      validUntil: fields.validUntil,
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
      // 目录自身这一行的可检索文本是它的 L0 摘要，由 `SummaryService` 写；目录本身
      // 没有正文。概览正文走另一行（L1，见文件头），这里写空不会碰到它：
      // `upsert` 的冲突键是 `(uri, level)`。
      abstract: null,
      content: '',
      bodyDigest: stableDigest(''),
      size,
      updatedAt,
      status: existing?.status ?? 'active',
    };
  }

  /**
   * 记忆文件的 `memory_type` / `status` / `valid_from` / `valid_until`。
   *
   * 只有 `contextType === 'memory'` 的文件才有这几个键，其它文件连原始字节都不用
   * 再读一遍——`readText` 已经把正文与摘要拿回来了。
   */
  async #readFrontmatterFields(uri: Uri, contextType: ContextType): Promise<FrontmatterFields> {
    if (contextType !== 'memory') {
      return EMPTY_FRONTMATTER_FIELDS;
    }
    const bytes = await this.#store.readBytes(uri);
    return parseFrontmatterFields(Buffer.from(bytes).toString('utf8'));
  }
}
