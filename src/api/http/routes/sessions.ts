/**
 * 会话路由（架构文档 §14、§10.1）。
 *
 * 会话 URI 由「作用域根 + `sessions/` + 会话 ID」拼成（§6.5），所以每个端点接受一个
 * 可选 `scopeUri`：缺省是当前身份的个人根。身份只从请求上下文取——body 里的任何
 * 字段都不能覆盖它，否则一个请求就能以别人的身份建会话。
 *
 * `GET /sessions` 没有服务层的列表原语（`SessionService` 只有 `create` / `load` /
 * `addMessage` / `commitPhase1`）。这里列 `sessions/` 下的目录再逐个 `load`：读权限由
 * `FileSystemService.list` 逐条过滤（§12.4 的列表语义），元数据缺失的目录跳过
 * （`load` 抛 `NOT_FOUND`——那是「建了一半」的会话，不是错误）。
 */

import type { FastifyInstance } from 'fastify';

import { parsePrincipal } from '../../../domain/acl.js';
import { ComemError } from '../../../domain/errors.js';
import type { ContentPart, MessageRole, Session, SessionMessage } from '../../../domain/session.js';
import { Uri } from '../../../domain/uri.js';
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

const ROLES: readonly MessageRole[] = ['user', 'assistant', 'system', 'tool'];

/** `GET /sessions` 的默认条数。经验值：控制台一页展示 100 条已经要滚动。 */
const DEFAULT_LIST_LIMIT = 100;

function invalid(message: string, details: Record<string, unknown>): ComemError {
  return new ComemError('INVALID_ARGUMENT', message, details);
}

/** `user:alice` → `comem://user/alice`。 */
function scopeOfSubject(subject: string): Uri {
  const principal = parsePrincipal(subject);
  if (principal.kind !== 'user') {
    throw invalid(`会话身份必须是 user 主体：${subject}`, { subject });
  }
  return Uri.parse(`comem://user/${principal.id}`);
}

/** 作用域根 + 会话 ID。ID 走 `Uri.child` 校验（保留名、空段、控制字符都会被拒）。 */
function sessionUriOf(scope: Uri, id: string): Uri {
  if (id === '') {
    throw invalid('会话 ID 不能为空。', { field: 'id' });
  }
  return scope.child('sessions', id);
}

/** body 里可选的 `scopeUri` 覆盖；缺省用当前身份的个人根。 */
function scopeFrom(body: Record<string, unknown>, subject: string): Uri {
  const scopeUri = optionalString(body, 'scopeUri');
  return scopeUri === undefined ? scopeOfSubject(subject) : Uri.parse(scopeUri);
}

function requireStringField(record: Record<string, unknown>, field: string, where: string): string {
  const value = record[field];
  if (typeof value !== 'string') {
    throw invalid(`${where}.${field} 必须是字符串。`, { field });
  }
  return value;
}

function parseRole(value: unknown): MessageRole {
  if (typeof value !== 'string') {
    throw invalid('role 必须是字符串。', { field: 'role' });
  }
  const role = ROLES.find((candidate) => candidate === value);
  if (role === undefined) {
    throw invalid(`role 只能是 ${ROLES.join(' / ')}。`, { field: 'role' });
  }
  return role;
}

/** 一条 `ContentPart`。五种 kind 各自校验字段，不接受未校验的值进服务层。 */
function parsePart(value: unknown, index: number): ContentPart {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalid(`parts[${index}] 必须是对象。`, { index });
  }
  const record = requireRecord(value, `parts[${index}]`);
  const where = `parts[${index}]`;
  switch (record['kind']) {
    case 'text':
      return { kind: 'text', text: requireStringField(record, 'text', where) };
    case 'image': {
      const alt = record['alt'];
      if (alt !== undefined && alt !== null && typeof alt !== 'string') {
        throw invalid(`${where}.alt 必须是字符串或 null。`, { index });
      }
      return {
        kind: 'image',
        url: requireStringField(record, 'url', where),
        alt: typeof alt === 'string' ? alt : null,
      };
    }
    case 'context':
      return {
        kind: 'context',
        uri: requireStringField(record, 'uri', where),
        abstract: requireStringField(record, 'abstract', where),
      };
    case 'tool_use':
      return {
        kind: 'tool_use',
        toolUseId: requireStringField(record, 'toolUseId', where),
        name: requireStringField(record, 'name', where),
        input: record['input'],
      };
    case 'tool_result': {
      const isError = record['isError'];
      if (typeof isError !== 'boolean') {
        throw invalid(`${where}.isError 必须是布尔值。`, { index });
      }
      return {
        kind: 'tool_result',
        toolUseId: requireStringField(record, 'toolUseId', where),
        output: requireStringField(record, 'output', where),
        isError,
      };
    }
    default:
      throw invalid(`${where}.kind 只能是 text / image / context / tool_use / tool_result。`, {
        index,
      });
  }
}

/** 一条待追加的消息。`turn` 由服务层按消息总数分配，不接受调用方传（§8.7）。 */
function parseMessage(body: Record<string, unknown>): Omit<SessionMessage, 'turn'> {
  const id = body['id'];
  const createdAt = body['createdAt'];
  const parts = body['parts'];
  if (id !== undefined && typeof id !== 'string') {
    throw invalid('id 必须是字符串。', { field: 'id' });
  }
  if (createdAt !== undefined && typeof createdAt !== 'string') {
    throw invalid('createdAt 必须是字符串。', { field: 'createdAt' });
  }
  if (!Array.isArray(parts)) {
    throw invalid('parts 必须是数组。', { field: 'parts' });
  }
  return {
    id: typeof id === 'string' ? id : crypto.randomUUID(),
    role: parseRole(body['role']),
    parts: parts.map((part, index) => parsePart(part, index)),
    createdAt: typeof createdAt === 'string' ? createdAt : new Date().toISOString(),
  };
}

