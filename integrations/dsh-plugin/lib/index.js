/**
 * CoMem 的 DSH 原生插件（架构文档 §15.7）。
 *
 * DSH 没有 hook 脚本面：它的事件是**同进程 Cordis 插件订阅的 typed 事件**（`ctx.on`）。
 * 所以这个插件不是「把 stdin 的 JSON 转成 CoMem 的请求」的进程，而是五个接缝上的
 * 订阅者：
 *
 * | 接缝 | 等价于 | 做什么 |
 * |---|---|---|
 * | `agent/created` | `SessionStart` | `handleSessionStart` 拼画像 / 偏好 / 技能索引，`agent.inject()` |
 * | `agent/pre-step`（waterfall） | `UserPromptSubmit` | `handleUserPromptSubmit` 检索，块折进 `decision.messages` |
 * | `session/event` 的 `turn/end` | `Stop` | 本轮 user / assistant 消息剥离后 `POST /sessions/{id}/messages` + `/commit` |
 * | `agent/disposed` | `SessionEnd` 的近似物 | 尽力把还没提交的缓冲发出去 |
 * | `session/event` 的 `compaction/start` | `PreCompact` | **做不到**：只记一条 warn，压缩前不归档 |
 *
 * ## 这个文件只做适配，不做第二份实现
 *
 * 渲染、预算、转义、剥离、跨轮账本、HTTP 都在 `integrations/lib/`。这里只做三件
 * 事：把 DSH 的载荷翻译成 handler 已经接受的事件形状、把 handler 的输出放进 DSH
 * 的接缝、把 DSH 的消息形状翻译成 CoMem 的采集形状。**没有一个块是在这里拼的。**
 *
 * ## 为什么 `agent/pre-step` 里先 `await next()`
 *
 * waterfall 的 `messages` 只是**本步从 inbox 取走的那一批**，不是全会话。同一轮里
 * 后续的 tool step 会拿到空数组——这正是「不要重复注入」的判据。先拿到底层
 * decision，再在 `kind === 'enter'` 时追加一条消息；不动底层决定。
 *
 * ## 为什么注入失败不影响对话
 *
 * DSH 的 `agent/created` 监听器抛错会**让会话创建失败**，`agent/pre-step` 抛错会
 * 让这一轮失败。CoMem 是旁路：所有接缝都吞掉异常，`ctx.logger.warn` 留一行诊断，
 * 然后返回底层 decision / 什么都不做。
 *
 * ## 配置
 *
 * ```yaml
 * - insert:
 *     - id: comem
 *       name: comem-dsh-plugin
 *       config:
 *         baseUrl: http://127.0.0.1:1933   # 必填
 *         token: ''                        # 非回环时必须给
 *         timeoutMs: 5000
 * ```
 *
 * `baseUrl` 缺失时 `apply` 记一条 warn 并**不注册任何监听器**：插件加载失败会让
 * DSH 起不来，这条路径不允许抛错。
 */

import { randomUUID } from 'node:crypto';

import { DEFAULT_CONFIG, loadConfig, resolveTempDir } from '../../lib/config.mjs';
import { createHttpClient } from '../../lib/http.mjs';
import { DEFAULT_MAX_CONTEXT_BYTES } from '../../lib/injection.mjs';
import { createDeadline, HOOK_BUDGETS_MS } from '../../lib/lifecycle.mjs';
import { sanitizeCapturedMessages } from '../../lib/sanitize.mjs';
import { handleSessionStart } from '../../servers/session-start.mjs';
import { handleUserPromptSubmit } from '../../servers/user-prompt-submit.mjs';
import { ensureSession } from '../../servers/stop.mjs';

/**
 * @typedef {object} PluginContext
 * @property {{ warn: (message: string, ...args: unknown[]) => void }} logger
 * @property {(event: string, listener: (...args: unknown[]) => unknown) => unknown} on
 */

/** §15.5：DSH 会话 ID 前缀。 */
const SESSION_ID_PREFIX = 'dsh-';

/** 会话端点前缀（与 `servers/stop.mjs` 的 `SESSIONS_PATH` 同一个）。 */
const SESSIONS_PATH = '/api/v1/sessions';

/**
 * 注入消息的来源 `kind`。
 *
 * `MessageSource` 是可合并的联合类型，「每个生产者声明自己的 kind」。用 `user`
 * 会让下一轮把注入块当成用户说的话再检索一遍；用一个独立 kind，`agent/pre-step`
 * 取 prompt 时能按 `source.kind === 'user'` 把它排除。
 */
