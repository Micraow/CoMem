/**
 * 摘要服务：生成与失效（架构文档 §9.1–§9.3、§7）。
 *
 * 三层摘要里 L0 / L1 是**目录级**的：目录的 `.abstract.md` / `.overview.md` 由这一层
 * 生成，目录的正文就是它的 L0 摘要（`Directory.digest()`）。文件级摘要跟着文件自己的
 * frontmatter 走（§6.7），由 `ContentStore` 维护，本服务只在生成父目录 L1 时把索引里的
 * `abstract` 读出来（§9.1「文件摘要存在索引记录的 abstract 字段里，作为生成父目录 L1
 * 的输入」）。
 *
 * ## 生成（§9.2）
 *
 * 自底向上：叶子目录 → 父目录 → … → `rootUri`。一个目录的 L1 输入是「直接子文件的
 * 摘要」+「直接子目录的 L0 正文」。**L0 从 L1 提取**（`extractAbstract`），不让模型
 * 分别生成两层——两层各写一遍必然互相矛盾。
 *
 * `SummaryGenerator` 是 Strategy：`LlmSummarizer` 调模型，`RuleSummarizer` 断网降级，
 * 由装配方按 `summary.generator` 配置选择（§18）。降级不是静默的：`degraded` 写进
 * `.abstract.md` / `.overview.md` 的 frontmatter，控制台的「监控」页与 `health` 工具
 * 读它（§9.2、§17.9）。
 *
 * ## 失效（§9.3）
 *
 * 只增量失效，不全量重算。写节点 N 之后：算 N 的正文 digest，与索引里记录的
 * `body_digest` 比较——**一致就到此为止**，正文没变不传播。变化了才给
 * `P = parent(N)` 的计数器加一，再按四个条件判定「立刻重算」还是「只记脏」。
 * 重算 P 之后如果 P 的 L0 也变了，对 `parent(P)` 重复。到达 scope 根停止。
 *
 * 「事件计数」而不是「脏标记」：同一个文件反复改，脏标记只算一次，永远到不了阈值。
 * 消费时**减**而不是清零：生成期间可能又有新改动进来（`consumeChanges`）。
 *
 * ## 写盘顺序与崩溃恢复
 *
 * 先写摘要文件（真相），再在一个事务里写索引行与新鲜度列（缓存）。理由与 §7 一致：
 * 索引永远能从文件重建，反过来不成立。窗口期（文件 rename 成功、事务提交之前进程
 * 挂掉）的后果是 `summary_baseline` 落后于摘要文件：该目录会被判定为「摘要基于旧
 * 正文」，下一次 `invalidate` / `regenerate` 重算即可修复，不丢数据。
 *
 * ## 并发
 *
 * 每个目录一把 `EXACT` 锁（`PathLockManager`）：`rm -r` 拿的是 `TREE` 锁，两边
 * 互斥，否则后台写摘要与递归删除会同时改同一个目录。`locks` 省略时不加锁
 * （纯内存测试、单进程一次性重建）；**生产装配必须传**，否则这条互斥不成立。
 *
 * **锁内不得跨越慢操作**（§10.6）：`generator.generate` 是一次 7–9 秒的模型调用，
 * 不能放在 `EXACT` 锁里，否则锁持有时间放大 1000 倍，并发的 `tree` 锁会在 5 秒后
 * `CONFLICT`（W83 实测）。所以 `#invalidateDirectory` 拆成「锁内判定 → 锁外生成 →
 * 锁内写回」三段，中间只留下「摘要可能比内容旧一拍」这一可接受竞态（见该方法注释）。
 *
 * ## 为什么事务不调用 `withWriteTransaction`
 *
 * 那是 `adapters/sqlite/database.ts` 的**值**导出，而 `services/` 只允许 `import type`
 * 引用适配层（§4.2）。这里用最小结构端口 `SummaryDatabase` 自己开 `BEGIN IMMEDIATE`，
 * `SqliteFtsIndex.upsert` 检测到外层已有事务会直接复用，所以索引行与新鲜度列仍在
 * 同一个事务里。
 *
 * 事务体里有一次 `await`（`upsert` 是 async 方法）。它的实现是同步的，`await` 只让出
 * 一个微任务；同一目录的重算由 EXACT 锁串行化。跨服务的事务若恰好落在这个微任务
 * 窗口里，会加入本事务——SQLite 单连接本来就是单写者，失败方向是可自愈的（见上），
 * 这里不为它引入跨服务写队列。
 */

