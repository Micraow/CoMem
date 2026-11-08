/**
 * 检索服务编排（架构文档 §8.3–§8.8、§12.4）。
 *
 * 四个检索面，各自解决一个访问路径：
 *
 * | 面 | 输入 | 返回 | 走索引 |
 * |---|---|---|---|
 * | `find` | 单条 query | 命中列表（uri / level / abstract / score） | 是（FTS5） |
 * | `search` | query + sessionId | 同上，**先做意图分析得到 0–5 条 TypedQuery** | 是（每条一次） |
 * | `grep` | 正则 + 路径范围 | 行级命中，带行号与前后文 | 否（读文件） |
 * | `glob` | 路径通配 | 文件 URI 列表 | 是（GLOB） |
 * | `context` | 单条 query | 可直接注入模型的文本 | 是 + 组装 |
 *
 * ## 为什么 `grep` 不走索引
 *
 * FTS5 索引的是**词**（而且写进去的是 `segmentCjk` 切分后的文本），`grep` 匹配的是
 * **任意正则**。两者是不同的访问路径：索引没有原文，也没有行号，让它实现 `grep`
 * 等于让索引去读文件。做法是先用 `index.glob` 拿权限过滤后的候选 URI 集合，再逐个
 * `filesystem.read` 做行匹配。
 *
 * 代价是「一个 `.*` 会读穿整个库」，所以候选文件数必须有上限（`GREP_CANDIDATE_LIMIT`）。
 *
 * ## 权限是两遍
 *
 * 索引侧已经在 SQL 里按 `node_permission` 过滤过（§8.2），服务层仍然再过一遍
 * `authorizer.filterReadable` / `glob` 的二次过滤：§12.4 的出口清单是按出口数的，
 * 不是按「索引实现看起来已经做了」。这是纵深防御，不是重复劳动。
 */

import type { NodeAccessStats, NodeRepository } from '../adapters/sqlite/node-repository.js';
import type { SqliteVectorIndex, VectorHit } from '../adapters/sqlite/vector-index.js';
import { parsePrincipal } from '../domain/acl.js';
import {
  type AssemblyCandidate,
  type AssemblyOptions,
  type AssemblyResult,
  type QuotaPreset,
} from '../domain/assembly.js';
import { ComemError } from '../domain/errors.js';
import { DEFAULT_HALF_LIFE_DAYS, hotnessScore } from '../domain/hotness.js';
import type { Level } from '../domain/level.js';
import type { LlmPrompt } from '../domain/llm.js';
import type { Logger } from '../domain/log.js';
import type { ContextType } from '../domain/node.js';
import { rankCandidates, type LevelWeights, type RankedCandidate } from '../domain/ranking.js';
import {
  applyQueryFilters,
  compileQueryFilters,
  type QueryFilter,
} from '../domain/query-filter.js';
import {
  MAX_TYPED_QUERIES,
  reciprocalRankFusion,
  type FusedHit,
  type GrepHit,
  type RetrievalEngine,
  type RetrievalIndex,
  type SearchHit,
  type SearchPlan,
  type SearchResultHit,
  type TypedQuery,
} from '../domain/retrieval.js';
import { renderMessageText, type SessionMessage } from '../domain/session.js';
import { Uri } from '../domain/uri.js';

import type { Authorizer } from './authorizer.js';
import type { ContextAssembler } from './context-assembler.js';
import type { EmbeddingService } from './embedding.js';
import type { FileSystemService } from './filesystem.js';
import type { LlmService } from './llm.js';
import {
  buildRewriteUserPrompt,
  REWRITE_SCHEMA,
  REWRITE_SYSTEM_PROMPT,
  type RewriteMessage,
} from './prompts/rewrite.js';
import { DEFAULT_RECALL_LEDGER_OPTIONS, type RecallLedger } from './recall-ledger.js';
import type { SessionService } from './session.js';

/**
 * 服务层需要的检索配置（§18 的 `retrieval` 段）。
 *
 * 结构类型而不是直接 `Pick<RetrievalConfig, ...>`：`config/schema.ts` 只导出
 * `ComemConfig`（整个配置对象），没有单独的 `RetrievalConfig` 别名。用结构类型
 * 让 bootstrap 可以直接把 `config.retrieval` 传进来，改 schema 时不需要动这里。
 *
 * `candidateMultiplier` 由索引构造时消费（`SqliteFtsIndex` 的构造参数），服务层
 * 不读它；保留在形状里是为了让「传整段配置」成立。
 */
export interface RetrievalSettings {
  readonly candidateMultiplier: number;
  readonly levelWeights: LevelWeights;
  readonly queryFilters: readonly string[];
  readonly assembly: {
    readonly maxTokens: number;
    readonly dedupTurns: number;
    readonly quotaPreset: QuotaPreset;
  };
}

export interface SearchServiceDeps {
  readonly index: RetrievalIndex;
  readonly filesystem: FileSystemService;
  readonly authorizer: Authorizer;
  readonly assembler: ContextAssembler;
  readonly logger: Logger;
  readonly config: RetrievalSettings;
  /**
   * 召回账本（§8.7）。只有 `context` 的 `excludeDelivered` 用到；不传时传了
   * `excludeDelivered` 会抛 `INVALID_ARGUMENT`——静默不去重比报错更难查。
   */
  readonly ledger?: Pick<RecallLedger, 'recentlyDelivered'>;
  /**
   * 意图分析（§8.4）。只有 `search` 用到。
   *
   * 不注入时 `search` 仍然可用：降级成单条原 query，`plan.analyzed = false` 且
   * `plan.reason` 写明原因。降级不静默（§17.9 的同一原则）——但也不该因为「没有
   * 模型」让整条只读路径不可用。
   */
  readonly llm?: Pick<LlmService, 'generateJson'>;
  /**
   * 最近消息的来源（§8.4 的「用 session」）。
   *
   * 只用来解析指代（「那它呢」）。不注入时按「历史为空」处理：查询仍然会重写，
   * 只是省略的主语补不回来。
   */
  readonly sessions?: Pick<SessionService, 'load'>;
  /**
   * 嵌入（§8.3、§18 的 `retrieval.engine`）。只有 `vector` / `hybrid` 用到。
   *
   * 三个向量相关依赖是可选的，但**不是可静默省略的**：`engine` 不是 `fts5` 时
   * 缺任何一个都在构造期抛 `INVALID_ARGUMENT`。可选只是为了让「只跑 FTS5」的
   * 调用方（测试、只读脚本）不必造一套用不上的向量图。
   *
   * `model` 也是必需的：`SqliteVectorIndex.search` 按模型过滤旧行，没有模型名
   * 就分不清「当前模型的向量」与「换模型前的残留」。
   */
  readonly embedding?: Pick<EmbeddingService, 'embed' | 'available' | 'model'>;
  readonly vectors?: Pick<SqliteVectorIndex, 'search'>;
  /**
   * 向量命中只有 URI + 分数，其余列（`level` / `abstract` / `contextType` /
   * `memoryType` / `status`）从 `node` 表补。没有它 `SearchHit` 就是半成品。
   */
  readonly nodes?: Pick<NodeRepository, 'get'>;
  /** §18 的 `retrieval.engine`，默认 `fts5`（与 schema 默认值一致）。 */
  readonly engine?: RetrievalEngine;
  /**
   * 热度对最终排序的影响（`telemetry.hotness.weight`）。
   *
   * `0`（默认）= 不参与排序，`hotness` 字段仍然是 `null`，行为与接线前完全一致。
   * 非 0 时查询 `node.access_count` / `node.last_accessed_at` 并计算。
   */
  readonly hotnessWeight?: number;
  /** 半衰期（小时）。`telemetry.hotness.halfLifeHours`，默认 168（一周）。 */
  readonly hotnessHalfLifeHours?: number;
  /** 读访问统计。缺省时不做热度计算（`hotness` 恒为 `null`）。 */
  readonly accessStats?: (uris: readonly string[]) => readonly NodeAccessStats[];
  /**
   * 累加访问计数（`NodeRepository.recordAccess`）。
   *
   * 只在 `hotnessWeight !== 0` 且真的返回了命中时调用，**不 await**（见
   * `#recordHits`）。缺省时不记：只读部署没有热度数据源，写不进去也不该报错。
   */
  readonly recordAccess?: (uris: readonly string[]) => unknown;
}

