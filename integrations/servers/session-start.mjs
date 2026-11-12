#!/usr/bin/env node
/**
 * `SessionStart`：注入用户画像索引、偏好索引与技能目录（架构文档 §15.2）。
 *
 * 会话开始时模型对「这个用户是谁、怎么做事、有哪些技能」一无所知。这三样都是
 * **稳定**的（变化以天计），适合开局一次性注入；放到每轮召回里是重复投喂。
 *
 * ## 注入的是索引，不是正文
 *
 * 画像与偏好每条只给一行 `- [类型] 摘要 · comem://…`，正文靠模型按需 `read`。
 * 整段正文注入的代价与收益不对等：画像按 157 字/归档增长，1,076 次归档有 16 万字，
 * 而每轮会话都要把这 16 万字重付一遍。索引化之后一条记忆几十 token，地址还在，
 * 模型要看细节时自己取。
 *
 * 摘要来自服务端 `GET /content/abstract`（文件的 L0 存在索引里，目录的 L0 是
 * `.abstract.md`）。**不在 hook 里截断正文**：那是第二个摘要实现，两处口径必然漂移，
 * 而且 hook 拿到的正文比服务端长。
 *
 * ## 技能目录的独立 token 预算
 *
 * §15.2 只规定「技能目录有独立预算」，没给数。三档降级是硬要求：
 *
 * 1. **全放**：每个技能一行 `- 名字: 描述`；
 * 2. **只名字**：放不下描述就只放名字，模型至少知道有这个技能；
 * 3. **一行计数**：连一个名字都放不下时缩成 `N 个技能可用`——不要输出半截列表。
 *
 * 三档的判定用估算 token（`estimateTokens`），粒度是「几百 token 的量级」，
 * 30% 的误差不影响结论（与 `domain/session.ts` §10.2.1 的估算同一公式）。
 *
 * ## 再往外是宿主字节上限
 *
 * 逐宿主的值在 `hosts/*.mjs` 的 `MAX_CONTEXT_BYTES`（Claude Code 9,500、Codex
 * 9,500；DSH 插件传的是默认的 9,500）。超限时按 `lib/injection.mjs` 的
 * `CONTEXT_BLOCK_DROP_ORDER` 丢块：技能目录 → 召回 → 偏好 → 画像。**顺序是显式的**，
 * 不依赖块在数组里的位置——「从后往前丢」会让块的插入顺序变成第二份优先级表。
 *
 * ## 读哪些接口
 *
 * - `GET /content/abstract?uri=comem://user/{uid}/memories/profile.md`（§6.5 的
 *   个人档案，一条记忆一行）
 * - `GET /fs/ls?uri=comem://user/{uid}/memories/preferences`（**目录**，取直接子文件）
 * - 每个子文件再 `GET /content/abstract?uri=…`（一条偏好一行）
 * - `GET /skills`（技能目录）
 *
 * **偏好必须按目录列，不能拼 `.overview.md`。** `.overview.md` 是保留名
 * （`domain/uri.ts` 的 `RESERVED_SEGMENT_NAMES`），`Uri.parse` 对它抛
 * `INVALID_URI`（HTTP 400）。曾经这里直接 `content/read` 那个文件名，又被
 * `.catch(() => null)` 吞成「没有偏好」——`<comem-preferences>` 从上线起就没注入过，
 * 而文件一直在盘上。`fs/ls` 接的是目录 URI，服务端 `FileSystemService.list` 逐条
 * 求过读权限，无权限的节点不出现。
 *
 * 文件不存在不是错误：用户可能刚装好插件，还没写过 profile。静默跳过该块。
 * 其余错误（400 / 5xx / 网络）记一条 warn 再降级——它们不是「没有画像」，是配置
 * 或部署坏了。
 */

import { DEFAULT_PROFILE_BUDGET_TOKENS, isBypassed, loadConfig, resolveHost } from '../lib/config.mjs';
import { ComemHookError, createHttpClient } from '../lib/http.mjs';
import { isMainModule } from '../lib/is-main.mjs';
import { runMain, warnToStderr } from '../lib/lifecycle.mjs';
import {
  DEFAULT_MAX_CONTEXT_BYTES,
  elideMemoryIndex,
  escapeInjectionText,
  estimateTokens,
  fitContext,
} from '../lib/injection.mjs';
import { elapsedMs, processStartMs, reportOverhead } from '../lib/telemetry.mjs';

const CONTENT_ABSTRACT_PATH = '/api/v1/content/abstract';
const FS_LIST_PATH = '/api/v1/fs/ls';
const SKILLS_PATH = '/api/v1/skills';

/** 目录不存在 / 不可读时服务端返回的状态：还没写过偏好，不是错误。 */
const MISSING_NODE_STATUSES = new Set([403, 404]);

