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

import { parsePrincipal } from '../../../domain/acl.js';
import type { AssembledItem } from '../../../domain/assembly.js';
import { ComemError } from '../../../domain/errors.js';
import { isLevel, LEVELS, type Level } from '../../../domain/level.js';
import { CONTEXT_TYPES, isContextType, type ContextType } from '../../../domain/node.js';
import type { GrepHit, SearchPlan, SearchResultHit } from '../../../domain/retrieval.js';
import type { ScoredHit } from '../../../services/search.js';
import { API_CALL_DEADLINE_MS, CallDeadline, runWithDeadline } from '../../deadline.js';
import { DEFAULT_SEARCH_LIMIT } from '../../search-defaults.js';
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

import { isSearchMode, SEARCH_MODES, type SearchMode } from '../../search-mode.js';
import type { HttpRouteServices } from './index.js';

/** §12.1：read = 1（`grep` / `glob` 的范围求权只用这一个级别）。 */
const READ = 1;


/**
 * `search` 的出参形态（§8.6）。
 *
 * `list` 是默认值，保持向后兼容；`context` 返回可直接注入模型的文本与分层明细。
 * 这是同一个 `search` 能力的出参变体，不是第 17 个 MCP 工具。
 */

/**
 * §8.4 的默认条数。与 MCP 的 `find` / `search` / `grep` 共用 `api/search-defaults.ts`
 * 里的同一个值：默认值写两处会让同一个能力按入口返回不同规模。
 */
const DEFAULT_LIMIT = DEFAULT_SEARCH_LIMIT;

function parseContextTypes(value: readonly string[] | undefined): readonly ContextType[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  return value.map((item) => {
    if (!isContextType(item)) {
      throw new ComemError('INVALID_ARGUMENT', `contextTypes 只能是 ${CONTEXT_TYPES.join(' / ')}。`, {
        contextTypes: value,
      });
    }
    return item;
  });
}

function parseLevels(value: readonly string[] | undefined): readonly Level[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  return value.map((item) => {
    if (!isLevel(item)) {
      throw new ComemError('INVALID_ARGUMENT', `levels 只能是 ${LEVELS.join(' / ')}。`, {
        levels: value,
      });
    }
    return item;
  });
}

function parseMode(value: string | undefined): SearchMode {
  if (value === undefined) {
    return 'list';
  }
  if (!isSearchMode(value)) {
    throw new ComemError('INVALID_ARGUMENT', `mode 只能是 ${SEARCH_MODES.join(' / ')}。`, {
      mode: value,
    });
  }
  return value;
}

/** `user:alice` → `comem://user/alice`（不带末尾斜杠）。 */
function scopeOfSubject(subject: string): string {
  const principal = parsePrincipal(subject);
  if (principal.kind !== 'user') {
    throw new ComemError('INVALID_ARGUMENT', `检索身份必须是 user 主体：${subject}`, { subject });
  }
  return `comem://user/${principal.id}`;
}

function serializeHit(hit: ScoredHit): Record<string, unknown> {
  return {
    uri: hit.uri,
    contextType: hit.contextType,
    memoryType: hit.memoryType,
    level: hit.level,
    abstract: hit.abstract,
    score: hit.score,
  };
}

function serializeGrepHit(hit: GrepHit): Record<string, unknown> {
  return {
    uri: hit.uri,
    line: hit.line,
    text: hit.text,
    before: hit.before,
    after: hit.after,
  };
}

/**
 * `search` 的命中：`find` 的字段 + 命中的是重写后的哪条查询。
 *
 * `matchedQuery` 不出现在 `/search/find` 的返回里——那条路径没有重写，多一个
 * 恒为空的字段只会让调用方多写一个分支。
 */
function serializeSearchHit(hit: SearchResultHit): Record<string, unknown> {
  return { ...serializeHit(hit), matchedQuery: hit.matchedQuery };
}

