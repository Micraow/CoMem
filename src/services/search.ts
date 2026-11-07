/**
 * 检索服务编排（架构文档 §8.3–§8.8、§12.4）。
 *
 * 四个检索面，各自解决一个访问路径：
 *
 * | 面 | 输入 | 返回 | 走索引 |
 * |---|---|---|---|
 * | `find` | 单条 query | 命中列表（uri / level / abstract / score） | 是（FTS5） |
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

import {
  type AssemblyCandidate,
  type AssemblyOptions,
  type AssemblyResult,
  type QuotaPreset,
} from '../domain/assembly.js';
import { ComemError } from '../domain/errors.js';
import type { Level } from '../domain/level.js';
import type { Logger } from '../domain/log.js';
import type { ContextType } from '../domain/node.js';
import { rankCandidates, type LevelWeights, type RankedCandidate } from '../domain/ranking.js';
import {
  applyQueryFilters,
  compileQueryFilters,
  type QueryFilter,
} from '../domain/query-filter.js';
import type { RetrievalIndex, GrepHit, SearchHit } from '../domain/retrieval.js';
import { Uri } from '../domain/uri.js';

import type { Authorizer } from './authorizer.js';
import type { ContextAssembler } from './context-assembler.js';
import type { FileSystemService } from './filesystem.js';
import { DEFAULT_RECALL_LEDGER_OPTIONS, type RecallLedger } from './recall-ledger.js';

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

/** `context` 变体的返回值就是组装结果（§8.6 的四步产物）。 */
export type ContextAssembly = AssemblyResult;

/**
 * 默认返回条数。
 *
 * 20：经验值，来源未知。§8.4 / §8.5 没给默认值；§13.2 的 MCP `find` 工具默认 10，
 * 服务层取 20 给工具层留截断余量（工具可以再取前 10 条，反过来拿不到）。
 */
const DEFAULT_RESULT_LIMIT = 20;

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

/** 1 毫秒 = 1e6 纳秒。 */
const NANOSECONDS_PER_MILLISECOND = 1_000_000;

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

export class SearchService {
  readonly #index: RetrievalIndex;
  readonly #filesystem: FileSystemService;
  readonly #authorizer: Authorizer;
  readonly #assembler: ContextAssembler;
  readonly #logger: Logger;
  readonly #config: RetrievalSettings;
  readonly #ledger: Pick<RecallLedger, 'recentlyDelivered'> | undefined;
  readonly #queryFilters: readonly QueryFilter[];

  constructor(deps: SearchServiceDeps) {
    this.#index = deps.index;
    this.#filesystem = deps.filesystem;
    this.#authorizer = deps.authorizer;
    this.#assembler = deps.assembler;
    this.#logger = deps.logger;
    this.#config = deps.config;
    this.#ledger = deps.ledger;
    // 配置错误在装配期抛出，不是首次查询时——那时已经有人等着结果了。
    this.#queryFilters = compileQueryFilters(deps.config.queryFilters);
  }

  /**
   * §8.4 的 `find`：单条 query，不做意图分析。
   *
   * 过滤后为空**直接返回空数组，不调索引**：空查询没有「相关」可比，任何实现给出
   * 的结果都是随机的，而这些随机结果会被当成「用户这句话对应的记忆」写进召回账本
   * （§8.8）。
   *
   * `scoreThreshold` 在层级加权之后过滤（§8.5）——传给索引的话比较的是未加权分，
   * 会把「L0 加权后过线」的条目错杀。
   */
  async find(query: string, options: FindOptions): Promise<readonly ScoredHit[]> {
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
      return [];
    }

    const hits = await this.#index.search({
      text: filtered,
      scopes: options.scopes,
      principals: options.principals,
      contextTypes: options.contextTypes,
      levels: options.levels,
      limit,
    });

    const result = this.#rank(hits, limit, options.scoreThreshold);
    this.#logger.info('检索完成', {
      subject: options.subject,
      queryLength: filtered.length,
      returned: result.length,
      durationMs: elapsedMs(startedAt),
    });
    return result;
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
