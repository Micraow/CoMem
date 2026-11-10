/**
 * 负责：检索服务的对外类型，以及 `retrieval/` 目录内部的中间结构。
 * 不负责：任何行为——本文件只有类型声明，没有运行期代码。
 */

import type { NodeAccessStats, NodeRepository } from '../../adapters/sqlite/node-repository.js';
import type { SqliteVectorIndex } from '../../adapters/sqlite/vector-index.js';
import type { AssemblyResult, QuotaPreset } from '../../domain/assembly.js';
import type { ComemErrorCode } from '../../domain/errors.js';
import type { Level } from '../../domain/level.js';
import type { Logger } from '../../domain/log.js';
import type { ContextType } from '../../domain/node.js';
import type { LevelWeights } from '../../domain/ranking.js';
import type { RerankProvider } from '../../domain/rerank.js';
import type {
  RetrievalEngine,
  RetrievalIndex,
  SearchPlan,
  SearchResultHit,
} from '../../domain/retrieval.js';
import type { Authorizer } from '../authorizer.js';
import type { ContextAssembler } from '../context-assembler.js';
import type { EmbeddingService } from '../embedding.js';
import type { FileSystemService } from '../filesystem.js';
import type { LlmService } from '../llm.js';
import type { RecallLedger } from '../recall-ledger.js';
import type { SessionService } from '../session.js';

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

/**
 * 重排降级原因。取值与 `adapters/llm/rerank-provider.ts` 的错误映射一一对应：
 *
 * - `timeout`：`AbortController` 超时（`details.timeout === true`）；
 * - `http_5xx`：供应商回了 5xx（`details.statusCode >= 500`）；
 * - `network`：连不上（fetch 抛 `TypeError`，没有状态码）；
 * - `other`：4xx 配置错误（API Key、模型名、请求体）与其它未分类异常。
 *
 * 分开是为了让「调大超时」与「换 API Key」在日志里一眼能分辨——两者的处置完全不同。
 */
export type RerankFailureReason = 'timeout' | 'network' | 'http_5xx' | 'other';

/**
 * 最近一次重排失败。进程内状态，不落盘：重排是质量增强，失败只影响这一次检索。
 *
 * **它必须可见**（§17.9 的「降级不静默」）：配了重排但一半查询超时退化成融合分
 * 的部署，比明确报错的部署难发现得多。
 */
export interface RerankFailure {
  /** 失败时刻（ISO 8601） */
  readonly at: string;
  readonly reason: RerankFailureReason;
  /** 模型调用耗时（毫秒）。不含候选正文读取——那部分失败走自己的 warn */
  readonly durationMs: number;
  /** 这次送去重排的候选条数（`providers.rerank.topN` 截断后的实际条数） */
  readonly topN: number;
  readonly code: ComemErrorCode;
  readonly message: string;
}

/**
 * 重排健康度（`/health` 与 MCP `health` 读它）。
 *
 * `failures` 是进程启动以来的累计失败次数；`lastFailure` 在最近一次调用成功后清空，
 * 所以 `degraded` 回答的是「**现在**重排还在不在跑」，`failures` 保留「间歇性失败过
 * 几次」——两者缺一不可：只看累计次数会把一次启动抖动永久标成降级，只看当前状态
 * 又看不出 30% 的查询在超时。
 */
export interface RerankHealth {
  /** 是否配置了重排（`retrieval.rerank.enabled` 且 `providers.rerank` 可用） */
  readonly configured: boolean;
  /** 最近一次重排调用是否失败（失败即退化成融合分） */
  readonly degraded: boolean;
  readonly failures: number;
  readonly lastFailure: RerankFailure | null;
}

