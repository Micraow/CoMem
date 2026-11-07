/**
 * 检索路由（架构文档 §14、§8.4、§12.4）。
 *
 * 四个面与 `SearchService` 一一对应：
 *
 * | 路由 | 服务方法 | 返回 |
 * |---|---|---|
 * | `POST /search/find` | `find` | 命中列表（uri / level / abstract / score） |
 * | `POST /search/search` | `find` + 查询计划 | 命中列表 + 实际执行的过滤条件 |
 * | `POST /search/grep` | `grep` | 行级命中，带行号与前后文 |
 * | `POST /search/glob` | `glob` | 文件 URI 列表 |
 *
 * `grep` / `glob` 的范围必须先求 read 权限再调服务：`SearchService.glob` 只做
 * `filterReadable`，不抛 `PERMISSION_DENIED`——它挡的是「结果里出现无权节点」，
 * 挡不住「一个无权目录被当成根扫一遍」。§12.4 的出口清单按出口数，这一道不能省。
 */

import type { FastifyInstance } from 'fastify';

import { parsePrincipal } from '../../../domain/acl.js';
import { ComemError } from '../../../domain/errors.js';
import type { Level } from '../../../domain/level.js';
import type { ContextType } from '../../../domain/node.js';
import type { GrepHit } from '../../../domain/retrieval.js';
import type { ScoredHit } from '../../../services/search.js';
import { ok } from '../envelope.js';
import { requestContextOf } from '../middleware.js';
import {
  optionalInteger,
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

        const hits = await search.find(query, {
          scopes: scope,
          subject: context.subject,
          principals: context.principals,
          contextTypes,
          levels,
          limit,
        });

        // 查询计划：排查「为什么没命中」时不用猜哪些过滤条件生效了（§13.2 的 search）。
        return ok({
          hits: hits.map(serializeHit),
          plan: {
            scopes: scope,
            limit,
            contextTypes: contextTypes ?? null,
            levels: levels ?? null,
            subject: context.subject,
          },
        });
      });

      app.post<{ Body: unknown }>('/grep', async (request) => {
        const body = requireRecord(request.body, 'search/grep');
        const context = requestContextOf(request);
        const uri = requireUri(body, 'uri');
        const pattern = requireString(body, 'pattern');
        const limit = optionalInteger(body, 'limit', DEFAULT_LIMIT, { min: 1 });
        const contextLines = optionalInteger(body, 'contextLines', 3, { min: 0 });

        await authorizer.assert(uri, READ);
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

        await authorizer.assert(uri, READ);
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
