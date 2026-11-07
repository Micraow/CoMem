/**
 * 用户与组路由（架构文档 §14）。
 *
 * ## 为什么全部是 501
 *
 * v1 **没有用户表，也没有组成员表**：配置里只有一个 `acl.groupDefaultLevel`，主体
 * 是 `user:{uid}` / `group:{gid}` 字符串，组员关系由反向代理注入的身份展开（§12.5
 * 「退组立即生效」靠的就是不把成员列表写进授权）。
 *
 * 从 `node_permission` 反查能给出一份「出现过的主体」列表，但那份列表**不是用户
 * 目录**：它只包含被显式授权过的节点，没授权过的用户与组不出现，而组员的成员关系
 * 根本推不出来。用它冒充用户管理接口比返回 501 更糟——控制台会显示一份看起来完整、
 * 实际是权限副产物的清单。
 *
 * 所以五个端点全部返回 `501 NOT_IMPLEMENTED`，错误消息里写明缺什么。需要真正的
 * 用户目录时，先加用户/组成员表，再实现这一组。
 *
 * ## 为什么是手写封套
 *
 * `ComemErrorCode`（`domain/errors.ts`）是冻结的错误枚举，没有 `NOT_IMPLEMENTED`，
 * 而本 wave 不改 domain 层。`toErrorEnvelope` 会把未知码收敛成 `INTERNAL`（500），
 * 语义是错的。这里按 §19 的封套形状手写一份 501，是「响应一律走 `ok` /
 * `toErrorEnvelope`」的唯一例外。
 */

import type { FastifyInstance } from 'fastify';

import type { ErrorEnvelope } from '../envelope.js';
import { requestContextOf } from '../middleware.js';
import type { HttpRouteGroup } from '../server.js';

/** v1 缺失的能力。消息里说清楚「缺什么」，而不是让调用方猜。 */
const NOT_IMPLEMENTED_MESSAGE =
  'v1 没有用户与组的管理接口：主体由反向代理注入，组员关系不落库。';

/** HTTP 501（§19 的封套 + 明确的 `NOT_IMPLEMENTED` 码）。 */
const NOT_IMPLEMENTED_STATUS = 501;

function notImplemented(feature: string, requestId: string): ErrorEnvelope {
  return {
    status: 'error',
    error: {
      code: 'NOT_IMPLEMENTED',
      message: `${NOT_IMPLEMENTED_MESSAGE}（${feature}）`,
      details: { feature, requestId },
    },
  };
}

export function createAdminRoutes(): HttpRouteGroup {
  return {
    prefix: '/admin',
    register(app: FastifyInstance): void {
      app.get('/users', async (request, reply) => {
        const context = requestContextOf(request);
        reply.code(NOT_IMPLEMENTED_STATUS).send(notImplemented('GET /admin/users', context.requestId));
      });

      app.post('/users', async (request, reply) => {
        const context = requestContextOf(request);
        reply
          .code(NOT_IMPLEMENTED_STATUS)
          .send(notImplemented('POST /admin/users', context.requestId));
      });

      app.get('/groups', async (request, reply) => {
        const context = requestContextOf(request);
        reply
          .code(NOT_IMPLEMENTED_STATUS)
          .send(notImplemented('GET /admin/groups', context.requestId));
      });

      app.post('/groups', async (request, reply) => {
        const context = requestContextOf(request);
        reply
          .code(NOT_IMPLEMENTED_STATUS)
          .send(notImplemented('POST /admin/groups', context.requestId));
      });

      app.post<{ Params: { id: string } }>('/groups/:id/members', async (request, reply) => {
        const context = requestContextOf(request);
        reply
          .code(NOT_IMPLEMENTED_STATUS)
          .send(
            notImplemented(`POST /admin/groups/${request.params.id}/members`, context.requestId),
          );
      });
    },
  };
}
