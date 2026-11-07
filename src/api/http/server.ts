/**
 * HTTP 服务端装配（架构文档 §14、§17.1、§17.9、§19）。
 *
 * ## 前缀与挂载
 *
 * 业务路由统一前缀 `/api/v1`（§14）。`/health` 与 `/metrics` 是运维端点（§17.1、
 * §17.9），同时挂在根路径和前缀下：探活与 Prometheus 抓取按根路径写，控制台按
 * 「所有 API 都在前缀下」调用，两者都成立，不需要调用方记住例外。
 *
 * MCP 挂在 `/mcp`（Streamable HTTP 传输），由 `McpHttpServer` 自己注册——它只要求
 * `post` / `get` 两个方法，测试可以传 `node:http` 的适配器，不依赖 Fastify。
 *
 * ## 错误只有一种形状
 *
 * 404 与异常都走 `error-mapper`：Fastify 默认的纯文本 404 会被客户端当成 HTML，
 * 而「接口总是返回 JSON 封套」是集成方的硬要求（§14）。500 额外写一条带 `requestId`
 * 的 error 日志——响应体里没有堆栈（§19），定位只能靠这个 ID（§17.7）。
 *
 * ## 请求 ID 进 `details`
 *
 * `error-mapper` 不依赖 HTTP 上下文，所以它不写 `requestId`；这一层在封套上补
 * `details.requestId`（§17.7「每个错误响应的 details.requestId 带上」）。
 */

import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';

import type { ComemConfig } from '../../config/index.js';
import { ComemError } from '../../domain/errors.js';
import type { Logger } from '../../domain/log.js';
import { Uri } from '../../domain/uri.js';
import type { ObservabilityService } from '../../services/observability.js';
import type { McpHttpServer } from '../mcp/server.js';

import { toErrorEnvelope } from './error-mapper.js';
import {
  createIdentityMiddleware,
  createObservabilityMiddleware,
  createRequestIdMiddleware,
  REQUEST_ID_HEADER,
  recordErrorCode,
  requestErrorCode,
  requestStartedAt,
  tryRequestContext,
  type IdentityResolver,
} from './middleware.js';

/** 业务路由的统一前缀（§14）。 */
export const API_PREFIX = '/api/v1';

/** Prometheus 文本的 Content-Type（§17.1 的抓取格式）。 */
export const PROMETHEUS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

/** 与 `package.json` 一致（§17.9 的 `version` 字段）。 */
export const SERVICE_VERSION = '0.1.0';

/** 一个路由分组。`prefix` 为空串表示挂在根路径（运维端点）。 */
export interface HttpRouteGroup {
  readonly prefix: string;
  readonly register: (app: FastifyInstance) => void;
}

export interface HttpServerOptions {
  readonly config: ComemConfig;
  readonly logger: Logger;
  readonly observability: ObservabilityService;
  readonly routes: readonly HttpRouteGroup[];
  readonly mcp: McpHttpServer;
  readonly resolveIdentity: IdentityResolver;
}

/** `startHttpServer` 的返回值：URL 与幂等的关闭入口。 */
export interface RunningHttpServer {
  readonly app: FastifyInstance;
  readonly url: string;
  close(): Promise<void>;
}

// ── 请求参数校验（§19：非法参数是 INVALID_ARGUMENT，非法 URI 是 INVALID_URI）──

function invalidArgument(field: string, expected: string, value: unknown): ComemError {
  return new ComemError('INVALID_ARGUMENT', `参数 ${field} 必须是${expected}。`, {
    field,
    value,
  });
}

/** 请求体必须是对象。GET 的查询串用 `request.query`，形状相同。 */
export function requireRecord(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ComemError('INVALID_ARGUMENT', `${where} 的请求体必须是对象。`, { where });
  }
  return { ...value };
}

export function requireString(
  body: Record<string, unknown>,
  field: string,
): string {
  const value = body[field];
  if (typeof value !== 'string' || value === '') {
    throw invalidArgument(field, '非空字符串', value);
  }
  return value;
}

