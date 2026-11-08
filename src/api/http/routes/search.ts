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
 */

import type { FastifyInstance } from 'fastify';

import { parsePrincipal } from '../../../domain/acl.js';
import type { AssembledItem } from '../../../domain/assembly.js';
import { ComemError } from '../../../domain/errors.js';
import type { Level } from '../../../domain/level.js';
import type { ContextType } from '../../../domain/node.js';
import type { GrepHit, SearchPlan, SearchResultHit } from '../../../domain/retrieval.js';
import type { ScoredHit } from '../../../services/search.js';
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

/** §12.1：read = 1（`grep` / `glob` 的范围求权只用这一个级别）。 */
const READ = 1;

const CONTEXT_TYPES: readonly ContextType[] = ['memory', 'resource', 'skill', 'session'];
const LEVELS: readonly Level[] = ['L0', 'L1', 'L2'];

/**
 * `search` 的出参形态（§8.6）。
 *
 * `list` 是默认值，保持向后兼容；`context` 返回可直接注入模型的文本与分层明细。
 * 这是同一个 `search` 能力的出参变体，不是第 17 个 MCP 工具。
 */
type SearchMode = 'list' | 'context';

const SEARCH_MODES: readonly SearchMode[] = ['list', 'context'];

/** §8.4 的默认条数。与 `SearchService` 的默认值一致。 */
const DEFAULT_LIMIT = 20;

function parseContextTypes(value: readonly string[] | undefined): readonly ContextType[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  return value.map((item) => {
    const match = CONTEXT_TYPES.find((candidate) => candidate === item);
    if (match === undefined) {
      throw new ComemError('INVALID_ARGUMENT', `contextTypes 只能是 ${CONTEXT_TYPES.join(' / ')}。`, {
        contextTypes: value,
      });
    }
    return match;
  });
}

function parseLevels(value: readonly string[] | undefined): readonly Level[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  return value.map((item) => {
    const match = LEVELS.find((candidate) => candidate === item);
    if (match === undefined) {
      throw new ComemError('INVALID_ARGUMENT', `levels 只能是 ${LEVELS.join(' / ')}。`, {
        levels: value,
      });
    }
    return match;
  });
}

function parseMode(value: string | undefined): SearchMode {
  if (value === undefined) {
    return 'list';
  }
  const match = SEARCH_MODES.find((candidate) => candidate === value);
  if (match === undefined) {
    throw new ComemError('INVALID_ARGUMENT', `mode 只能是 ${SEARCH_MODES.join(' / ')}。`, {
      mode: value,
    });
  }
  return match;
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

export function createSearchRoutes(services: HttpRouteServices): HttpRouteGroup {
  const { search, authorizer } = services;

  return {
    prefix: '/search',
    register(app: FastifyInstance): void {
      app.post<{ Body: unknown }>('/find', async (request) => {
        const body = requireRecord(request.body, 'search/find');
        const context = requestContextOf(request);
        const query = requireString(body, 'query');
        const scope = optionalStringArray(body, 'scopes') ?? [scopeOfSubject(context.subject)];
        const limit = optionalInteger(body, 'limit', DEFAULT_LIMIT, { min: 1 });
        const hits = await search.find(query, {
          scopes: scope,
          subject: context.subject,
          principals: context.principals,
          contextTypes: parseContextTypes(optionalStringArray(body, 'contextTypes')),
          levels: parseLevels(optionalStringArray(body, 'levels')),
          limit,
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
        // 会话只用于解析指代（§8.4）；不传也能检索，只是历史为空。
        const sessionId = optionalString(body, 'sessionId');
        const mode = parseMode(optionalString(body, 'mode'));

        if (mode === 'context') {
          // `context` 是同一个 `search` 出参形态的变体（§8.6），不是第 17 个工具。
          // 跨轮去重的时钟由 `sessionId` 推导；不传就不去重（见 `ContextOptions`）。
          const result = await search.context(query, {
            scopes: scope,
            subject: context.subject,
            principals: context.principals,
            contextTypes,
            levels,
            limit,
            sessionId,
          });
          return ok({
            items: result.items.map(serializeAssembledItem),
            rendered: result.rendered,
            dropped: result.dropped,
            usedTokens: result.tokensUsed,
          });
        }

        const result = await search.search(query, {
          scopes: scope,
          subject: context.subject,
          principals: context.principals,
          contextTypes,
          levels,
          limit,
          sessionId,
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
