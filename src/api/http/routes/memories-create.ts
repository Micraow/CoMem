/**
 * 新建记忆（架构文档 §11.1、§14、§16）。
 *
 * 浏览器里的「新建记忆」只交三个输入：类型、标题/主题、正文。路径由服务端算——
 * `deriveCreationIdentity` 把标题映射成该类型的 identity 字段，`renderMemoryUri`
 * 用 schema 的 `filename` 模板渲染；控制台拿到的响应里直接带最终 URI，不自己拼路径。
 *
 * **走 `MemoryService.upsertMemory`，不走 `POST /content/write`。** 后者写的是裸正文：
 * 没有 `memory_type` frontmatter 的文件不是记忆（不参与复核闸门、TTL 与类型化合并），
 * 而且它要求调用方自己给出 URI——那会把路径规则复制到控制台。`upsertMemory` 一次
 * 完成 identity 校验、字段写入、复核状态与索引通知。
 *
 * 同类型同标题再次提交是**更新**（`upsertMemory` 的字段级合并），响应里的 `created`
 * 区分两种情况；`events` 是 `addOnly`，撞名时由服务层返回 `ALREADY_EXISTS`。
 */

import type { FastifyInstance } from 'fastify';

import { invalidArgument } from '../../../domain/errors.js';
import { getMemoryType } from '../../../domain/memory-types/index.js';
import { deriveCreationIdentity } from '../../../domain/memory-types/creation.js';
import type { NodeStatus } from '../../../domain/node.js';
import { renderMemoryUri } from '../../../services/memory/document.js';
import { ok } from '../envelope.js';
import { requestContextOf } from '../middleware.js';
import { requireRecord, requireText, requireUri, type HttpRouteGroup } from '../server.js';

import type { HttpRouteServices } from './index.js';

/** §12.1：write = 3。 */
const WRITE = 3;

/** `POST /memories` 的响应体。 */
interface MemoryCreateResponse {
  readonly uri: string;
  readonly memoryType: string;
  /** `false` 表示同类型同标题的记忆已存在，这次是更新。 */
  readonly created: boolean;
  /** 写入后的状态；`pending` 表示还在复核队列里，检索搜不到。读不回来时为 `null`。 */
  readonly status: NodeStatus | null;
}

export function createMemoryCreateRoutes(services: HttpRouteServices): HttpRouteGroup {
  const { memory, authorizer } = services;

  return {
    prefix: '/memories',
    register(app: FastifyInstance): void {
      app.post<{ Body: unknown }>('/', async (request) => {
        const context = requestContextOf(request);
        const body = requireRecord(request.body, 'memories/create');
        const scope = requireUri(body, 'scope');
        const memoryType = requireText(body, 'memoryType');
        const title = requireText(body, 'title');
        const content = requireText(body, 'content');

        if (!scope.isRoot) {
          throw invalidArgument('作用域必须是一个命名空间根。', { field: 'scope' });
        }
        const schema = getMemoryType(memoryType);
        if (schema === undefined) {
          throw invalidArgument(`未知的记忆类型：${memoryType}。`, {
            field: 'memoryType',
            value: memoryType,
          });
        }
        // 空正文写进去就是一条“什么都没有”的记忆；表单也要求这一栏。
        if (content.trim() === '') {
          throw invalidArgument('内容不能为空。', { field: 'content' });
        }

        const identity = deriveCreationIdentity(schema, title, new Date());
        const uri = renderMemoryUri(scope, schema, identity);
        // 目标文件还不存在：`authorizer.assert` 会先物化权限行再求权，与 create 类
        // 写路径（`POST /content/write` 的 `mode=create`）同一条判据。
        await authorizer.assert(uri, WRITE, context.principals);

        const result = await memory.upsertMemory(scope, schema, { ...identity, content });
        // 复核闸门（§11.6）由 `MemoryService` 按 `memory.reviewRequired` 决定；
        // 这里读回落盘状态，不在路由层抄一份「哪些类型需要复核」。
        const record = await memory.read(result.uri);

        return ok<MemoryCreateResponse>({
          uri: result.uri.toString(),
          memoryType: schema.type,
          created: result.created,
          status: record?.status ?? null,
        });
      });
    },
  };
}