export interface SearchServiceDeps {
  readonly index: RetrievalIndex;
  readonly filesystem: FileSystemService;
  readonly authorizer: Authorizer;
  readonly assembler: ContextAssembler;
  readonly logger: Logger;
  readonly config: RetrievalSettings;
  /**
   * 召回账本（§8.7）。`context` 的跨轮去重读它，组装完成后把真正投出去的条目
   * 写回它。不注入时不做跨轮去重——账本是去重辅助，不是检索的真相来源。
   */
  readonly ledger?: Pick<RecallLedger, 'recentlyDelivered' | 'record'>;
  /**
   * 重排（`retrieval.rerank.*` / `providers.rerank.*`）。
   *
   * 不注入时整条重排路径不执行，行为与接线前逐字一致（默认关）。`topN` 是送去
   * 重排的条数上限；`keepTopN` 是重排后保留的条数（0 = 不截断）。
   */
  readonly rerank?: {
    readonly provider: RerankProvider;
    readonly topN: number;
    readonly keepTopN: number;
  };
  /**
   * 意图分析（§8.4）。只有 `search` 用到。
   *
   * 不注入时 `search` 仍然可用：降级成单条原 query，`plan.analyzed = false` 且
   * `plan.reason` 写明原因。降级不静默（§17.9 的同一原则）——但也不该因为「没有
   * 模型」让整条只读路径不可用。
   */
  readonly llm?: Pick<LlmService, 'generateJson'>;
  /**
   * 会话服务，两个用途：
   *
   * - `load`：最近消息的来源（§8.4 的「用 session」）。只用来解析指代（「那它呢」）。
   *   不注入时按「历史为空」处理：查询仍然会重写，只是省略的主语补不回来。
   * - `totalMessageCount`：跨轮去重的轮次时钟（§8.7）。**不能换成 `load` 的
   *   `messageCount`**：那是 live 未提交条数（`shouldAutoCommit` 的判据），提交后
   *   归零，时钟会倒退。
   */
  readonly sessions?: Pick<SessionService, 'load' | 'totalMessageCount'>;
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
   * `memoryType`）从 `node` 表补。没有它 `SearchHit` 就是半成品。
   * 归档状态不在这里补：候选集已由 `index.glob` 的 SQL 过滤。
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
  readonly hotnessWeight: number;
  /** 半衰期（小时）。`telemetry.hotness.halfLifeHours`，默认 168（一周）。 */
  readonly hotnessHalfLifeHours: number;
  /** 读访问统计。缺省时不做热度计算（`hotness` 恒为 `null`）。 */
  readonly accessStats?: (uris: readonly string[]) => readonly NodeAccessStats[];
  /**
   * 累加访问计数（`NodeRepository.recordAccess`）。
   *
   * **只要真的进入了调用方的上下文就调用，与 `hotnessWeight` 无关**：
   * `last_accessed_at` 有两个读者——热度排序（`hotnessWeight` 控制）与 TTL 清扫的
   * 滑动窗口（§11.7，没有开关）。按权重决定写不写，会让默认部署（`weight = 0`）的
   * 检索命中对 TTL 不可见。`find` / `search` 记返回的命中，`mode=context` 记组装后
   * 注入的条目；调用**不 await**（见 `delivery.ts` 的 `recordHits`）。缺省时不记：
   * 只读部署没有这个写端口。
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
  /**
   * 只看这些记忆类型（`node.memory_type`），**下推到索引的 SQL**。
   *
   * 省略或空数组 = 不按类型过滤。给了类型就没有候选被「先取 limit 条再筛」挤掉：
   * `rule_search` 传 `['rules']`，偏好与实体在 SQL 里就被排除。
   */
  readonly memoryTypes?: readonly string[];
  /** 更新时间下界，闭区间（`updated_at >= updatedAfter`），ISO 8601。同样下推到 SQL。 */
  readonly updatedAfter?: string;
  /** 更新时间上界，闭区间（`updated_at <= updatedBefore`），ISO 8601。 */
  readonly updatedBefore?: string;
  readonly limit?: number;
  /**
   * 本次查询的**墙上时钟**上限（epoch 毫秒），由接口层（MCP 工具）注入。
   *
   * 与 `providers.*.timeoutSeconds` 不是一件事：那个是单次外部调用的预算，这里是
   * 一次工具调用的总预算。省略时不做工具级收窄，行为与接线前逐字一致（HTTP /
   * Hook 路径）。给了它，查询嵌入与重排的预算按剩余时间截断，并且**先降级再谈
   * 失败**：向量拿不到就退 FTS，重排拿不到就用融合分。
   */
  readonly deadlineAt?: number;
  /**
   * 进入一次外部上游前上报，供接口层在到达总上限时归因。
   *
   * 只上报三类真正会打网络的地方（意图分析 / 查询嵌入 / 重排）。本地索引与文件
   * 系统由工具层自己标记，服务层不猜。
   */
  readonly onUpstream?: (upstream: SearchUpstream) => void;
}

