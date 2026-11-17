/**
 * 自动召回的项目绑定解析。
 *
 * 会话的物理 URI 始终在个人根下；项目 ID 只决定召回范围。已绑定会话是事实来源，
 * 请求里的显式项目只能确认同一个绑定，不能在同一会话内切换项目。
 */

import { ComemError } from '../../domain/errors.js';
import { normalizeProjectId } from '../../domain/project.js';
import type { Uri } from '../../domain/uri.js';
import { sessionUriOf } from './intent.js';

interface SessionProjectLoader {
  load(sessionUri: Uri): Promise<{ readonly projectId?: string }>;
  readSessionMeta?(sessionUri: Uri): Promise<{ readonly projectId?: string } | null>;
}

export interface AutomaticProjectInput {
  readonly subject: string;
  readonly principals: readonly string[];
  readonly sessionId?: string;
  readonly projectId?: string;
  readonly sessions?: SessionProjectLoader;
}

/**
 * 解析本次自动召回使用的项目。
 *
 * - 没有会话时允许显式项目，覆盖宿主首轮 `ensure` 前的请求。
 * - 会话尚未创建时同样允许显式项目；创建失败之外的读取错误继续抛出。
 * - 会话已绑定时，缺省采用绑定值；显式值必须一致。
 */
export async function resolveAutomaticProjectId(
  input: AutomaticProjectInput,
): Promise<string | undefined> {
  const requested = input.projectId === undefined
    ? undefined
    : normalizeProjectId(input.projectId);
  if (input.sessionId === undefined) {
    return requested;
  }

  const sessionUri = sessionUriOf(input.subject, input.sessionId);
  if (input.sessions === undefined) {
    return requested;
  }

  let bound: string | undefined;
  try {
    if (input.sessions.readSessionMeta !== undefined) {
      const meta = await input.sessions.readSessionMeta(sessionUri);
      if (meta === null) return requested;
      bound = meta?.projectId === undefined
        ? undefined
        : normalizeProjectId(meta.projectId);
    } else {
      const session = await input.sessions.load(sessionUri);
      bound = session.projectId === undefined
        ? undefined
        : normalizeProjectId(session.projectId);
    }
  } catch (error) {
    if (error instanceof ComemError && error.code === 'NOT_FOUND') {
      return requested;
    }
    throw error;
  }

  if (bound !== undefined && requested !== undefined && bound !== requested) {
    throw new ComemError(
      'CONFLICT',
      '会话已绑定其他项目，不能在同一会话中切换项目。',
      {
        sessionId: input.sessionId,
        boundProjectId: bound,
        requestedProjectId: requested,
      },
    );
  }
  return bound ?? requested;
}
