/**
 * 检索请求解析、参数校验与请求级超时。
 *
 * 这里只做请求解析与参数校验（外加把所有上游调用收进同一个墙上时钟上限），
 * 不碰响应形状——响应 DTO 在 `search.ts` 顶部。函数体与拆分前逐字相同。
 */

import { userScopeOf } from '../../../domain/acl.js';
import { ComemError } from '../../../domain/errors.js';
import { isLevel, LEVELS, type Level } from '../../../domain/level.js';
import { CONTEXT_TYPES, isContextType, type ContextType } from '../../../domain/node.js';
import { isSearchMode, SEARCH_MODES, type SearchMode } from '../../search-mode.js';
import { CallDeadline, runWithDeadline } from '../../deadline.js';

export function parseContextTypes(value: readonly string[] | undefined): readonly ContextType[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  return value.map((item) => {
    if (!isContextType(item)) {
      throw new ComemError('INVALID_ARGUMENT', `contextTypes 只能是 ${CONTEXT_TYPES.join(' / ')}。`, {
        contextTypes: value,
      });
    }
    return item;
  });
}

export function parseLevels(value: readonly string[] | undefined): readonly Level[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  return value.map((item) => {
    if (!isLevel(item)) {
      throw new ComemError('INVALID_ARGUMENT', `levels 只能是 ${LEVELS.join(' / ')}。`, {
        levels: value,
      });
    }
    return item;
  });
}

export function parseMode(value: string | undefined): SearchMode {
  if (value === undefined) {
    return 'list';
  }
  if (!isSearchMode(value)) {
    throw new ComemError('INVALID_ARGUMENT', `mode 只能是 ${SEARCH_MODES.join(' / ')}。`, {
      mode: value,
    });
  }
  return value;
}

/** `user:alice` → `comem://user/alice`（不带末尾斜杠）。 */
export function scopeOfSubject(subject: string): string {
  return userScopeOf(subject, '检索身份').toString();
}

/**
 * 到上限时的错误（§19：超时 → `PROVIDER_UNAVAILABLE`，`details.timeout = true`）。
 *
 * 必须返回错误而不是空结果：200 + `hits: []` 会被调用方读成「记忆里没有」。
 * 这与 MCP 侧「超时不能伪装成空结果」是同一条规则，只是返回形态不同。
 */
function deadlineExceeded(deadline: CallDeadline): ComemError {
  const upstream = deadline.lastUpstream;
  const where =
    upstream === null
      ? '，且没有进入任何外部上游；卡住的位置在本地（索引 / 文件系统 / 锁）'
      : `；最后进入的上游是 ${upstream.label}，已等待 ${upstream.elapsedMs} 毫秒仍未响应`;
  return new ComemError(
    'PROVIDER_UNAVAILABLE',
    `检索在 ${deadline.budgetMs} 毫秒内没有返回${where}。本次请求已中止等待，上游可能仍在执行。`,
    {
      timeout: true,
      timeoutMs: deadline.budgetMs,
      reason: 'deadline_exceeded',
      upstream: upstream?.upstream ?? null,
      elapsedMs: upstream?.elapsedMs ?? null,
    },
  );
}

/**
 * 在总上限内跑一次检索。
 *
 * 上限施加在**路由 handler** 上，不是 Fastify 的钩子：钩子只能决定「什么时候
 * 放行」，没法把 handler 的返回值换成错误；而 handler 是 `app.inject()` 与真实
 * 监听端口共同经过的唯一位置（两者都是同一套路由与 handler）。
 *
 * `operation` 拿到的 deadline 要做两件事：
 *
 * 1. `mark` 上报上游，到点时错误消息能写清卡在哪；
 * 2. 把 `deadlineAt` 传给服务层。服务层据此把三段上游预算收窄到剩余时间
 *    （`services/search.ts` 的 `remainingBudget` 与 `#analyze`），provider 再把
 *    这个预算与 `providers.*.timeoutSeconds` 取 `min` 后设超时——它只会收紧用户
 *    配置，不会放宽。到点时 provider 的 `AbortController` 会真正中止在途 HTTP
 *    请求，而不是让它在 503 之后继续跑。
 *
 * 两个上游预算都留了「剩余时间 - min(1s, 剩余/5)」的余量，所以降级与中止通常
 * 发生在总上限**之前**；真正走到这一层的 `timed_out` 兜的是本地卡住（索引 / ACL）。
 */
export async function runRetrieval<T>(
  budgetMs: number,
  operation: (deadline: CallDeadline) => Promise<T>,
): Promise<T> {
  const deadline = new CallDeadline(budgetMs);
  const outcome = await runWithDeadline(operation(deadline), deadline);
  if (outcome.kind === 'timed_out') {
    throw deadlineExceeded(deadline);
  }
  return outcome.value;
}