/** `onUpstream` 的上报取值（见 `FindOptions.onUpstream`）。 */
export type SearchUpstream = 'llm' | 'embedding' | 'rerank';

export interface SearchOptions extends FindOptions {
  /** 会话 ID。有它才能解析指代；没有也能分析，只是历史为空 */
  readonly sessionId?: string;
}

export interface ContextOptions extends FindOptions {
  /**
   * 会话 ID。跨轮去重的轮次时钟（§8.7）取该会话的累计消息数。
   *
   * 不传时不做跨轮去重：没有会话就没有东西能推进 `turn`，用常量会让账本在
   * 500 条之后永久排除所有候选——那是静默失效，比不去重更糟。组装本身照常工作。
   */
  readonly sessionId?: string;
}

/**
 * 跨轮去重的时钟（§8.7）。
 *
 * `scopeKey` 决定账本文件（按作用域分片），`sessionId` 决定文件里哪些条目参与
 * 本次去重，`turn` 决定去重窗口。
 *
 * `turn` 取会话的**累计**消息数（`SessionService.totalMessageCount`：已归档 +
 * live）。`Session.messageCount` 是 live 未提交条数、`SessionMessage.turn` 是 live
 * 窗口内序号，两者提交后都会倒退，不能当时钟。
 */
export interface DeliveryClock {
  readonly scopeKey: string;
  readonly sessionId: string;
  readonly turn: number;
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
export type PreHotnessHit = ScoredHit & {
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

/** 一次 `find` 的内部产物：命中 + 各上游的降级原因。 */
export interface RetrieveOutcome {
  readonly hits: readonly RankedScoredHit[];
  /** 向量后端降级原因；`null` 表示这次没有降级 */
  readonly degradation: string | null;
  /** 本次重排是否失败（失败即用融合分）；`null` 表示没配重排、没命中或调用成功 */
  readonly rerankFailure: RerankFailure | null;
}

/**
 * `findWithDiagnostics` 的返回体。
 *
 * 降级必须能被出口读到（§17.9）：`find` 的旧返回类型只有命中，向量不可用时
 * `Found 0` 与「记忆里没有」无法区分。MCP 工具用这个变体输出 `Degraded:` 行；
 * 只要命中的调用方继续用 `find`，行为不变。
 */
export interface FindDiagnostics {
  readonly hits: readonly RankedScoredHit[];
  readonly degradation: string | null;
  readonly rerankFailure: RerankFailure | null;
}

/** 向量检索需要的三个依赖。构造期保证 `engine !== 'fts5'` 时非空。 */
export interface VectorRetrievalDeps {
  readonly embedding: Pick<EmbeddingService, 'embed' | 'available' | 'model'>;
  readonly vectors: Pick<SqliteVectorIndex, 'search'>;
  readonly nodes: Pick<NodeRepository, 'get'>;
}

/** `context` 变体的返回值就是组装结果（§8.6 的四步产物）。 */
export type ContextAssembly = AssemblyResult;