function serializeSession(session: Session): Record<string, unknown> {
  return {
    id: session.id,
    uri: session.uri.toString(),
    status: session.status,
    messageCount: session.messageCount,
    pendingTokens: session.pendingTokens,
    lastCommitAt: session.lastCommitAt,
    messages: session.messages,
  };
}

export function createSessionRoutes(services: HttpRouteServices): HttpRouteGroup {
  const { session, filesystem, authorizer, observability } = services;

  return {
    prefix: '/sessions',
    register(app: FastifyInstance): void {
      app.post<{ Body: unknown }>('/', async (request) => {
        const body = requireRecord(request.body, 'sessions/create');
        const context = requestContextOf(request);
        const scope = scopeFrom(body, context.subject);
        await authorizer.assert(scope, WRITE, context.principals);
        const sessionId = optionalString(body, 'sessionId');
        // 已存在返回 409（`ALREADY_EXISTS` → §19 的状态表）：`create` 只创建，
        // 不重置已有会话的消息。Hook 的 `PostToolUse` / `Stop` 按「409 即复用」
        // 实现——它们收到 200 就会以为刚建出一个空会话。
        const uri = await session.create(
          scope,
          context.principals,
          sessionId === undefined ? {} : { sessionId },
        );
        return ok({ uri: uri.toString() });
      });

      app.post<{ Params: { id: string }; Body: unknown }>('/:id/messages', async (request) => {
        const body = requireRecord(request.body, 'sessions/messages');
        const context = requestContextOf(request);
        const scope = scopeFrom(body, context.subject);
        const sessionUri = sessionUriOf(scope, request.params.id);
        await authorizer.assert(sessionUri, WRITE, context.principals);

        // **批量形状是规范形状。** 采集侧（Hook 插件）一次可能补投多条消息，
        // 逐条发 HTTP 会让「游标确认」变成 N 次往返，而游标一旦在中间失败就会
        // 重投已确认的部分。数组长度为 1 是它的退化形式，不再单独支持单对象。
        const rawMessages = body['messages'];
        if (!Array.isArray(rawMessages) || rawMessages.length === 0) {
          throw invalid('messages 必须是非空数组。', { field: 'messages' });
        }
        // §17.2 的 `capture`：`Stop` 在 hook 里只写 worker 载荷并 spawn，**真正落盘
        // 的是这个端点**。边界包住逐条 `addMessage`，授权与参数解析不算——它们是
        // 未归因间隙。
        const appended = await observability.phase('capture', async () => {
          const messages: SessionMessage[] = [];
          for (const rawMessage of rawMessages) {
            messages.push(
              await session.addMessage(
                sessionUri,
                parseMessage(requireRecord(rawMessage, 'messages[]')),
              ),
            );
          }
          return messages;
        });
        return ok({ uri: sessionUri.toString(), messages: appended, count: appended.length });
      });

      app.post<{ Params: { id: string }; Body: unknown }>('/:id/commit', async (request) => {
        const body = requireRecord(request.body, 'sessions/commit');
        const context = requestContextOf(request);
        const scope = scopeFrom(body, context.subject);
        const sessionUri = sessionUriOf(scope, request.params.id);
        await authorizer.assert(sessionUri, WRITE, context.principals);
        const result = await session.commitPhase1(sessionUri);
        return ok({
          sessionUri: sessionUri.toString(),
          taskId: result.taskId,
          archiveUri: result.archiveUri.toString(),
          archivedCount: result.archivedCount,
        });
      });

      app.get<{ Querystring: Record<string, unknown> }>('/', async (request) => {
        const query = requireRecord(request.query, 'sessions/list');
        const context = requestContextOf(request);
        const scope = scopeFrom(query, context.subject);
        const limit = optionalQueryInteger(query, 'limit', DEFAULT_LIST_LIMIT, { min: 1 });
        await authorizer.assert(scope, READ, context.principals);

        const sessions: Record<string, unknown>[] = [];
        for (const child of await filesystem.list(
          scope.child('sessions'),
          context.principals,
        )) {
          if (child.kind !== 'directory' || sessions.length >= limit) {
            continue;
          }
          try {
            sessions.push(serializeSession(await session.load(child.uri)));
          } catch (error) {
            // 建了一半的会话（有目录、没有元数据）不是错误：跳过，不打断整页。
            if (error instanceof ComemError && error.code === 'NOT_FOUND') {
              continue;
            }
            throw error;
          }
        }
        return ok({ scope: scope.toString(), sessions });
      });

      app.get<{ Params: { id: string }; Querystring: Record<string, unknown> }>(
        '/:id',
        async (request) => {
          const query = requireRecord(request.query, 'sessions/get');
          const context = requestContextOf(request);
          const scope = scopeFrom(query, context.subject);
          const sessionUri = sessionUriOf(scope, request.params.id);
          await authorizer.assert(sessionUri, READ, context.principals);
          return ok(serializeSession(await session.load(sessionUri)));
        },
      );
    },
  };
}