export interface FindOptions {
  /** 路径前缀 */
  readonly scopes: readonly string[];
  /** 调用方身份，如 `user:alice`。只进日志与审计；权限判定用 `principals` */
  readonly subject: string;
  /** 已由 `Authorizer` 展开，含 `user:*` 与全部组 */
  readonly principals: readonly string[];
  readonly contextTypes?: readonly ContextType[];
  readonly levels?: readonly Level[];
  readonly limit?: number;
  readonly scoreThreshold?: number;
}

export interface SearchOptions extends FindOptions {
  /** 会话 ID。有它才能解析指代；没有也能分析，只是历史为空 */
  readonly sessionId?: string;
  /** 最多执行几条 TypedQuery；默认 5（§8.4 的「0–5 条」），传入更大值按 5 算 */
  readonly maxQueries?: number;
}

export interface ContextOptions extends FindOptions {
  readonly quotaPreset?: QuotaPreset;
  /** 跨轮去重：上一轮已经投过的 URI 不再投（§8.7） */
  readonly excludeDelivered?: { readonly scopeKey: string; readonly turn: number };
}

/** `find` / `glob` 的命中。`level` 是命中记录的层级，`score` 已做层级加权。 */
export interface ScoredHit {
  readonly uri: string;
  readonly contextType: ContextType;
  /** 记忆类型，非记忆文件为 `null`；§8.6 的起始层级靠它区分 `events` */
  readonly memoryType: string | null;
  readonly level: Level;
  readonly abstract: string | null;
  readonly score: number;
}

/**
 * `find` 的命中 + 各后端名次（1 起，没出现记 `null`）。
 *
 * 名次是「为什么这条排在这」的唯一解释（§8.4 的合并规则）。只有 `hybrid` 会
 * 两个后端都有名次；`fts5` / `vector` 单引擎时只填自己那一位，另一位是 `null`。
 *
 * 不并进 `ScoredHit`：`ScoredHit` 是接口层的序列化形状（`api/http/routes/search.ts`
 * 的 `serializeHit`），名次是融合过程的产物，不该改变那个契约的位置。
 */
export interface RankedScoredHit extends ScoredHit {
  readonly ranks: Readonly<Record<RetrievalEngine, number | null>> | null;
  /**
   * 热度分 `[0,1]`。
   *
   * `null` 表示「没有计算」——`telemetry.hotness.weight` 为 0、或者这个 URI 没有
   * 访问记录。**不要把「没算」和「算出来是 0」混为一谈**：前者是配置关闭，后者是
   * 从没被访问过，控制台要能区分。
   */
  readonly hotness: number | null;
}

/** 热度加权前的命中：`RankedScoredHit` 去掉 `hotness` 那一列。 */
type PreHotnessHit = ScoredHit & {
  readonly ranks: Readonly<Record<RetrievalEngine, number | null>> | null;
};

/**
 * `search` 合并后的命中。在 `SearchResultHit` 之上多带融合名次。
 *
 * `SearchResultHit` 在领域层（`domain/retrieval.ts`）没有 `ranks` 列，本层用
 * 交叉类型补上——领域类型描述「检索结果」，名次是融合过程的产物，属于服务层。
 */
export interface ScoredSearchHit extends SearchResultHit {
  readonly ranks: Readonly<Record<RetrievalEngine, number | null>> | null;
}

/** `search` 的返回体。结构上是 `SearchResult` 的子类型，多带 `ranks`。 */
export interface ScoredSearchResult {
  readonly hits: readonly ScoredSearchHit[];
  readonly plan: SearchPlan;
}

/** 一次 `find` 的内部产物：命中 + 向量后端的降级原因。 */
interface RetrieveOutcome {
  readonly hits: readonly RankedScoredHit[];
  /** 向量后端降级原因；`null` 表示这次没有降级 */
  readonly degradation: string | null;
}

/** 向量检索需要的三个依赖。构造期保证 `engine !== 'fts5'` 时非空。 */
interface VectorRetrievalDeps {
  readonly embedding: Pick<EmbeddingService, 'embed' | 'available' | 'model'>;
  readonly vectors: Pick<SqliteVectorIndex, 'search'>;
  readonly nodes: Pick<NodeRepository, 'get'>;
}

/** `context` 变体的返回值就是组装结果（§8.6 的四步产物）。 */
export type ContextAssembly = AssemblyResult;

/**
 * 默认返回条数。
 *
 * 20：经验值，来源未知。§8.4 / §8.5 没给默认值；§13.2 的 MCP `find` 工具默认 10，
 * 服务层取 20 给工具层留截断余量（工具可以再取前 10 条，反过来拿不到）。
 */
const DEFAULT_RESULT_LIMIT = 20;

/** 一天的小时数。`hotnessHalfLifeHours` 的单位是小时，`hotnessScore` 的输入是天。 */
const HOURS_PER_DAY = 24;

/**
 * 默认半衰期（小时）：168。
 *
 * 从领域层的 `DEFAULT_HALF_LIFE_DAYS` 换算，而不是再写一遍 168：配置默认值与
 * 公式默认值不一致时，同一条记忆会得到两个冷热分档。
 */
const DEFAULT_HALF_LIFE_HOURS = DEFAULT_HALF_LIFE_DAYS * HOURS_PER_DAY;

/**
 * `grep` 的默认前后文行数。
 *
 * 3：经验值，来源未知。§13.2 的 `grep` 工具契约没给默认；取 3 与 `grep -C 3` 的
 * 常见用法一致——再少看不出上下文，再多就是在读文件。
 */
const DEFAULT_CONTEXT_LINES = 3;

/**
 * `grep` 最多读多少个候选文件。
 *
 * 200：经验值，来源未知。作用是挡住 `.*` 读穿整个库：tmpfs 上 200 个文件约
 * 20–200ms，真实磁盘上是它的数倍；再往上单次 `grep` 会进入秒级，而用户拿到的
 * 还只是前 `limit` 条命中。
 */
const GREP_CANDIDATE_LIMIT = 200;