/** 查询计划。`SearchPlan` 本身不含 `sessionId`，回传自然也不会泄漏（§8.4）。 */
function serializePlan(plan: SearchPlan): Record<string, unknown> {
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

/**
 * `context` 模式的条目：投放层级与渲染后的文本都要回传。
 *
 * `detail === null` 表示只给了 URI（模型没看到正文）；`tokens` 是这一条的 token
 * 成本，`tokensUsed` 是合计——调用方要能解释「预算花在哪」。
 */
function serializeAssembledItem(item: AssembledItem): Record<string, unknown> {
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

/**
 * 到上限时的错误（§19：超时 → `PROVIDER_UNAVAILABLE`，`details.timeout = true`）。
 *
 * 必须返回错误而不是空结果：200 + `hits: []` 会被调用方读成「记忆里没有」。
 * 这与 MCP 侧「超时不能伪装成空结果」是同一条规则，只是返回形态不同。
 */
function deadlineExceeded(deadline: CallDeadline): ComemError {
  const upstream = deadline.lastUpstream;
  const where =
    upstream === null
      ? '，且没有进入任何外部上游；卡住的位置在本地（索引 / 文件系统 / 锁）'
      : `；最后进入的上游是 ${upstream.label}，已等待 ${upstream.elapsedMs} 毫秒仍未响应`;
  return new ComemError(
    'PROVIDER_UNAVAILABLE',
    `检索在 ${deadline.budgetMs} 毫秒内没有返回${where}。本次请求已中止等待，上游可能仍在执行。`,
    {
      timeout: true,
      timeoutMs: deadline.budgetMs,
      reason: 'deadline_exceeded',
      upstream: upstream?.upstream ?? null,
      elapsedMs: upstream?.elapsedMs ?? null,
    },
  );
}

/**
 * 在总上限内跑一次检索。
 *
 * 上限施加在**路由 handler** 上，不是 Fastify 的钩子：钩子只能决定「什么时候
 * 放行」，没法把 handler 的返回值换成错误；而 handler 是 `app.inject()` 与真实
 * 监听端口共同经过的唯一位置（两者都是同一套路由与 handler）。
 *
 * `operation` 拿到的 deadline 要做两件事：
 *
 * 1. `mark` 上报上游，到点时错误消息能写清卡在哪；
 * 2. 把 `deadlineAt` 传给服务层。服务层据此把三段上游预算收窄到剩余时间
 *    （`services/search.ts` 的 `remainingBudget` 与 `#analyze`），provider 再把
 *    这个预算与 `providers.*.timeoutSeconds` 取 `min` 后设超时——它只会收紧用户
 *    配置，不会放宽。到点时 provider 的 `AbortController` 会真正中止在途 HTTP
 *    请求，而不是让它在 503 之后继续跑。
 *
 * 两个上游预算都留了「剩余时间 - min(1s, 剩余/5)」的余量，所以降级与中止通常
 * 发生在总上限**之前**；真正走到这一层的 `timed_out` 兜的是本地卡住（索引 / ACL）。
 */
async function runRetrieval<T>(
  budgetMs: number,
  operation: (deadline: CallDeadline) => Promise<T>,
): Promise<T> {
  const deadline = new CallDeadline(budgetMs);
  const outcome = await runWithDeadline(operation(deadline), deadline);
  if (outcome.kind === 'timed_out') {
    throw deadlineExceeded(deadline);
  }
  return outcome.value;
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
        const limit = optionalInteger(body, 'limit', DEFAULT_LIMIT, { min: 1 });
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
        return ok({ hits: hits.map(serializeHit) });
      });

      app.post<{ Body: unknown }>('/search', async (request) => {
        const body = requireRecord(request.body, 'search/search');
        const context = requestContextOf(request);
        const query = requireString(body, 'query');
        const scope = optionalStringArray(body, 'scopes') ?? [scopeOfSubject(context.subject)];
        const limit = optionalInteger(body, 'limit', DEFAULT_LIMIT, { min: 1 });
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
          return ok({
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
        return ok({ hits: result.hits.map(serializeSearchHit), plan: serializePlan(result.plan) });
      });

      app.post<{ Body: unknown }>('/grep', async (request) => {
        const body = requireRecord(request.body, 'search/grep');
        const context = requestContextOf(request);
        const uri = requireUri(body, 'uri');
        const pattern = requireString(body, 'pattern');
        const limit = optionalInteger(body, 'limit', DEFAULT_LIMIT, { min: 1 });
        const contextLines = optionalInteger(body, 'contextLines', 3, { min: 0 });

        await authorizer.assert(uri, READ, context.principals);
        const hits = await search.grep(pattern, {
          scopes: [uri.toString()],
          subject: context.subject,
          principals: context.principals,
          limit,
          contextLines,
        });
        return ok({ hits: hits.map(serializeGrepHit) });
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
        return ok({ files });
      });
    },
  };
}
