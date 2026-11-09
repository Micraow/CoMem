/**
 * MCP Streamable HTTP 服务端（架构文档 §13、§14、§17.7）。
 *
 * ## 无状态模式，每请求一个 transport
 *
 * `sessionIdGenerator: undefined` 打开无状态模式：没有会话状态、没有重连恢复。
 * 每个 HTTP 请求新建一个 `Server` + `StreamableHTTPServerTransport`，请求结束销毁。
 * 这是 SDK 对无状态模式的硬性要求（同一个 transport 处理第二个请求会撞消息 ID），
 * 也符合 CoMem 的现状——16 个工具都是无状态调用，没有需要跨请求保持的会话。
 *
 * ## 身份与 requestId
 *
 * 认证在 `resolveIdentity` 里完成（真实实现在 `bootstrap/`，测试用固定身份）。解析
 * 失败一律 401 + `UNAUTHENTICATED`，不回显底层异常。
 *
 * `requestId` 从 `x-request-id` 头取，没有就生成 UUID；它进 `McpToolContext`，由
 * 各工具写进日志（§17.7：没有 requestId 就串不起「哪个请求触发了哪次模型调用」）。
 *
 * ## 错误
 *
 * 工具抛 `ComemError` 时消息原样进 MCP 的 error 结果（`isError: true`），不暴露
 * 堆栈；非 `ComemError` 收敛成 `INTERNAL`，堆栈只进日志（§19）。
 *
 * ## 为什么 `mount` 用结构化的最小接口
 *
 * `api/` 可以 import fastify（禁止列表里只有 `adapters/` 与 `bootstrap/`），但为了
 * 让测试不依赖任何 HTTP 框架，`mount` 只要求 `post` / `get` 两个方法。真实装配传
 * Fastify 实例，测试传 `node:http` 的薄适配器；两者都只用到 `raw` 与可选 `hijack`。
 */

import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type CallToolResult,
  type ContentBlock,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';

import type { ComemConfig } from '../../config/index.js';
import { ComemError } from '../../domain/errors.js';
import type { Logger } from '../../domain/log.js';

import type { McpToolContext } from './context.js';
import type { McpToolDefinition, McpToolResult, ToolRegistry } from './registry.js';

/** MCP 端点的路径（§14：MCP 挂在 `/mcp`）。 */
const MCP_PATH = '/mcp';

/** 与 `package.json` 的版本一致。 */
const SERVER_VERSION = '0.1.0';

/** 服务端信息里展示给客户端。 */
const SERVER_NAME = 'comem';

/** 每个请求允许解析的身份。 */
export interface McpIdentity {
  readonly subject: string;
  readonly principals: readonly string[];
}

export interface McpServerOptions {
  readonly registry: ToolRegistry;
  readonly config: ComemConfig;
  readonly logger: Logger;
  /**
   * 从请求解析身份。真实实现在 bootstrap，测试用固定身份。
   *
   * 失败必须抛 `ComemError('UNAUTHENTICATED')`（或任意异常，server 会收敛成 401）。
   */
  readonly resolveIdentity: (request: {
    readonly headers: Record<string, string | undefined>;
  }) => Promise<McpIdentity>;
  /**
   * 除「本次请求的身份」之外的依赖。每次请求由它 + 认证结果拼出 `McpToolContext`。
   *
   * 这一段是 prompt 里 `McpServerOptions` 草图没有列出的必需项：工具执行需要
   * 文件系统、检索、ACL 等实例，仅凭 `registry` / `config` / `logger` 拼不出来。
   */
  readonly context: Omit<McpToolContext, 'subject' | 'principals' | 'requestId'>;
}

/** `node:http` 兼容的最小请求形状。Fastify 的 `request.raw` / `request.body` 也满足。 */
export interface McpHttpRequest {
  readonly headers: Record<string, string | undefined>;
  /** 已被框架解析的请求体；不传时 transport 自己读 `raw` 的流。 */
  readonly body?: unknown;
  readonly raw: IncomingMessage;
}

/** `node:http` 兼容的最小响应形状。 */
export interface McpHttpReply {
  readonly raw: ServerResponse;
  /**
   * 接管响应。Fastify 需要它来跳过自己的发送逻辑；`node:http` 适配器不实现。
   */
  hijack?(): void;
}

export type McpRouteHandler = (request: McpHttpRequest, reply: McpHttpReply) => Promise<void>;

export interface McpHttpApp {
  post(path: string, handler: unknown): void;
  get(path: string, handler: unknown): void;
}

