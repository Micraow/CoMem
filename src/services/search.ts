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

import { parsePrincipal } from '../domain/acl.js';
import {
  type AssemblyCandidate,
  type AssemblyOptions,
  type AssemblyResult,
  type QuotaPreset,
} from '../domain/assembly.js';
import { ComemError } from '../domain/errors.js';
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
  type GrepHit,
  type RetrievalIndex,
  type SearchHit,
  type SearchPlan,
  type SearchResult,
  type SearchResultHit,
  type TypedQuery,
} from '../domain/retrieval.js';
import { renderMessageText, type SessionMessage } from '../domain/session.js';
import { Uri } from '../domain/uri.js';

import type { Authorizer } from './authorizer.js';
import type { ContextAssembler } from './context-assembler.js';
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
  async search(query: string, options: SearchOptions): Promise<SearchResult> {
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
        hits: await this.find(typedQuery.text, {
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
    const plan: SearchPlan = {
      original: query,
      queries: analysis.queries,
      analyzed: analysis.analyzed,
      reason: analysis.reason,
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
  ran: readonly { readonly typedQuery: TypedQuery; readonly hits: readonly ScoredHit[] }[],
  limit: number,
): SearchResultHit[] {
  const byUri = new Map<string, SearchResultHit>();
  for (const { typedQuery, hits } of ran) {
    for (const hit of hits) {
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
        matchedQuery: typedQuery.text,
      });
    }
  }
  return [...byUri.values()].sort((left, right) => right.score - left.score).slice(0, limit);
}