import type { ContentStore } from '../adapters/fs/content-store.js';
import type { PathLockManager } from '../adapters/fs/lock.js';
import type { MetadataFileStore } from '../adapters/fs/metadata-file.js';
import type { NodeRepository, NodeRow } from '../adapters/sqlite/node-repository.js';
import type { SqliteFtsIndex } from '../adapters/sqlite/retrieval-index.js';
import type { Logger } from '../domain/log.js';
import { contextTypeOf, isVersionFile, stableDigest, type NodeKind } from '../domain/node.js';
import type { IndexRecord } from '../domain/retrieval.js';
import {
  ABSTRACT_MAX_CHARS,
  DEFAULT_FRESHNESS_THRESHOLDS,
  OVERVIEW_MAX_CHARS,
  consumeChanges,
  extractAbstract,
  recordChange,
  shouldRecompute,
  truncateToChars,
  type DirectorySummary,
  type FreshnessThresholds,
  type SummaryChild,
  type SummaryFreshness,
  type SummaryGenerator,
  type SummaryInput,
} from '../domain/summary.js';
import type { Uri } from '../domain/uri.js';

import type { AclService } from './acl.js';
import type { LlmService } from './llm.js';
import { buildSummaryPrompt } from './prompts/summarize.js';

/**
 * `services/` 不能 import `node:sqlite`（§4.2，连类型导入都算依赖）。
 *
 * 这里只声明本服务用到的最小形状：新鲜度三列在 `node` 表上，读一行、写一行。
 * `DatabaseSync` 结构上可赋值。与 `AclService` 的 `AclDatabase` 同一做法。
 */
export interface SummaryDatabase {
  readonly isTransaction: boolean;
  exec(sql: string): void;
  prepare(sql: string): {
    get(...params: unknown[]): Record<string, unknown> | undefined;
    run(...params: unknown[]): { readonly changes: number | bigint };
  };
}

export interface SummaryServiceConfig {
  /** L0 正文预算（§9.1 的 256 字符，默认 `ABSTRACT_MAX_CHARS`） */
  readonly abstractMaxChars: number;
  /** L1 正文预算（§9.1 的 4000 字符，默认 `OVERVIEW_MAX_CHARS`） */
  readonly overviewMaxChars: number;
  /** §9.3 的两个阈值；省略时用 `DEFAULT_FRESHNESS_THRESHOLDS`（同一份默认值） */
  readonly freshness?: FreshnessThresholds;
}

export interface SummaryServiceDeps {
  readonly nodes: NodeRepository;
  readonly index: SqliteFtsIndex;
  readonly metadata: MetadataFileStore;
  readonly store: ContentStore;
  /**
   * 新鲜度列在 `node` 表上，本服务直接读写它（见 `SummaryDatabase`）。
   *
   * 为什么不让 `NodeRepository` 代劳：`services/` 只能 `import type` 引用适配层，
   * 而 `NodeRepository` 没有暴露新鲜度方法，也不应该为一个服务加四个转发方法。
   */
  readonly db: SummaryDatabase;
  readonly generator: SummaryGenerator;
  readonly logger: Logger;
  readonly config: SummaryServiceConfig;
  /**
   * 写摘要之后的权限物化（§12.4 的「写时算」）。
   *
   * 归档子树（`history/`、`archive_NNN/`）是 `SessionService` 直接写 `ContentStore`
   * 建出来的，观察者收不到通知；摘要生成是这条链上唯一的写后钩子。只取
   * `materializeNode` 一个方法，与 `ArchiveSummaryStep` 取 `Pick<SummaryService, ...>`
   * 同一取舍：不需要整个 `AclService` 的测试不该造一个。
   */
  readonly acl: Pick<AclService, 'materializeNode'>;
  /** 每个目录一把 EXACT 锁；省略时不加锁（见文件头「并发」）。 */
  readonly locks?: PathLockManager;
}

export interface InvalidationResult {
  /** 真正重算了摘要的目录，自底向上 */
  readonly recomputed: readonly string[];
  /** 只记了脏、等下次的目录 */
  readonly markedStale: readonly string[];
  /** 到达 scope 根停止 */
  readonly stoppedAt: string;
}

/** 目录自身那一行在 `node.level` 上存的值：目录的可检索正文是它的 L0 摘要。 */
const DIRECTORY_LEVEL = 'L0';

/**
 * 目录概览行在 `node.level` 上存的值（§8.5）。
 *
 * 同一个目录因此在索引里有两行：L0 行（一句话摘要）与 L1 行（`overviewMaxChars`
 * 的概览正文）。两行的文本长度与信噪比不同，`bm25 × levelWeight` 才有意义——
 * 在此之前 `levelWeights.l1` 没有任何行可乘。
 */
