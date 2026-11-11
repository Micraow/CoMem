#!/usr/bin/env node
/**
 * `stdio` → Streamable HTTP 的 MCP 代理（架构文档 §15.6）。
 *
 * ## 为什么需要它
 *
 * CoMem 的 MCP 端点只暴露一种传输：`POST /mcp` 的 Streamable HTTP。支持这个传输
 * 的宿主（Claude Code、DSH 等）直连即可，不需要本进程。但 MCP 规范里 `stdio` 是
 * 兼容面最广的一种——只支持本地 stdio 服务器、或者只给 `command` + `args` 配置位
 * 的宿主，没有别的办法接上 CoMem。本进程补上这一段：宿主当它是本地 stdio 服务器，
 * 它把每一行 JSON-RPC 转发到 `POST /mcp`。
 *
 * 顺带解决凭据：代理自己读 `COMEM_TOKEN` / 配置文件，宿主的 MCP 配置里**不需要**
 * 出现 `Authorization` 头，换 key 只改一处。
 *
 * ## 为什么自己实现而不引依赖
 *
 * `integrations/package.json` 不声明任何 `dependencies`（见该文件与 README 的
 * 「只依赖 Node 内置模块」）。引入 `@modelcontextprotocol/sdk` 会让每个装插件的
 * 宿主多一份 SDK。这里只用到「读一行、POST、写一行」，不值得为它破例。
 *
 * MCP 的 streamable HTTP 响应有两种：`application/json`（CoMem 开了
 * `enableJsonResponse`）与 `text/event-stream`。两种都解析——只解析 JSON 的话，
 * 将来把 `enableJsonResponse` 关掉时代理会静默地什么都写不出来。
 *
 * ## 为什么没有会话续期
 *
 * CoMem 的传输是**无状态**的（`sessionIdGenerator: undefined`）：不返回
 * `Mcp-Session-Id`，没有会话可过期，也没有 `DELETE` 可发。所以这里没有重连逻辑，
 * 只有「转发 + 报错」。
 *
 * ## stdout 只走协议
 *
 * 宿主的 MCP 客户端按行读 stdout 并 `JSON.parse`。任何一行日志漏到 stdout 都会让
 * 宿主报 `JSON-RPC parse error`，而错误信息里只有那一行文本、指不回是哪个进程写的。
 * 所以本文件的**所有**诊断输出走 stderr（`log()` 是唯一出口），stdout 只由
 * `writeMessage()` 写。
 *
 * ## 错误要能定位
 *
 * 「HTTP 401」不是能行动的信息。每类失败都翻成一句「下一步做什么」：凭据无效指向
 * 环境变量与配置文件；连不上指向 `curl /health`；超时说明服务端可能还在算。
 */

