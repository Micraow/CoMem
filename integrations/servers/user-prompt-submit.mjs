#!/usr/bin/env node
/**
 * `UserPromptSubmit`：拿这条 prompt 去检索，把相关记忆注入上下文（架构文档 §15.2、
 * §15.9）。
 *
 * 这是**同步阻塞**的一环：用户按下回车 → 宿主起 hook 进程 → 这里调 `find` →
 * 宿主把 prompt 与注入内容一起发给模型。§15.9 的三条前提必须同时成立，否则
 * 200ms 的预热开销纯亏：
 *
 * 1. **召回为空就不注入**——不要给模型一段「没有相关记忆」的废话；
 * 2. **低于阈值不注入**——低分命中是噪音，会被错上下文带偏；
 * 3. **过滤后为空就不检索**——空查询返回的是随机结果（§8.8）。
 *
 * ## 为什么阈值在 hook 侧再过一遍
 *
 * 服务端的 `find` 支持 `scoreThreshold`，但 hook 与服务端的版本可以不同步（插件
 * 是独立交付物）。阈值是「注入还是噪音」的判定，必须由注入方自己负责。
 *
 * ## 检索失败不注入
 *
 * 服务端不可达、超时、返回错误时静默放行：这一轮没有记忆，对话照常进行。把错误
 * 文本注入进去只会污染上下文。
 */

import { pathToFileURL } from 'node:url';

import { isBypassed, loadConfig, resolveHost } from '../lib/config.mjs';
import { applyQueryFilters } from '../lib/filter.mjs';
import { createHttpClient } from '../lib/http.mjs';
import { elapsedMs, processStartMs, reportOverhead } from '../lib/telemetry.mjs';

/** §14 的检索端点。 */
const FIND_PATH = '/api/v1/search/find';

/** 注入块的包裹标签。用 XML 风格，模型对它的边界判断比 Markdown 稳。 */
const RECALL_OPEN = '<comem-recall>';
const RECALL_CLOSE = '</comem-recall>';

/** 响应可能是数组，也可能封在 `hits` 里（两版服务端的差异）。 */
function readHits(result) {
  const value = Array.isArray(result) ? result : result?.hits;
  if (!Array.isArray(value)) {
    return [];
  }
  const hits = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) {
      continue;
    }
    if (typeof entry.uri !== 'string' || typeof entry.score !== 'number') {
      continue;
    }
    hits.push({
      uri: entry.uri,
      score: entry.score,
      memoryType: typeof entry.memoryType === 'string' ? entry.memoryType : null,
      contextType: typeof entry.contextType === 'string' ? entry.contextType : null,
      abstract: typeof entry.abstract === 'string' ? entry.abstract : null,
    });
  }
  return hits;
}

/**
 * 渲染注入块（§8.6 的展示格式与 §13.2 的 `find` 返回值同构）。
 *
 * 分数保留两位小数：三位以上在上下文里只是噪音。摘要按行缩进，模型才能把
 * 「一行 URI + 若干行摘要」当一条记录读。
 *
 * @param {readonly { uri: string, score: number, memoryType: string | null, contextType: string | null, abstract: string | null }[]} hits
 * @param {number} threshold
 * @returns {string | undefined}
 */
export function formatRecallBlock(hits, threshold) {
  const kept = hits.filter((hit) => hit.score >= threshold);
  if (kept.length === 0) {
    return undefined;
  }
  const lines = [RECALL_OPEN];
  for (const hit of kept) {
    const type = hit.memoryType ?? hit.contextType ?? 'memory';
    lines.push(`- [${type} ${hit.score.toFixed(2)}] ${hit.uri}`);
    const abstract = hit.abstract?.trim() ?? '';
    if (abstract !== '') {
      lines.push(`  ${abstract.replaceAll('\n', '\n  ')}`);
    }
  }
  lines.push(RECALL_CLOSE);
  return lines.join('\n');
}

/**
 * @param {{ sessionId: string, cwd: string, prompt: string | null }} event
 * @param {{ config: Awaited<ReturnType<typeof loadConfig>>, http: ReturnType<typeof createHttpClient>, env?: NodeJS.ProcessEnv }} deps
 * @returns {Promise<{ context?: string } | undefined>}
 */
export async function handleUserPromptSubmit(event, deps) {
  const env = deps.env ?? process.env;
  if (isBypassed({ cwd: event.cwd }, env)) {
    return undefined;
  }
  if (event.prompt === null) {
    return undefined;
  }

  // §8.8：过滤后为空就不检索。空查询没有「相关」可比，返回的结果会被当成这条
  // prompt 对应的记忆写进召回账本。
  const query = applyQueryFilters(event.prompt, deps.config.queryFilters);
  if (query === '') {
    return undefined;
  }

  const recallStartedAt = process.hrtime.bigint();
  let hits;
  try {
    const result = await deps.http.post(FIND_PATH, {
      query,
      limit: deps.config.recallLimit,
    });
    hits = readHits(result);
  } catch {
    // 检索失败是正常的降级路径（服务端没起、网络抖动）。这一轮没有记忆。
    return undefined;
  }
  const recallMs = elapsedMs(recallStartedAt);

  const serializeStartedAt = process.hrtime.bigint();
  const context = formatRecallBlock(hits, deps.config.recallScoreThreshold);
  const serializeMs = elapsedMs(serializeStartedAt);

  await reportOverhead(
    {
      event: 'UserPromptSubmit',
      sessionId: event.sessionId,
      phases: { processStartMs: processStartMs(), recallMs, serializeMs, captureMs: 0 },
    },
    { config: deps.config, http: deps.http },
  );

  return context === undefined ? undefined : { context };
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const host = await resolveHost();
  const config = await loadConfig();
  const http = createHttpClient(config);
  await host.runHook(async (event) => handleUserPromptSubmit(event, { config, http }));
}
