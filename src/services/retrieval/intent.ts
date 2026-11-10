/**
 * 负责：意图分析（`search` 之前的查询重写、历史消息取材、降级成单条原查询）。
 * 不负责：拿到 TypedQuery 之后的检索（`arms.ts`）与多查询合并（`merge.ts`）。
 */

import { parsePrincipal } from '../../domain/acl.js';
import { ComemError } from '../../domain/errors.js';
import type { LlmPrompt } from '../../domain/llm.js';
import type { Logger } from '../../domain/log.js';
import type { TypedQuery } from '../../domain/retrieval.js';
import { renderMessageText, type SessionMessage } from '../../domain/session.js';
import { Uri } from '../../domain/uri.js';

import {
  buildRewriteUserPrompt,
  REWRITE_SCHEMA,
  REWRITE_SYSTEM_PROMPT,
  type RewriteMessage,
} from '../prompts/rewrite.js';
import { budgetExceeded, deadlineRemainingMs, withBudget } from './budget.js';
import type { SearchOptions, SearchServiceDeps } from './types.js';

/**
 * 意图分析的历史窗口：最近 5 轮。
 *
 * 5 轮 = 10 条消息。§8.7 的轮次时钟取消息总数，一轮就是「一条 user + 一条
 * assistant」，所以 5 轮是末尾 10 条。再往前翻对指代解析没有帮助（更早的话题
 * 已经结束），只会挤占当前查询在提示词里的位置。
 */
const RECENT_MESSAGES = 10;

/**
 * 意图分析的单次超时，毫秒。
 *
 * 10000 是**经验值，来源未知**。§18 的 `providers.llm.default.timeoutSeconds`
 * 默认 120 秒，那是后台任务（抽取、摘要）的预算；`search` 是交互路径，用户站在
 * 前面等。「10 秒后降级」与「120 秒后降级」对用户是两件不同的事，所以这里显式
 * 收窄，而不是继承后台任务的默认值。
 */
const REWRITE_TIMEOUT_MS = 10_000;

/** §6.5 的 `sessions/sess_xxx/` 目录名（与 `services/session.ts` 指向同一个目录）。 */
const SESSIONS_DIRECTORY_NAME = 'sessions';

/** 意图分析的依赖。三者都可以缺省，缺省时各自走「不静默的降级」路径。 */
export interface IntentStageDeps {
  readonly llm: SearchServiceDeps['llm'];
  readonly sessions: SearchServiceDeps['sessions'];
  readonly logger: Logger;
}

export class IntentStage {
  readonly #llm: SearchServiceDeps['llm'];
  readonly #sessions: SearchServiceDeps['sessions'];
  readonly #logger: Logger;

  constructor(deps: IntentStageDeps) {
    this.#llm = deps.llm;
    this.#sessions = deps.sessions;
    this.#logger = deps.logger;
  }

