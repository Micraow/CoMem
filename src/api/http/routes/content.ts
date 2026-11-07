/**
 * 内容路由（架构文档 §14、§12.4、§13.2 的 `download`）。
 *
 * ## 下载走签名 URL
 *
 * 原始附件必须能被浏览器或 `curl` 直接下载（MCP 的文本/二进制块不适合大文件）。
 * 签名由 `api/mcp/tools/download.ts` 的 `verifyDownloadToken` 校验——签发与验证共用
 * 一份实现，两处各写一遍必然漂移。签名里的 `uri` 是**签名的一部分**：只校验
 * 「过期时间 + 签名」，不校验「这个 URI 是否属于当前身份」——签名本身已经绑定了
 * 它，能拿到 URL 的人本来就被授权过一次（10 分钟后失效）。
 *
 * ## 二进制响应不是封套
 *
 * `download` 返回原始字节，套一层 `{status:'ok', result:{base64}}` 会让下载变成
 * 「先解析 JSON 再解码」，大文件还要多占一倍内存。这是「响应一律走封套」的唯一
 * 例外，错误路径仍然走 `toErrorEnvelope`。
 *
 * ## 读写模式
 *
 * `write` 的三种模式与 MCP `write` 工具（§13.2）一致：`replace`（默认，保留
 * frontmatter）、`append`、`create`（已存在报 `ALREADY_EXISTS`）。
 */

import type { FastifyInstance } from 'fastify';

import { ComemError } from '../../../domain/errors.js';
import type { PatchBlock } from '../../../domain/patch.js';
import type { Uri } from '../../../domain/uri.js';
import { verifyDownloadToken } from '../../mcp/tools/download.js';

import { ok } from '../envelope.js';
import {
  optionalQueryInteger,
  requireRecord,
  requireString,
  requireText,
  requireUri,
  type HttpRouteGroup,
} from '../server.js';

import type { HttpRouteServices } from './index.js';

/** §12.1：read = 1、write = 3。 */
const READ = 1;
const WRITE = 3;

/** 下载的 MIME。附件不猜类型：内容是二进制，猜错只会让浏览器把它当图片打开。 */
const DOWNLOAD_CONTENT_TYPE = 'application/octet-stream';

const WRITE_MODES = ['replace', 'append', 'create'] as const;

type WriteMode = (typeof WRITE_MODES)[number];

function parseWriteMode(value: unknown): WriteMode {
  if (value === undefined) {
    return 'replace';
  }
  if (value === 'replace' || value === 'append' || value === 'create') {
    return value;
  }
  throw new ComemError('INVALID_ARGUMENT', `write 的 mode 只能是 ${WRITE_MODES.join(' / ')}。`, {
    mode: value,
  });
}

/**
 * 按 **Unicode 码点** 切片。中文与 emoji 才不会从中间断开（与 MCP `read` 一致）。
 */
function sliceText(text: string, offset: number, limit: number): string {
  const codePoints = [...text];
  return codePoints.slice(offset, limit < 0 ? undefined : offset + limit).join('');
}

function parsePatchBlocks(value: unknown): readonly PatchBlock[] {
  if (!Array.isArray(value)) {
    throw new ComemError('INVALID_ARGUMENT', 'edit 的 blocks 必须是数组。', {
      field: 'blocks',
    });
  }
  return value.map((item, index) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new ComemError('INVALID_ARGUMENT', `edit 的 blocks[${index}] 必须是对象。`, {
        index,
      });
    }
    const record = requireRecord(item, `edit.blocks[${index}]`);
    return {
      search: requireString(record, 'search'),
      replace: requireString(record, 'replace'),
    };
  });
}

async function readExisting(services: HttpRouteServices, uri: Uri): Promise<string> {
  try {
    return (await services.filesystem.read(uri)).text;
  } catch (error) {
    if (error instanceof ComemError && error.code === 'NOT_FOUND') {
      return '';
    }
    throw error;
  }
}