const OVERVIEW_LEVEL = 'L1';

/** 摘要新鲜度三列只在目录的 L0 行上有意义（`0004_node_level_rows.sql`）。 */
const FRESHNESS_ROW_SQL = `level = '${DIRECTORY_LEVEL}'`;

/**
 * 首句终止符：中英文句号、叹号、问号与换行（§9.2 的「各自摘要首句」）。
 *
 * 只是规则摘要的切分启发式，不是完整的分句（`v1.2` 会在点处截断）。规则摘要本身
 * 就是降级产物，为此引入分词器不值得。
 */
const SENTENCE_TERMINATORS = /[。！？!?\n]/;

/** 空目录的规则摘要正文。与 `buildSummaryPrompt` 的「（这个目录是空的。）」同义。 */
const EMPTY_DIRECTORY_TEXT = '（这个目录是空的。）';

/** 生成器选项。两个预算同时进提示词，避免「提示词里 256、截断用 4000」。 */
export interface SummarizerOptions {
  readonly abstractMaxChars: number;
  readonly overviewMaxChars: number;
}

const DEFAULT_SUMMARIZER_OPTIONS: SummarizerOptions = {
  abstractMaxChars: ABSTRACT_MAX_CHARS,
  overviewMaxChars: OVERVIEW_MAX_CHARS,
};

