/**
 * 当前执行链路的审计关联信息。
 *
 * HTTP 请求由请求 ID 与认证主体标识；后台归档任务没有 HTTP 请求，用会话所属作用域
 * 和会话 ID 标识。模型调用从这里补关联字段。`AsyncLocalStorage` 保证并发请求与
 * 并发后台任务不会把关联写到彼此身上。
 */

import { AsyncLocalStorage } from 'node:async_hooks';

import { Uri } from '../../domain/uri.js';

export interface LlmCallContext {
  requestId: string | null;
  subject: string | null;
  sessionId: string | null;
}

const storage = new AsyncLocalStorage<LlmCallContext>();

export function runWithLlmCallContext<T>(
  context: Partial<LlmCallContext>,
  fn: () => Promise<T>,
): Promise<T> {
  return storage.run(
    {
      requestId: context.requestId ?? null,
      subject: context.subject ?? null,
      sessionId: context.sessionId ?? null,
    },
    fn,
  );
}

/** 更新当前作用域；没有作用域时不创建，避免一条脱离请求的调用污染后来者。 */
export function setLlmCallContext(context: Partial<LlmCallContext>): void {
  const current = storage.getStore();
  if (current === undefined) {
    return;
  }
  if (context.requestId !== undefined) {
    current.requestId = context.requestId;
  }
  if (context.subject !== undefined) {
    current.subject = context.subject;
  }
  if (context.sessionId !== undefined) {
    current.sessionId = context.sessionId;
  }
}

export function currentLlmCallContext(): Readonly<LlmCallContext> {
  return storage.getStore() ?? { requestId: null, subject: null, sessionId: null };
}

export function runWithCommitCallContext<T>(
  sessionUri: string,
  scopeUri: Uri,
  fn: () => Promise<T>,
): Promise<T> {
  return runWithLlmCallContext(
    {
      subject: `${scopeUri.scope}:${scopeUri.rootId}`,
      sessionId: Uri.parse(sessionUri).name,
    },
    fn,
  );
}

export function runWithResourceCallContext<T>(uri: Uri, fn: () => Promise<T>): Promise<T> {
  const current = currentLlmCallContext();
  return runWithLlmCallContext(
    {
      requestId: current.requestId,
      subject: current.subject ?? `${uri.scope}:${uri.rootId}`,
      sessionId: current.sessionId,
    },
    fn,
  );
}
