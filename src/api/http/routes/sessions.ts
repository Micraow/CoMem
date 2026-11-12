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

import { ComemError, invalidArgument } from '../../../domain/errors.js';
import type { Session, SessionMessage, SessionStatus } from '../../../domain/session.js';
import { ok } from '../envelope.js';
import { requestContextOf } from '../middleware.js';
import {
  optionalQueryInteger,
  optionalString,
  requireRecord,
  type HttpRouteGroup,
} from '../server.js';

import type { HttpRouteServices } from './index.js';
import { parseMessage, scopeFrom, sessionUriOf } from './sessions-request.js';

/** §12.1：read = 1、write = 3。 */
const READ = 1;
const WRITE = 3;


/** `GET /sessions` 的默认条数。经验值：控制台一页展示 100 条已经要滚动。 */
const DEFAULT_LIST_LIMIT = 100;

/** `GET /sessions` 列表项与 `GET /sessions/{id}` 的响应形状。 */
interface SerializedSession {
  readonly id: string;
  readonly uri: string;
  readonly status: SessionStatus;
  readonly messageCount: number;
  readonly pendingTokens: number;
  readonly lastCommitAt: string | null;
  readonly messages: readonly SessionMessage[];
}

/** `POST /sessions` 的响应体：只回新建会话的 URI。 */
interface SessionCreateResponse {
  readonly uri: string;
}

/** `POST /sessions/{id}/messages` 的响应体：追加后的消息与条数。 */
interface SessionMessagesResponse {
  readonly uri: string;
  readonly messages: readonly SessionMessage[];
  readonly count: number;
}

/** `POST /sessions/{id}/commit` 的响应体：阶段一归档的产物。 */
interface SessionCommitResponse {
  readonly sessionUri: string;
  readonly taskId: string;
  readonly archiveUri: string;
  readonly archivedCount: number;
}

/** `GET /sessions` 的响应体：作用域根 + 列表。 */
interface SessionListResponse {
  readonly scope: string;
  readonly sessions: readonly SerializedSession[];
}

function serializeSession(session: Session): SerializedSession {
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
        return ok<SessionCreateResponse>({ uri: uri.toString() });
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
          throw invalidArgument('messages 必须是非空数组。', { field: 'messages' });
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
        return ok<SessionMessagesResponse>({
          uri: sessionUri.toString(),
          messages: appended,
          count: appended.length,
        });
      });

      app.post<{ Params: { id: string }; Body: unknown }>('/:id/commit', async (request) => {
        const body = requireRecord(request.body, 'sessions/commit');
        const context = requestContextOf(request);
        const scope = scopeFrom(body, context.subject);
        const sessionUri = sessionUriOf(scope, request.params.id);
        await authorizer.assert(sessionUri, WRITE, context.principals);
        const result = await session.commitPhase1(sessionUri);
        return ok<SessionCommitResponse>({
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

        const sessions: SerializedSession[] = [];
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
        return ok<SessionListResponse>({ scope: scope.toString(), sessions });
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