function nullableText(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function integer(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** 取一段摘要的首句；没有终止符时返回整段。 */
function firstSentence(text: string): string {
  const flat = text.trim();
  if (flat === '') {
    return '';
  }
  const index = flat.search(SENTENCE_TERMINATORS);
  return index < 0 ? flat : flat.slice(0, index + 1).trim();
}

/** 规则摘要的标题：目录名；scope 根没有名字，退回整串 URI。 */
function ruleTitle(uri: Uri): string {
  return uri.name === '' ? uri.toString() : uri.name;
}

/**
 * 调模型的摘要生成器（§9.2 的实现 1）。
 *
 * 只产 L1（`buildSummaryPrompt` 的四段结构），L0 由 `extractAbstract` 从 L1 正文
 * 提取——两层各生成一遍必然互相矛盾。
 *
 * **不在这里截断**：预算是 `SummaryService` 的职责（`truncateToChars`），生成器只
 * 负责「模型说了什么」。这样换一个生成器实现时预算仍然生效。
 */
export class LlmSummarizer implements SummaryGenerator {
  readonly #llm: LlmService;
  readonly #options: SummarizerOptions;

  constructor(llm: LlmService, options: SummarizerOptions = DEFAULT_SUMMARIZER_OPTIONS) {
    this.#llm = llm;
    this.#options = options;
  }

  async generate(input: SummaryInput): Promise<DirectorySummary> {
    const prompt = buildSummaryPrompt({
      uri: input.uri,
      children: input.children,
      abstractMaxChars: this.#options.abstractMaxChars,
      overviewMaxChars: this.#options.overviewMaxChars,
    });
    const result = await this.#llm.generate(prompt);
    return {
      abstract: extractAbstract(result.text),
      overview: result.text,
      degraded: false,
    };
  }
}

/**
 * 断网降级的摘要生成器（§9.2 的实现 2）。
 *
 * 不调模型，纯字符串拼接：一级标题 + 每个直接子节点一行「名字：摘要首句」。
 * 结果恒带 `degraded: true`——静默降级等于骗人（§17.9）。
 */
export class RuleSummarizer implements SummaryGenerator {
  async generate(input: SummaryInput): Promise<DirectorySummary> {
    const lines =
      input.children.length === 0
        ? [EMPTY_DIRECTORY_TEXT]
        : input.children.map((child) => {
            const sentence = firstSentence(child.abstract);
            return sentence === '' ? `- ${child.name}` : `- ${child.name}：${sentence}`;
          });
    const overview = [`# ${ruleTitle(input.uri)}`, '', ...lines].join('\n');
    return { abstract: extractAbstract(overview), overview, degraded: true };
  }
}

export class SummaryService {
  readonly #nodes: NodeRepository;
  readonly #index: SqliteFtsIndex;
  readonly #metadata: MetadataFileStore;
  readonly #store: ContentStore;
  readonly #db: SummaryDatabase;
  readonly #generator: SummaryGenerator;
  readonly #logger: Logger;
  readonly #config: SummaryServiceConfig;
  readonly #thresholds: FreshnessThresholds;
  readonly #acl: Pick<AclService, 'materializeNode'>;
  readonly #locks: PathLockManager | undefined;

  constructor(deps: SummaryServiceDeps) {
    this.#nodes = deps.nodes;
    this.#index = deps.index;
    this.#metadata = deps.metadata;
    this.#store = deps.store;
    this.#db = deps.db;
    this.#generator = deps.generator;
    this.#logger = deps.logger;
    this.#config = deps.config;
    this.#thresholds = deps.config.freshness ?? DEFAULT_FRESHNESS_THRESHOLDS;
    this.#acl = deps.acl;
    this.#locks = deps.locks;
  }

  /**
   * 自底向上重建一棵子树的摘要（§9.2）。
   *
   * 返回**真正重算的目录**，按重算顺序（最深的在前，`rootUri` 最后）。不看新鲜度：
   * 调用方要的是「重建」，跳过「看起来还新」的目录只会让显式重建变成空操作。
   */
  async regenerate(rootUri: Uri): Promise<readonly string[]> {
    const recomputed: string[] = [];

    const visit = async (directoryUri: Uri): Promise<void> => {
      const entries = await this.#store.list(directoryUri);
      for (const entry of entries) {
        if (entry.kind === 'directory') {
          await visit(entry.uri);
        }
      }
      // 慢操作（模型调用）在锁外生成，只在写回时持锁（§10.6「锁内不得跨越慢操作」）。
      // 快照在生成**之前**读：写回时 `pending = max(pending - 快照, 0)`，生成期间到达
      // 的改动留在计数里（`consumeChanges`）。
      const snapshot = this.#readFreshness(directoryUri.toString()).pendingChanges;
      const summary = await this.#summarize(directoryUri);
      await this.#withDirectoryLock(directoryUri, () =>
        this.#persistSummary(directoryUri, summary, snapshot, null),
      );
      recomputed.push(directoryUri.toString());
    };

    await visit(rootUri);

    this.#logger.info('子树摘要已重建', {
      root: rootUri.toString(),
      recomputed: recomputed.length,
    });
    return recomputed;
  }

  /**
   * 写节点之后的失效传播（§9.3）。
   *
   * `nodeUri` 是被写入 / 删除 / 移动的节点。五步见文件头；两条提前返回的路径都要
   * 有测试：正文没变（第 2 步）与「只记脏」（第 4 步的 else 分支）。
   */
  async invalidate(nodeUri: Uri): Promise<InvalidationResult> {
    if (!(await this.#bodyChanged(nodeUri))) {
      // §9.3 第 2 步：正文没变不传播。这是性能的关键——同一个内容重复写不应该
      // 让整条祖先链都重算。
      return { recomputed: [], markedStale: [], stoppedAt: nodeUri.toString() };
    }
    return this.#propagateFrom(nodeUri, nodeUri.parent());
  }

  /**
   * 只标脏，跳过「正文 digest 是否变化」的比较。
   *
   * **批量写入必须用它，不能调 `invalidate`。** `add_resource` 的顺序是「写文件 →
   * 批量 `index.upsert` → 标脏」：等标脏被调用时索引里已经是新 digest 了，比较必然
   * 相等，整条传播链会被静默跳过。结果是文件写了、目录摘要永远不重算，而测试只数
   * 调用次数，看不出来。
   *
   * 调用方在**知道内容确实变了**时用它——批量导入就是这种情况：它刚写完这批文件。
   *
   * `directoryUri` 是要标脏的目录本身（不是被写的文件），因为它没有文件可供比较。
   */
  async markStale(directoryUri: Uri): Promise<InvalidationResult> {
    return this.#propagateFrom(directoryUri, directoryUri);
  }

  /** 从 `start` 开始向上传播；`origin` 只用于日志。 */
  async #propagateFrom(origin: Uri, start: Uri | null): Promise<InvalidationResult> {
    const recomputed: string[] = [];
    const markedStale: string[] = [];

    let stoppedAt = origin.toString();
    let current = start;

    while (current !== null) {
      stoppedAt = current.toString();
      const outcome = await this.#invalidateDirectory(current);

      if (outcome === 'stale') {
        markedStale.push(stoppedAt);
        break;
      }

      recomputed.push(stoppedAt);
      // §9.3 第 5 步：只有 P 的 L0 正文也变了才继续向上。
      if (outcome === 'unchanged' || current.isRoot) {
        break;
      }
      current = current.parent();
    }

    this.#logger.debug('摘要失效传播完成', {
      node: origin.toString(),
      recomputed: recomputed.length,
      markedStale: markedStale.length,
      stoppedAt,
    });
    return { recomputed, markedStale, stoppedAt };
  }

  /**
   * 读目录摘要（不管新鲜度），给 `getAcl` 之类的只读面用。
   *
   * 两个文件缺任一就没有完整摘要，返回 `null` —— 「摘要都不全」比「只有半份摘要」
   * 更接近调用方想要的语义（重建索引、显示「暂无摘要」）。
   *
   * `degraded` 从 `SummaryFileContent.generation` 回填——断网时走规则摘要，模型看到的
   * 概览质量会明显下降，这个标记是它判断「要不要重试」的依据（§9.2）。
   */
  async read(directoryUri: Uri): Promise<DirectorySummary | null> {
    const content = await this.#metadata.readSummary(directoryUri);
    if (!content.complete) {
      return null;
    }
    return {
      abstract: content.abstract,
      overview: content.overview,
      // 没有生成信息（手工写的摘要文件、从未生成过）按「未降级」处理：`degraded`
      // 的语义是「这次生成走了规则摘要」，来源未知不等于降级。
      degraded: content.generation?.degraded ?? false,
    };
  }

  // ── 失效 ──

  /** §9.3 第 1–2 步：节点正文是否与索引里记录的不一致。 */
  async #bodyChanged(nodeUri: Uri): Promise<boolean> {
    const digest = await this.#bodyDigest(nodeUri);
    const recorded = this.#nodes.get(nodeUri.toString())?.bodyDigest;
    if (recorded === undefined) {
      // 索引里没有这一行（还没索引过，或刚被删除）：按「变化了」处理，让父目录
      // 至少记一次脏。不能按「没变」处理——那会让没建过索引的目录永远不生成摘要。
      return true;
    }
    return recorded !== digest;
  }

  /**
   * 节点的正文 digest（§9.3 第 1 步）。
   *
   * 文件是正文；目录的正文是它的 L0 摘要（`Directory.digest()`）。节点已不在磁盘上
   * （删除 / 移动后的旧地址）时返回 `null`：调用方拿到的一定与索引里的记录不同。
   */
  async #bodyDigest(nodeUri: Uri): Promise<string | null> {
    const stat = await this.#store.stat(nodeUri);
    if (stat === null) {
      return null;
    }
    if (stat.kind === 'directory') {
      const summary = await this.#metadata.readSummary(nodeUri);
      return stableDigest(summary.abstract);
    }
    const document = await this.#store.readText(nodeUri);
    return stableDigest(document.text);
  }

  /**
   * 处理一个目录：记一次脏，然后判定是否立刻重算。
   *
   * 返回 `changed` / `unchanged` 表示重算了（后者指 L0 与旧值相同），`stale` 表示
   * 只记了脏。
   *
   * ## 为什么拆成两段锁（§10.6「锁内不得跨越慢操作」）
   *
   * 第一段（`EXACT`，几毫秒）：记脏、判定、需要重算则把本次要覆盖的 `pending`
   * 快照抢下来并清零计数——这一段是「读状态 → 决定 → 写状态」的短路径，不能放
   * LLM。`#summarize` 里的 `generator.generate` 是一次 7–9 秒的模型调用，放进锁里
   * 会让 `EXACT` 锁持有 7–9 秒；而 `PathLockManager` 不可重入且与祖先 `TREE`
   * 互斥，并发的 `rm -r` / `tree` 会在 5 秒后 `CONFLICT`（W83 实测：LLM 摘要时
   * ingest 撞祖先 `tree` 锁超时，只能把 `summary.generator` 降级成 `rule`）。
   *
   * 第二段（`EXACT`，几毫秒）：写摘要文件、写索引、写回新鲜度。
   *
   * ## 两段之间的竞态
   *
   * 慢操作在锁外进行时，目录内容可能被别的写者改动（新增 / 删除子项）。我们
   * **接受「摘要可能比内容旧一拍」**：第一段已经把 `pending` 清零，慢操作期间
   * 到达的改动会重新把 `pending` 加回来（`onNodeWritten` → `markStale`），下一轮
   * 失效会再次重算，摘要最终收敛到最新内容。这与文件头「消费时减而不是清零」
   * 同一个机制——旧实现也在 `#summarize` 里读 `pending` 快照后于锁内消费，只是
   * 那时改动无法插进来。
   *
   * 要「严格不旧」需要版本号：第一段记下当前内容版本，第二段写回前比对，不一致
   * 就放弃这次结果、留待下次。这里不引入——摘要是派生数据、按拍收敛即可，多一次
   * 重算的代价远小于 7–9 秒的锁。
   */
  async #invalidateDirectory(directoryUri: Uri): Promise<'changed' | 'unchanged' | 'stale'> {
    // 记忆的版本快照目录（`memories/{type}/.history`）不参与目录摘要（W98）。
    // 每次覆盖写都会新增一份版本文件，它的父目录就是 `.history`（`rules` 的镜像
    // 子目录也一样）。若照常传播，每次覆盖写会多两次 LLM 摘要调用（`.history` 与
    // 它上面的类型目录），而版本文件不是给检索用的内容。直接返回 `unchanged`：
    // 传播在 `.history` 就停，类型目录的摘要保持原样（它的子项确实多了一个隐藏
    // 目录，接受这份摘要「比磁盘旧一拍」，由下一次真实改动收敛）。
    if (isVersionFile(directoryUri)) {
      return 'unchanged';
    }

    const uri = directoryUri.toString();

    // 第一段锁：记脏 → 判定 → （需要）抢快照并清零。
    const decision = await this.#withDirectoryLock(directoryUri, async () => {
      const current = this.#readFreshness(uri);
      const changed = recordChange(current);

      if (!shouldRecompute(changed, this.#thresholds)) {
        // §9.3 第 4 步的 else 分支：只更新计数器，等改动攒够。
        this.#writePending(uri, changed.pendingChanges);
        return { recompute: false as const };
      }

      // 记下本次生成覆盖的 `pending` 快照，并把计数清零。慢操作期间到达的改动
      // 会被重新加回（`markStale`），因此清零不等于吞掉这些改动：写回时以
      // `snapshotPending = 0` 消费，本轮到达的改动原样留在计数里。
      this.#writePending(uri, 0);
      const previous = this.#nodes.get(uri)?.bodyDigest ?? null;
      return { recompute: true as const, previous };
    });

    if (!decision.recompute) {
      return 'stale';
    }

    // 慢操作在锁外：调模型 / 规则生成 L0 + L1。这一步可能要 7–9 秒。
    const summary = await this.#summarize(directoryUri);

    // 第二段锁：写回。摘要文件、索引、新鲜度都在这里落盘。
    return await this.#withDirectoryLock(directoryUri, () =>
      this.#persistSummary(directoryUri, summary, 0, decision.previous),
    );
  }

  // ── 生成 ──

  /**
   * 生成一个目录的 L0 + L1（**只生成，不落盘**，§9.2）。
   *
   * 拆成「生成」与「落盘」两步是为了让慢操作（`generator.generate`）待在锁外：
   * `#invalidateDirectory` 在锁外调本方法，拿到结果后再进锁调 {@link #persistSummary}。
   * `regenerate` 是显式全量重建，读目录列表本身在锁外，本方法后直接落盘即可。
   *
   * 预算在服务这一层执行：换任何生成器实现都不会超。
   */
  async #summarize(directoryUri: Uri): Promise<DirectorySummary> {
    const children = await this.#summaryChildren(directoryUri);
    const generated = await this.#generator.generate({ uri: directoryUri, children });

    const overview = truncateToChars(generated.overview, this.#config.overviewMaxChars);
    // L0 从 L1 提取（§9.1）：两层各生成一遍必然互相矛盾。
    const abstract = truncateToChars(
      extractAbstract(overview),
      this.#config.abstractMaxChars,
    );
    return { abstract, overview, degraded: generated.degraded };
  }

  /**
   * 把一个已生成的摘要落盘、写索引、写回新鲜度（§9.2、§9.3）。
   *
   * 调用方必须持本目录的 `EXACT` 锁：这里是「写状态」，要与并发的目录写入 / 删除
   * 互斥。`snapshotPending` 是第一段锁记下的 `pending` 快照，写回时
   * `pending = max(pending - 快照, 0)`——慢操作期间到达的改动留在计数里
   * （`consumeChanges`）。
   *
   * 返回 `changed` / `unchanged`（后者指 L0 与旧 `bodyDigest` 相同）。
   */
  async #persistSummary(
    directoryUri: Uri,
    summary: DirectorySummary,
    snapshotPending: number,
    previous: string | null,
  ): Promise<'changed' | 'unchanged'> {
    const baseline = stableDigest(summary.abstract);

    // 先写文件（真相），再改表（缓存）：§7「先写内容再更新索引」。写文件失败时
    // 索引与新鲜度都没有动过，不会出现「摘要宣称更新了、磁盘上还是旧的」。
    await this.#metadata.writeSummary(directoryUri, summary.abstract, summary.overview, {
      generatedBy: summary.degraded ? 'rule' : 'llm',
      generatedAt: new Date().toISOString(),
      degraded: summary.degraded,
    });

    const children = await this.#store.list(directoryUri);

    await this.#runInTransaction(async () => {
      // 两行一起写：目录的 L0 摘要行（检索一句话）与 L1 概览行（检索概览正文）。
      // L1 行必须跟着摘要失效 / 重算同步更新，否则「概览改了、检索还是旧内容」
      // 会变成一条没有任何报错的陈旧数据。
      await this.#index.upsert([
        this.#indexRecord(directoryUri, summary, children.length, baseline),
        this.#overviewRecord(directoryUri, summary, children.length),
      ]);
      this.#consume(directoryUri.toString(), baseline, snapshotPending, children.length);
    });

    // §12.4 的「写时算」：归档子树是 `SessionService` 直接写 `ContentStore` 建出来的，
    // 观察者收不到通知，所以 `node_permission` 里没有 `history/` 与 `archive_NNN/`
    // 的行。而 `list` / `tree` / `glob` 的权限过滤是**纯 SQL 查询**——归档写成功了，
    // 控制台的文件树里一条都没有，`stat` 一次又全部恢复（读路径的
    // `InheritingAuthorizer` 会补）。摘要生成是这条链上唯一的写后钩子。
    //
    // 物化在 `index.upsert` 之后：`materializeNode` 从 `node` 表读 kind 决定链的起点
    // （与 `IndexObserver.#indexNode` 同一顺序）。
    //
    // 失败不吞：本服务在后台任务里跑，静默跳过只会让「归档写成功、树里看不到」
    // 变成一条没有上下文的空目录；抛出去由提交步骤重试。
    await this.#materialize(directoryUri);

    this.#logger.debug('目录摘要已生成', {
      uri: directoryUri.toString(),
      children: children.length,
      abstractChars: summary.abstract.length,
      overviewChars: summary.overview.length,
      degraded: summary.degraded,
    });

    // §9.3 第 5 步：L0 没变就不往上传。父目录的输入（这个目录的 L0）没有变化，
    // 重算父目录只会得到同一份摘要。
    return previous !== null && previous === baseline ? 'unchanged' : 'changed';
  }

  /**
   * L1 的输入：直接子文件的摘要 + 直接子目录的 L0 正文（§9.2）。
   *
   * 子项从磁盘列，不从索引列：磁盘是真相，索引可能落后（§7）。文件摘要取索引里的
   * `abstract`（§9.1 明确它作为父目录 L1 的输入），目录摘要取 `.abstract.md` 正文。
   */
  async #summaryChildren(directoryUri: Uri): Promise<readonly SummaryChild[]> {
    const entries = await this.#store.list(directoryUri);
    const children: SummaryChild[] = [];
    for (const entry of entries) {
      const kind: NodeKind = entry.kind === 'directory' ? 'directory' : 'document';
      const abstract =
        kind === 'directory'
          ? (await this.#metadata.readSummary(entry.uri)).abstract
          : (this.#nodes.get(entry.uri.toString())?.abstract ?? '');
      children.push({ uri: entry.uri, name: entry.uri.name, kind, abstract });
    }
    return children;
  }

  /**
   * 目录自身那一行（L0）要写进索引的内容（§8.1 的 `node` 行）。
   *
   * 目录没有 L2 正文，这一行可检索的文本就是 L0 摘要：`abstract` 存 L0 原文，
   * `content` 留空（`node_fts` 的 `content` 列留给 L1 行，同一段文本写两列只会让
   * bm25 把同一处匹配算两遍）。`body_digest` 是 L0 正文的摘要——失效传播靠它判断
   * 「L0 变了没有」（§9.3）。
   *
   * 已有行里的 `context_type` / `memory_type` / `level` / `status` 原样保留：这些字段
   * 是索引重建时由内容决定的，摘要生成不该改写它们。
   */
  #indexRecord(
    directoryUri: Uri,
    summary: DirectorySummary,
    entries: number,
    baseline: string,
  ): IndexRecord {
    const uri = directoryUri.toString();
    const existing: NodeRow | null = this.#nodes.get(uri);
    return {
      uri,
      parentUri: directoryUri.parent()?.toString() ?? '',
      scope: directoryUri.scope,
      kind: 'directory',
      contextType: existing?.contextType ?? contextTypeOf(directoryUri),
      memoryType: existing?.memoryType ?? null,
      level: existing?.level ?? DIRECTORY_LEVEL,
      abstract: summary.abstract,
      content: '',
      bodyDigest: baseline,
      size: entries,
      updatedAt: new Date().toISOString(),
      status: existing?.status ?? 'active',
    };
  }

  /**
   * 目录的概览行（L1）要写进索引的内容（§8.5、§8.6）。
   *
   * 与 L0 行的差别只有两列：`level` 是 `L1`，`content` 是概览正文（L0 行的 `content`
   * 留空）。`abstract` 与 L0 行相同——检索结果里展示的就是这条命中对应的 L0 摘要，
   * 而「同一目录的 L0 行与 L1 行同时命中时只留高分那条」要靠它比较（§8.6 第 3 步
   * 按渲染后正文去重，`services/search.ts` 的 `#rank` 按 `(uri, abstract)` 去重）。
   *
   * `body_digest` 是概览正文的摘要，不是节点正文的摘要。它只有一个读者
   * （`#bodyChanged` 比的是节点自身那一行），把概览的 digest 写在这里是让这一行
   * 描述自己检索的是什么文本，而不是冒充节点。
   */
  #overviewRecord(
    directoryUri: Uri,
    summary: DirectorySummary,
    entries: number,
  ): IndexRecord {
    const uri = directoryUri.toString();
    const existing: NodeRow | null = this.#nodes.get(uri);
    return {
      uri,
      parentUri: directoryUri.parent()?.toString() ?? '',
      scope: directoryUri.scope,
      kind: 'directory',
      contextType: existing?.contextType ?? contextTypeOf(directoryUri),
      memoryType: existing?.memoryType ?? null,
      level: OVERVIEW_LEVEL,
      abstract: summary.abstract,
      content: summary.overview,
      bodyDigest: stableDigest(summary.overview),
      size: entries,
      updatedAt: new Date().toISOString(),
      status: existing?.status ?? 'active',
    };
  }

  // ── 新鲜度（`node` 表的三列） ──

  #readFreshness(uri: string): SummaryFreshness {
    const row = this.#db
      .prepare(
        `SELECT summary_baseline, summary_pending, summary_entries
           FROM node WHERE uri = ? AND ${FRESHNESS_ROW_SQL}`,
      )
      .get(uri);
    return {
      baseline: nullableText(row?.['summary_baseline']),
      pendingChanges: integer(row?.['summary_pending']),
      totalEntries: integer(row?.['summary_entries']),
    };
  }

  /** 只更新计数器，不动基线（§9.3 第 4 步的 else 分支）。 */
  #writePending(uri: string, pendingChanges: number): void {
    this.#db
      .prepare(`UPDATE node SET summary_pending = ? WHERE uri = ? AND ${FRESHNESS_ROW_SQL}`)
      .run(pendingChanges, uri);
  }

  /**
   * 写回新鲜度（§9.3「消费时减而不是清零」）。
   *
   * 必须在事务里、在索引行写入之后调用：行不存在时 `UPDATE` 影响 0 行，基线会永远
   * 停在 `NULL`，每次失效都重算整个子树。
   */
  #consume(uri: string, baseline: string, snapshotPending: number, entries: number): void {
    const current = this.#readFreshness(uri);
    const consumed = consumeChanges(
      { baseline, pendingChanges: current.pendingChanges, totalEntries: entries },
      snapshotPending,
    );
    this.#db
      .prepare(
        `UPDATE node
            SET summary_baseline = ?,
                summary_pending = ?,
                summary_entries = ?
          WHERE uri = ? AND ${FRESHNESS_ROW_SQL}`,
      )
      .run(baseline, consumed.pendingChanges, entries, uri);
  }

  // ── 基础设施 ──

  /**
   * 物化 `uri` 及其全部祖先的权限（§12.4 的「写时算」）。
   *
   * 只物化 `uri` 自己不够：`ContentStore.writeText` 写
   * `.../history/archive_001/messages.jsonl` 时顺手 `mkdir -p` 出 `history/` 与
   * `archive_001/`，两个目录都没有行，而 `filterReadable` 是纯 SQL 查询——它们在
   * `list` / `tree` / `glob` 里**整个消失**，用户看到的会话目录树是断的。
   *
   * 逐级 `materializeNode` 是幂等的（行已存在就是覆盖成同样的值），depth 通常
   * 3–6，换「归档目录树不断」是划算的。与 `IndexObserver.#materializeAncestors`
   * 同一做法。
   */
  async #materialize(uri: Uri): Promise<void> {
    let current: Uri | null = uri;
    while (current !== null) {
      await this.#acl.materializeNode(current);
      current = current.parent();
    }
  }

  async #withDirectoryLock<T>(uri: Uri, fn: () => Promise<T>): Promise<T> {
    if (this.#locks === undefined) {
      return fn();
    }
    return this.#locks.withLock(uri, 'exact', fn);
  }

  /** 见文件头「为什么事务不调用 `withWriteTransaction`」。 */
  async #runInTransaction(fn: () => Promise<void>): Promise<void> {
    if (this.#db.isTransaction) {
      await fn();
      return;
    }
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      await fn();
      this.#db.exec('COMMIT');
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }
}
