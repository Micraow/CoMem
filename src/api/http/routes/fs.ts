/**
 * 文件系统路由（架构文档 §14、§12.4）。
 *
 * 路由与 `FileSystemService` 各自求权，分别守护出口契约和内部调用。
 * `cp` 没有存储原语，这里递归调用读、写、建目录和列目录；记忆 frontmatter
 * 不随复制保留，复制结果按普通文档重新索引。
 */

import type { FastifyInstance } from 'fastify';

import { ComemError } from '../../../domain/errors.js';
import type { Uri } from '../../../domain/uri.js';
import type { TreeEntry, TreeResult } from '../../../services/filesystem.js';
import { ok } from '../envelope.js';
import { requestContextOf } from '../middleware.js';
import {
  optionalQueryInteger,
  requireRecord,
  requireUri,
  type HttpRouteGroup,
} from '../server.js';

import type { HttpRouteServices } from './index.js';

/** §12.1：read = 1、write = 3、manage = 7。 */
const READ = 1;
const WRITE = 3;
const MANAGE = 7;

/** `tree` 的默认深度与节点上限，与 `FileSystemService.tree` 的默认值一致。 */
const DEFAULT_TREE_DEPTH = 3;
const DEFAULT_TREE_LIMIT = 1000;

interface SerializedEntry {
  readonly uri: string;
  readonly name: string;
  readonly kind: 'file' | 'directory';
  readonly size: number;
}

interface FsCapabilities { readonly read: boolean; readonly write: boolean; readonly manage: boolean }

/** `GET /fs/tree` 的响应体：根 URI + 展平后的条目 + 是否被截断。 */
interface SerializedTree {
  readonly root: string;
  readonly entries: readonly SerializedEntry[];
  readonly truncated: boolean;
  readonly capabilities: FsCapabilities;
}

/** `GET /fs/stat` 的 stat 字段；目标不存在时授权层返回 404（`NOT_FOUND`），`null` 只用于并发删除。 */
interface FsStat {
  readonly kind: 'file' | 'directory';
  readonly size: number;
  readonly updatedAt: string;
}

/** `GET /fs/ls` 的响应体。 */
interface FsListResponse {
  readonly uri: string;
  readonly entries: readonly SerializedEntry[];
  readonly capabilities: FsCapabilities;
}

/** `GET /fs/stat` 的响应体。 */
interface FsStatResponse {
  readonly uri: string;
  readonly stat: FsStat | null;
  readonly capabilities: FsCapabilities;
}

/** `POST /fs/mkdir` 的响应体。 */
interface FsMkdirResponse {
  readonly uri: string;
  readonly created: true;
}

/** `POST /fs/mv`、`POST /fs/cp` 的响应体。 */
interface FsTransferResponse {
  readonly from: string;
  readonly to: string;
}

/** `DELETE /fs` 的响应体。 */
interface FsDeleteResponse {
  readonly uri: string;
  readonly removedFiles: number;
}

function serializeEntry(entry: TreeEntry): SerializedEntry {
  return {
    uri: entry.uri.toString(),
    name: entry.uri.name,
    kind: entry.kind,
    size: entry.size,
  };
}

async function capabilitiesOf(
  authorizer: HttpRouteServices['authorizer'],
  uri: Uri,
  principals: readonly string[],
): Promise<FsCapabilities> {
  const [read, write, manage] = await Promise.all([
    authorizer.check(uri, READ, principals),
    authorizer.check(uri, WRITE, principals),
    authorizer.check(uri, MANAGE, principals),
  ]);
  return { read, write, manage };
}

function serializeTree(result: TreeResult, capabilities: FsCapabilities): SerializedTree {
  return {
    root: result.root.toString(),
    entries: result.entries.map(serializeEntry),
    truncated: result.truncated,
    capabilities,
  };
}

/**
 * 递归复制。源不存在抛 NOT_FOUND；目录逐层建、逐层拷。
 *
 * 不可读的子项由 `filesystem.list` 过滤掉（无权限节点完全不出现，§12.4），所以复制
 * 一棵「部分可见」的目录只会得到可见的那部分——这比报错更符合「看不到就不存在」的
 * 列表语义。
 */