function headerValue(
  headers: Record<string, string | undefined>,
  name: string,
): string | undefined {
  const value = headers[name];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function sendError(
  reply: McpHttpReply,
  status: number,
  code: string,
  message: string,
): void {
  if (reply.raw.headersSent) {
    return;
  }
  reply.raw.statusCode = status;
  reply.raw.setHeader('content-type', 'application/json; charset=utf-8');
  reply.raw.end(JSON.stringify({ status: 'error', error: { code, message } }));
}

function toSdkTool(tool: McpToolDefinition): Tool {
  return {
    name: tool.name,
    description: tool.description,
    // 注册表保证 `type === 'object'` 且 `properties` 是对象（见 registry 的测试）。
    inputSchema: tool.inputSchema as Tool['inputSchema'],
  };
}

function toBinaryBlock(result: {
  readonly mimeType: string;
  readonly base64: string;
}): ContentBlock {
  if (result.mimeType.startsWith('image/')) {
    return { type: 'image', data: result.base64, mimeType: result.mimeType };
  }
  if (result.mimeType.startsWith('audio/')) {
    return { type: 'audio', data: result.base64, mimeType: result.mimeType };
  }
  // 工具层只会产出图片/音频；其它类型没有对应的 MCP 内容块。
  throw new ComemError('INTERNAL', `不支持的二进制类型：${result.mimeType}`, {
    mimeType: result.mimeType,
  });
}

function toCallToolResult(result: McpToolResult): CallToolResult {
  if (result.type === 'text') {
    return { content: [{ type: 'text', text: result.text }] };
  }
  if (result.type === 'error') {
    // 工具级失败走 MCP 的 isError 形态，而不是 200 + 空文本：后者会让 agent 以为
    // 「记忆里没有」。`code` 放在文本最前面，便于宿主与日志按它检索。
    return {
      content: [{ type: 'text', text: `${result.code}: ${result.message}` }],
      isError: true,
    };
  }
  return { content: [toBinaryBlock(result)] };
}

async function closeQuietly(
  target: { close(): Promise<void> },
  logger: Logger,
  requestId: string,
): Promise<void> {
  try {
    await target.close();
  } catch (error) {
    logger.warn('MCP 资源关闭失败。', {
      requestId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export class McpHttpServer {
  readonly #options: McpServerOptions;

  constructor(options: McpServerOptions) {
    this.#options = options;
  }

  /** 挂到已存在的 HTTP 服务上，路径 `/mcp`。 */
  mount(app: McpHttpApp): void {
    const handler: McpRouteHandler = (request, reply) => this.#handle(request, reply);
    app.post(MCP_PATH, handler);
    // GET 是无状态模式下的 SSE 端点：没有会话可恢复，SDK 会回 405。注册它让
    // 客户端拿到明确的协议错误，而不是一个 404。
    app.get(MCP_PATH, handler);
  }

  async #handle(request: McpHttpRequest, reply: McpHttpReply): Promise<void> {
    reply.hijack?.();
    const requestId = headerValue(request.headers, 'x-request-id') ?? randomUUID();

    let identity: McpIdentity;
    try {
      identity = await this.#options.resolveIdentity({ headers: request.headers });
    } catch (error) {
      const failure = ComemError.from(error);
      this.#options.logger.warn('MCP 身份解析失败。', {
        requestId,
        code: failure.code,
        error: failure.message,
      });
      sendError(reply, 401, 'UNAUTHENTICATED', failure.message);
      return;
    }

    const context: McpToolContext = {
      ...this.#options.context,
      config: this.#options.config,
      subject: identity.subject,
      principals: identity.principals,
      requestId,
    };

    const server = new Server(
      { name: SERVER_NAME, version: SERVER_VERSION },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: this.#options.registry.list().map(toSdkTool),
    }));
    server.setRequestHandler(CallToolRequestSchema, async (call) => {
      const tool = this.#options.registry.get(call.params.name);
      if (tool === undefined) {
        throw new McpError(
          ErrorCode.MethodNotFound,
          `未知的 MCP 工具：${call.params.name}`,
        );
      }
      try {
        const result = await tool.execute(call.params.arguments ?? {}, context);
        if (result.type === 'error') {
          // 超时不是工具的业务拒绝，是「这次调用没有等到答案」。用 warn 让运维在
          // 日志里能按 `TOOL_DEADLINE_EXCEEDED` 搜到；工具本身没有 logger。
          this.#options.logger.warn('MCP 工具超过调用上限。', {
            requestId,
            tool: tool.name,
            code: result.code,
            error: result.message,
          });
        }
        return toCallToolResult(result);
      } catch (error) {
        const failure = ComemError.from(error);
        const fields = {
          requestId,
          tool: tool.name,
          code: failure.code,
          error: failure.message,
          stack: error instanceof Error ? error.stack : undefined,
        };
        if (failure.code === 'INTERNAL') {
          this.#options.logger.error('MCP 工具执行失败。', fields);
        } else {
          this.#options.logger.warn('MCP 工具拒绝。', fields);
        }
        return { content: [{ type: 'text', text: failure.message }], isError: true };
      }
    });

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(request.raw, reply.raw, request.body);
    } catch (error) {
      this.#options.logger.error('MCP 传输失败。', {
        requestId,
        error: error instanceof Error ? error.message : String(error),
      });
      sendError(reply, 500, 'INTERNAL', 'MCP 请求处理失败。');
    } finally {
      // 请求结束销毁（无状态模式）。先关 server 再关 transport 也可以；
      // 两者都幂等，这里各关一次，覆盖 connect 失败的分支。
      await closeQuietly(server, this.#options.logger, requestId);
      await closeQuietly(transport, this.#options.logger, requestId);
    }
  }
}