  /**
   * 意图分析。**只在这一处**决定 `analyzed` 与 `reason`，降级路径不会散落在
   * 各个调用点。
   *
   * `search` 的 `plan` 有三条不能静默的路径（前两条在本模块决定，「输入过滤后为空」
   * 由调用方在进入本模块之前决定）：
   *
   * | 情况 | 结果 |
   * |---|---|
   * | 模型说「不该检索」 | 空命中，`analyzed: true`、`queries: []`——合法结论 |
   * | 分析失败（超时 / 截断 / 不合法） | 降级成单条原 query，`analyzed: false` + `reason` |
   * | 输入过滤后为空 | 空命中，`analyzed: true`，**不调模型**（§8.8） |
   *
   * 降级必须写进 `plan`：控制台要能显示「意图分析不可用，已用原查询」。静默降级
   * 等于骗人。
   *
   * 失败一律降级成「单条原 query」，不重试、不抛错：`search` 是只读路径，检索
   * 本身仍然成立，把一次降级变成一次请求失败是更差的结果。
   */
  async analyze(
    query: string,
    options: SearchOptions,
  ): Promise<{
    readonly queries: readonly TypedQuery[];
    readonly analyzed: boolean;
    readonly reason: string | null;
  }> {
    if (this.#llm === undefined) {
      return {
        queries: [fallbackQuery(query)],
        analyzed: false,
        reason: '没有注入 LlmService（SearchServiceDeps.llm），无法做意图分析。',
      };
    }

    const recentMessages = await this.#recentMessages(options.sessionId, options.subject);
    const prompt: LlmPrompt = {
      system: REWRITE_SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: buildRewriteUserPrompt({
            query,
            recentMessages,
            knownScopes: options.scopes,
          }),
        },
      ],
    };

    options.onUpstream?.('llm');
    // 工具级预算存在时，意图分析也收窄到剩余时间：LlmService 的 3 次尝试各自
    // 10 秒会把一次 `search` 拖到 30 秒以上。`AbortSignal` 让「超时」不再被上层
    // 当成可重试的瞬态错误——否则第一次 10 秒超时后还会退避再打两次。
    // 意图分析最多用掉**剩余预算的一半**：它只是查询重写，后面还要跑检索。
    // 用满剩余时间的话，reach 到总上限时只剩「工具级失败」一条路——而这次检索
    // 本来可以降级成原查询继续跑（30 秒上限下：10 秒分析 + 最多 18 秒检索）。
    const remaining = deadlineRemainingMs(options.deadlineAt);
    const budget =
      remaining === null ? null : Math.max(1, Math.min(REWRITE_TIMEOUT_MS, Math.floor(remaining / 2)));
    const controller = new AbortController();
    const timer = budget === null ? undefined : setTimeout(() => controller.abort(), budget);
    timer?.unref();

    try {
      const call = this.#llm.generateJson(prompt, REWRITE_SCHEMA, {
        timeoutMs: budget ?? REWRITE_TIMEOUT_MS,
        ...(budget === null ? { } : { abortSignal: controller.signal }),
      });
      const output =
        budget === null
          ? await call
          : await withBudget(call, budget, () => budgetExceeded('意图分析（LLM）', budget));
      return { queries: output.queries, analyzed: true, reason: null };
    } catch (error) {
      // 超时、截断（`details.truncated`）、结构化输出不合法都收敛成 `ComemError`
      // （§19）。三种都不重试：同样的输入与上限只会再失败一次。
      const failure = ComemError.from(error);
      this.#logger.warn('意图分析不可用，已降级为原查询', {
        subject: options.subject,
        code: failure.code,
        message: failure.message,
        truncated: failure.details?.['truncated'] === true,
      });
      return {
        queries: [fallbackQuery(query)],
        analyzed: false,
        reason: `意图分析失败（${failure.code}）：${failure.message}`,
      };
    } finally {
      // 超时后立刻取消在途调用：不取消的话 3 次尝试（各 10 秒）会在后台继续跑，
      // 而结果已经没人要了。
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      controller.abort();
    }
  }

  /**
   * 最近 5 轮（10 条）user / assistant 消息。
   *
   * `tool` 消息要过滤掉（与 §10.1「默认隐藏工具输出」同源）：它又长又噪声，一段
   * 200 行的工具输出会把当前 query 挤出模型的注意力。`system` 同理——它不是对话。
   *
   * 会话读不到（已归档、ID 写错）时按「历史为空」处理并记 warn：历史只影响重写
   * 质量，让整次检索失败代价更大。这不算静默降级——`analyzed` 仍然是 `true`，
   * 因为分析确实跑了，只是没有历史可用。
   */
  async #recentMessages(
    sessionId: string | undefined,
    subject: string,
  ): Promise<readonly RewriteMessage[]> {
    if (sessionId === undefined) {
      return [];
    }
    if (this.#sessions === undefined) {
      this.#logger.warn('没有注入 SessionService，意图分析按「历史为空」处理', { sessionId });
      return [];
    }

    let sessionUri: Uri;
    try {
      sessionUri = sessionUriOf(subject, sessionId);
    } catch (error) {
      this.#logger.warn('会话 ID 无法归属到调用方，意图分析按「历史为空」处理', {
        sessionId,
        code: ComemError.from(error).code,
      });
      return [];
    }

    try {
      const session = await this.#sessions.load(sessionUri);
      return session.messages
        .filter(isConversational)
        .slice(-RECENT_MESSAGES)
        .map((message) => ({ role: message.role, text: renderMessageText(message) }));
    } catch (error) {
      this.#logger.warn('会话不可读，意图分析按「历史为空」处理', {
        sessionId,
        code: ComemError.from(error).code,
      });
      return [];
    }
  }
}

/** 参与意图分析的消息角色。`tool` / `system` 不参与（见 `#recentMessages`）。 */
function isConversational(message: SessionMessage): boolean {
  return message.role === 'user' || message.role === 'assistant';
}

/**
 * 会话 URI：`comem://user/{uid}/sessions/{sessionId}`（§6.5）。
 *
 * 身份来自 `options.subject`，与路由层 `scopeOfSubject` 是同一份推导：`sessionId`
 * 只在它所属的作用域内唯一，拿它去拼 group 根会读到别人的会话。
 */
export function sessionUriOf(subject: string, sessionId: string): Uri {
  const principal = parsePrincipal(subject);
  if (principal.kind !== 'user') {
    throw new ComemError('INVALID_ARGUMENT', `会话只能归属 user 主体：${subject}`, { subject });
  }
  return Uri.parse(`comem://user/${principal.id}`).child(SESSIONS_DIRECTORY_NAME, sessionId);
}

/**
 * 降级用的单条查询。
 *
 * `intent` 落 `other`（没有分类），`confidence` 记 1：兜底查询不经过模型，「置信
 * 度」在这里没有含义，但它在语义上**一定执行**，取 0 会让按置信度排序的调用方把
 * 降级结果当成「可丢弃」。
 */
function fallbackQuery(query: string): TypedQuery {
  return { text: query, intent: 'other', confidence: 1, derivedFrom: null };
}
