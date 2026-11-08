/**
 * HTTP 中间件（架构文档 §17.6、§17.7、§17.8、§12.4）。
 *
 * 三件事按固定顺序挂在 `onRequest` 上：
 *
 * | 顺序 | 中间件 | 做什么 |
 * |---|---|---|
 * | 1 | 可观测 | 用 `withRequestScope` 包住**整个**请求 |
 * | 2 | 请求 ID | 从 `x-request-id` 取，没有就生成；回写响应头 |
 * | 3 | 身份 | 从 `x-comem-subject` 取；缺失时用 v1 单用户默认值 |
 *
 * ## 为什么可观测必须排第一
 *
 * `ObservabilityService` 用 `AsyncLocalStorage` 存「当前请求的阶段耗时」。作用域必须
 * 覆盖后续所有 hook 与 handler，阶段归因才不会被丢弃（§17.2：四阶段相加等于总耗时）。
 * 这也是唯一一个用 **callback 风格** 的理由：只有 `done()` 在 `run()` 的回调里被调用，
 * Fastify 后续的 Promise 链才会继承这个上下文。
 *
 * ## 身份为什么可以不校验
 *
 * v1 不做认证：身份由反向代理（Hook 插件、控制台网关）注入 `x-comem-subject`，本服务
 * 只负责把它变成 `RequestContext.subject`。**没这个头时用服务图绑定的主体**
 * （`server.subject`）——单用户桌面部署没有代理，要求它配置一个头只会让
 * `curl /health` 之类的手工调用全部 401。多租户部署要换成真正的认证，那时这里必须
 * 改成「缺失即 401 UNAUTHENTICATED」。
 *
 * ## 中间件抛错
 *
 * `resolveIdentity` 抛出的 `ComemError` 交给 Fastify 的错误处理（`setErrorHandler`），
 * 由 `error-mapper` 统一成封套——这里不自己写响应体，否则同一个错误会有两种形状。
 */

import { randomUUID } from 'node:crypto';

import type { FastifyReply, FastifyRequest } from 'fastify';

import { ComemError } from '../../domain/errors.js';

import type { ObservabilityService } from '../../services/observability.js';

/** 请求 ID 的响应头与入站头同名（§17.7）。 */
export const REQUEST_ID_HEADER = 'x-request-id';

/** 注入身份的请求头。v1 由反向代理设置。 */
export const SUBJECT_HEADER = 'x-comem-subject';

/** 通配主体（§12.1）。身份展开时永远追加在末尾。 */
const USER_WILDCARD = 'user:*';

/**
 * 不认证的路径（§17.1、§17.9）。
 *
 * 探活与 Prometheus 抓取由运维系统发起，它们没有 CoMem 身份，也不读用户内容。
 * 走认证只会让 `curl /health` 全部 401，而这两个端点泄露不了任何东西（只有计数）。
 *
 * 两个前缀各列一次：`createHttpServer` 把运维端点同时挂在根路径和 `/api/v1` 下。
 */
const PUBLIC_PATHS: ReadonlySet<string> = new Set([
  '/health',
  '/metrics',
  '/api/v1/health',
  '/api/v1/metrics',
  // 登录时还没有身份，登出没有服务端状态可清（§12.7）。两个前缀各列一次，
  // 与运维端点同理。
  '/auth/login',
  '/auth/logout',
  '/api/v1/auth/login',
  '/api/v1/auth/logout',
]);

/** 请求路径（去掉查询串）。 */
function pathnameOf(request: FastifyRequest): string {
  return request.url.split('?')[0] ?? request.url;
}

/** 一次请求的身份与 ID。由中间件写入，路由与日志读取。 */
export interface RequestContext {
  readonly requestId: string;
  readonly subject: string;
  readonly principals: readonly string[];
}

/** `resolveIdentity` 的入参：已归一化的请求头。 */
export type IdentityHeaders = Readonly<Record<string, string | undefined>>;

export interface Identity {
  readonly subject: string;
  readonly principals: readonly string[];
}

export type IdentityResolver = (headers: IdentityHeaders) => Promise<Identity>;

export type RequestIdMiddleware = (
  request: FastifyRequest,
  reply: FastifyReply,
) => Promise<void>;

export type IdentityMiddleware = (
  request: FastifyRequest,
  reply: FastifyReply,
) => Promise<void>;

/** callback 风格：`done()` 必须在 `withRequestScope` 的回调里调用（见文件头）。 */
export type ObservabilityMiddleware = (
  request: FastifyRequest,
  reply: FastifyReply,
  done: (error?: Error) => void,
) => void;

/** 请求级可变状态。`RequestContext` 是它的只读视图。 */
interface MutableRequestContext {
  readonly requestId: string;
  readonly startedAtMs: number;
  subject: string;
  principals: readonly string[];
  errorCode: string | null;
}

/**
 * 按请求对象存上下文。
 *
 * 用 `WeakMap` 而不是 `request` 上的属性：Fastify 的 `decorateRequest` 需要类型增强，
 * 而增强是全局声明——测试里 `app.inject()` 拿到的请求也会被增强，多一个全局形状。
 * `WeakMap` 的键是请求对象本身，请求结束自动回收。
 */