const SOURCE_KIND = 'comem';

/** 采集只收这两种角色（工具调用由 `PostToolUse` 那类接缝负责，DSH 上没接）。 */
const CAPTURE_ROLES = new Set(['user', 'assistant']);

/**
 * 注入块的字节上限。
 *
 * DSH 是进程内注入，没有「hook 输出超限被转存成文件」那回事；这里仍用
 * `DEFAULT_MAX_CONTEXT_BYTES`（9,500，最严的宿主值），让 `CONTEXT_BLOCK_DROP_ORDER`
 * 的显式降级在异常增长的偏好目录上照常生效。真实上限不存在，不提高也不另设配置。
 */
const MAX_CONTEXT_BYTES = DEFAULT_MAX_CONTEXT_BYTES;

/** 线程内的「进程启动」开销：没有起进程，就是 0ms。 */
const NO_PROCESS_START = () => 0;

/** 子 agent 会话：不注入、不采集（`dsh-subagent` 写的 `header.origin`）。 */
function isSubagentSession(session) {
  return session?.header?.origin === 'subagent';
}

/** DSH 会话 ID → CoMem 会话 ID（已经带前缀时不重复加）。 */
function comemSessionId(sessionId) {
  return sessionId.startsWith(SESSION_ID_PREFIX) ? sessionId : `${SESSION_ID_PREFIX}${sessionId}`;
}

/** 会话的工作目录；没有就退回 DSH 进程自己的 cwd。 */
function cwdOf(session) {
  const cwd = session?.header?.cwd;
  return typeof cwd === 'string' && cwd !== '' ? cwd : process.cwd();
}

/** 一条消息里的文本块 → CoMem 的 `parts`。图片、推理、工具调用都不进采集。 */
function textPartsOf(content) {
  const parts = [];
  if (!Array.isArray(content)) {
    return parts;
  }
  for (const block of content) {
    if (typeof block !== 'object' || block === null) {
      continue;
    }
    if (block.type === 'text' && typeof block.text === 'string' && block.text !== '') {
      parts.push({ kind: 'text', text: block.text });
    }
  }
  return parts;
}

/**
 * DSH 消息 → `POST /sessions/{id}/messages` 的一条消息。
 *
 * `id` 原样保留：服务端按消息 ID 幂等，重投不会变成两条。DSH 的消息一定有 id，
 * 没有时补一个随机值而不是空串——空串会被服务端拒成 `INVALID_ARGUMENT`。
 *
 * 没有文本的消息（纯工具调用）返回 `null`：它没有可抽取的内容。
 *
 * @param {unknown} message
 * @param {number} time 事件时间（epoch ms）
 * @returns {{ id: string, role: string, parts: { kind: 'text', text: string }[], createdAt: string } | null}
 */
function toCapturedMessage(message, time) {
  if (typeof message !== 'object' || message === null) {
    return null;
  }
  const role = message.role;
  if (typeof role !== 'string' || !CAPTURE_ROLES.has(role)) {
    return null;
  }
  const parts = textPartsOf(message.content);
  if (parts.length === 0) {
    return null;
  }
  const id = typeof message.id === 'string' && message.id !== '' ? message.id : randomUUID();
  return { id, role, parts, createdAt: new Date(time).toISOString() };
}

/** 本步 claimed 消息里**用户真的说的**那部分文本；注入块与运行时上下文不算。 */
function promptTextOf(messages) {
  const chunks = [];
  for (const message of messages) {
    if (message?.source?.kind !== 'user') {
      continue;
    }
    const text = textPartsOf(message.content)
      .map((part) => part.text)
      .join('\n');
    if (text.trim() !== '') {
      chunks.push(text);
    }
  }
  return chunks.join('\n');
}

/** 一条注入消息。`form` 让 DSH 的展示层知道这是目录 / 召回，而不是用户发言。 */
function contextMessage(text, form) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: SOURCE_KIND, form },
  };
}

/** 诊断字段：code + 消息，不含 prompt 或记忆正文。 */
function errorFields(error) {
  return {
    code: typeof error?.code === 'string' ? error.code : 'UNKNOWN',
    error: error instanceof Error ? error.message : String(error),
  };
}

/**
 * 插件入口。
 *
 * `ctx` 是 Cordis 的上下文（只用到 `on` 与 `logger`）；不 import DSH 的任何包：
 * 插件以 `link:` 装进 profile，从仓库真实路径解析，`@deepseek-ai/*` 不在它的
 * 依赖里。载荷形状由架构文档与实测钉住，不是靠类型。
 *
 * @param {PluginContext} ctx
 * @param {{ baseUrl?: string, token?: string, timeoutMs?: number } | null | undefined} rawConfig
 */