/**
 * `grep` 的候选集来源：`**` 在 `index.glob` 里展开成「scope 下全部节点」。
 *
 * 不用 `*`：`*` 不跨 `/`（只匹配直接子项），而 `grep` 要扫整棵子树。
 */
const GREP_CANDIDATE_PATTERN = '**';

/**
 * 向量检索的候选集：`scope` 下全部可读节点。
 *
 * 与 `grep` 用同一个 `**`（跨 `/` 的子树），区别只在数量——`grep` 有
 * `GREP_CANDIDATE_LIMIT` 兜底，向量检索**不能截断**：传少了会漏掉「BM25 排
 * 第 50 但向量排第 1」的命中，而 RRF 的意义正是在两个后端都有完整候选时融合。
 */
const VECTOR_CANDIDATE_PATTERN = '**';

/**
 * 向量检索候选集的上限：不截断。
 *
 * `GlobQuery.limit` 是必填参数（`validateGlobQuery` 要求正整数），这里用最大
 * 安全整数表达「全部」。代价是每次向量检索都要把 `scope` 下的可读 URI 全查一遍
 * （O(n) 行）——§8.2 已经承认过这种「先取全量候选再过滤」的代价，十万节点以上
 * 必须换成带权限列的 ANN 索引。
 */
const VECTOR_CANDIDATE_LIMIT = Number.MAX_SAFE_INTEGER;

/** 1 毫秒 = 1e6 纳秒。 */
const NANOSECONDS_PER_MILLISECOND = 1_000_000;

/**
 * 意图分析的历史窗口：最近 5 轮。
 *
 * 5 轮 = 10 条消息。§8.7 的轮次时钟取消息总数，一轮就是「一条 user + 一条
 * assistant」，所以 5 轮是末尾 10 条。再往前翻对指代解析没有帮助（更早的话题
 * 已经结束），只会挤占当前查询在提示词里的位置。
 */
const RECENT_MESSAGES = 10;

/**
 * 意图分析的单次超时，毫秒。
 *
 * 10000 是**经验值，来源未知**。§18 的 `providers.llm.default.timeoutSeconds`
 * 默认 120 秒，那是后台任务（抽取、摘要）的预算；`search` 是交互路径，用户站在
 * 前面等。「10 秒后降级」与「120 秒后降级」对用户是两件不同的事，所以这里显式
 * 收窄，而不是继承后台任务的默认值。
 */
const REWRITE_TIMEOUT_MS = 10_000;

/** §6.5 的 `sessions/sess_xxx/` 目录名（与 `services/session.ts` 指向同一个目录）。 */
const SESSIONS_DIRECTORY_NAME = 'sessions';

function elapsedMs(startedAt: bigint): number {
  return Number(process.hrtime.bigint() - startedAt) / NANOSECONDS_PER_MILLISECOND;
}

function resolveLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return DEFAULT_RESULT_LIMIT;
  }
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new ComemError('INVALID_ARGUMENT', 'limit 必须是正整数。', { limit });
  }
  return limit;
}

/**
 * `maxQueries` 的上限是 §8.4 的「0–5 条」。
 *
 * 传入更大的值按 5 截断而不是报错：调用方表达的是「最多跑几条」，而 5 是契约
 * 上限，截断不改变它的意图。`0` 与负数报错——那多半是把「不限制」写错了。
 */
function resolveMaxQueries(maxQueries: number | undefined): number {
  if (maxQueries === undefined) {
    return MAX_TYPED_QUERIES;
  }
  if (!Number.isInteger(maxQueries) || maxQueries <= 0) {
    throw new ComemError('INVALID_ARGUMENT', 'maxQueries 必须是正整数。', { maxQueries });
  }
  return Math.min(maxQueries, MAX_TYPED_QUERIES);
}

export class SearchService {
  readonly #index: RetrievalIndex;
  readonly #filesystem: FileSystemService;
  readonly #authorizer: Authorizer;
  readonly #assembler: ContextAssembler;
  readonly #logger: Logger;
  readonly #config: RetrievalSettings;
  readonly #ledger: Pick<RecallLedger, 'recentlyDelivered'> | undefined;
  readonly #llm: Pick<LlmService, 'generateJson'> | undefined;
  readonly #sessions: Pick<SessionService, 'load'> | undefined;
  readonly #queryFilters: readonly QueryFilter[];
  readonly #engine: RetrievalEngine;
  /**
   * 向量检索的三个依赖。`engine === 'fts5'` 时是 `null`，其余情况在构造期保证
   * 非空——这样查询路径上不需要反复判空，也不会把「少注入一个依赖」变成运行时
   * 的静默降级。
   */
  readonly #vector: VectorRetrievalDeps | null;
  /** 热度权重（`telemetry.hotness.weight`）。`0` 时整条热度路径不执行。 */
  readonly #hotnessWeight: number;
  /** 热度半衰期（天）。`hotnessScore` 的输入是天，配置里的单位是小时。 */
  readonly #hotnessHalfLifeDays: number;
  readonly #accessStats: SearchServiceDeps['accessStats'];
  readonly #recordAccess: SearchServiceDeps['recordAccess'];