/** 允许空串的字符串（正文可以是空的）。 */
export function requireText(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== 'string') {
    throw invalidArgument(field, '字符串', value);
  }
  return value;
}

export function optionalString(
  body: Record<string, unknown>,
  field: string,
): string | undefined {
  const value = body[field];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw invalidArgument(field, '字符串', value);
  }
  return value;
}

/**
 * 请求体里的整数。查询串用 `optionalQueryInteger`——那个还要处理「字符串转数字」。
 */
export function optionalInteger(
  body: Record<string, unknown>,
  field: string,
  fallback: number,
  options: { readonly min?: number; readonly max?: number } = {},
): number {
  const value = body[field];
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw invalidArgument(field, '整数', value);
  }
  if (options.min !== undefined && value < options.min) {
    throw invalidArgument(field, `不小于 ${options.min} 的整数`, value);
  }
  if (options.max !== undefined && value > options.max) {
    throw invalidArgument(field, `不大于 ${options.max} 的整数`, value);
  }
  return value;
}

/**
 * 查询串里的整数。
 *
 * Fastify 把查询串解析成字符串（`?depth=1` 的 `depth` 是 `'1'`），而 JSON 请求体
 * 里的整数是 `number`。两个来源共用一个校验点，只在查询串这一侧做一次转换——
 * 转换失败仍然是 `INVALID_ARGUMENT`，不把 `'abc'` 解释成 `NaN` 往下传。
 */
export function optionalQueryInteger(
  query: Record<string, unknown>,
  field: string,
  fallback: number,
  options: { readonly min?: number; readonly max?: number } = {},
): number {
  const raw = query[field];
  if (raw === undefined) {
    return fallback;
  }
  const value = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : Number.NaN;
  if (!Number.isInteger(value)) {
    throw invalidArgument(field, '整数', raw);
  }
  if (options.min !== undefined && value < options.min) {
    throw invalidArgument(field, `不小于 ${options.min} 的整数`, raw);
  }
  if (options.max !== undefined && value > options.max) {
    throw invalidArgument(field, `不大于 ${options.max} 的整数`, raw);
  }
  return value;
}

/**
 * URI 参数校验。
 *
 * 用 `Uri.parse` 而不是自己写正则：规范化（NFC、合并斜杠、保留名、单段字节上限）
 * 只有一份实现，自己写一份必然与 `domain/uri.ts` 漂移（§6.2）。
 */
export function requireUri(body: Record<string, unknown>, field: string): Uri {
  const value = body[field];
  if (typeof value !== 'string' || value === '') {
    throw new ComemError('INVALID_URI', `参数 ${field} 必须是 comem:// URI 字符串。`, {
      field,
      value,
    });
  }
  return Uri.parse(value);
}

/** 字符串数组；元素必须是字符串。 */
export function optionalStringArray(
  body: Record<string, unknown>,
  field: string,
): readonly string[] | undefined {
  const value = body[field];
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw invalidArgument(field, '字符串数组', value);
  }
  return value;
}

// ── 错误封套 ──

function detailsWithRequestId(details: unknown, requestId: string): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  if (typeof details === 'object' && details !== null && !Array.isArray(details)) {
    for (const [key, value] of Object.entries(details)) {
      merged[key] = value;
    }
  }
  merged['requestId'] = requestId;
  return merged;
}

function pathOf(request: FastifyRequest): string {
  return request.routeOptions.url ?? request.url;
}

// ── 服务端 ──

/**
 * 建服务实例，不监听端口。
 *
 * 测试用 `app.inject()`（进程内请求，不占端口）；`startHttpServer` 负责 `listen`。
 * `logger: false` 是刻意的：CoMem 有自己的结构化日志（§17.8），Fastify 再打一份
 * 只会让同一行出现两次，字段还不一样。
 */
