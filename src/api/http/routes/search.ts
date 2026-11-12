/**
 * 检索路由（架构文档 §14、§8.4、§12.4）。
 *
 * 四个面与 `SearchService` 一一对应：
 *
 * | 路由 | 服务方法 | 返回 |
 * |---|---|---|
 * | `POST /search/find` | `find` | 命中列表（uri / level / abstract / score） |
 * | `POST /search/search` | `search` | 命中列表 + 查询计划（意图分析产出的 TypedQuery） |
 * | `POST /search/grep` | `grep` | 行级命中，带行号与前后文 |
 * | `POST /search/glob` | `glob` | 文件 URI 列表 |
 *
 * **`/search/search` 与 `/search/find` 的差别不是返回体形状。** 前者先做意图分析
 * （§8.4）：模型把 query 重写成 0–5 条 TypedQuery，服务层逐条检索再合并。计划里
 * 的 `analyzed` / `reason` 是排查「重写为什么没生效」的唯一入口——**故意不回传
 * `sessionId`**：它是调用方的入参，回传只会让它出现在不该出现的日志与界面上。
 *
 * `grep` / `glob` 的范围必须先求 read 权限再调服务：`SearchService.glob` 只做
 * `filterReadable`，不抛 `PERMISSION_DENIED`——它挡的是「结果里出现无权节点」，
 * 挡不住「一个无权目录被当成根扫一遍」。§12.4 的出口清单按出口数，这一道不能省。
 *
 * ## 三个会调模型的端点有总上限
 *
 * `find` / `search` / `mode=context` 内部走意图分析、查询嵌入与重排，三段供应商
 * 超时叠起来可能是几分钟（`providers.*.timeoutSeconds` 写 3600 也合法）。它们与
 * MCP 的同名工具共用 `API_CALL_DEADLINE_MS`（`api/deadline.ts`）：到点返回 503
 * `PROVIDER_UNAVAILABLE` 的错误封套（`details.timeout = true`），**不回落到空
 * 结果**。`grep` / `glob` 不调模型，没有这一层。
 */

import type { FastifyInstance } from 'fastify';

import type { AssembledItem } from '../../../domain/assembly.js';
import type { Level } from '../../../domain/level.js';
import type { ContextType } from '../../../domain/node.js';
import type { ContextDetail } from '../../../domain/render.js';
import type {
  GrepHit,
  SearchPlan,
  SearchResultHit,
  TypedQueryIntent,
} from '../../../domain/retrieval.js';
import type { ScoredHit } from '../../../services/search.js';
import { API_CALL_DEADLINE_MS } from '../../deadline.js';
import { DEFAULT_SEARCH_LIMIT } from '../../../services/retrieval/budget.js';
import { ok } from '../envelope.js';
import { requestContextOf } from '../middleware.js';
import {
  optionalInteger,
  optionalString,
  optionalStringArray,
  requireRecord,
  requireString,
  requireUri,
  type HttpRouteGroup,
} from '../server.js';

import type { HttpRouteServices } from './index.js';
import {
  parseContextTypes,
  parseLevels,
  parseMode,
  runRetrieval,
  scopeOfSubject,
} from './search-request.js';

/** §12.1：read = 1（`grep` / `glob` 的范围求权只用这一个级别）。 */
const READ = 1;


/**
 * `search` 的出参形态（§8.6）。
 *
 * `list` 是默认值，保持向后兼容；`context` 返回可直接注入模型的文本与分层明细。
 * 这是同一个 `search` 能力的出参变体，不是第 17 个 MCP 工具。
 */

/** `find` 命中的响应形状（`uri` / 类别 / 层级 / 摘要 / 分数）。 */
interface SerializedHit {
  readonly uri: string;
  readonly contextType: ContextType;
  /**
   * 记忆类型；非记忆节点为 `null`。
   *
   * 保持开放 `string`：记忆类型是配置写进来的（`domain/memory-types` 可扩展），
   * 收窄成字面量联合会让「自定义类型写进去了但读不出来」变成「不存在」。
   */
  readonly memoryType: string | null;
  readonly level: Level;
  readonly abstract: string | null;
  readonly score: number;
}