  constructor(deps: SearchServiceDeps) {
    this.#index = deps.index;
    this.#filesystem = deps.filesystem;
    this.#authorizer = deps.authorizer;
    this.#assembler = deps.assembler;
    this.#logger = deps.logger;
    this.#config = deps.config;
    this.#ledger = deps.ledger;
    this.#llm = deps.llm;
    this.#sessions = deps.sessions;
    // 配置错误在装配期抛出，不是首次查询时——那时已经有人等着结果了。
    this.#queryFilters = compileQueryFilters(deps.config.queryFilters);

    const hotnessWeight = deps.hotnessWeight ?? 0;
    const halfLifeHours = deps.hotnessHalfLifeHours ?? DEFAULT_HALF_LIFE_HOURS;
    if (!Number.isFinite(hotnessWeight) || hotnessWeight < 0) {
      throw new ComemError('INVALID_ARGUMENT', 'hotnessWeight 必须是非负有限数。', {
        hotnessWeight: deps.hotnessWeight,
      });
    }
    if (!Number.isFinite(halfLifeHours) || halfLifeHours <= 0) {
      // 半衰期是除数：0 得到 Infinity，负数让「越旧越热」。都必须在装配期挡掉。
      throw new ComemError('INVALID_ARGUMENT', 'hotnessHalfLifeHours 必须是正的有限数。', {
        hotnessHalfLifeHours: deps.hotnessHalfLifeHours,
      });
    }
    this.#hotnessWeight = hotnessWeight;
    this.#hotnessHalfLifeDays = halfLifeHours / HOURS_PER_DAY;
    this.#accessStats = deps.accessStats;
    this.#recordAccess = deps.recordAccess;

    this.#engine = deps.engine ?? 'fts5';
    if (this.#engine === 'fts5') {
      this.#vector = null;
    } else {
      if (deps.embedding === undefined || deps.vectors === undefined || deps.nodes === undefined) {
        throw new ComemError(
          'INVALID_ARGUMENT',
          `retrieval.engine = ${this.#engine} 需要注入 embedding / vectors / nodes，否则向量检索没有可用的数据来源。`,
          {
            engine: this.#engine,
            missing: [
              ...(deps.embedding === undefined ? ['embedding'] : []),
              ...(deps.vectors === undefined ? ['vectors'] : []),
              ...(deps.nodes === undefined ? ['nodes'] : []),
            ],
          },
        );
      }
      this.#vector = {
        embedding: deps.embedding,
        vectors: deps.vectors,
        nodes: deps.nodes,
      };
    }
  }

  /**
   * §8.4 的 `find`：单条 query，不做意图分析。
   *
   * 过滤后为空**直接返回空数组，不调索引**：空查询没有「相关」可比，任何实现给出
   * 的结果都是随机的，而这些随机结果会被当成「用户这句话对应的记忆」写进召回账本
   * （§8.8）。
   *
   * ## 引擎差异（§18 的 `retrieval.engine`）
   *
   * | engine | 行为 |
   * |---|---|
   * | `fts5` | 只用关键词检索。**这是回归基线，行为与接入向量前逐字一致** |
   * | `vector` | 只用语义检索。降级时返回空命中并在日志里说明，**不退回 FTS5** |
   * | `hybrid` | 并行跑两者，`reciprocalRankFusion` 融合。向量降级时退化成纯 FTS5 |
   *
   * `vector` 降级不退回 FTS5，是因为用户显式选了语义检索：静默换引擎会给出
   * 「看起来能用、其实换了实现」的结果，比空命中更让人困惑。
   *
   * ## `scoreThreshold` 的语义
   *
   * 三种引擎的分数量纲不同：FTS5 是 `bm25` 取负（无界正数），向量是余弦
   * （`[-1, 1]`），融合是 RRF（约 `1/61` 到 `2/61`）。`scoreThreshold` 作用在
   * **本引擎最终排序分**上——单引擎是层级加权后的分（§8.5），`hybrid` 是融合分。
   * 同一个阈值在三种引擎下不可比，切换引擎时必须重新标定。
   *
   * 配了 `telemetry.hotness.weight` 时，阈值作用在**热度加权之前**的相关性分上：
   * 热度只重排已经通过阈值的命中，不能把一条不相关的记忆「救」进来。
   */
  async find(query: string, options: FindOptions): Promise<readonly RankedScoredHit[]> {
    const outcome = await this.#findWithOutcome(query, options);
    // 记的是「返回给调用方的命中」，不是候选集：截断与阈值都在 `#retrieve` 里做完。
    this.#recordHits(outcome.hits);
    return outcome.hits;
  }

  /**
   * `find` 的内部实现。返回 `degradation` 让 `search` 能把「向量降级」写进
   * `plan.reason`（`find` 的返回体里没有 plan 这一列）。
   */
  async #findWithOutcome(query: string, options: FindOptions): Promise<RetrieveOutcome> {
    const startedAt = process.hrtime.bigint();
    const limit = resolveLimit(options.limit);
    const filtered = applyQueryFilters(query, this.#queryFilters);

    if (filtered === '') {
      this.#logger.info('检索查询过滤后为空，跳过', {
        subject: options.subject,
        queryLength: query.length,
        returned: 0,
        durationMs: elapsedMs(startedAt),
      });
      return { hits: [], degradation: null };
    }

    const outcome = await this.#retrieve(filtered, options, limit);
    if (outcome.degradation !== null) {
      this.#logger.warn('向量检索降级', {
        subject: options.subject,
        engine: this.#engine,
        reason: outcome.degradation,
        returned: outcome.hits.length,
      });
    }
    this.#logger.info('检索完成', {
      subject: options.subject,
      queryLength: filtered.length,
      returned: outcome.hits.length,
      durationMs: elapsedMs(startedAt),
    });
    return outcome;
  }

  /** 按配置的引擎分派。`fts5` 分支与接入向量前的实现逐字一致（回归基线）。 */
  async #retrieve(text: string, options: FindOptions, limit: number): Promise<RetrieveOutcome> {
    if (this.#engine === 'fts5') {
      const hits = await this.#index.search({
        text,
        scopes: options.scopes,
        principals: options.principals,
        contextTypes: options.contextTypes,
        levels: options.levels,
        limit,
      });
      return {
        hits: this.#applyHotness(
          this.#rank(hits, limit, options.scoreThreshold).map((hit) => ({
            ...hit,
            ranks: null,
          })),
        ),
        degradation: null,
      };
    }

    const vector = this.#vector;
    if (vector === null) {
      // 构造期已经挡掉；走到这里说明实例被绕过构造器篡改过。
      throw new ComemError('INTERNAL', `检索后端 ${this.#engine} 缺少向量依赖。`, {
        engine: this.#engine,
      });
    }
    return this.#engine === 'vector'
      ? this.#retrieveVector(vector, text, options, limit)
      : this.#retrieveHybrid(vector, text, options, limit);
  }

  /**
   * 纯向量检索。
   *
   * 降级时返回空命中 + 原因，**不退回 FTS5**（见 `find` 的引擎差异）。调用方从
   * 日志与 `search` 的 `plan.reason` 能看到原因。
   */
  async #retrieveVector(
    vector: VectorRetrievalDeps,
    text: string,
    options: FindOptions,
    limit: number,
  ): Promise<RetrieveOutcome> {
    const embedded = await vector.embedding.embed([text]);
    const queryVector = embedded.vectors[0];
    if (embedded.degraded || queryVector === undefined) {
      return {
        hits: [],
        degradation: embedded.reason ?? '向量检索没有拿到查询向量。',
      };
    }

    const model = vector.embedding.model;
    if (model === null) {
      return { hits: [], degradation: '没有配置嵌入模型，无法按模型过滤向量。' };
    }

    const uris = await this.#readableUris(options);
    const raw = await vector.vectors.search({ vector: queryVector, model, uris, limit });
    const enriched = this.#enrich(raw, options, vector.nodes);
    const ranked = this.#rank(enriched, limit, options.scoreThreshold);
    return {
      hits: this.#applyHotness(
        ranked.map((hit, index) => ({
          ...hit,
          ranks: { fts5: null, vector: index + 1, hybrid: null },
        })),
      ),
      degradation: null,
    };
  }

  /**
   * 混合检索：并行跑 FTS5 与向量，RRF 融合。
   *
   * **融合用两个后端自己的排序**，不先做层级加权：加权会改变名次，而 RRF 的输入
   * 就是「各后端认为谁更相关」。层级加权只在单引擎与最终展示分上有意义。
   *
   * 向量降级时退化成纯 FTS5，并把原因带回给 `search` 的 `plan`。
   */
  async #retrieveHybrid(
    vector: VectorRetrievalDeps,
    text: string,
    options: FindOptions,
    limit: number,
  ): Promise<RetrieveOutcome> {
    // 两路并行：串行会让一次 hybrid 查询把两倍的索引延迟叠在用户身上。
    const [ftsHits, embedded] = await Promise.all([
      this.#index.search({
        text,
        scopes: options.scopes,
        principals: options.principals,
        contextTypes: options.contextTypes,
        levels: options.levels,
        limit,
      }),
      vector.embedding.embed([text]),
    ]);

    const queryVector = embedded.vectors[0];
    const model = vector.embedding.model;
    let vectorHits: SearchHit[] = [];
    let degradation: string | null = null;

    if (embedded.degraded || queryVector === undefined) {
      degradation = embedded.reason ?? '向量检索没有拿到查询向量。';
    } else if (model === null) {
      degradation = '没有配置嵌入模型，无法按模型过滤向量。';
    } else {
      const uris = await this.#readableUris(options);
      const raw = await vector.vectors.search({ vector: queryVector, model, uris, limit });
      vectorHits = this.#enrich(raw, options, vector.nodes);
    }

    const fused = reciprocalRankFusion(
      [
        { engine: 'fts5', hits: ftsHits },
        { engine: 'vector', hits: vectorHits },
      ],
      { limit },
    );

    return {
      // 阈值作用在融合分上（见 `find` 的 `scoreThreshold` 语义）。
      hits: this.#applyHotness(
        fused
          .filter(
            (hit: FusedHit) =>
              options.scoreThreshold === undefined || hit.score >= options.scoreThreshold,
          )
          .map((hit: FusedHit) => ({
            uri: hit.uri,
            contextType: hit.contextType,
            memoryType: hit.memoryType,
            level: hit.level,
            abstract: hit.abstract,
            score: hit.score,
            ranks: hit.ranks,
          })),
      ),
      degradation,
    };
  }

  /**
   * 向量检索的候选集：`scope` 下**全部**可读 URI。
   *
   * 不能传 `limit` 条：传少了会漏掉「BM25 排第 50 但向量排第 1」的命中，而 RRF
   * 的意义正是两个后端都有完整候选。代价是每次查询把可读 URI 全查一遍（O(n)），
   * 见 `VECTOR_CANDIDATE_LIMIT` 的说明。
   *
   * 权限过滤在这里完成（`glob` 的 SQL 里就是 `node_permission` 的 allow/deny
   * 谓词），所以传进 `SqliteVectorIndex.search` 的已经是可读集合——向量索引不需要
   * 再查一次权限。
   */
  async #readableUris(options: FindOptions): Promise<readonly string[]> {
    return this.#index.glob({
      pattern: VECTOR_CANDIDATE_PATTERN,
      scopes: options.scopes,
      principals: options.principals,
      limit: VECTOR_CANDIDATE_LIMIT,
    });
  }

  /**
   * 向量命中补全成 `SearchHit`。
   *
   * 向量索引只返回 URI + 分数；`node` 表的 `level` / `abstract` / `context_type` /
   * `memory_type` / `status` 必须补上，否则 §8.6 的分层投放拿不到层级、事件类记忆
   * 会退化成一句话摘要。`node` 行已不存在（索引与磁盘短暂不一致）时跳过——留一条
   * 打不开的命中比少一条更难查。
   *
   * `contextTypes` / `levels` / `status` 在这里过滤：FTS5 在 SQL 里做，向量后端
   * 没有这些列，过滤必须落在补全之后。
   */
  #enrich(
    hits: readonly VectorHit[],
    options: FindOptions,
    nodes: Pick<NodeRepository, 'get'>,
  ): SearchHit[] {
    const enriched: SearchHit[] = [];
    for (const hit of hits) {
      const node = nodes.get(hit.uri);
      if (node === null || node.status !== 'active') {
        continue;
      }
      if (
        options.contextTypes !== undefined &&
        options.contextTypes.length > 0 &&
        !options.contextTypes.includes(node.contextType)
      ) {
        continue;
      }
      if (
        options.levels !== undefined &&
        options.levels.length > 0 &&
        !options.levels.includes(node.level)
      ) {
        continue;
      }
      enriched.push({
        uri: hit.uri,
        level: node.level,
        abstract: node.abstract,
        score: hit.score,
        contextType: node.contextType,
        memoryType: node.memoryType,
      });
    }
    return enriched;
  }

  /**
   * §8.4 的 `search`：先做意图分析（0–5 条 TypedQuery），再逐条 `find` 并合并。
   *
   * 与 `find` 的差别不只是返回体：入口多了一层**重写**。指代（「那它呢」）与复合
   * 意图（「之前那个 X 和 Y」）在 `find` 里只能得到一条字面查询。
   *
   * ## 三条不能静默的路径
   *
   * | 情况 | 结果 |
   * |---|---|
   * | 模型说「不该检索」 | 空命中，`analyzed: true`、`queries: []`——合法结论 |
   * | 分析失败（超时 / 截断 / 不合法） | 降级成单条原 query，`analyzed: false` + `reason` |
   * | 输入过滤后为空 | 空命中，`analyzed: true`，**不调模型**（§8.8） |
   *
   * 降级必须写进 `plan`：控制台要能显示「意图分析不可用，已用原查询」。静默降级
   * 等于骗人。
   *
   * ## limit 语义
   *
   * 每条 TypedQuery 都用**同一个 limit** 取候选，不是 `limit / 条数`：去重之后
   * 可能不足 limit 条，宁可多取再合并。5 条查询各返回 10 条，合并去重后仍然最多
   * `limit` 条。
   */
  async search(query: string, options: SearchOptions): Promise<ScoredSearchResult> {
    const startedAt = process.hrtime.bigint();
    const limit = resolveLimit(options.limit);
    const maxQueries = resolveMaxQueries(options.maxQueries);
    const filtered = applyQueryFilters(query, this.#queryFilters);

    if (filtered === '') {
      const plan: SearchPlan = {
        original: query,
        queries: [],
        analyzed: true,
        reason: null,
        elapsedMs: elapsedMs(startedAt),
      };
      this.#logger.info('检索查询过滤后为空，跳过意图分析', {
        subject: options.subject,
        queryLength: query.length,
        returned: 0,
        durationMs: plan.elapsedMs,
      });
      return { hits: [], plan };
    }

    const analysis = await this.#analyze(filtered, options, maxQueries);

    if (analysis.queries.length === 0) {
      const plan: SearchPlan = {
        original: query,
        queries: [],
        analyzed: analysis.analyzed,
        reason: analysis.reason,
        elapsedMs: elapsedMs(startedAt),
      };
      this.#logger.info('意图分析判定不该检索，返回空命中', {
        subject: options.subject,
        queryLength: filtered.length,
        returned: 0,
        durationMs: plan.elapsedMs,
      });
      return { hits: [], plan };
    }

    // 并行：5 条查询串行执行会把一次 search 变成 5 倍延迟，而索引查询是可重入的只读。
    const ran = await Promise.all(
      analysis.queries.map(async (typedQuery) => ({
        typedQuery,
        outcome: await this.#findWithOutcome(typedQuery.text, {
          scopes: options.scopes,
          subject: options.subject,
          principals: options.principals,
          contextTypes: options.contextTypes,
          levels: options.levels,
          limit,
          scoreThreshold: options.scoreThreshold,
        }),
      })),
    );

    const hits = mergeHits(ran, limit);
    // 合并去重之后才是「返回给调用方的命中」。5 条 TypedQuery 各记一次会把
    // 写放大乘上查询条数，同一条记忆被多条查询命中时也只该算一次访问。
    this.#recordHits(hits);
    const plan: SearchPlan = {
      original: query,
      queries: analysis.queries,
      analyzed: analysis.analyzed,
      // 向量降级与意图分析失败是两条独立的降级路径，都要能解释。`plan.reason`
      // 是 `SearchPlan` 上唯一能承载「这次为什么不是完整结果」的字段，两条都
      // 非空时拼接，不覆盖任何一条。
      reason: combineReasons(
        analysis.reason,
        ran.map((entry) => entry.outcome.degradation),
      ),
      elapsedMs: elapsedMs(startedAt),
    };
    this.#logger.info('检索完成（含意图分析）', {
      subject: options.subject,
      queryLength: filtered.length,
      queries: analysis.queries.length,
      analyzed: analysis.analyzed,
      returned: hits.length,
      durationMs: plan.elapsedMs,
    });
    return { hits, plan };
  }

  /**
   * 意图分析。**只在这一处**决定 `analyzed` 与 `reason`，降级路径不会散落在
   * 各个调用点。
   *
   * 失败一律降级成「单条原 query」，不重试、不抛错：`search` 是只读路径，检索
   * 本身仍然成立，把一次降级变成一次请求失败是更差的结果。
   */
  async #analyze(
    query: string,
    options: SearchOptions,
    maxQueries: number,
  ): Promise<{
    readonly queries: readonly TypedQuery[];
    readonly analyzed: boolean;
    readonly reason: string | null;
  }> {
    if (this.#llm === undefined) {
      return {
        queries: [fallbackQuery(query)],
        analyzed: false,
        reason: '没有注入 LlmService（SearchServiceDeps.llm），无法做意图分析。',
      };
    }

    const recentMessages = await this.#recentMessages(options.sessionId, options.subject);
    const prompt: LlmPrompt = {
      system: REWRITE_SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: buildRewriteUserPrompt({
            query,
            recentMessages,
            knownScopes: options.scopes,
          }),
        },
      ],
    };

    try {
      const output = await this.#llm.generateJson(prompt, REWRITE_SCHEMA, {
        timeoutMs: REWRITE_TIMEOUT_MS,
      });
      return { queries: output.queries.slice(0, maxQueries), analyzed: true, reason: null };
    } catch (error) {
      // 超时、截断（`details.truncated`）、结构化输出不合法都收敛成 `ComemError`
      // （§19）。三种都不重试：同样的输入与上限只会再失败一次。
      const failure = ComemError.from(error);
      this.#logger.warn('意图分析不可用，已降级为原查询', {
        subject: options.subject,
        code: failure.code,
        message: failure.message,
        truncated: failure.details?.['truncated'] === true,
      });
      return {
        queries: [fallbackQuery(query)],
        analyzed: false,
        reason: `意图分析失败（${failure.code}）：${failure.message}`,
      };
    }
  }

  /**
   * 最近 5 轮（10 条）user / assistant 消息。
   *
   * `tool` 消息要过滤掉（与 §10.1「默认隐藏工具输出」同源）：它又长又噪声，一段
   * 200 行的工具输出会把当前 query 挤出模型的注意力。`system` 同理——它不是对话。
   *
   * 会话读不到（已归档、ID 写错）时按「历史为空」处理并记 warn：历史只影响重写
   * 质量，让整次检索失败代价更大。这不算静默降级——`analyzed` 仍然是 `true`，
   * 因为分析确实跑了，只是没有历史可用。
   */
  async #recentMessages(
    sessionId: string | undefined,
    subject: string,
  ): Promise<readonly RewriteMessage[]> {
    if (sessionId === undefined) {
      return [];
    }
    if (this.#sessions === undefined) {
      this.#logger.warn('没有注入 SessionService，意图分析按「历史为空」处理', { sessionId });
      return [];
    }

    let sessionUri: Uri;
    try {
      sessionUri = sessionUriOf(subject, sessionId);
    } catch (error) {
      this.#logger.warn('会话 ID 无法归属到调用方，意图分析按「历史为空」处理', {
        sessionId,
        code: ComemError.from(error).code,
      });
      return [];
    }

    try {
      const session = await this.#sessions.load(sessionUri);
      return session.messages
        .filter(isConversational)
        .slice(-RECENT_MESSAGES)
        .map((message) => ({ role: message.role, text: renderMessageText(message) }));
    } catch (error) {
      this.#logger.warn('会话不可读，意图分析按「历史为空」处理', {
        sessionId,
        code: ComemError.from(error).code,
      });
      return [];
    }
  }

  /**
   * §8.4 的 `grep`：正则 + 路径范围，行级命中带前后文。
   *
   * 先 `index.glob` 拿权限过滤后的候选，再逐个读文件做行匹配（见文件头）。候选
   * 文件数超过 `GREP_CANDIDATE_LIMIT` 时记 warn 并截断——截断必须留痕，否则
   * 用户会以为「没有更多命中」。
   *
   * `contextTypes` / `levels` 不生效：`GlobQuery` 只有「路径 + 权限」两个过滤维度，
   * 而 `NodeStat` 不带层级。要支持它们得给索引加一个「按元数据取 URI」的查询，
   * 超出本服务的职责。
   */
  async grep(
    pattern: string,
    options: FindOptions & { readonly contextLines?: number },
  ): Promise<readonly GrepHit[]> {
    const startedAt = process.hrtime.bigint();
    const limit = resolveLimit(options.limit);
    const contextLines = options.contextLines ?? DEFAULT_CONTEXT_LINES;
    if (!Number.isInteger(contextLines) || contextLines < 0) {
      throw new ComemError('INVALID_ARGUMENT', 'contextLines 必须是非负整数。', { contextLines });
    }

    let regex: RegExp;
    try {
      regex = new RegExp(pattern);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new ComemError('INVALID_ARGUMENT', `grep 的正则不合法：${reason}`, {
        pattern,
        reason,
      });
    }

    // 多要一条用来判断「是否被截断」，不能只看返回条数是否等于上限。
    const candidates = await this.#index.glob({
      pattern: GREP_CANDIDATE_PATTERN,
      scopes: options.scopes,
      principals: options.principals,
      limit: GREP_CANDIDATE_LIMIT + 1,
    });
    if (candidates.length > GREP_CANDIDATE_LIMIT) {
      this.#logger.warn('grep 候选文件数超过上限，已截断', {
        candidates: candidates.length,
        limit: GREP_CANDIDATE_LIMIT,
      });
    }

    const hits: GrepHit[] = [];
    let scanned = 0;
    for (const value of candidates.slice(0, GREP_CANDIDATE_LIMIT)) {
      if (hits.length >= limit) {
        break;
      }
      const uri = Uri.tryParse(value);
      if (uri === null) {
        continue;
      }
      scanned += 1;

      let text: string;
      try {
        text = (await this.#filesystem.read(uri)).text;
      } catch (error) {
        // 索引与磁盘短暂不一致（刚删、刚移动）是正常状态：跳过这一条，
        // 不打断整次 grep。权限在 filesystem 里已经拒过，同样跳过。
        if (error instanceof ComemError) {
          this.#logger.warn('grep 跳过不可读的候选', {
            uri: value,
            code: error.code,
          });
          continue;
        }
        throw error;
      }

      // 文件末尾的换行是**行终止符**，不是「多一个空行」：不摘掉的话，末尾为换行的
      // 文件会凭空多出一行（`grep -n` 不会）。只摘一个，全文为空的文件仍然算一行。
      const lines = text.replace(/\r?\n$/, '').split(/\r?\n/);
      for (const [index, line] of lines.entries()) {
        if (!regex.test(line)) {
          continue;
        }
        hits.push({
          uri: value,
          line: index + 1,
          text: line,
          before: lines.slice(Math.max(0, index - contextLines), index),
          after: lines.slice(index + 1, index + 1 + contextLines),
        });
        if (hits.length >= limit) {
          break;
        }
      }
    }

    this.#logger.info('grep 完成', {
      subject: options.subject,
      patternLength: pattern.length,
      files: scanned,
      returned: hits.length,
      durationMs: elapsedMs(startedAt),
    });
    return hits;
  }

  /**
   * §8.4 的 `glob`：路径通配。
   *
   * 索引层已经按 `node_permission` 过滤过（§8.2），这里仍然再过一遍
   * `authorizer.filterReadable`：服务层不能依赖索引实现的自觉（§12.4 的出口清单
   * 是按出口数的）。顺带把 URI 规范化成 `Uri.toString()` 的形态再返回。
   */
  async glob(pattern: string, options: FindOptions): Promise<readonly string[]> {
    const startedAt = process.hrtime.bigint();
    const limit = resolveLimit(options.limit);
    const matched = await this.#index.glob({
      pattern,
      scopes: options.scopes,
      principals: options.principals,
      limit,
    });

    const candidates: Uri[] = [];
    for (const value of matched) {
      const uri = Uri.tryParse(value);
      if (uri !== null) {
        candidates.push(uri);
      }
    }
    const readable = await this.#authorizer.filterReadable(candidates);
    const result = candidates
      .map((uri) => uri.toString())
      .filter((value) => readable.has(value));

    this.#logger.info('glob 完成', {
      subject: options.subject,
      patternLength: pattern.length,
      matched: matched.length,
      returned: result.length,
      durationMs: elapsedMs(startedAt),
    });
    return result;
  }

  /**
   * §8.6 的 `context` 变体：返回可直接注入模型的文本。
   *
   * `find` → `AssemblyCandidate[]` →（可选）账本去重 → 组装。
   *
   * `memoryType` 从索引透传：§8.6 的起始层级按记忆类型区分（`events` 从 L1 概览起，
   * 其余从 L0 摘要起）。少了这一列，事件类记忆会一律退化成一句话摘要。
   */
  async context(query: string, options: ContextOptions): Promise<ContextAssembly> {
    const startedAt = process.hrtime.bigint();
    const hits = await this.find(query, options);
    const candidates: AssemblyCandidate[] = hits.map((hit) => ({
      uri: hit.uri,
      contextType: hit.contextType,
      memoryType: hit.memoryType,
      level: hit.level,
      score: hit.score,
      abstract: hit.abstract,
    }));

    const assembly: AssemblyOptions = {
      maxTokens: this.#config.assembly.maxTokens,
      quotaPreset: options.quotaPreset ?? this.#config.assembly.quotaPreset,
      excludedUris: await this.#excludedUris(options.excludeDelivered),
    };
    const result = await this.#assembler.assemble(candidates, assembly);

    this.#logger.info('上下文组装完成', {
      subject: options.subject,
      queryLength: query.length,
      candidates: candidates.length,
      items: result.items.length,
      tokensUsed: result.tokensUsed,
      durationMs: elapsedMs(startedAt),
    });
    return result;
  }

  /**
   * 层级加权 + 截断（§8.5），再做 `scoreThreshold` 过滤。
   *
   * `rankCandidates` 只排序不去重，所以用「下标当身份」把排名结果映射回原始命中：
   * 同一个 URI 可能同时命中 L0 与 L2 两条记录，用 URI 当键会把它们合并成一条。
   * 索引返回的条数已经不超过 `limit`，因此「先截断再按阈值过滤」与「先过滤再截断」
   * 结果相同。
   */
  #rank(
    hits: readonly SearchHit[],
    limit: number,
    scoreThreshold: number | undefined,
  ): ScoredHit[] {
    const ranked = rankCandidates(
      hits.map((hit, index) => ({
        uri: hit.uri,
        level: hit.level,
        score: hit.score,
        rendered: String(index),
      })),
      limit,
      this.#config.levelWeights,
    );

    const byHandle = new Map<string, SearchHit>();
    for (const [index, hit] of hits.entries()) {
      byHandle.set(String(index), hit);
    }

    return toScoredHits(ranked, byHandle, scoreThreshold);
  }

  /**
   * 热度加权（架构文档 §17.5 的 `telemetry.hotness.weight`）。
   *
   * `finalScore = score × (1 + weight × hotnessAsFactor)`，`hotness ∈ [0, 1]`。
   *
   * **为什么是乘性而不是加性**：RRF 融合分是 `0.016–0.033` 量级，热度是 `[0,1]`。
   * 加法会让热度完全压过相关性——一条 30 天没访问、只被单路命中的记忆，加 0.3 就
   * 排到了双路第一前面。乘性保住「先按相关性排序，热度只在同档次内做区分」。
   *
   * **为什么不用归一化后线性混合**：RRF 分数没有绝对尺度，归一化等于每次查询按
   * 当前结果集重新缩放；多返回一条结果就会改变所有分数，「为什么这条排第一」无法
   * 复现。乘性不依赖结果集。
   *
   * `weight === 0`（默认）时**不查库**：默认部署是绝大多数，多一次 SQL 全是浪费。
   * 此时 `hotness` 恒为 `null`，与接线前的行为逐字一致。
   *
   * 输入已经是「本引擎相关性排序并截断」的结果，这里只重排：热度不能把一条没进
   * 候选集的记忆拉进来（那等于让热度决定相关性）。
   */
  #applyHotness(hits: readonly PreHotnessHit[]): RankedScoredHit[] {
    const stats = this.#accessStats;
    if (this.#hotnessWeight === 0 || stats === undefined) {
      return hits.map((hit) => ({ ...hit, hotness: null }));
    }
    if (hits.length === 0) {
      return [];
    }

    // 同一个 URI 可能同时命中 L0 与 L2 两条记录（见 `#rank`），去重后再查。
    const uniqueUris = [...new Set(hits.map((hit) => hit.uri))];
    const byUri = new Map(stats(uniqueUris).map((row) => [row.uri, row]));
    const now = new Date();

    const weighted: RankedScoredHit[] = hits.map((hit) => {
      const row = byUri.get(hit.uri);
      if (row === undefined) {
        // 索引里有、`node` 表里没有：数据不一致。热度按「没算」处理，但分数保持
        // 原样——不能因为少了一行统计就把这条命中从结果里抹掉。
        return { ...hit, hotness: null };
      }
      const hotness = hotnessScore({
        activeCount: row.accessCount,
        lastAccessedAt: row.lastAccessedAt,
        now,
        halfLifeDays: this.#hotnessHalfLifeDays,
      });
      return { ...hit, score: hit.score * (1 + this.#hotnessWeight * hotness), hotness };
    });

    return weighted.sort(compareRankedHits);
  }

  /**
   * 把「这次真正返回给调用方的命中」记一次访问（§17.5 的热度输入）。
   *
   * **不 await**：一次查询 50 条就是 50 次 UPDATE（`recordAccess` 一个写事务）。
   * 检索是只读路径，让调用方等写入会把它变成写路径；写失败只记 warn，不该让检索
   * 失败——热度是治理指标，不是检索正确性的一部分。
   *
   * **`weight === 0` 不写**：默认部署不承担写放大。`weight` 一旦为 0，热度本来
   * 也不参与排序，记了没有任何读者。
   *
   * 入参是最终返回的命中（已去重、已截断），不是候选集全集。
   */
  #recordHits(hits: readonly { readonly uri: string }[]): void {
    const record = this.#recordAccess;
    if (this.#hotnessWeight === 0 || record === undefined || hits.length === 0) {
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
  async #excludedUris(
    delivered: ContextOptions['excludeDelivered'],
  ): Promise<ReadonlySet<string> | undefined> {
    if (delivered === undefined) {
      return undefined;
    }
    if (this.#ledger === undefined) {
      throw new ComemError(
        'INVALID_ARGUMENT',
        'excludeDelivered 需要注入召回账本（SearchServiceDeps.ledger）。',
        { scopeKey: delivered.scopeKey, turn: delivered.turn },
      );
    }
    return this.#ledger.recentlyDelivered(delivered.scopeKey, delivered.turn, {
      dedupTurns: this.#config.assembly.dedupTurns,
      maxEntries: DEFAULT_RECALL_LEDGER_OPTIONS.maxEntries,
    });
  }
}