/** 注入块标签。 */
const PROFILE_OPEN = '<comem-profile>';
const PROFILE_CLOSE = '</comem-profile>';
const PREFERENCES_OPEN = '<comem-preferences>';
const PREFERENCES_CLOSE = '</comem-preferences>';
const SKILLS_OPEN = '<available-skills>';

/**
 * 三个块的标签、空行与 JSON 信封约 100 字节，取 128 留余量。
 *
 * `maxContextBytes` 逐宿主不同（见 `hosts/*.mjs` 的 `MAX_CONTEXT_BYTES`），
 * 调用方不传时用最严的 9,500（`DEFAULT_MAX_CONTEXT_BYTES`）。
 */
const CONTEXT_ENVELOPE_BYTES = 128;

/**
 * 偏好概览的预算 = 画像预算的 1/4。
 *
 * 索引化之后它是**条目数预算**：默认 500 token 约 6 条中文摘要（每条最坏 256 字 +
 * URI），够模型判断「哪些偏好与这一轮相关」；完整正文走 `read` / `list` 按需取。
 * 不单开配置项：它是画像预算的派生值，单独配只会多一处要解释的默认值。
 */
const PREFERENCES_BUDGET_DIVISOR = 4;

/**
 * 一次 `SessionStart` 最多为多少条偏好拉摘要。
 *
 * 偏好目录没有分页，`fs/ls` 一次返回全部；逐条拉摘要是一个子项一次 HTTP。上限的
 * 来源是**内容预算的倒推**：500 token 在摘要偏长时只放得下 2 条、摘要短时约 15 条，
 * 32 已经比可渲染的多一个数量级。再多的条目本来就会被 `elideMemoryIndex` 截掉，
 * 提前拉只是把用户的回车延迟花在不会显示的内容上。
 *
 * **这是经验上界，没有测量过真实部署的偏好条数分布**；条数超过它时索引里会写
 * 「（已截断，共 M 条）」，完整列表用 `list` 取。
 */
const PREFERENCES_INDEX_ENTRY_LIMIT = 32;

/**
 * 粗估 token 数的出口。
 *
 * 实现搬到 `lib/injection.mjs`（与截断、字节上限放在一起），这里保留导出是为了
 * 调用方与测试只 import 一个模块。
 */
export { estimateTokens };

/**
 * 按预算渲染技能目录，三档降级（见文件头）。没有技能时返回 `undefined`——
 * 空的 `<available-skills>` 块只会让模型困惑。
 *
 * 技能的名字与描述来自服务端（可以是任意记忆），渲染前先转义 `<comem-` 标签：
 * 描述里自带 `<comem-recall>` 时，它会在块里伪造出一层召回边界（§15.10）。
 *
 * @param {readonly { name: string, description: string | null }[]} skills
 * @param {number} budgetTokens
 * @returns {string | undefined}
 */
export function renderSkillCatalog(skills, budgetTokens) {
  if (skills.length === 0) {
    return undefined;
  }

  const detailed = skills
    .map((skill) =>
      skill.description === null || skill.description === ''
        ? `- ${escapeInjectionText(skill.name)}`
        : `- ${escapeInjectionText(skill.name)}: ${escapeInjectionText(skill.description)}`,
    )
    .join('\n');
  if (estimateTokens(detailed) <= budgetTokens) {
    return `${SKILLS_OPEN}\n${detailed}\n</available-skills>`;
  }

  const namesOnly = skills.map((skill) => `- ${escapeInjectionText(skill.name)}`).join('\n');
  if (estimateTokens(namesOnly) <= budgetTokens) {
    return `${SKILLS_OPEN}\n${namesOnly}\n</available-skills>`;
  }

  return `${SKILLS_OPEN}\n${skills.length} 个技能可用（详细列表超出预算）\n</available-skills>`;
}

/** `GET /content/abstract` 的结果是 `{abstract: string | null}`（其它字段不用）。 */
function readAbstractText(result) {
  if (typeof result === 'object' && result !== null && typeof result.abstract === 'string') {
    return result.abstract.trim();
  }
  return '';
}

/** 降级诊断：一行 JSON 到 stderr，不含记忆正文。 */
const warn = (message, data) => warnToStderr('session-start', message, data);

/** 节点不存在 / 不可读 = 「没有这条记忆」。其余错误不是。 */
function isMissingNode(error) {
  return error instanceof ComemHookError && MISSING_NODE_STATUSES.has(error.status);
}

/** 读取失败的诊断字段：code / status / 消息，不含正文。 */
function errorFields(error) {
  return {
    code: error instanceof ComemHookError ? error.code : 'UNKNOWN',
    status: error instanceof ComemHookError ? (error.status ?? null) : null,
    error: error instanceof Error ? error.message : String(error),
  };
}