export function createContentRoutes(services: HttpRouteServices): HttpRouteGroup {
  const { filesystem, summary, authorizer } = services;

  return {
    prefix: '/content',
    register(app: FastifyInstance): void {
      app.get<{ Querystring: Record<string, unknown> }>('/read', async (request) => {
        const query = requireRecord(request.query, 'content/read');
        const uri = requireUri(query, 'uri');
        const offset = optionalQueryInteger(query, 'offset', 0, { min: 0 });
        const limit = optionalQueryInteger(query, 'limit', -1, { min: -1 });
        await authorizer.assert(uri, READ);
        const document = await filesystem.read(uri);
        return ok({
          uri: uri.toString(),
          text: sliceText(document.text, offset, limit),
          truncated: limit >= 0,
        });
      });

      app.get<{ Querystring: Record<string, unknown> }>('/abstract', async (request) => {
        const query = requireRecord(request.query, 'content/abstract');
        const uri = requireUri(query, 'uri');
        await authorizer.assert(uri, READ);

        // 文件的 L0 存在索引里（§6.7：文件级摘要跟着文件走，写在 frontmatter 里
        // 再物化进索引），目录的 L0 才是 `.abstract.md`。只读摘要文件会让文件详情
        // 页永远显示「还没有摘要」，而摘要其实早就生成了。
        const node = await services.index.stat(uri.toString());
        if (node !== null && node.kind === 'document') {
          return ok({
            uri: uri.toString(),
            abstract: node.abstract,
            degraded: false,
            source: 'index',
          });
        }

        const directory = await summary.read(uri);
        return ok({
          uri: uri.toString(),
          abstract: directory?.abstract ?? null,
          degraded: directory?.degraded ?? false,
          source: 'summary',
        });
      });

      app.get<{ Querystring: Record<string, unknown> }>('/overview', async (request) => {
        const query = requireRecord(request.query, 'content/overview');
        const uri = requireUri(query, 'uri');
        await authorizer.assert(uri, READ);

        // 文件没有 L1 概览：概览是**目录级**的（§9.1）。文件详情页的「概览」档
        // 由前端用正文的标题树合成（`skeletonOverview` 的同一条逻辑），这里返回
        // `null` 并在 `source` 里说清来源。
        const node = await services.index.stat(uri.toString());
        if (node !== null && node.kind === 'document') {
          return ok({ uri: uri.toString(), overview: null, degraded: false, source: 'none' });
        }

        const directory = await summary.read(uri);
        return ok({
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

        await authorizer.assert(uri, READ);
        const stat = await filesystem.stat(uri);
        if (stat === null || stat.kind !== 'file') {
          throw new ComemError('NOT_FOUND', `下载目标不是文件：${uri.toString()}`, {
            uri: uri.toString(),
          });
        }

        const bytes = await filesystem.readBytes(uri);
        return reply
          .header('content-type', DOWNLOAD_CONTENT_TYPE)
          .header(
            'content-disposition',
            `attachment; filename*=UTF-8''${encodeURIComponent(uri.name)}`,
          )
          .header('content-length', String(bytes.byteLength))
          .send(Buffer.from(bytes));
      });

      app.post<{ Body: unknown }>('/write', async (request) => {
        const body = requireRecord(request.body, 'content/write');
        const uri = requireUri(body, 'uri');
        const content = requireText(body, 'content');
        const mode = parseWriteMode(body['mode']);
        await authorizer.assert(uri, WRITE);

        switch (mode) {
          case 'replace': {
            const result = await filesystem.write(uri, content);
            return ok({ uri: uri.toString(), created: result.created, size: result.stat.size });
          }
          case 'append': {
            const existing = await readExisting(services, uri);
            const result = await filesystem.write(uri, `${existing}${content}`);
            return ok({ uri: uri.toString(), created: result.created, size: result.stat.size });
          }
          case 'create': {
            if ((await filesystem.stat(uri)) !== null) {
              throw new ComemError('ALREADY_EXISTS', `目标已存在：${uri.toString()}`, {
                uri: uri.toString(),
              });
            }
            const result = await filesystem.write(uri, content);
            return ok({ uri: uri.toString(), created: result.created, size: result.stat.size });
          }
        }
      });

      app.post<{ Body: unknown }>('/edit', async (request) => {
        const body = requireRecord(request.body, 'content/edit');
        const uri = requireUri(body, 'uri');
        const blocks = parsePatchBlocks(body['blocks']);
        await authorizer.assert(uri, WRITE);
        const result = await filesystem.edit(uri, blocks);
        return ok({
          uri: uri.toString(),
          applied: result.applied,
          size: result.stat.size,
        });
      });
    },
  };
}