async function copyNode(
  services: HttpRouteServices,
  from: Uri,
  to: Uri,
  principals: readonly string[],
): Promise<void> {
  const stat = await services.filesystem.stat(from, principals);
  if (stat === null) {
    throw new ComemError('NOT_FOUND', `复制源不存在：${from.toString()}`, {
      uri: from.toString(),
    });
  }

  if (stat.kind === 'directory') {
    await services.filesystem.mkdir(to, principals);
    for (const child of await services.filesystem.list(from, principals)) {
      await copyNode(services, child.uri, to.child(child.uri.name), principals);
    }
    return;
  }

  const document = await services.filesystem.read(from, principals);
  await services.filesystem.write(
    to,
    document.text,
    principals,
    document.frontmatter === null ? {} : { frontmatter: document.frontmatter },
  );
}

export function createFsRoutes(services: HttpRouteServices): HttpRouteGroup {
  const { filesystem, authorizer } = services;

  return {
    prefix: '/fs',
    register(app: FastifyInstance): void {
      app.get<{ Querystring: Record<string, unknown> }>('/ls', async (request) => {
        const query = requireRecord(request.query, 'fs/ls');
        const uri = requireUri(query, 'uri');
        const principals = requestContextOf(request).principals;
        await authorizer.assert(uri, READ, principals);
        return ok<FsListResponse>({
          uri: uri.toString(),
          entries: (await filesystem.list(uri, principals)).map(serializeEntry),
          capabilities: await capabilitiesOf(authorizer, uri, principals),
        });
      });

      app.get<{ Querystring: Record<string, unknown> }>('/tree', async (request) => {
        const query = requireRecord(request.query, 'fs/tree');
        const uri = requireUri(query, 'uri');
        const depth = optionalQueryInteger(query, 'depth', DEFAULT_TREE_DEPTH, { min: 0 });
        const limit = optionalQueryInteger(query, 'limit', DEFAULT_TREE_LIMIT, { min: 1 });
        const principals = requestContextOf(request).principals;
        await authorizer.assert(uri, READ, principals);
        return ok<SerializedTree>(
          serializeTree(
            await filesystem.tree(uri, principals, { depth, limit }),
            await capabilitiesOf(authorizer, uri, principals),
          ),
        );
      });

      app.get<{ Querystring: Record<string, unknown> }>('/stat', async (request) => {
        const query = requireRecord(request.query, 'fs/stat');
        const uri = requireUri(query, 'uri');
        const principals = requestContextOf(request).principals;
        await authorizer.assert(uri, READ, principals);
        const stat = await filesystem.stat(uri, principals);
        return ok<FsStatResponse>({
          uri: uri.toString(),
          stat:
            stat === null
              ? null
              : { kind: stat.kind, size: stat.size, updatedAt: stat.updatedAt },
          capabilities: await capabilitiesOf(authorizer, uri, principals),
        });
      });

      app.post<{ Body: unknown }>('/mkdir', async (request) => {
        const body = requireRecord(request.body, 'fs/mkdir');
        const uri = requireUri(body, 'uri');
        const principals = requestContextOf(request).principals;
        await authorizer.assert(uri, WRITE, principals);
        await filesystem.mkdir(uri, principals);
        return ok<FsMkdirResponse>({ uri: uri.toString(), created: true });
      });

      app.post<{ Body: unknown }>('/mv', async (request) => {
        const body = requireRecord(request.body, 'fs/mv');
        const from = requireUri(body, 'from');
        const to = requireUri(body, 'to');
        const principals = requestContextOf(request).principals;
        await authorizer.assert(from, MANAGE, principals);
        await authorizer.assert(to, MANAGE, principals);
        await filesystem.move(from, to, principals);
        return ok<FsTransferResponse>({ from: from.toString(), to: to.toString() });
      });

      app.post<{ Body: unknown }>('/cp', async (request) => {
        const body = requireRecord(request.body, 'fs/cp');
        const from = requireUri(body, 'from');
        const to = requireUri(body, 'to');
        const principals = requestContextOf(request).principals;
        await authorizer.assert(from, READ, principals);
        await authorizer.assert(to, WRITE, principals);
        await copyNode(services, from, to, principals);
        return ok<FsTransferResponse>({ from: from.toString(), to: to.toString() });
      });

      app.delete<{ Querystring: Record<string, unknown> }>('/', async (request) => {
        const query = requireRecord(request.query, 'fs/delete');
        const uri = requireUri(query, 'uri');
        // 固定递归删（§12.4 的 `rm -r` 语义）。不提供「只删空目录」的开关：
        // 非空目录要删就得显式知道自己在删整棵子树，多一个参数不改变误删的后果。
        const principals = requestContextOf(request).principals;
        await authorizer.assert(uri, MANAGE, principals);
        const removed = await filesystem.remove(uri, principals);
        return ok<FsDeleteResponse>({ uri: uri.toString(), removedFiles: removed.removedFiles });
      });
    },
  };
}