/**
 * 读一条记忆的 L0 摘要。
 *
 * 三种结果：
 * - 字符串（可能为空串）：节点存在。空串表示「还没生成摘要」，索引行只留 URI；
 * - `null`：节点不存在（403 / 404），调用方跳过这条；
 * - `null` + 一条 warn：读取失败。**不能把失败静默成「没有这条记忆」**——那正是
 *   `<comem-preferences>` 从上线起就没出现过、而文件一直在盘上的原因。
 *
 * @param {string} uri
 * @param {{ http: ReturnType<typeof createHttpClient>, warn?: (message: string, data: Record<string, unknown>) => void }} deps
 * @param {string} warnMessage
 * @returns {Promise<string | null>}
 */
async function readAbstract(uri, deps, warnMessage) {
  try {
    return readAbstractText(await deps.http.get(CONTENT_ABSTRACT_PATH, { uri }));
  } catch (error) {
    if (!isMissingNode(error)) {
      (deps.warn ?? warn)(warnMessage, { uri, ...errorFields(error) });
    }
    return null;
  }
}

/**
 * 列出偏好目录的直接子文件（只要文件，不要子目录）。
 *
 * 按 URI 排序：目录项的顺序是文件系统顺序，不排序的话同一份记忆在不同机器上
 * 会渲染成不同的索引顺序，模型看到的相关度顺序也跟着漂。
 *
 * @param {string} preferencesUri
 * @param {{ http: ReturnType<typeof createHttpClient>, warn?: (message: string, data: Record<string, unknown>) => void }} deps
 * @returns {Promise<string[]>}
 */
async function listPreferenceUris(preferencesUri, deps) {
  let result;
  try {
    result = await deps.http.get(FS_LIST_PATH, { uri: preferencesUri });
  } catch (error) {
    if (!isMissingNode(error)) {
      (deps.warn ?? warn)('读取偏好目录失败，本次不注入 <comem-preferences>。', {
        uri: preferencesUri,
        ...errorFields(error),
      });
    }
    return [];
  }

  const entries = typeof result === 'object' && result !== null && Array.isArray(result.entries) ? result.entries : [];
  return entries
    .filter(
      (entry) =>
        typeof entry === 'object' &&
        entry !== null &&
        entry.kind === 'file' &&
        typeof entry.uri === 'string' &&
        entry.uri !== '',
    )
    .map((entry) => entry.uri)
    .sort((left, right) => left.localeCompare(right));
}

/** 技能列表既可能是名字数组，也可能是 `{name, description}` 数组。 */
function readSkills(result) {
  const value = Array.isArray(result) ? result : result?.skills;
  if (!Array.isArray(value)) {
    return [];
  }
  const skills = [];
  for (const entry of value) {
    if (typeof entry === 'string') {
      // 服务端的 `listSkills` 只返回目录 URI（§12.4 的列表语义），名字取最后一段。
      const name = entry.replace(/\/+$/, '').split('/').at(-1);
      if (name !== undefined && name !== '') {
        skills.push({ name, description: null });
      }
      continue;
    }
    if (typeof entry !== 'object' || entry === null) {
      continue;
    }
    const name =
      typeof entry.name === 'string'
        ? entry.name
        : typeof entry.uri === 'string'
          ? entry.uri.replace(/\/+$/, '').split('/').at(-1)
          : undefined;
    if (name === undefined || name === '') {
      continue;
    }
    skills.push({
      name,
      description:
        typeof entry.description === 'string' && entry.description !== '' ? entry.description : null,
    });
  }
  return skills;
}

/**
 * @param {{ event: string, sessionId: string, cwd: string, source: string | null }} event `event` 是内部事件名（`lib/events.json` 的键），上报时原样用
 * @param {{
 *   config: Awaited<ReturnType<typeof loadConfig>>,
 *   http: ReturnType<typeof createHttpClient>,
 *   env?: NodeJS.ProcessEnv,
 *   warn?: (message: string, data: Record<string, unknown>) => void,
 *   maxContextBytes?: number,
 *   processStartMs?: () => number,
 * }} deps `maxContextBytes` 来自宿主适配器（`hosts/*.mjs` 的 `MAX_CONTEXT_BYTES`）；`processStartMs` 供进程内调用方（DSH 插件）覆盖「进程启动」这一段——那里没有起进程，值是 0
 * @returns {Promise<{ context?: string } | undefined>}
 */
