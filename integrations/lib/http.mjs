/**
 * CoMem HTTP 客户端（架构文档 §14 的响应封套、§15.9 的超时预算）。
 *
 * Hook 进程每次调用都是新进程，没有连接池可复用，所以这里只做三件事：拼 URL、
 * 套超时、把失败包成 `ComemHookError`。
 *
 * ## 只重试幂等的 GET
 *
 * `POST` 一律不重试。会话消息的「至少一次」由游标保证：请求失败时游标不前进，
 * 下一次 hook 把同一批消息重投一遍（§15.4「宁可重复不能丢」）。在客户端重试
 * `POST` 只会让「游标没动」与「消息已写入」之间的窗口变宽，制造重复消息。
 *
 * `GET` 是只读的，重试没有副作用，所以允许重试瞬时故障（网络错误、超时、5xx、
 * 429）。重试次数是经验值，没有架构来源：hook 的阻塞预算只有几十毫秒到几秒
 * （§15.9），两次重试已经踩到上限。
 */

/** 默认超时。5s 来自任务书与 §15.9 的 `expansionTimeoutMs = 5000`（hook 侧最长阻塞预算）。 */
export const DEFAULT_TIMEOUT_MS = 5000;

/** GET 的重试次数（不含首次）。见文件头：经验值，无架构来源。 */
const DEFAULT_RETRIES = 2;

/** 视为瞬时故障、值得重试的 HTTP 状态。 */
const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

/**
 * Hook 侧的统一错误。
 *
 * `code` 与 `status` 分开：`code` 是给日志与调用方分支用的稳定标识，`status` 是
 * 服务端返回的 HTTP 状态（没有经过网络时为 `undefined`）。
 *
 * `code` 取值：
 * - `HOOK_INVALID_ARGUMENT` / `HOOK_INVALID_CONFIG`：调用方或配置错
 * - `HOOK_HTTP_ERROR`：服务端返回了错误封套或非 2xx
 * - `HOOK_TIMEOUT` / `HOOK_UNREACHABLE`：网络层
 * - `HOOK_LOCK_TIMEOUT`：等会话锁超时
 * - `HOOK_CONFLICT`：409
 */
export class ComemHookError extends Error {
  /**
   * @param {string} message
   * @param {{ code?: string, status?: number, path?: string, cause?: unknown }} [options]
   */
  constructor(message, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ComemHookError';
    this.code = options.code ?? 'HOOK_HTTP_ERROR';
    this.status = options.status;
    this.path = options.path;
  }
}

/** `path` 不以 `/` 开头时补一个，避免拼出 `//api`。 */
function normalizePath(path) {
  return path.startsWith('/') ? path : `/${path}`;
}

function buildQuery(query) {
  if (query === undefined) {
    return '';
  }
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) {
      continue;
    }
    search.set(key, String(value));
  }
  const serialized = search.toString();
  return serialized === '' ? '' : `?${serialized}`;
}

function isTimeoutError(error) {
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
}

function isRetryable(error) {
  if (error.code === 'HOOK_TIMEOUT' || error.code === 'HOOK_UNREACHABLE') {
    return true;
  }
  return error.status !== undefined && RETRYABLE_STATUSES.has(error.status);
}

function toHookError(error, path, timeoutMs) {
  if (error instanceof ComemHookError) {
    return error;
  }
  if (isTimeoutError(error)) {
    return new ComemHookError(`CoMem 请求超时：${path}（${timeoutMs}ms）`, {
      code: 'HOOK_TIMEOUT',
      path,
      cause: error,
    });
  }
  return new ComemHookError(`CoMem 服务端不可达：${path}`, {
    code: 'HOOK_UNREACHABLE',
    path,
    cause: error,
  });
}

/**
 * 拆封套（§14：`{status:'ok', result}` / `{status:'error', error}`）。
 *
 * 非 JSON 响应（例如 `GET /health` 的纯文本）原样返回文本：hook 不假设所有端点
 * 都走封套。
 */
async function unwrap(response, method, path) {
  const text = await response.text();
  let payload;
  try {
    payload = text === '' ? undefined : JSON.parse(text);
  } catch {
    payload = undefined;
  }

  const envelope =
    typeof payload === 'object' && payload !== null && !Array.isArray(payload) ? payload : undefined;

  if (!response.ok) {
    const code = typeof envelope?.error?.code === 'string' ? envelope.error.code : undefined;
    const message =
      typeof envelope?.error?.message === 'string'
        ? envelope.error.message
        : `CoMem 请求失败：${method} ${path} → HTTP ${response.status}`;
    throw new ComemHookError(message, {
      code: response.status === 409 ? 'HOOK_CONFLICT' : 'HOOK_HTTP_ERROR',
      status: response.status,
      path,
    });
  }

  if (envelope !== undefined && envelope.status === 'ok') {
    return envelope.result;
  }
  if (envelope !== undefined && envelope.status === 'error') {
    throw new ComemHookError(
      typeof envelope.error?.message === 'string' ? envelope.error.message : 'CoMem 返回错误',
      { code: 'HOOK_HTTP_ERROR', status: response.status, path },
    );
  }
  return payload === undefined ? text : payload;
}

/**
 * @param {{
 *   baseUrl: string,
 *   token?: string,
 *   timeoutMs?: number,
 *   retries?: number,
 *   fetchImpl?: typeof fetch,
 * }} options
 */
export function createHttpClient(options) {
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const token = options.token ?? '';
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retries = options.retries ?? DEFAULT_RETRIES;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  if (typeof fetchImpl !== 'function') {
    throw new ComemHookError('当前 Node 运行时没有 fetch，无法访问 CoMem 服务端。', {
      code: 'HOOK_INVALID_CONFIG',
    });
  }

  async function request(method, path, body, query) {
    const target = `${baseUrl}${normalizePath(path)}${buildQuery(query)}`;
    const headers = { accept: 'application/json' };
    if (token !== '') {
      headers.authorization = `Bearer ${token}`;
    }
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
    }

    // §15.9：hook 的阻塞预算以秒计，重试次数固定；POST 永不重试（见文件头）。
    const attempts = method === 'GET' ? retries + 1 : 1;
    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const response = await fetchImpl(target, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
        return await unwrap(response, method, path);
      } catch (error) {
        const wrapped = toHookError(error, path, timeoutMs);
        if (method !== 'GET' || !isRetryable(wrapped)) {
          throw wrapped;
        }
        lastError = wrapped;
      }
    }
    // attempts >= 1，循环内要么返回要么抛错；这里的兜底只是为了不返回 undefined。
    throw lastError ?? new ComemHookError(`CoMem 请求失败：${path}`, { path });
  }

  return {
    get(path, query) {
      return request('GET', path, undefined, query);
    },
    post(path, body) {
      return request('POST', path, body, undefined);
    },
  };
}