/** 行级命中：`grep` 的响应形状，带行号与前后文。 */
interface SerializedGrepHit {
  readonly uri: string;
  readonly line: number;
  readonly text: string;
  readonly before: readonly string[];
  readonly after: readonly string[];
}

/**
 * `search` 的命中：`find` 的字段 + 命中的是重写后的哪条查询。
 *
 * `matchedQuery` 不出现在 `/search/find` 的返回里——那条路径没有重写，多一个
 * 恒为空的字段只会让调用方多写一个分支。
 */
interface SerializedSearchHit extends SerializedHit {
  readonly matchedQuery: string;
}

/** 查询计划里的一条类型化查询（§8.4）。 */
interface SerializedTypedQuery {
  readonly text: string;
  readonly intent: TypedQueryIntent;
  readonly confidence: number;
  readonly derivedFrom: string | null;
}

/** 查询计划。`SearchPlan` 本身不含 `sessionId`，回传自然也不会泄漏（§8.4）。 */
interface SerializedPlan {
  readonly original: string;
  readonly queries: readonly SerializedTypedQuery[];
  readonly analyzed: boolean;
  readonly reason: string | null;
  readonly elapsedMs: number;
}

/**
 * `context` 模式的条目：投放层级与渲染后的文本都要回传。
 *
 * `detail === null` 表示只给了 URI（模型没看到正文）；`tokens` 是这一条的 token
 * 成本，`tokensUsed` 是合计——调用方要能解释「预算花在哪」。
 */
interface SerializedAssembledItem {
  readonly uri: string;
  readonly contextType: ContextType;
  readonly level: Level;
  readonly score: number;
  readonly detail: ContextDetail | null;
  readonly text: string;
  readonly tokens: number;
}

/** `POST /search/find` 的响应体。 */
interface SearchFindResponse {
  readonly hits: readonly SerializedHit[];
}

/** `POST /search/search`（`mode=context`）的响应体。 */
interface SearchContextResponse {
  readonly items: readonly SerializedAssembledItem[];
  readonly rendered: string;
  readonly dropped: number;
  readonly usedTokens: number;
}

/** `POST /search/search`（默认 `list` 模式）的响应体。 */
interface SearchResponse {
  readonly hits: readonly SerializedSearchHit[];
  readonly plan: SerializedPlan;
}

/** `POST /search/grep` 的响应体。 */
interface SearchGrepResponse {
  readonly hits: readonly SerializedGrepHit[];
}

/** `POST /search/glob` 的响应体。 */
interface SearchGlobResponse {
  readonly files: readonly string[];
}

function serializeHit(hit: ScoredHit): SerializedHit {
  return {
    uri: hit.uri,
    contextType: hit.contextType,
    memoryType: hit.memoryType,
    level: hit.level,
    abstract: hit.abstract,
    score: hit.score,
  };
}

function serializeGrepHit(hit: GrepHit): SerializedGrepHit {
  return {
    uri: hit.uri,
    line: hit.line,
    text: hit.text,
    before: hit.before,
    after: hit.after,
  };
}

function serializeSearchHit(hit: SearchResultHit): SerializedSearchHit {
  return { ...serializeHit(hit), matchedQuery: hit.matchedQuery };
}

function serializePlan(plan: SearchPlan): SerializedPlan {
  return {
    original: plan.original,
    queries: plan.queries.map((query) => ({
      text: query.text,
      intent: query.intent,
      confidence: query.confidence,
      derivedFrom: query.derivedFrom,
    })),
    analyzed: plan.analyzed,
    reason: plan.reason,
    elapsedMs: plan.elapsedMs,
  };
}

