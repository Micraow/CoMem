/**
 * 记忆复核路由（架构文档 §14、§11.6、§11.8、§12.4）。
 *
 * `experiences` / `rules` 写入时是 `pending`（§11.6）：它们在被 `approve` 之前不进
 * 检索结果。控制台的「记忆复核」页用这三个端点。
 *
 * `POST /consolidate` 是记忆合并（§11.8）：**破坏性操作**（会 `delete`），所以
 * 需要 `manage`、`dryRun` 默认 `true`、并且配置里没开启时明确拒绝。它**不进 MCP**
 * （§3：16 个工具，不多不少）。
 *
 * 路径里的 URI 是 **percent-encoded** 的（`comem%3A%2F%2Fuser%2Falice%2F...`）：
 * URI 含 `/`，不编码会被 Fastify 当成多段路径。Fastify 的路径参数默认已经
 * `decodeURIComponent`，这里直接 `Uri.parse`。
 */

import type { FastifyInstance } from 'fastify';

import { parsePrincipal } from '../../../domain/acl.js';
import { ComemError } from '../../../domain/errors.js';
import { Uri } from '../../../domain/uri.js';
import type { ConsolidationResult } from '../../../services/consolidation.js';
import type { MemoryLink } from '../../../domain/memory-link.js';
import type { MemoryRecord } from '../../../services/memory.js';
import { ok } from '../envelope.js';
import { requestContextOf } from '../middleware.js';
import {
  optionalQueryInteger,
  optionalString,
  requireRecord,
  requireUri,
  type HttpRouteGroup,
} from '../server.js';

import type { HttpRouteServices } from './index.js';

/** §12.1：read = 1、write = 3、manage = 7。 */
const READ = 1;
const WRITE = 3;
const MANAGE = 7;

/** 复核列表的默认条数。经验值：一页 100 条已经够滚动。 */
const DEFAULT_PENDING_LIMIT = 100;

function parseMemoryUri(raw: string): Uri {
  if (raw === '') {
    throw new ComemError('INVALID_URI', '记忆 URI 不能为空。', { uri: raw });
  }
  return Uri.parse(raw);
}

function serializeRecord(record: MemoryRecord): Record<string, unknown> {
  return {
    uri: record.uri.toString(),
    memoryType: record.memoryType,
    status: record.status,
    updatedAt: record.updatedAt,
    fields: record.fields,
  };
}

function scopeOfSubject(subject: string): string {
  const principal = parsePrincipal(subject);
  if (principal.kind !== 'user') {
    throw new ComemError('INVALID_ARGUMENT', `记忆身份必须是 user 主体：${subject}`, { subject });
  }
  return `comem://user/${principal.id}`;
}

