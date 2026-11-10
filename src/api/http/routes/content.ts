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
 *
 * 请求解析与参数校验在 `content-request.ts`；读路径与写路径各自一个文件，本文件
 * 只做装配与响应形状。
 */

import type { FastifyInstance } from 'fastify';

import type { HttpRouteGroup } from '../server.js';

import { createContentReadRoutes } from './content-read.js';
import type { HttpRouteServices } from './index.js';
import { createContentWriteRoutes } from './content-write.js';

/** `GET /content/read` 的响应体：正文分页后的文本。 */
interface ContentReadResponse {
  readonly uri: string;
  readonly text: string;
  /** `limit < 0` 表示不截断；否则表示还有码点没返回。 */
  readonly truncated: boolean;
}

/** `GET /content/abstract` 的响应体。 */
interface ContentAbstractResponse {
  readonly uri: string;
  /** 没有摘要时为 `null`。 */
  readonly abstract: string | null;
  /** 摘要是否来自降级路径（`summary.generator = rule`）。 */
  readonly degraded: boolean;
  /** 文件级摘要读索引（`index`），目录级读 `.abstract.md`（`summary`）。 */
  readonly source: 'index' | 'summary';
}

/** `GET /content/overview` 的响应体。 */
interface ContentOverviewResponse {
  readonly uri: string;
  /** 文件没有 L1 概览，恒为 `null`。 */
  readonly overview: string | null;
  readonly degraded: boolean;
  /** 文件没有概览（`none`），目录读 `.overview.md`（`summary`）。 */
  readonly source: 'none' | 'summary';
}

/** `POST /content/write` 的响应体。 */
interface ContentWriteResponse {
  readonly uri: string;
  readonly created: boolean;
  readonly size: number;
}

/** `POST /content/edit` 的响应体。 */
interface ContentEditResponse {
  readonly uri: string;
  readonly applied: number;
  readonly size: number;
}

export function createContentRoutes(services: HttpRouteServices): HttpRouteGroup {
  return {
    prefix: '/content',
    register(app: FastifyInstance): void {
      createContentReadRoutes(services).register(app);
      createContentWriteRoutes(services).register(app);
    },
  };
}

export type {
  ContentAbstractResponse,
  ContentEditResponse,
  ContentOverviewResponse,
  ContentReadResponse,
  ContentWriteResponse,
};
