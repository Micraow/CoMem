/**
 * 记忆复核路由（架构文档 §14、§11.6、§12.4）。
 *
 * `experiences` / `rules` 写入时是 `pending`（§11.6）：它们在被 `approve` 之前不进
 * 检索结果。控制台的「记忆复核」页用这三个端点。
 *
 * 路径里的 URI 是 **percent-encoded** 的（`comem%3A%2F%2Fuser%2Falice%2F...`）：
 * URI 含 `/`，不编码会被 Fastify 当成多段路径。Fastify 的路径参数默认已经
 * `decodeURIComponent`，这里直接 `Uri.parse`。
 */

import type { FastifyInstance } from 'fastify';

import { parsePrincipal } from '../../../domain/acl.js';
import { ComemError } from '../../../domain/errors.js';
import { Uri } from '../../../domain/uri.js';
import type { MemoryRecord } from '../../../services/memory.js';
import { ok } from '../envelope.js';
import { requestContextOf } from '../middleware.js';
import {
  optionalQueryInteger,
  optionalString,
  requireRecord,
  type HttpRouteGroup,
} from '../server.js';

import type { HttpRouteServices } from './index.js';

/** §12.1：read = 1、write = 3。 */
const READ = 1;
const WRITE = 3;

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
  const { memory, authorizer } = services;

  return {
    prefix: '/memories',
    register(app: FastifyInstance): void {
      app.get<{ Querystring: Record<string, unknown> }>('/pending', async (request) => {
        const query = requireRecord(request.query, 'memories/pending');
        const context = requestContextOf(request);
        const limit = optionalQueryInteger(query, 'limit', DEFAULT_PENDING_LIMIT, { min: 1 });
        const scopeUri = optionalString(query, 'scopeUri') ?? scopeOfSubject(context.subject);
        const scope = Uri.parse(scopeUri);
        await authorizer.assert(scope, READ);
        const records = await memory.listPending(scope, { limit });
        return ok({ scope: scope.toString(), memories: records.map(serializeRecord) });
      });

      app.post<{ Params: { uri: string } }>('/:uri/approve', async (request) => {
        const context = requestContextOf(request);
        const uri = parseMemoryUri(request.params.uri);
        await authorizer.assert(uri, WRITE);
        await memory.approve(uri);
        return ok({ uri: uri.toString(), status: 'active', subject: context.subject });
      });

      app.post<{ Params: { uri: string }; Body: unknown }>('/:uri/reject', async (request) => {
        requestContextOf(request);
        const body = requireRecord(request.body, 'memories/reject');
        const uri = parseMemoryUri(request.params.uri);
        const reason = requireRecordReason(body);
        await authorizer.assert(uri, WRITE);
        await memory.reject(uri, reason);
        return ok({ uri: uri.toString(), removed: true, reason });
      });
    },
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
