/**
 * 文件系统路由（架构文档 §14、§12.4）。
 *
 * 每个出口先求权，再调服务——服务内部也会再求一次（`FileSystemService` 的每个
 * 方法都以 `authorizer.assert` 开头）。这里不是重复劳动：§12.4 的出口清单是按
 * **出口**数的，路由层自己漏一个 `assert` 就等于少一道闸，而服务层的实现可能
 * 在重构时被换掉。
 *
 * `cp` 没有服务原语。`ContentStore` 只有 `move`（跨设备时内部才是「复制再删」），
 * 没有公开的 `copy`。这里按「文件读正文 + 摘要 frontmatter、目录递归」实现，
 * 走 `FileSystemService` 的 `read` / `write` / `mkdir` / `list`：
 *
 * - 权限、路径锁、观察者（索引 / 权限 / 摘要失效）全部生效；
 * - 记忆文件的 `memory_type` / `status` 等 frontmatter 字段**不会**被复制——它们由
 *   `MemoryService` 维护，`fs/cp` 不是记忆复制路径。复制出来的文件按普通文档索引。
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

function serializeEntry(entry: TreeEntry): SerializedEntry {
  return {
    uri: entry.uri.toString(),
    name: entry.uri.name,
    kind: entry.kind,
    size: entry.size,
  };
}

function serializeTree(result: TreeResult): {
  readonly root: string;
  readonly entries: readonly SerializedEntry[];
  readonly truncated: boolean;
} {
  return {
    root: result.root.toString(),
    entries: result.entries.map(serializeEntry),
    truncated: result.truncated,
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
        return ok({
          uri: uri.toString(),
          entries: (await filesystem.list(uri, principals)).map(serializeEntry),
        });
      });

      app.get<{ Querystring: Record<string, unknown> }>('/tree', async (request) => {
        const query = requireRecord(request.query, 'fs/tree');
        const uri = requireUri(query, 'uri');
        const depth = optionalQueryInteger(query, 'depth', DEFAULT_TREE_DEPTH, { min: 0 });
        const limit = optionalQueryInteger(query, 'limit', DEFAULT_TREE_LIMIT, { min: 1 });
        const principals = requestContextOf(request).principals;
        await authorizer.assert(uri, READ, principals);
        return ok(serializeTree(await filesystem.tree(uri, principals, { depth, limit })));
      });

      app.get<{ Querystring: Record<string, unknown> }>('/stat', async (request) => {
        const query = requireRecord(request.query, 'fs/stat');
        const uri = requireUri(query, 'uri');
        const principals = requestContextOf(request).principals;
        await authorizer.assert(uri, READ, principals);
        const stat = await filesystem.stat(uri, principals);
        return ok({
          uri: uri.toString(),
          stat:
            stat === null
              ? null
              : { kind: stat.kind, size: stat.size, updatedAt: stat.updatedAt },
        });
      });

      app.post<{ Body: unknown }>('/mkdir', async (request) => {
        const body = requireRecord(request.body, 'fs/mkdir');
        const uri = requireUri(body, 'uri');
        const principals = requestContextOf(request).principals;
        await authorizer.assert(uri, WRITE, principals);
        await filesystem.mkdir(uri, principals);
        return ok({ uri: uri.toString(), created: true });
      });

      app.post<{ Body: unknown }>('/mv', async (request) => {
        const body = requireRecord(request.body, 'fs/mv');
        const from = requireUri(body, 'from');
        const to = requireUri(body, 'to');
        const principals = requestContextOf(request).principals;
        await authorizer.assert(from, MANAGE, principals);
        await authorizer.assert(to, MANAGE, principals);
        await filesystem.move(from, to, principals);
        return ok({ from: from.toString(), to: to.toString() });
      });

      app.post<{ Body: unknown }>('/cp', async (request) => {
        const body = requireRecord(request.body, 'fs/cp');
        const from = requireUri(body, 'from');
        const to = requireUri(body, 'to');
        const principals = requestContextOf(request).principals;
        await authorizer.assert(from, READ, principals);
        await authorizer.assert(to, WRITE, principals);
        await copyNode(services, from, to, principals);
        return ok({ from: from.toString(), to: to.toString() });
      });

      app.delete<{ Querystring: Record<string, unknown> }>('/', async (request) => {
        const query = requireRecord(request.query, 'fs/delete');
        const uri = requireUri(query, 'uri');
        // 固定递归删（§12.4 的 `rm -r` 语义）。不提供「只删空目录」的开关：
        // 非空目录要删就得显式知道自己在删整棵子树，多一个参数不改变误删的后果。
        const principals = requestContextOf(request).principals;
        await authorizer.assert(uri, MANAGE, principals);
        const removed = await filesystem.remove(uri, principals);
        return ok({ uri: uri.toString(), removedFiles: removed.removedFiles });
      });
    },
  };
}