/**
 * 热度加权后的排序比较器：`finalScore` 降序 → `hotness` 降序（`null` 最后）→ URI 升序。
 *
 * 后两级是**稳定性**：同分同热度的两条命中，不同次查询不能换顺序。URI 用码点序
 * 比较（`<` / `>`），与 `domain/ranking.ts` 的 `compareCandidates` 同一套口径，
 * 不依赖运行环境的 ICU 数据。
 *
 * `null` 用 `-1` 兜：热度分落在 `[0, 1]`，`-1` 比任何算出来的分都小。
 */
function compareRankedHits(left: RankedScoredHit, right: RankedScoredHit): number {
  if (right.score !== left.score) {
    return right.score - left.score;
  }
  const leftHotness = left.hotness ?? -1;
  const rightHotness = right.hotness ?? -1;
  if (rightHotness !== leftHotness) {
    return rightHotness - leftHotness;
  }
  if (left.uri === right.uri) {
    return 0;
  }
  return left.uri < right.uri ? -1 : 1;
}

function toScoredHits(
  ranked: readonly RankedCandidate[],
  byHandle: ReadonlyMap<string, SearchHit>,
  scoreThreshold: number | undefined,
): ScoredHit[] {
  const result: ScoredHit[] = [];
  for (const entry of ranked) {
    if (scoreThreshold !== undefined && entry.score < scoreThreshold) {
      continue;
    }
    const hit = byHandle.get(entry.rendered);
    if (hit === undefined) {
      continue;
    }
    result.push({
      uri: hit.uri,
      contextType: hit.contextType,
      memoryType: hit.memoryType,
      level: hit.level,
      abstract: hit.abstract,
      score: entry.score,
    });
  }
  return result;
}

