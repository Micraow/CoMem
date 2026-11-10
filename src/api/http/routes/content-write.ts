/**
 * 内容写路径（`POST /content/write`、`/edit`）。
 *
 * 函数体与拆分前逐字相同，只加了 `ok` 的类型实参与 import。
 */

import type { FastifyInstance } from 'fastify';

import { ComemError } from '../../../domain/errors.js';
import { ok } from '../envelope.js';
import { requestContextOf } from '../middleware.js';
import {
  requireRecord,
  requireText,
  requireUri,
  type HttpRouteGroup,
} from '../server.js';

import type { ContentEditResponse, ContentWriteResponse } from './content.js';
import { parsePatchBlocks, parseWriteMode, readExisting } from './content-request.js';
import type { HttpRouteServices } from './index.js';

/** §12.1：read = 1、write = 3。 */
const WRITE = 3;

export function createContentWriteRoutes(services: HttpRouteServices): HttpRouteGroup {
  const { filesystem, authorizer } = services;

  return {
    prefix: '/content',
    register(app: FastifyInstance): void {
      app.post<{ Body: unknown }>('/write', async (request) => {
        const body = requireRecord(request.body, 'content/write');
        const uri = requireUri(body, 'uri');
        const content = requireText(body, 'content');
        const mode = parseWriteMode(body['mode']);
        const principals = requestContextOf(request).principals;
        await authorizer.assert(uri, WRITE, principals);

        switch (mode) {
          case 'replace': {
            const result = await filesystem.write(uri, content, principals);
            return ok<ContentWriteResponse>({ uri: uri.toString(), created: result.created, size: result.stat.size });
          }
          case 'append': {
            const existing = await readExisting(services, uri, principals);
            const result = await filesystem.write(uri, `${existing}${content}`, principals);
            return ok<ContentWriteResponse>({ uri: uri.toString(), created: result.created, size: result.stat.size });
          }
          case 'create': {
            if ((await filesystem.stat(uri, principals)) !== null) {
              throw new ComemError('ALREADY_EXISTS', `目标已存在：${uri.toString()}`, {
                uri: uri.toString(),
              });
            }
            const result = await filesystem.write(uri, content, principals);
            return ok<ContentWriteResponse>({ uri: uri.toString(), created: result.created, size: result.stat.size });
          }
          default: {
            // `WRITE_MODES`（`api/write-mode.ts`）加一个模式时这一行编译失败。
            const exhaustive: never = mode;
            throw new ComemError(
              'INVALID_ARGUMENT',
              `write 的 mode 不受支持：${String(exhaustive)}`,
              { mode: exhaustive },
            );
          }
        }
      });

      app.post<{ Body: unknown }>('/edit', async (request) => {
        const body = requireRecord(request.body, 'content/edit');
        const uri = requireUri(body, 'uri');
        const blocks = parsePatchBlocks(body['blocks']);
        const principals = requestContextOf(request).principals;
        await authorizer.assert(uri, WRITE, principals);
        const result = await filesystem.edit(uri, blocks, principals);
        return ok<ContentEditResponse>({
          uri: uri.toString(),
          applied: result.applied,
          size: result.stat.size,
        });
      });
    },
  };
}
