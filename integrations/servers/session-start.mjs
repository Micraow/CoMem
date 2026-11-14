#!/usr/bin/env node
import { DEFAULT_PROFILE_BUDGET_TOKENS, isBypassed, loadConfig, resolveHost } from '../lib/config.mjs';
import { createHttpClient } from '../lib/http.mjs';
import { DEFAULT_MAX_CONTEXT_BYTES, escapeInjectionText, estimateTokens, fitContext } from '../lib/injection.mjs';
import { isMainModule } from '../lib/is-main.mjs';
import { runMain, warnToStderr } from '../lib/lifecycle.mjs';
import { elapsedMs, processStartMs, reportOverhead } from '../lib/telemetry.mjs';
import { contextEpoch } from '../lib/context-epoch.mjs';
import { contextBudget, contextDelivery } from '../lib/context-delivery.mjs';

export { estimateTokens };

export function renderSkillCatalog(skills, budgetTokens) {
  if (skills.length === 0) return undefined;
  const detailed = skills.map((skill) => `- ${escapeInjectionText(skill.name)}${skill.description ? `: ${escapeInjectionText(skill.description)}` : ''}`).join('\n');
  const names = skills.map((skill) => `- ${escapeInjectionText(skill.name)}`).join('\n');
  const text = estimateTokens(detailed) <= budgetTokens ? detailed
    : estimateTokens(names) <= budgetTokens ? names : `${skills.length} 个技能可用（详细列表超出预算）`;
  return `<available-skills>\n${text}\n</available-skills>`;
}

function readSkills(result) {
  const entries = Array.isArray(result) ? result : result?.skills;
  if (!Array.isArray(entries)) return [];
  return entries.flatMap((entry) => {
    const uri = typeof entry === 'string' ? entry : entry?.uri;
    const name = typeof entry?.name === 'string' ? entry.name : typeof uri === 'string' ? uri.replace(/\/+$/, '').split('/').at(-1) : null;
    return name ? [{ name, description: typeof entry?.description === 'string' ? entry.description : null }] : [];
  });
}

export async function handleSessionStart(event, deps) {
  if (isBypassed({ cwd: event.cwd }, deps.env ?? process.env)) return undefined;
  const startedAt = process.hrtime.bigint();
  const warn = deps.warn ?? ((message, data) => warnToStderr('session-start', message, data));
  const maxBytes = deps.maxContextBytes ?? DEFAULT_MAX_CONTEXT_BYTES;
  const epoch = event.contextEpoch ?? await contextEpoch(deps.config, event.sessionId, true);
  const delivery = await contextDelivery(deps.config, event.sessionId, epoch);
  const [background, skills] = await Promise.all([
    deps.http.post('/api/v1/context', {
      sessionId: event.sessionId, maxTokens: deps.config.profileBudgetTokens ?? DEFAULT_PROFILE_BUDGET_TOKENS,
      contextEpoch: epoch,
      previousDeliveryToken: delivery.previousDeliveryToken, budgetMs: contextBudget(deps.http),
      maxBytes: Math.max(0, maxBytes - 64),
    }).then(async (result) => { await delivery.accepted(); return result; })
      .catch((error) => { warn('读取个人背景失败。', { error: error instanceof Error ? error.message : String(error) }); return null; }),
    deps.http.get('/api/v1/skills').then(readSkills).catch((error) => {
      warn('读取技能目录失败。', { error: error instanceof Error ? error.message : String(error) }); return [];
    }),
  ]);
  const blocks = [];
  if (typeof background?.rendered === 'string' && background.rendered !== '') {
    blocks.push({ id: 'profile', text: `<comem-profile>\n${background.rendered}\n</comem-profile>` });
  }
  const catalog = renderSkillCatalog(skills, deps.config.skillBudgetTokens);
  if (catalog !== undefined) blocks.push({ id: 'skills', text: catalog });
  const result = fitContext(blocks, maxBytes);
  if (result.dropped.length > 0) warn('上下文超过宿主预算，已缩减。', { dropped: result.dropped });
  void reportOverhead({
    event: event.event, sessionId: event.sessionId,
    phases: { processStartMs: (deps.processStartMs ?? processStartMs)(), recallMs: elapsedMs(startedAt), serializeMs: 0, captureMs: 0 },
  }, { config: deps.config, http: deps.http });
  return result.context === '' ? undefined : { context: result.context,
    onDelivered: () => result.dropped.includes('profile') ? undefined : delivery.delivered(background?.deliveryToken) };
}

if (isMainModule(import.meta.url)) {
  await runMain('hook session-start', async () => {
    const host = await resolveHost();
    const config = await loadConfig();
    await host.runHook(async (event, { deadline }) => handleSessionStart(event, {
      config, http: createHttpClient({ ...config, deadline }), maxContextBytes: host.MAX_CONTEXT_BYTES,
    }), { hardExit: true });
  });
}
