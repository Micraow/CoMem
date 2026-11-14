#!/usr/bin/env node
import { isBypassed, loadConfig, resolveHost } from '../lib/config.mjs';
import { applyQueryFilters } from '../lib/filter.mjs';
import { ComemHookError, createHttpClient } from '../lib/http.mjs';
import { DEFAULT_MAX_CONTEXT_BYTES } from '../lib/injection.mjs';
import { isMainModule } from '../lib/is-main.mjs';
import { runMain, warnToStderr } from '../lib/lifecycle.mjs';
import { elapsedMs, processStartMs, reportOverhead } from '../lib/telemetry.mjs';
import { contextEpoch } from '../lib/context-epoch.mjs';

const warn = (message, data) => warnToStderr('user-prompt-submit', message, data);

export async function handleUserPromptSubmit(event, deps) {
  if (isBypassed({ cwd: event.cwd }, deps.env ?? process.env) || event.prompt === null) return undefined;
  const query = applyQueryFilters(event.prompt, deps.config.queryFilters);
  if (query === '') return undefined;
  const startedAt = process.hrtime.bigint();
  let result;
  try {
    result = await deps.http.post('/api/v1/context', {
      query, sessionId: event.sessionId, limit: deps.config.recallLimit,
      contextEpoch: event.contextEpoch ?? await contextEpoch(deps.config, event.sessionId),
      maxBytes: Math.max(0, (deps.maxContextBytes ?? DEFAULT_MAX_CONTEXT_BYTES) - 64),
    });
    if (result?.degradation) (deps.warn ?? warn)('本轮召回已降级。', { reason: result.degradation });
  } catch (error) {
    (deps.warn ?? warn)('检索失败，本轮不注入记忆。', {
      code: error instanceof ComemHookError ? error.code : 'UNKNOWN',
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
  const rendered = typeof result?.rendered === 'string' ? result.rendered : '';
  await reportOverhead({
    event: event.event, sessionId: event.sessionId,
    phases: { processStartMs: (deps.processStartMs ?? processStartMs)(), recallMs: elapsedMs(startedAt), serializeMs: 0, captureMs: 0 },
  }, { config: deps.config, http: deps.http });
  return rendered === '' ? undefined : { context: `<comem-recall>\n${rendered}\n</comem-recall>` };
}

if (isMainModule(import.meta.url)) {
  await runMain('hook user-prompt-submit', async () => {
    const host = await resolveHost();
    const config = await loadConfig();
    await host.runHook(async (event, { deadline }) => handleUserPromptSubmit(event, {
      config, http: createHttpClient({ ...config, deadline }), maxContextBytes: host.MAX_CONTEXT_BYTES,
    }), { hardExit: true });
  });
}
