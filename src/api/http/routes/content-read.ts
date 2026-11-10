/**
 * 内容读路径（`GET /content/read`、`/abstract`、`/overview`、`/download`）。
 *
 * 函数体与拆分前逐字相同，只加了 `ok` 的类型实参与 import。
 */

import type { FastifyInstance } from 'fastify';

import { ComemError } from '../../../domain/errors.js';
import { verifyDownloadToken } from '../../mcp/tools/download.js';
import { sliceText } from '../../text-slice.js';
import { ok } from '../envelope.js';
import { requestContextOf } from '../middleware.js';
import {
  optionalQueryInteger,
  requireRecord,
  requireString,
  requireUri,
  type HttpRouteGroup,
} from '../server.js';

import type {
  ContentAbstractResponse,
  ContentOverviewResponse,
  ContentReadResponse,
} from './content.js';
import type { HttpRouteServices } from './index.js';

/** §12.1：read = 1、write = 3。 */
const READ = 1;

/** 下载的 MIME。附件不猜类型：内容是二进制，猜错只会让浏览器把它当图片打开。 */
const DOWNLOAD_CONTENT_TYPE = 'application/octet-stream';

export function createContentReadRoutes(services: HttpRouteServices): HttpRouteGroup {
  const { filesystem, summary, authorizer } = services;

  return {
    prefix: '/content',
    register(app: FastifyInstance): void {
      app.get<{ Querystring: Record<string, unknown> }>('/read', async (request) => {
        const query = requireRecord(request.query, 'content/read');
        const uri = requireUri(query, 'uri');
        const offset = optionalQueryInteger(query, 'offset', 0, { min: 0 });
        const limit = optionalQueryInteger(query, 'limit', -1, { min: -1 });
        const principals = requestContextOf(request).principals;
        await authorizer.assert(uri, READ, principals);
        const document = await filesystem.read(uri, principals);
        const text = sliceText(document.text, offset, limit);
        return ok<ContentReadResponse>({
          uri: uri.toString(),
          text,
          // `limit < 0` 表示不截断；否则「还有码点没返回」才是截断。按码点数比较，
          // 中文与 emoji 不会因为 UTF-16 代理对被算多。
          truncated: limit >= 0 && offset + [...text].length < [...document.text].length,
        });
      });

      app.get<{ Querystring: Record<string, unknown> }>('/abstract', async (request) => {
        const query = requireRecord(request.query, 'content/abstract');
        const uri = requireUri(query, 'uri');
        await authorizer.assert(uri, READ, requestContextOf(request).principals);

        // 文件的 L0 存在索引里（§6.7：文件级摘要跟着文件走，写在 frontmatter 里
        // 再物化进索引），目录的 L0 才是 `.abstract.md`。只读摘要文件会让文件详情
        // 页永远显示「还没有摘要」，而摘要其实早就生成了。
        const node = await services.index.stat(uri.toString());
        if (node !== null && node.kind === 'document') {
          return ok<ContentAbstractResponse>({
            uri: uri.toString(),
            abstract: node.abstract,
            degraded: false,
            source: 'index',
          });
        }

        const directory = await summary.read(uri);
        return ok<ContentAbstractResponse>({
          uri: uri.toString(),
          abstract: directory?.abstract ?? null,
          degraded: directory?.degraded ?? false,
          source: 'summary',
        });
      });

      app.get<{ Querystring: Record<string, unknown> }>('/overview', async (request) => {
        const query = requireRecord(request.query, 'content/overview');
        const uri = requireUri(query, 'uri');
        await authorizer.assert(uri, READ, requestContextOf(request).principals);

        // 文件没有 L1 概览：概览是**目录级**的（§9.1）。文件详情页的「概览」档
        // 由前端用正文的标题树合成（`skeletonOverview` 的同一条逻辑），这里返回
        // `null` 并在 `source` 里说清来源。
        const node = await services.index.stat(uri.toString());
        if (node !== null && node.kind === 'document') {
          return ok<ContentOverviewResponse>({ uri: uri.toString(), overview: null, degraded: false, source: 'none' });
        }

        const directory = await summary.read(uri);
        return ok<ContentOverviewResponse>({
          uri: uri.toString(),
          overview: directory?.overview ?? null,
          degraded: directory?.degraded ?? false,
          source: 'summary',
        });
      });

      app.get<{ Querystring: Record<string, unknown> }>('/download', async (request, reply) => {
        const query = requireRecord(request.query, 'content/download');
        const uri = requireUri(query, 'uri');
        const expires = requireString(query, 'expires');
        const signature = requireString(query, 'signature');

        if (!verifyDownloadToken(uri.toString(), expires, signature)) {
          throw new ComemError(
            'PERMISSION_DENIED',
            '下载链接无效或已过期，请重新签发。',
            { uri: uri.toString() },
          );
        }

        const principals = requestContextOf(request).principals;
        await authorizer.assert(uri, READ, principals);
        const stat = await filesystem.stat(uri, principals);
        if (stat === null || stat.kind !== 'file') {
          throw new ComemError('NOT_FOUND', `下载目标不是文件：${uri.toString()}`, {
            uri: uri.toString(),
          });
        }

        const bytes = await filesystem.readBytes(uri, requestContextOf(request).principals);
        return reply
          .header('content-type', DOWNLOAD_CONTENT_TYPE)
          .header(
            'content-disposition',
            `attachment; filename*=UTF-8''${encodeURIComponent(uri.name)}`,
          )
          .header('content-length', String(bytes.byteLength))
          .send(Buffer.from(bytes));
      });
    },
  };
}