const requestContexts = new WeakMap<FastifyRequest, MutableRequestContext>();

function headerOf(headers: FastifyRequest['headers'], name: string): string | undefined {
  const value = headers[name];
  if (typeof value === 'string' && value !== '') {
    return value;
  }
  if (Array.isArray(value)) {
    const first = value.find((candidate) => candidate !== '');
    return first;
  }
  return undefined;
}

/**
 * Fastify 的 `IncomingHttpHeaders` → 单值字符串映射。
 *
 * 重复的同名头（`x-request-id` 出现两次）取第一个非空值：只处理第一个是「代理追加」
 * 与「代理覆盖」两种部署里都成立的那一种解释，不做拼接。
 */
function normalizeHeaders(headers: FastifyRequest['headers']): IdentityHeaders {
  const normalized: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value === 'string') {
      normalized[name] = value;
    } else if (Array.isArray(value)) {
      normalized[name] = value.find((candidate) => candidate !== '');
    }
  }
  return normalized;
}

/** 读请求上下文；中间件没跑（测试直接调 handler）时返回 `null`。 */
export function tryRequestContext(request: FastifyRequest): RequestContext | null {
  return requestContexts.get(request) ?? null;
}

/** 读请求上下文。路由里用；缺失是装配错误，不是调用方输入错误。 */
export function requestContextOf(request: FastifyRequest): RequestContext {
  const context = requestContexts.get(request);
  if (context === undefined) {
    throw new ComemError('INTERNAL', '请求上下文未初始化：可观测中间件没有挂上。');
  }
  return context;
}

/** §17.6 的 `durationMs` 起点。 */
export function requestStartedAt(request: FastifyRequest): number {
  return requestContexts.get(request)?.startedAtMs ?? performance.now();
}

/** 当前请求的错误码；成功请求为 `null`（§17.6 的 `errorCode` 列）。 */
export function requestErrorCode(request: FastifyRequest): string | null {
  return requestContexts.get(request)?.errorCode ?? null;
}

/** 错误处理器回填 `errorCode`，`onResponse` 记录到 `request_log`（§17.6）。 */
export function recordErrorCode(request: FastifyRequest, code: string): void {
  const context = requestContexts.get(request);
  if (context !== undefined) {
    context.errorCode = code;
  }
}

/**
 * 请求 ID（§17.7）。
 *
 * 没有入站 ID 时生成 UUID。**必须回写响应头**：客户端拿不到它就没法按 ID 查日志，
 * 「错误必须可解释」在响应体只留一句话的前提下就只剩这个入口。
 */
export function createRequestIdMiddleware(): RequestIdMiddleware {
  return async (request, reply) => {
    const requestId = headerOf(request.headers, REQUEST_ID_HEADER) ?? randomUUID();
    reply.header(REQUEST_ID_HEADER, requestId);
    requestContexts.set(request, {
      requestId,
      startedAtMs: performance.now(),
      subject: '',
      principals: [],
      errorCode: null,
    });
  };
}

/**
 * 身份（§12.4 的出口清单依赖它）。
 *
 * `resolveIdentity` 由装配方提供：真实实现读头并展开组，测试可以传固定身份。这里只
 * 负责把结果落到请求上下文——认证失败时抛 `ComemError('UNAUTHENTICATED')`，由
 * `error-mapper` 转成 401。
 */
export function createIdentityMiddleware(resolve: IdentityResolver): IdentityMiddleware {
  return async (request) => {
    if (PUBLIC_PATHS.has(pathnameOf(request))) {
      return;
    }
    const identity = await resolve(normalizeHeaders(request.headers));
    const context = requestContexts.get(request);
    if (context === undefined) {
      // 请求 ID 中间件没跑：装配顺序错了。抛 INTERNAL 而不是静默丢身份。
      throw new ComemError('INTERNAL', '请求 ID 中间件必须在身份中间件之前。');
    }
    context.subject = identity.subject;
    context.principals = identity.principals;
  };
}

/**
 * 可观测作用域（§17.2）。
 *
 * `done()` 在 `withRequestScope` 的回调里被同步调用，所以后续 hook 与 handler 都继承
 * 这个 `AsyncLocalStorage` 上下文；`onResponse` 里 `recordRequest` 才能读到阶段耗时。
 */
export function createObservabilityMiddleware(
  observability: ObservabilityService,
): ObservabilityMiddleware {
  return (_request, _reply, done) => {
    observability
      .withRequestScope(async () => {
        done();
      })
      .catch((error: unknown) => {
        // `done` 自己抛错时不能再调一次；这里只在 withRequestScope 自身失败时兜底。
        done(error instanceof Error ? error : new Error(String(error)));
      });
  };
}

/** 默认身份展开：绑定主体 + 通配主体。v1 没有组。 */
export function defaultIdentity(subject: string): Identity {
  return { subject, principals: [subject, USER_WILDCARD] };
}
