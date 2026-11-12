/**
 * 资源摄取路由（架构文档 §14、§13.2 的 `add_resource`）。
 *
 * ## 为什么 `temp-upload` 收原始字节而不是 `multipart/form-data`
 *
 * 二分法：要么加 `@fastify/multipart`（多一个依赖 + 一套临时文件清理语义），要么
 * 只收 `application/octet-stream` + `x-file-name` 头。这里选后者：
 *
 * - 服务层本来就是「先 `stageUpload` 拿 `uploadId`，再 `addResource` 引用它」的
 *   两步协议（§13.2），multipart 的一次性上传根本用不上；
 * - 原始字节没有边界解析、文件名字段、编码协商这些分支，攻击面更小；
 * - 调用方是控制台与 agent，`fetch(url, {method:'POST', body: file})` 加一个头
 *   就能用，不需要构造 multipart 边界。
 *
 * 文件名只作为**提示**：真正落盘的名字由 `addResource` 的 `path` 决定，`x-file-name`
 * 只进 `_meta/tmp/` 的元数据。
 *
 * 限制：单文件上限与 `ResourceService` 的 `maxFileBytes` 一致（50MB）。超出返回
 * `RESOURCE_EXHAUSTED`（429），连临时文件都不写。
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';

import { ComemError, invalidArgument } from '../../../domain/errors.js';
import {
  DEFAULT_MAX_FILE_BYTES,
  type AddResourceResult,
} from '../../../services/resource.js';
import { ok } from '../envelope.js';
import { requestContextOf } from '../middleware.js';
import { optionalInteger, requireRecord, requireUri, type HttpRouteGroup } from '../server.js';

import type { HttpRouteServices } from './index.js';

/** §12.1：write = 3（摄取是写操作）。 */
const WRITE = 3;

/** 原始字节的 Content-Type（见文件头）。 */
const BINARY_CONTENT_TYPE = 'application/octet-stream';

interface ParsedFile {
  readonly path: string;
  readonly content?: string;
  readonly uploadId?: string;
  readonly summary?: string;
}

function parseFile(value: unknown, index: number): ParsedFile {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalidArgument(`files[${index}] 必须是对象。`, { index });
  }
  const record = requireRecord(value, `files[${index}]`);
  const path = record['path'];
  if (typeof path !== 'string' || path === '') {
    throw invalidArgument(`files[${index}].path 必须是非空字符串。`, { index });
  }

  const content = record['content'];
  const uploadId = record['uploadId'];
  const summary = record['summary'];
  if (content !== undefined && typeof content !== 'string') {
    throw invalidArgument(`files[${index}].content 必须是字符串。`, { index });
  }
  if (uploadId !== undefined && typeof uploadId !== 'string') {
    throw invalidArgument(`files[${index}].uploadId 必须是字符串。`, { index });
  }
  if (summary !== undefined && typeof summary !== 'string') {
    throw invalidArgument(`files[${index}].summary 必须是字符串。`, { index });
  }
  if (content === undefined && uploadId === undefined) {
    throw invalidArgument(`files[${index}] 需要 content 或 uploadId。`, { index });
  }

  return {
    path,
    ...(typeof content === 'string' ? { content } : {}),
    ...(typeof uploadId === 'string' ? { uploadId } : {}),
    ...(typeof summary === 'string' ? { summary } : {}),
  };
}

function parseFiles(value: unknown): readonly ParsedFile[] {
  if (!Array.isArray(value)) {
    throw invalidArgument('files 必须是数组。', { field: 'files' });
  }
  return value.map((item, index) => parseFile(item, index));
}

/** `x-file-name` 头：重复头取第一个非空值，缺省为 `null`。 */
function fileNameOf(request: FastifyRequest): string | null {
  const value = request.headers['x-file-name'];
  if (typeof value === 'string' && value !== '') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.find((candidate) => candidate !== '') ?? null;
  }
  return null;
}

/** `POST /resources` 的响应体：落盘结果按「新建 / 更新 / 跳过 / 附件」分组。 */
interface ResourceAddResponse {
  readonly parentUri: string;
  readonly created: readonly string[];
  readonly updated: readonly string[];
  /** 跳过的文件与原因（大小上限、文件名冲突之外的服务层判断）。 */
  readonly skipped: AddResourceResult['skipped'];
  readonly attachments: readonly string[];
  readonly tokens: AddResourceResult['tokens'];
}

export function createResourceRoutes(services: HttpRouteServices): HttpRouteGroup {
  const { resource, authorizer } = services;

  return {
    prefix: '/resources',
    register(app: FastifyInstance): void {
      // 只在本插件内生效：其它路由仍然只接受 JSON。
      app.addContentTypeParser(
        BINARY_CONTENT_TYPE,
        { parseAs: 'buffer' },
        (_request, body, done) => {
          done(null, body);
        },
      );

      app.post<{ Body: unknown }>('/temp-upload', async (request) => {
        requestContextOf(request);
        const bytes = request.body;
        if (!Buffer.isBuffer(bytes)) {
          throw new ComemError(
            'INVALID_ARGUMENT',
            `temp-upload 只接受 ${BINARY_CONTENT_TYPE} 的原始字节。`,
            { contentType: request.headers['content-type'] ?? null },
          );
        }
        if (bytes.byteLength > DEFAULT_MAX_FILE_BYTES) {
          throw new ComemError(
            'RESOURCE_EXHAUSTED',
            `文件大小 ${bytes.byteLength} 字节超过单文件上限 ${DEFAULT_MAX_FILE_BYTES} 字节。`,
            { size: bytes.byteLength, maxFileBytes: DEFAULT_MAX_FILE_BYTES },
          );
        }

        const fileName = fileNameOf(request);
        const result = await resource.stageUpload(new Uint8Array(bytes), {
          ...(fileName === null ? {} : { fileName }),
        });
        return ok(result);
      });

      app.post<{ Body: unknown }>('/', async (request) => {
        const body = requireRecord(request.body, 'resources/add');
        const context = requestContextOf(request);
        const parentUri = requireUri(body, 'parentUri');
        const files = parseFiles(body['files']);
        const maxFileBytes = optionalInteger(body, 'maxFileBytes', DEFAULT_MAX_FILE_BYTES, {
          min: 1,
        });
        const maxFiles = optionalInteger(body, 'maxFiles', 1000, { min: 1 });

        await authorizer.assert(parentUri, WRITE, context.principals);
        const result = await resource.addResource({
          parentUri,
          files,
          subject: context.subject,
          principals: context.principals,
          maxFileBytes,
          maxFiles,
        });

        return ok<ResourceAddResponse>({
          parentUri: parentUri.toString(),
          created: result.created.map((uri) => uri.toString()),
          updated: result.updated.map((uri) => uri.toString()),
          skipped: result.skipped,
          attachments: result.attachments.map((uri) => uri.toString()),
          tokens: result.tokens,
        });
      });
    },
  };
}
