/**
 * 单条记忆的元数据（`GET /memories/{uri}`，架构文档 §14、§16）。
 *
 * 控制台的文件详情页要回答「这条记忆为什么能／不能被搜到」。检索只看索引里的
 * `status = 'active'`（`adapters/sqlite/retrieval-index.ts` 的 `ACTIVE_STATUS_PREDICATE`），
 * 而正文、摘要与 `fs/stat` 都不带状态与有效期；复核列表只列 `pending`。这个端点
 * 补的就是「按 URI 读一条记忆的元数据」。
 *
 * **状态与类型取自检索索引，不取自记忆文件。** TTL 归档只把索引行改成
 * `archived`，记忆文件的 frontmatter 仍是 `active`（`services/ttl.ts`）；版本文件
 * 又被路径规则排除在检索之外。回答「agent 能不能搜到」必须以索引那一行为准，
 * 读 frontmatter 会在 TTL 归档后给出相反的答案。有效期反过来只有文件里有：索引
 * 的 `NodeStat` 没有这两列，`memory.read` 是唯一出口。
 *
 * 路径里的 URI 是 percent-encoded 的，与同组的 `/:uri/links`、`/:uri/approve` 一致
 * （`comem://` 不编码会被 Fastify 当成多段路径）。
 *
 * 权限与 `content/read` 同一档：对查询的 URI 求 read。不放宽——类型、状态与有效期
 * 都是记忆内容的一部分。
 *
 * 节点存在但读不出记忆元数据（`memories/` 下的 `.abstract.md`、还没进索引的文件）
 * 时返回全 `null` 的字段，不返回 404：文件在文件树里看得见，界面要把「不是一条
 * 当前记忆」与「请求失败」分开显示。节点不存在才是 404。目录与版本文件
 * （`.history/`）同样返回空字段——它们不是一条当前记忆。
 */

import type { FastifyInstance } from 'fastify';

import { ComemError } from '../../../domain/errors.js';
import { isVersionFile, type NodeStatus } from '../../../domain/node.js';
import { ok } from '../envelope.js';
import { requestContextOf } from '../middleware.js';
import type { HttpRouteGroup } from '../server.js';

import type { HttpRouteServices } from './index.js';
import { parseMemoryUri } from './memories-request.js';

/** §12.1：read = 1。与 `content/read` 同一档。 */
const READ = 1;

/** `GET /memories/{uri}` 的响应体。没有记忆元数据时各字段是 `null`。 */
interface MemoryMetaResponse {
  readonly uri: string;
  readonly memoryType: string | null;
  readonly status: NodeStatus | null;
  readonly validFrom: string | null;
  readonly validUntil: string | null;
}

export function createMemoryMetaRoutes(services: HttpRouteServices): HttpRouteGroup {
  const { filesystem, index, memory, authorizer } = services;

  return {
    prefix: '/memories',
    register(app: FastifyInstance): void {
      app.get<{ Params: { uri: string } }>('/:uri', async (request) => {
        const uri = parseMemoryUri(request.params.uri);
        const principals = requestContextOf(request).principals;
        await authorizer.assert(uri, READ, principals);

        const stat = await filesystem.stat(uri, principals);
        if (stat === null) {
          throw new ComemError('NOT_FOUND', `节点不存在：${uri.toString()}`, {
            uri: uri.toString(),
          });
        }

        // 目录与版本快照不是「一条当前记忆」；它们没有可回答的检索状态。
        const isMemoryFile = stat.kind === 'file' && !isVersionFile(uri);
        const indexed = isMemoryFile ? await index.stat(uri.toString()) : null;
        const record = isMemoryFile ? await memory.read(uri) : null;
        return ok<MemoryMetaResponse>({
          uri: uri.toString(),
          // 检索索引是「能不能被搜到」的实际判据；没有索引行就是状态未知。
          memoryType: indexed?.memoryType ?? null,
          status: indexed?.status ?? null,
          // 有效期只在记忆文件里；索引的 NodeStat 没有这两列。
          validFrom: record?.validFrom ?? null,
          validUntil: record?.validUntil ?? null,
        });
      });
    },
  };
}