export async function handleSessionStart(event, deps) {
  const env = deps.env ?? process.env;
  if (isBypassed({ cwd: event.cwd }, env)) {
    return undefined;
  }

  const userId = deps.config.userId;
  if (userId === '') {
    // 没有 userId 就拼不出个人根。`co-mem doctor` 会把这一项报成失败。
    return undefined;
  }

  const recallStartedAt = process.hrtime.bigint();
  const memoriesRoot = `comem://user/${userId}/memories`;
  const profileUri = `${memoriesRoot}/profile.md`;
  const preferencesUri = `${memoriesRoot}/preferences`;
  const maxContextBytes = deps.maxContextBytes ?? DEFAULT_MAX_CONTEXT_BYTES;
  const [profileAbstract, preferenceUris, skills] = await Promise.all([
    readAbstract(profileUri, deps, '读取画像摘要失败，本次不注入 <comem-profile>。'),
    listPreferenceUris(preferencesUri, deps),
    deps.http
      .get(SKILLS_PATH)
      .then(readSkills)
      .catch(() => []),
  ]);

  // 只拉会被渲染的条目的摘要：超出的部分 `elideMemoryIndex` 本来就会截掉。
  const preferenceAbstracts = await Promise.all(
    preferenceUris
      .slice(0, PREFERENCES_INDEX_ENTRY_LIMIT)
      .map((uri) => readAbstract(uri, deps, '读取偏好摘要失败，该条不进索引。')),
  );
  const recallMs = elapsedMs(recallStartedAt);

  const serializeStartedAt = process.hrtime.bigint();
  // 画像预算不得超过宿主字节上限：最坏 4 字节/token（英文 1 字符 1 字节、4 字符
  // 1 token），所以 `maxBytes / 4` 个 token 一定放得下。配置调大时以宿主为准。
  const profileBudgetTokens = Math.min(
    deps.config.profileBudgetTokens ?? DEFAULT_PROFILE_BUDGET_TOKENS,
    Math.floor((maxContextBytes - CONTEXT_ENVELOPE_BYTES) / 4),
  );
  const preferencesBudgetTokens = Math.floor(profileBudgetTokens / PREFERENCES_BUDGET_DIVISOR);

  const blocks = [];
  if (profileAbstract !== null) {
    const index = {
      open: PROFILE_OPEN,
      close: PROFILE_CLOSE,
      entries: [{ type: 'profile', abstract: profileAbstract, uri: profileUri }],
      total: 1,
    };
    const elided = elideMemoryIndex(index, profileBudgetTokens);
    blocks.push({
      id: 'profile',
      text: elided.text,
      index: { ...index, entries: elided.entries },
    });
  }
  const preferenceEntries = preferenceUris
    .slice(0, PREFERENCES_INDEX_ENTRY_LIMIT)
    .flatMap((uri, index) => {
      const abstract = preferenceAbstracts[index];
      return abstract === null ? [] : [{ type: 'preferences', abstract, uri }];
    });
  if (preferenceEntries.length > 0) {
    const index = {
      open: PREFERENCES_OPEN,
      close: PREFERENCES_CLOSE,
      entries: preferenceEntries,
      // 标记写目录里的**总条数**，不是这次拉到的条数：模型要知道还有多少没列。
      total: preferenceUris.length,
    };
    const elided = elideMemoryIndex(index, preferencesBudgetTokens);
    blocks.push({
      id: 'preferences',
      text: elided.text,
      index: { ...index, entries: elided.entries },
    });
  }
  const catalog = renderSkillCatalog(skills, deps.config.skillBudgetTokens);
  if (catalog !== undefined) {
    blocks.push({ id: 'skills', text: catalog });
  }

  // 超宿主字节上限时按 `CONTEXT_BLOCK_DROP_ORDER` 丢：技能目录 → 召回 → 偏好 → 画像。
  const { context: rendered, dropped, truncated } = fitContext(blocks, maxContextBytes);
  if (dropped.length > 0 || truncated.length > 0) {
    (deps.warn ?? warn)('注入上下文超过宿主字节上限，已按优先级降级。', {
      maxContextBytes,
      dropped,
      truncated,
    });
  }
  const context = rendered === '' ? undefined : rendered;
  const serializeMs = elapsedMs(serializeStartedAt);

  await reportOverhead(
    {
      event: event.event,
      sessionId: event.sessionId,
      phases: {
        processStartMs: (deps.processStartMs ?? processStartMs)(),
        recallMs,
        serializeMs,
        captureMs: 0,
      },
    },
    { config: deps.config, http: deps.http },
  );

  return context === undefined ? undefined : { context };
}

const isMain = isMainModule(import.meta.url);
if (isMain) {
  await runMain('hook session-start', async () => {
    const host = await resolveHost();
    const config = await loadConfig();
    await host.runHook(
      async (event, { deadline }) =>
        handleSessionStart(event, {
          config,
          http: createHttpClient({ ...config, deadline }),
          maxContextBytes: host.MAX_CONTEXT_BYTES,
        }),
      { hardExit: true },
    );
  });
}