export function createMemoryRoutes(services: HttpRouteServices): HttpRouteGroup {
  const { memory, memoryLink, authorizer, consolidation, config } = services;

  return {
    prefix: '/memories',
    register(app: FastifyInstance): void {
      app.get<{ Querystring: Record<string, unknown> }>('/pending', async (request) => {
        const query = requireRecord(request.query, 'memories/pending');
        const context = requestContextOf(request);
        const limit = optionalQueryInteger(query, 'limit', DEFAULT_PENDING_LIMIT, { min: 1 });
        const scopeUri = optionalString(query, 'scopeUri') ?? scopeOfSubject(context.subject);
        const scope = Uri.parse(scopeUri);
        await authorizer.assert(scope, READ, context.principals);
        const records = await memory.listPending(scope, { limit });
        return ok({ scope: scope.toString(), memories: records.map(serializeRecord) });
      });

      app.post<{ Body: unknown }>('/consolidate', async (request) => {
        const context = requestContextOf(request);
        const body = requireRecord(request.body, 'memories/consolidate');
        const scope = requireUri(body, 'scope');
        const dryRun = optionalBoolean(body, 'dryRun');

        // **不展开组**：合并是写操作，scope 必须显式指定（§11.8）。
        await authorizer.assert(scope, MANAGE, context.principals);

        if (!config.memory.consolidation.enabled) {
          // 不返回空结果：那会让「没开」看起来像「没有可合并的记忆」。
          throw new ComemError(
            'PERMISSION_DENIED',
            '记忆合并未开启：它是一次会删除记忆的破坏性操作，需要显式把 memory.consolidation.enabled 设为 true。',
            { field: 'memory.consolidation.enabled' },
          );
        }

        const result = await consolidation.consolidate(scope, {
          // 不传就是预览：合并会 delete，误点的代价不可逆。
          dryRun: dryRun ?? true,
          subject: context.subject,
          principals: context.principals,
        });
        return ok(serializeConsolidation(result));
      });

      app.post<{ Params: { uri: string } }>('/:uri/approve', async (request) => {
        const context = requestContextOf(request);
        const uri = parseMemoryUri(request.params.uri);
        await authorizer.assert(uri, WRITE, context.principals);
        await memory.approve(uri);
        return ok({ uri: uri.toString(), status: 'active', subject: context.subject });
      });

      app.post<{ Params: { uri: string }; Body: unknown }>('/:uri/reject', async (request) => {
        const context = requestContextOf(request);
        const body = requireRecord(request.body, 'memories/reject');
        const uri = parseMemoryUri(request.params.uri);
        const reason = requireRecordReason(body);
        await authorizer.assert(uri, WRITE, context.principals);
        await memory.reject(uri, reason);
        return ok({ uri: uri.toString(), removed: true, reason });
      });

      // 记忆关联边（§11.10）。**只读**：`links` 是派生/关联数据，产生端在写入路径上。
      // `direction` 决定返回正向（谁指向别人）还是派生（谁指向我）。
      app.get<{ Params: { uri: string }; Querystring: Record<string, unknown> }>(
        '/:uri/links',
        async (request) => {
          const context = requestContextOf(request);
          const uri = parseMemoryUri(request.params.uri);
          const query = requireRecord(request.query, 'memories/links');
          const direction = parseLinkDirection(query['direction']);
          await authorizer.assert(uri, READ, context.principals);
          const links =
            direction === 'backlinks' ? memoryLink.backlinksOf(uri) : memoryLink.linksOf(uri);
          return ok({ uri: uri.toString(), direction, links: links.map(serializeLink) });
        },
      );
    },
  };
}

/**
 * `direction`：`links`（默认，正向）或 `backlinks`（派生）。
 *
 * 缺省正向：调用方通常先说「这条记忆关联了哪些东西」，反查是第二问。
 */
function parseLinkDirection(raw: unknown): 'links' | 'backlinks' {
  if (raw === undefined) {
    return 'links';
  }
  if (raw === 'links' || raw === 'backlinks') {
    return raw;
  }
  throw new ComemError('INVALID_ARGUMENT', 'links 的 direction 只能是 links 或 backlinks。', {
    field: 'direction',
    value: raw,
  });
}

function serializeLink(link: MemoryLink): Record<string, unknown> {
  return {
    from: link.fromUri.toString(),
    to: link.toUri.toString(),
    linkType: link.linkType,
    weight: link.weight,
    matchText: link.matchText,
    description: link.description,
  };
}

function requireRecordReason(body: Record<string, unknown>): string {
  const reason = body['reason'];
  if (typeof reason !== 'string' || reason.trim() === '') {
    throw new ComemError('INVALID_ARGUMENT', 'reject 的 reason 必须是非空字符串。', {
      field: 'reason',
    });
  }
  return reason;
}

/** 可选的布尔参数。缺省返回 `undefined`（由服务端的默认值决定）。 */
function optionalBoolean(body: Record<string, unknown>, field: string): boolean | undefined {
  const value = body[field];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'boolean') {
    throw new ComemError('INVALID_ARGUMENT', `参数 ${field} 必须是布尔值。`, { field });
  }
  return value;
}

/**
 * 合并结果就是响应体：`adds` / `updates` / `deletes` 是 URI 列表，`trace` 是每一轮
 * 模型输出的摘要。**不返回正文**：正文在 `read` 里拿，响应体只说明「谁被改了」。
 */
function serializeConsolidation(result: ConsolidationResult): Record<string, unknown> {
  return {
    adds: result.adds,
    updates: result.updates,
    deletes: result.deletes,
    trace: result.trace,
  };
}