/** 参与意图分析的消息角色。`tool` / `system` 不参与（见 `#recentMessages`）。 */
function isConversational(message: SessionMessage): boolean {
  return message.role === 'user' || message.role === 'assistant';
}

/**
 * 会话 URI：`comem://user/{uid}/sessions/{sessionId}`（§6.5）。
 *
 * 身份来自 `options.subject`，与路由层 `scopeOfSubject` 是同一份推导：`sessionId`
 * 只在它所属的作用域内唯一，拿它去拼 group 根会读到别人的会话。
 */
function sessionUriOf(subject: string, sessionId: string): Uri {
  const principal = parsePrincipal(subject);
  if (principal.kind !== 'user') {
    throw new ComemError('INVALID_ARGUMENT', `会话只能归属 user 主体：${subject}`, { subject });
  }
  return Uri.parse(`comem://user/${principal.id}`).child(SESSIONS_DIRECTORY_NAME, sessionId);
}

/**
 * 降级用的单条查询。
 *
 * `intent` 落 `other`（没有分类），`confidence` 记 1：兜底查询不经过模型，「置信
 * 度」在这里没有含义，但它在语义上**一定执行**，取 0 会让按置信度排序的调用方把
 * 降级结果当成「可丢弃」。
 */
function fallbackQuery(query: string): TypedQuery {
  return { text: query, intent: 'other', confidence: 1, derivedFrom: null };
}

