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
 * 服务端 `find` 没有阈值参数：相关性由排序 + `limit` 决定，没有可下推的阈。这里的
 * 阈值是**客户端**对返回结果的再筛（`score >= topScore × threshold`，见
 * `formatRecallBlock` 的「为什么阈值是相对的」），与服务端参数无关。hook 又是独立
 * 交付物、与服务端版本可以不同步，所以「注入还是噪音」的判定留在注入方自己手里；
 * 排序分的量纲由引擎决定，也只有在拿到结果之后才算得出来。
 *
 * ## 检索失败不注入
 *
 * 服务端不可达、超时、返回错误时不注入：这一轮没有记忆，对话照常进行。把错误
 * 文本注入进去只会污染上下文。**但 stderr 要留一行诊断**——静默失败是「功能看
 * 起来正常、其实从未工作过」的来源（`<comem-preferences>` 就踩过这个坑）。
 */

import { pathToFileURL } from 'node:url';

import { isBypassed, loadConfig, resolveHost } from '../lib/config.mjs';
import { applyQueryFilters } from '../lib/filter.mjs';
import { ComemHookError, createHttpClient } from '../lib/http.mjs';
import { runMain, warnToStderr } from '../lib/lifecycle.mjs';
import { elapsedMs, processStartMs, reportOverhead } from '../lib/telemetry.mjs';

/** §14 的检索端点。 */
const FIND_PATH = '/api/v1/search/find';

/** 注入块的包裹标签。用 XML 风格，模型对它的边界判断比 Markdown 稳。 */
const RECALL_OPEN = '<comem-recall>';
const RECALL_CLOSE = '</comem-recall>';

/** 降级诊断：一行 JSON 到 stderr，不带 prompt 正文。 */
const warn = (message, data) => warnToStderr('user-prompt-submit', message, data);

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
 * ## 为什么阈值是相对的
 *
 * 服务端 `find` 在默认的 `retrieval.engine: hybrid` 下返回的是 RRF 融合分
 * （`Σ levelWeight / (60 + rank)`，量级 `1/61 ≈ 0.016` 到 `2/61 ≈ 0.033`），
 * 不是相关度分。把 `0.5` 当绝对下限，`hybrid` 下**一条都留不下**：这里返回
 * `undefined`，hook 静默不注入，功能看起来「正常」但从未工作过——不报错、
 * 不打日志、无法归因。
 *
 * 阈值因此按**本次最高分**的比例计算：`score >= topScore × threshold`。语义
 * 变成「只保留与最佳命中差距不到 `1 - threshold` 的」，与引擎无关：`fts5` 取
 * 负的 bm25、`vector` 的余弦、`hybrid` 的 RRF 分都成立。
 *
 * 两个边界：
 *
 * - `hits` 为空时 `Math.max()` 是 `-Infinity`，必须先判空；
 * - `topScore <= 0`（bm25 取负后为 0、余弦为负）时相对阈值没有意义，**全部保
 *   留**。这是正确的降级——分数不可用时不要静默丢数据。
 *
 * ## 为什么行首是编号而不是分数
 *
 * 分数只在**同一次检索的同一个引擎内**可比（§13.2）。RRF 下 rank 1 与 rank 5
 * 的比值是 `0.938`，`toFixed(2)` 把两条都渲染成 `0.02`——它既不携带「哪条更
 * 相关」，又暗示一个不存在的精度。归一化成百分比同样不行：那是按当前结果集
 * 重新缩放，多返回一条命中就会改变所有分数（§17.5 的同一理由）。顺序是这里
 * 唯一可用的信息，所以只编号。
 *
 * 摘要按行缩进，模型才能把「一行 URI + 若干行摘要」当一条记录读。
 *
 * @param {readonly { uri: string, score: number, memoryType: string | null, contextType: string | null, abstract: string | null }[]} hits
 * @param {number} threshold 相对于本次最高分的比例；`0.5` 表示「只保留与最佳命中差距不到一半的」
 * @returns {string | undefined}
 */
export function formatRecallBlock(hits, threshold) {
  if (hits.length === 0) {
    return undefined;
  }
  const topScore = Math.max(...hits.map((hit) => hit.score));
  const cutoff = topScore > 0 ? topScore * threshold : Number.NEGATIVE_INFINITY;
  const kept = hits.filter((hit) => hit.score >= cutoff);
  if (kept.length === 0) {
    // 阈值配到 1 以上时一条都留不下。保留这条分支：调用方仍然拿到「没有记忆」。
    return undefined;
  }
  const lines = [RECALL_OPEN];
  for (const [index, hit] of kept.entries()) {
    const type = hit.memoryType ?? hit.contextType ?? 'memory';
    lines.push(`${index + 1}. [${type}] ${hit.uri}`);
    const abstract = hit.abstract?.trim() ?? '';
    if (abstract !== '') {
      lines.push(`  ${abstract.replaceAll('\n', '\n  ')}`);
    }
  }
  lines.push(RECALL_CLOSE);
  return lines.join('\n');
}

/**
 * @param {{ event: string, sessionId: string, cwd: string, prompt: string | null }} event `event` 是内部事件名（`lib/events.json` 的键），上报时原样用
 * @param {{ config: Awaited<ReturnType<typeof loadConfig>>, http: ReturnType<typeof createHttpClient>, env?: NodeJS.ProcessEnv, warn?: (message: string, data: Record<string, unknown>) => void }} deps
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
  } catch (error) {
    // 检索失败是正常的降级路径（服务端没起、网络抖动）。这一轮没有记忆。
    // 诊断只写 code 与消息：prompt 可能含用户隐私，不进日志。
    (deps.warn ?? warn)('检索失败，本轮不注入 <comem-recall>。', {
      code: error instanceof ComemHookError ? error.code : 'UNKNOWN',
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
  const recallMs = elapsedMs(recallStartedAt);

  const serializeStartedAt = process.hrtime.bigint();
  const context = formatRecallBlock(hits, deps.config.recallScoreThreshold);
  const serializeMs = elapsedMs(serializeStartedAt);

  await reportOverhead(
    {
      event: event.event,
      sessionId: event.sessionId,
      phases: { processStartMs: processStartMs(), recallMs, serializeMs, captureMs: 0 },
    },
    { config: deps.config, http: deps.http },
  );

  return context === undefined ? undefined : { context };
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  await runMain('hook user-prompt-submit', async () => {
    const host = await resolveHost();
    const config = await loadConfig();
    await host.runHook(
      async (event, { deadline }) =>
        handleUserPromptSubmit(event, {
          config,
          http: createHttpClient({ ...config, deadline }),
        }),
      { hardExit: true },
    );
  });
}