import { createInterface } from 'node:readline';
import { realpathSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../lib/config.mjs';

/** MCP 端点（§14：挂在 `/mcp`）。 */
const MCP_PATH = '/mcp';

/** JSON-RPC 版本。 */
const JSON_RPC_VERSION = '2.0';

/** 解析失败：请求体不是 JSON。 */
const PARSE_ERROR = -32700;

/** 请求不是合法的 JSON-RPC 2.0 消息。 */
const INVALID_REQUEST = -32600;

/** 凭据被拒（401 / 403）。 */
const AUTH_FAILED = -32001;

/** 上游返回了其它非 2xx。 */
const UPSTREAM_HTTP = -32002;

/** 上游 2xx 但响应体为空。 */
const EMPTY_RESPONSE = -32003;

/** 超时。与「连不上」分开：服务端可能只是在算。 */
const TIMEOUT = -32004;

/** 连不上。 */
const UNREACHABLE = -32005;

/**
 * 把失败包成带状态码的错误，`mapError` 靠它区分「服务端说了什么」与「根本没到」。
 */
class ProxyHttpError extends Error {
  /**
   * @param {number} status
   * @param {string} statusText
   * @param {string} bodyText
   */
  constructor(status, statusText, bodyText) {
    super(`HTTP ${status}${statusText === '' ? '' : ` ${statusText}`}`);
    this.name = 'ProxyHttpError';
    this.status = status;
    this.bodyText = bodyText;
  }
}

/** `baseUrl` 末尾的斜杠会让 URL 拼出 `//mcp`。 */
function toMcpUrl(baseUrl) {
  return `${baseUrl.replace(/\/+$/, '')}${MCP_PATH}`;
}

/**
 * 从响应体里挑一句能给人看的话。
 *
 * 服务端的错误封套是 `{status, error: {code, message}}`（§14）；MCP 层是
 * `{jsonrpc, id, error: {code, message}}`。两种都认，认不出就退回截断的原文。
 */
function serverMessage(bodyText) {
  try {
    const parsed = JSON.parse(bodyText);
    const message = parsed?.error?.message ?? parsed?.message;
    if (typeof message === 'string' && message !== '') {
      return message;
    }
  } catch {
    // 不是 JSON：走下面的截断分支。
  }
  return bodyText.replace(/\s+/g, ' ').trim().slice(0, 300);
}

/**
 * 解析 SSE 响应体。
 *
 * 只认 `data:` 行；`event:` / `id:` / `retry:` 与 `:` 开头的注释行都跳过——
 * MCP 的每条消息都放在 `data` 里，靠空行分隔。
 *
 * @param {string} text
 * @returns {unknown[]}
 */
export function parseSseMessages(text) {
  const messages = [];
  let dataLines = [];

  function flush() {
    if (dataLines.length === 0) {
      return;
    }
    const data = dataLines.join('\n').trim();
    dataLines = [];
    if (data === '' || data === '[DONE]') {
      return;
    }
    messages.push(JSON.parse(data));
  }

  for (const rawLine of text.split(/\r\n|\r|\n/)) {
    if (rawLine === '') {
      flush();
      continue;
    }
    if (rawLine.startsWith(':')) {
      continue;
    }
    const colon = rawLine.indexOf(':');
    const field = colon === -1 ? rawLine : rawLine.slice(0, colon);
    if (field !== 'data') {
      continue;
    }
    const value = colon === -1 ? '' : rawLine.slice(colon + 1);
    dataLines.push(value.startsWith(' ') ? value.slice(1) : value);
  }
  flush();
  return messages;
}

/**
 * 按 `content-type` 解析响应体。空体返回 `[]`——通知（没有 `id`）本来就是空响应。
 *
 * @param {string | null} contentType
 * @param {string} text
 * @returns {unknown[]}
 */
function parseBody(contentType, text) {
  if (text.trim() === '') {
    return [];
  }
  if ((contentType ?? '').toLowerCase().includes('text/event-stream')) {
    return parseSseMessages(text);
  }
  return [JSON.parse(text)];
}

function errorResponse(id, code, message) {
  return { jsonrpc: JSON_RPC_VERSION, id: id ?? null, error: { code, message } };
}

function isRequest(message) {
  return Object.hasOwn(message, 'id');
}

/**
 * 建代理。参数全部可注入，测试不需要起子进程也能跑核心逻辑。
 *
 * @param {{
 *   config: { baseUrl: string, token: string, mcpTimeoutMs: number },
 *   stdin?: NodeJS.ReadableStream,
 *   stdout?: NodeJS.WritableStream,
 *   stderr?: NodeJS.WritableStream,
 *   fetchImpl?: typeof fetch,
 *   debug?: boolean,
 * }} options
 */
export function createMcpProxy(options) {
  const { config } = options;
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const debug = options.debug ?? false;
  const mcpUrl = toMcpUrl(config.baseUrl);

  /** 服务端在 `initialize` 里协商出的版本；没协商出来就不发这个头。 */
  let protocolVersion = '';

  /** stdout 串行化：并发请求的响应不能交错。 */
  let stdoutChain = Promise.resolve();

  /** 进行中的 `initialize`。其它请求先等它，否则服务端会以「未初始化」拒绝。 */
  let initializeInFlight = null;

  /**
   * 还没处理完的行。
   *
   * stdin 关闭（宿主退出、或测试用管道喂完就关）时 `close()` 必须等它们把响应写完
   * 再退。只等 `stdoutChain` 不够——那一刻它可能还是空的，进程会带着未发出的响应
   * 直接退出，宿主看到的是「服务器什么都没回」。
   */
  const inFlight = new Set();

  function log(stage, data) {
    if (!debug) {
      return;
    }
    // stderr 同步写：诊断信息丢一条不会影响协议，但绝不能让异常冒出去打断转发。
    try {
      stderr.write(`${JSON.stringify({ stage, ...data })}\n`);
    } catch {
      // 写不了 stderr 就只能放弃诊断。
    }
  }

  function buildHeaders() {
    /** @type {Record<string, string>} */
    const headers = {
      'content-type': 'application/json',
      // streamable HTTP 的客户端必须两种都接受（MCP 规范）；只写 json 时，
      // 服务端切到 SSE 的实现会按「不接受」处理。
      accept: 'application/json, text/event-stream',
    };
    if (config.token !== '') {
      headers.authorization = `Bearer ${config.token}`;
    }
    if (protocolVersion !== '') {
      headers['mcp-protocol-version'] = protocolVersion;
    }
    return headers;
  }

  function writeMessage(message) {
    const line = `${JSON.stringify(message)}\n`;
    stdoutChain = stdoutChain
      .then(() => new Promise((resolve) => stdout.write(line, resolve)))
      .catch(() => undefined);
    return stdoutChain;
  }

  async function postMessage(message) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.mcpTimeoutMs);
    try {
      const response = await fetchImpl(mcpUrl, {
        method: 'POST',
        headers: buildHeaders(),
        body: JSON.stringify(message),
        signal: controller.signal,
      });
      const text = await response.text();
      const messages = parseBody(response.headers.get('content-type'), text);
      if (message.method === 'initialize' && response.ok) {
        const negotiated = messages.find(
          (entry) => typeof entry?.result?.protocolVersion === 'string',
        )?.result?.protocolVersion;
        if (typeof negotiated === 'string' && negotiated !== '') {
          protocolVersion = negotiated;
        }
      }
      if (!response.ok) {
        throw new ProxyHttpError(response.status, response.statusText, text);
      }
      return messages;
    } finally {
      clearTimeout(timer);
    }
  }

  function mapError(id, error) {
    if (error instanceof ProxyHttpError) {
      const detail = serverMessage(error.bodyText);
      if (error.status === 401 || error.status === 403) {
        return errorResponse(
          id,
          AUTH_FAILED,
          `CoMem 拒绝了凭据（HTTP ${error.status}）。检查 COMEM_TOKEN 或 ~/.config/comem/config.yaml 的 token；连本机回环地址（127.0.0.1 / localhost）时不需要它。${detail === '' ? '' : ` 服务端说：${detail}`}`,
        );
      }
      return errorResponse(
        id,
        UPSTREAM_HTTP,
        `CoMem 的 MCP 端点返回 HTTP ${error.status}。${detail === '' ? '' : `服务端说：${detail}`}`,
      );
    }
    if (error?.name === 'AbortError' || error?.name === 'TimeoutError') {
      return errorResponse(
        id,
        TIMEOUT,
        `等 CoMem 超过 ${config.mcpTimeoutMs}ms 没有响应（${mcpUrl}）。服务端可能还在算（重排、提交都可能更久）；确认它没卡住，或调大 COMEM_MCP_TIMEOUT_MS。`,
      );
    }
    const message = error instanceof Error ? error.message : String(error);
    return errorResponse(
      id,
      UNREACHABLE,
      `连不上 CoMem 的 MCP 端点 ${mcpUrl}：${message}。确认服务端起了（curl ${config.baseUrl}/health）。`,
    );
  }

  async function handleMessage(message) {
    if (
      typeof message !== 'object' ||
      message === null ||
      Array.isArray(message) ||
      message.jsonrpc !== JSON_RPC_VERSION
    ) {
      await writeMessage(errorResponse(null, INVALID_REQUEST, '请求不是合法的 JSON-RPC 2.0 消息。'));
      return;
    }

    const expectsResponse = isRequest(message);
    if (message.method === 'initialize') {
      // 重新初始化时按新协商的版本发头。
      protocolVersion = '';
    }
    try {
      // `tools/list` 与 `initialize` 同时到达时不能抢跑：服务端会按「未初始化」拒绝。
      if (message.method !== 'initialize' && initializeInFlight !== null) {
        await initializeInFlight;
      }
      const pending = postMessage(message);
      if (message.method === 'initialize') {
        initializeInFlight = pending.then(
          () => undefined,
          () => undefined,
        );
        void initializeInFlight.then(() => {
          initializeInFlight = null;
        });
      }
      const messages = await pending;
      if (!expectsResponse) {
        return;
      }
      if (messages.length === 0) {
        await writeMessage(
          errorResponse(message.id, EMPTY_RESPONSE, `CoMem 的 MCP 端点返回了空响应（${mcpUrl}）。`),
        );
        return;
      }
      for (const outbound of messages) {
        await writeMessage(outbound);
      }
    } catch (error) {
      if (expectsResponse) {
        await writeMessage(mapError(message.id, error));
      } else {
        log('notification_failed', {
          method: typeof message.method === 'string' ? message.method : null,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  async function handleLine(line) {
    const trimmed = line.trim();
    if (trimmed === '') {
      return;
    }
    let message;
    try {
      message = JSON.parse(trimmed);
    } catch {
      await writeMessage(errorResponse(null, PARSE_ERROR, '请求不是合法 JSON。'));
      return;
    }
    await handleMessage(message);
  }

  async function close(code) {
    while (inFlight.size > 0) {
      await Promise.allSettled([...inFlight]);
    }
    await stdoutChain;
    process.exit(code);
  }

  function start() {
    log('start', { mcpUrl, hasToken: config.token !== '' });
    const reader = createInterface({ input: stdin, crlfDelay: Infinity, terminal: false });
    // 不 `await`：一条慢请求不能挡住下一行。响应顺序由 `stdoutChain` 与
    // `id` 保证，MCP 客户端按 `id` 匹配，不依赖到达顺序。
    reader.on('line', (line) => {
      const task = handleLine(line).finally(() => inFlight.delete(task));
      inFlight.add(task);
    });
    reader.on('close', () => {
      void close(0);
    });
    process.on('SIGINT', () => {
      void close(130);
    });
    process.on('SIGTERM', () => {
      void close(143);
    });
    return { close: () => close(0) };
  }

  return { start, handleMessage, handleLine };
}

function isDirectRun() {
  const entry = process.argv[1];
  if (entry === undefined) {
    return false;
  }
  const self = fileURLToPath(import.meta.url);
  try {
    return realpathSync(entry) === realpathSync(self);
  } catch {
    return resolvePath(entry) === self;
  }
}

if (isDirectRun()) {
  const config = await loadConfig();
  createMcpProxy({ config, debug: process.env['COMEM_DEBUG'] === '1' }).start();
}