export async function createHttpServer(options: HttpServerOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    // Fastify 内置的 requestId 与我们的 `x-request-id` 是两份数据，只用一份。
    requestIdHeader: false,
    // 默认 1MB 挡不住 `temp-upload` 的二进制；单文件上限由该路由自己再校验。
    bodyLimit: 64 * 1024 * 1024,
  });

  // 顺序即执行顺序（见 `middleware.ts` 文件头）。
  app.addHook('onRequest', createObservabilityMiddleware(options.observability));
  app.addHook('onRequest', createRequestIdMiddleware());
  app.addHook('onRequest', createIdentityMiddleware(options.resolveIdentity));

  app.addHook('onResponse', async (request, reply) => {
    const context = tryRequestContext(request);
    if (context === null) {
      return;
    }
    await options.observability.recordRequest({
      requestId: context.requestId,
      method: request.method,
      path: pathOf(request),
      statusCode: reply.statusCode,
      durationMs: performance.now() - requestStartedAt(request),
      errorCode: requestErrorCode(request),
      subject: context.subject === '' ? null : context.subject,
    });
  });

  app.setErrorHandler((error, request, reply) => {
    const mapped = toErrorEnvelope(error);
    const requestId = tryRequestContext(request)?.requestId ?? null;
    // 4xx 也记：`request_log` 的 errorCode 列对「为什么被拒」比状态码更有信息量。
    recordErrorCode(request, mapped.body.error.code);
    if (mapped.statusCode >= 500) {
      options.logger.error('HTTP 请求失败。', {
        requestId,
        method: request.method,
        path: pathOf(request),
        code: mapped.body.error.code,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    const body =
      requestId === null
        ? mapped.body
        : {
            ...mapped.body,
            error: {
              ...mapped.body.error,
              details: detailsWithRequestId(mapped.body.error.details, requestId),
            },
          };
    if (requestId !== null) {
      reply.header(REQUEST_ID_HEADER, requestId);
    }
    reply.code(mapped.statusCode).send(body);
  });

  app.setNotFoundHandler((request, reply) => {
    const requestId = tryRequestContext(request)?.requestId ?? null;
    const mapped = toErrorEnvelope(
      new ComemError('NOT_FOUND', `没有这个接口：${request.method} ${pathOf(request)}`, {
        method: request.method,
        path: pathOf(request),
      }),
    );
    const body =
      requestId === null
        ? mapped.body
        : {
            ...mapped.body,
            error: {
              ...mapped.body.error,
              details: detailsWithRequestId(mapped.body.error.details, requestId),
            },
          };
    if (requestId !== null) {
      reply.header(REQUEST_ID_HEADER, requestId);
    }
    reply.code(mapped.statusCode).send(body);
  });

  for (const group of options.routes) {
    // 空前缀 = 运维端点，同时挂根路径与 API 前缀（见文件头）。
    if (group.prefix === '') {
      app.register(group.register, { prefix: '' });
      app.register(group.register, { prefix: API_PREFIX });
      continue;
    }
    app.register(group.register, { prefix: `${API_PREFIX}${group.prefix}` });
  }

  options.mcp.mount(app);

  await app.ready();
  options.logger.debug('HTTP 服务已装配。', {
    routes: options.routes.length,
    prefix: API_PREFIX,
  });
  return app;
}

/**
 * 监听端口。
 *
 * URL 从实际地址取而不是拼配置：`port: 0`（测试、系统分配）时配置里是 0，拼出来
 * 是个连不上的地址。
 */
export async function startHttpServer(options: HttpServerOptions): Promise<RunningHttpServer> {
  const app = await createHttpServer(options);
  const { host, port } = options.config.server;
  await app.listen({ host, port });

  const address = app.server.address();
  const url =
    typeof address === 'object' && address !== null
      ? `http://${address.address}:${address.port}`
      : `http://${host}:${port}`;

  let closed = false;
  return {
    app,
    url,
    close: async () => {
      if (closed) {
        return;
      }
      closed = true;
      await app.close();
    },
  };
}