/**
 * 合并多条 TypedQuery 的命中（§8.4 第 5 步）。
 *
 * 按 URI 去重、**保留最高分**，同时记下「哪条 TypedQuery 命中的」。同一个 URI
 * 可能被多条查询命中：重写后的文本不同，BM25 分数不同，取高的那条才反映最好的
 * 一次匹配。降序 + `slice(0, limit)` 与 `find` 的 `rankCandidates` 是同一套口径。
 */
function mergeHits(
  ran: readonly { readonly typedQuery: TypedQuery; readonly outcome: RetrieveOutcome }[],
  limit: number,
): ScoredSearchHit[] {
  const byUri = new Map<string, ScoredSearchHit>();
  for (const { typedQuery, outcome } of ran) {
    for (const hit of outcome.hits) {
      const existing = byUri.get(hit.uri);
      if (existing !== undefined && existing.score >= hit.score) {
        continue;
      }
      byUri.set(hit.uri, {
        uri: hit.uri,
        contextType: hit.contextType,
        memoryType: hit.memoryType,
        level: hit.level,
        abstract: hit.abstract,
        score: hit.score,
        // 名次跟着命中的那条查询走：同一个 URI 被两条查询命中时，保留分数更高
        // 的那次的 `ranks`，与 `score` / `matchedQuery` 同一套「取最好一次」口径。
        ranks: hit.ranks,
        matchedQuery: typedQuery.text,
      });
    }
  }
  return [...byUri.values()].sort((left, right) => right.score - left.score).slice(0, limit);
}

/**
 * 合并「意图分析降级」与「向量降级」两条原因。
 *
 * 两条都非空时拼接，不覆盖：它们回答的是不同问题（查询重写不可用 / 语义检索
 * 不可用），只保留一条会让排查的人以为另一条没发生。去重是必要的——5 条
 * TypedQuery 同时降级时原因完全相同，拼 5 遍只会让消息不可读。
 */
function combineReasons(
  analysisReason: string | null,
  degradations: readonly (string | null)[],
): string | null {
  const reasons: string[] = [];
  if (analysisReason !== null) {
    reasons.push(analysisReason);
  }
  for (const degradation of degradations) {
    if (degradation !== null && !reasons.includes(degradation)) {
      reasons.push(degradation);
    }
  }
  return reasons.length === 0 ? null : reasons.join('；');
}