function serializeAssembledItem(item: AssembledItem): SerializedAssembledItem {
  return {
    uri: item.uri,
    contextType: item.contextType,
    level: item.level,
    score: item.score,
    detail: item.detail,
    text: item.text,
    tokens: item.tokens,
  };
}

/**
 * 检索路由只依赖这三个服务。
 *
 * 用 `Pick` 而不是整个 `HttpRouteServices`：测试要构造「模型请求挂住」的替身，
 * 拿不到完整的服务图；收窄之后替身只需要实现这条路真正调用的三个端口，不会因为
 * 别的路由加了一个依赖就编译不过。
 */
export type SearchRouteServices = Pick<
  HttpRouteServices,
  'search' | 'authorizer' | 'observability'
>;

/** `createSearchRoutes` 的装配参数。 */
export interface SearchRouteOptions {
  /**
   * 单次检索请求的墙上时钟上限（毫秒）。默认 `API_CALL_DEADLINE_MS`（`api/deadline.ts`），
   * 与 MCP 工具共用同一个常数。
   *
   * 仅供装配与测试注入；**不是配置项**——把 `providers.*.timeoutSeconds` 调到
   * 3600 也不能把这个上限调大，这正是它存在的理由。
   */
  readonly deadlineMs?: number;
}

export function createSearchRoutes(
  services: SearchRouteServices,
  options: SearchRouteOptions = {},
): HttpRouteGroup {
  const { search, authorizer, observability } = services;
  const deadlineMs = options.deadlineMs ?? API_CALL_DEADLINE_MS;

  return {
    prefix: '/search',
    register(app: FastifyInstance): void {
      app.post<{ Body: unknown }>('/find', async (request) => {
        const body = requireRecord(request.body, 'search/find');
        const context = requestContextOf(request);
        const query = requireString(body, 'query');
        const scope = optionalStringArray(body, 'scopes') ?? [scopeOfSubject(context.subject)];
        const limit = optionalInteger(body, 'limit', DEFAULT_SEARCH_LIMIT, { min: 1 });
        // 参数校验放在计时之前：非法输入不是检索耗时，它该落进未归因间隙。
        const contextTypes = parseContextTypes(optionalStringArray(body, 'contextTypes'));
        const levels = parseLevels(optionalStringArray(body, 'levels'));
        const memoryTypes = optionalStringArray(body, 'memoryTypes');
        const updatedAfter = optionalString(body, 'updatedAfter');
        const updatedBefore = optionalString(body, 'updatedBefore');
        // §17.2 的 `recall`：hook 每轮按回车都等的就是这一段。边界只包检索本身，
        // 后面的响应映射也不算——它们各自是未归因间隙。
        const hits = await runRetrieval(deadlineMs, async (deadline) => {
          // 本地索引 / ACL 阶段：超时归因要说得出「卡在本地」，不能笼统写「检索超时」。
          deadline.mark('index');
          return observability.phase('recall', () =>
            search.find(query, {
              scopes: scope,
              subject: context.subject,
              principals: context.principals,
              contextTypes,
              levels,
              memoryTypes,
              updatedAfter,
              updatedBefore,
              limit,
              deadlineAt: deadline.deadlineAt,
              onUpstream: (upstream) => deadline.mark(upstream),
            }),
          );
        });
        return ok<SearchFindResponse>({ hits: hits.map(serializeHit) });
      });

      app.post<{ Body: unknown }>('/search', async (request) => {
        const body = requireRecord(request.body, 'search/search');
        const context = requestContextOf(request);
        const query = requireString(body, 'query');
        const scope = optionalStringArray(body, 'scopes') ?? [scopeOfSubject(context.subject)];
        const limit = optionalInteger(body, 'limit', DEFAULT_SEARCH_LIMIT, { min: 1 });
        const contextTypes = parseContextTypes(optionalStringArray(body, 'contextTypes'));
        const levels = parseLevels(optionalStringArray(body, 'levels'));
        // 记忆类型 / 更新时间范围：与 MCP `find` / `search` 同名、同类型、同为可选。
        // 它们只收窄候选，不改变出参形状，因此两种 mode 都透传。
        const memoryTypes = optionalStringArray(body, 'memoryTypes');
        const updatedAfter = optionalString(body, 'updatedAfter');
        const updatedBefore = optionalString(body, 'updatedBefore');
        // 会话只用于解析指代（§8.4）；不传也能检索，只是历史为空。
        const sessionId = optionalString(body, 'sessionId');
        const mode = parseMode(optionalString(body, 'mode'));

        if (mode === 'context') {
          // `context` 是同一个 `search` 出参形态的变体（§8.6），不是第 17 个工具。
          // 跨轮去重的时钟由 `sessionId` 推导；不传就不去重（见 `ContextOptions`）。
          //
          // 这段 `recall` **包含上下文组装与渲染**：它们发生在 `SearchService.context`
          // 内部，路由层切不开。§17.2 把「组装 + 序列化」单列为 `serialize`，那一层
          // 只在 hook 里（`formatRecallBlock`）——所以这里不另记一个近乎为 0 的
          // `serialize`，那会让人以为注入序列化已经被量到了。
          const result = await runRetrieval(deadlineMs, async (deadline) => {
            deadline.mark('index');
            return observability.phase('recall', () =>
              search.context(query, {
                scopes: scope,
                subject: context.subject,
                principals: context.principals,
                contextTypes,
                levels,
                memoryTypes,
                updatedAfter,
                updatedBefore,
                limit,
                sessionId,
                deadlineAt: deadline.deadlineAt,
                onUpstream: (upstream) => deadline.mark(upstream),
              }),
            );
          });
          return ok<SearchContextResponse>({
            items: result.items.map(serializeAssembledItem),
            rendered: result.rendered,
            dropped: result.dropped,
            usedTokens: result.tokensUsed,
          });
        }

        const result = await runRetrieval(deadlineMs, async (deadline) => {
          deadline.mark('index');
          return observability.phase('recall', () =>
            search.search(query, {
              scopes: scope,
              subject: context.subject,
              principals: context.principals,
              contextTypes,
              levels,
              memoryTypes,
              updatedAfter,
              updatedBefore,
              limit,
              sessionId,
              deadlineAt: deadline.deadlineAt,
              onUpstream: (upstream) => deadline.mark(upstream),
            }),
          );
        });

        // 查询计划：`analyzed: false` 时看 `reason` 就知道重写为什么没生效。
        return ok<SearchResponse>({
          hits: result.hits.map(serializeSearchHit),
          plan: serializePlan(result.plan),
        });
      });

      app.post<{ Body: unknown }>('/grep', async (request) => {
        const body = requireRecord(request.body, 'search/grep');
        const context = requestContextOf(request);
        const uri = requireUri(body, 'uri');
        const pattern = requireString(body, 'pattern');
        const limit = optionalInteger(body, 'limit', DEFAULT_SEARCH_LIMIT, { min: 1 });
        const contextLines = optionalInteger(body, 'contextLines', 3, { min: 0 });

        await authorizer.assert(uri, READ, context.principals);
        const hits = await search.grep(pattern, {
          scopes: [uri.toString()],
          subject: context.subject,
          principals: context.principals,
          limit,
          contextLines,
        });
        return ok<SearchGrepResponse>({ hits: hits.map(serializeGrepHit) });
      });

      app.post<{ Body: unknown }>('/glob', async (request) => {
        const body = requireRecord(request.body, 'search/glob');
        const context = requestContextOf(request);
        const uri = requireUri(body, 'uri');
        const pattern = requireString(body, 'pattern');
        const limit = optionalInteger(body, 'limit', 100, { min: 1 });

        await authorizer.assert(uri, READ, context.principals);
        const files = await search.glob(pattern, {
          scopes: [uri.toString()],
          subject: context.subject,
          principals: context.principals,
          limit,
        });
        return ok<SearchGlobResponse>({ files });
      });
    },
  };
}