export function apply(ctx, rawConfig) {
  try {
    start(ctx, rawConfig ?? {});
  } catch (error) {
    // 插件加载失败会让 DSH 起不来；任何意外都收敛成一条 warn。
    ctx.logger.warn('comem: 插件初始化失败，不做任何事。%o', errorFields(error));
  }
}

/**
 * 注册五个接缝。
 *
 * @param {PluginContext} ctx
 * @param {{ baseUrl?: string, token?: string, timeoutMs?: number }} rawConfig
 */
function start(ctx, rawConfig) {
  const baseUrl = typeof rawConfig.baseUrl === 'string' ? rawConfig.baseUrl.trim() : '';
  if (baseUrl === '') {
    ctx.logger.warn(
      'comem: 缺少 config.baseUrl，插件不注入、不采集。在 cordis.patch.yml 的 comem 条目里配置它（默认 http://127.0.0.1:1933）。',
    );
    return;
  }

  // 插件 config 是 HTTP 三件事的权威来源；其余（userId、检索参数、查询过滤、
  // 临时目录）继续读 `~/.config/comem/config.yaml` 与环境变量——与 hook 同一套。
  // 只有显式给了的键才覆盖：`token` / `timeoutMs` 不写时沿用配置文件与环境变量，
  // 写了（包括空串）就以这里为准。`baseUrl` 必填，永远覆盖。
  const overrides = { baseUrl };
  if (typeof rawConfig.token === 'string') {
    overrides.token = rawConfig.token;
  }
  if (typeof rawConfig.timeoutMs === 'number' && Number.isFinite(rawConfig.timeoutMs)) {
    overrides.timeoutMs = rawConfig.timeoutMs;
  }
  const fallbackConfig = { ...DEFAULT_CONFIG, ...overrides, tmpDir: resolveTempDir() };
  const settings = loadConfig()
    .then((loaded) => ({ ...loaded, ...overrides }))
    .catch((error) => {
      ctx.logger.warn('comem: 读取 CoMem 配置文件失败，改用默认值。%o', errorFields(error));
      return fallbackConfig;
    });

  let warnedNoUserId = false;
  /** 每一轮最多等多久：沿用 hook 的总预算（召回 2s、开局 4s）。 */
  const clientFor = (config, budgetMs) =>
    createHttpClient({ ...config, deadline: createDeadline(budgetMs, Date.now()) });

  /** SessionStart：拼三个索引块，排队给下一步。 */
  async function injectSessionStart(agent, source) {
    const config = await settings;
    if (config.userId === '') {
      if (!warnedNoUserId) {
        warnedNoUserId = true;
        ctx.logger.warn('comem: 没有 userId（配置文件里写 userId: <你的用户名>），不注入画像与偏好。');
      }
      return;
    }
    const event = {
      event: 'session_start',
      sessionId: comemSessionId(agent.id),
      cwd: cwdOf(agent.session),
      source,
    };
    const result = await handleSessionStart(event, {
      config,
      http: clientFor(config, HOOK_BUDGETS_MS.session_start),
      maxContextBytes: MAX_CONTEXT_BYTES,
      processStartMs: NO_PROCESS_START,
    });
    if (result?.context !== undefined) {
      agent.inject(contextMessage(result.context, 'catalog'));
    }
  }

  ctx.on('agent/created', async ({ agent, source }) => {
    try {
      if (isSubagentSession(agent.session)) {
        return;
      }
      await injectSessionStart(agent, source);
    } catch (error) {
      ctx.logger.warn('comem: 注入画像 / 偏好 / 技能目录失败，本局不注入。%o', errorFields(error));
    }
  });

  ctx.on('agent/pre-step', async ({ agent, messages }, next) => {
    const decision = await next();
    try {
      // 同一轮里后续 tool step 的批次是空的：不重复注入（文件头）。
      if (messages.length === 0 || decision.kind !== 'enter') {
        return decision;
      }
      const prompt = promptTextOf(messages);
      if (prompt === '') {
        return decision;
      }
      const event = {
        event: 'user_prompt_submit',
        sessionId: comemSessionId(agent.id),
        cwd: cwdOf(agent.session),
        prompt,
      };
      const config = await settings;
      const result = await handleUserPromptSubmit(event, {
        config,
        http: clientFor(config, HOOK_BUDGETS_MS.user_prompt_submit),
        maxContextBytes: MAX_CONTEXT_BYTES,
        processStartMs: NO_PROCESS_START,
      });
      if (result?.context === undefined) {
        return decision;
      }
      return { ...decision, messages: [...decision.messages, contextMessage(result.context, 'recall')] };
    } catch (error) {
      // 召回是旁路：这一轮没有记忆，对话照常。
      ctx.logger.warn('comem: 召回失败，本轮不注入 <comem-recall>。%o', errorFields(error));
      return decision;
    }
  });

  /** 每个会话还没提交的消息（`turn/end` 或 `agent/disposed` 时发出去）。 */
  const pending = new Map();
  /** 同一会话的提交串行化；否则两次 `turn/end` 挨得近会并发发同一批。 */
  const queues = new Map();

  function bufferOf(session) {
    let entry = pending.get(session.id);
    if (entry === undefined) {
      entry = { messages: [] };
      pending.set(session.id, entry);
    }
    return entry;
  }

  /** 把缓冲里的消息发出去；成功才从缓冲里摘掉快照。失败留着重投。 */
  async function flushOnce(session, dropOnFailure) {
    const entry = pending.get(session.id);
    if (entry === undefined) {
      return;
    }
    if (entry.messages.length === 0) {
      pending.delete(session.id);
      return;
    }
    const snapshot = entry.messages.slice();
    const messages = sanitizeCapturedMessages(snapshot);
    // 一条都没剩下（整轮只有注入块）：不是错误，也不必发空数组。
    if (messages.length === 0) {
      entry.messages = entry.messages.slice(snapshot.length);
      if (entry.messages.length === 0) {
        pending.delete(session.id);
      }
      return;
    }
    const config = await settings;
    const sessionId = comemSessionId(session.id);
    // 提交没有「用户按回车的延迟」可比；用与 PreCompact 同一个宽上限。
    const http = clientFor(config, config.commitTimeoutMs);
    try {
      await ensureSession({ sessionId }, { config, http });
      await http.post(`${SESSIONS_PATH}/${sessionId}/messages`, { messages });
      await http.post(`${SESSIONS_PATH}/${sessionId}/commit`, {});
      entry.messages = entry.messages.slice(snapshot.length);
      if (entry.messages.length === 0) {
        pending.delete(session.id);
      }
    } catch (error) {
      if (dropOnFailure) {
        pending.delete(session.id);
      }
      throw error;
    }
  }

  /** 排队提交。返回的 Promise 永不 reject；事件路径不等它。 */
  function scheduleFlush(session, dropOnFailure = false) {
    const previous = queues.get(session.id) ?? Promise.resolve();
    const next = previous
      .then(() => flushOnce(session, dropOnFailure))
      .catch((error) => {
        ctx.logger.warn('comem: 提交会话消息失败，本轮消息留到下一次提交重投。%o', errorFields(error));
      })
      .finally(() => {
        if (queues.get(session.id) === next) {
          queues.delete(session.id);
        }
      });
    queues.set(session.id, next);
    return next;
  }

  ctx.on('session/event', (session, event) => {
    if (event.type === 'compaction/start') {
      ctx.logger.warn(
        'comem: DSH 的压缩只有 compaction/start 这个观察点，无法在压缩前拦截。CoMem 的 pre-compact 钩子在 DSH 上不可用，压缩前不会额外归档（会话 %s）。',
        session.id,
      );
      return;
    }
    if (isSubagentSession(session)) {
      return;
    }
    if (event.type === 'user/message') {
      // 只收人真的说的那条。DSH 的 `user/message` 通道同时承载运行时上下文
      // （`runtime-context`）、目标轮次（`goal`）、其它 agent 的转述（`agent-message`）
      // 与我们自己的 `comem` 注入——它们不是用户的发言，原样归档会被抽取成记忆。
      if (event.data?.source?.kind !== 'user') {
        return;
      }
      const captured = toCapturedMessage(event.data, event.time);
      if (captured !== null) {
        bufferOf(session).messages.push(captured);
      }
      return;
    }
    if (event.type === 'assistant/message') {
      const captured = toCapturedMessage(event.data.message, event.time);
      if (captured !== null) {
        bufferOf(session).messages.push(captured);
      }
      return;
    }
    if (event.type === 'turn/end') {
      void scheduleFlush(session);
    }
  });

  ctx.on('agent/disposed', ({ agent }) => {
    // emit 模式，返回值没人等。最后一次机会：失败就丢（会话已经没了）。
    void scheduleFlush(agent.session, true);
  });
}

/** Cordis 用它给日志命名；插件名与包名一致。 */
export const name = 'comem';
