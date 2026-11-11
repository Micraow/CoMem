#!/usr/bin/env node
/**
 * `SessionStart`：注入用户 profile、偏好与技能目录（架构文档 §15.2）。
 *
 * 会话开始时模型对「这个用户是谁、怎么做事、有哪些技能」一无所知。这三样都是
 * **稳定**的（变化以天计），适合开局一次性注入；放到每轮召回里是重复投喂。
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
 * ## 画像与偏好的注入预算
 *
 * 技能目录之外，画像与偏好也是**无上限**的：1,076 次归档的画像有 16 万字，整段塞
 * 进上下文会挤掉对话本身。两条约束：
 *
 * 1. **只注入正文**。`profile.md` 的 YAML frontmatter（`memory_type` / `created_at`
 *    / `uri` / 256 字的 `summary`）对模型是噪声；`summary` 还是正文首行的副本。
 *    服务端 `content/read` 已经剥过一次，Hook 再剥一次是防御（插件独立部署，
 *    对端不一定是同一个版本）。
 * 2. **token 预算 + head/tail 截断**。`profileBudgetTokens`（默认 2,000）放不下时
 *    保留前 8 行 / 句 + 尾部若干，中间插一条带 URI 的省略标记。标记必须写清怎么
 *    找回——只写 `...` 的模型不知道有东西被省略。
 *
 * 再往外是**宿主字节上限**（`hosts/*.mjs` 的 `MAX_CONTEXT_BYTES`）：超过之后宿主
 * 把 hook 输出转存成文件、只放预览。超限时按「画像 > 技能目录 > 偏好」丢块。
 *
 * ## 读哪些文件
 *
 * - `comem://user/{uid}/memories/profile.md`（§6.5 的个人档案）
 * - `comem://user/{uid}/memories/preferences`（**目录**，取它的 L1 概览 §9.1 的
 *   4000 字符预算）
 *
 * **偏好必须按目录读，不能拼 `.overview.md`。** `.overview.md` 是保留名
 * （`domain/uri.ts` 的 `RESERVED_SEGMENT_NAMES`），`Uri.parse` 对它抛
 * `INVALID_URI`（HTTP 400）。曾经这里直接 `content/read` 那个文件名，又被
 * `.catch(() => null)` 吞成「没有偏好」——`<comem-preferences>` 从上线起就没注入过，
 * 而文件一直在盘上。`GET /content/overview` 接的是目录 URI，服务端自己读
 * `.overview.md`（`SummaryService.read`）。
 *
 * 文件不存在不是错误：用户可能刚装好插件，还没写过 profile。静默跳过该块。
 * 其余错误（400 / 5xx / 网络）记一条 warn 再降级——它们不是「没有偏好」，是配置
 * 或部署坏了。
 */

import { pathToFileURL } from 'node:url';

import { DEFAULT_PROFILE_BUDGET_TOKENS, isBypassed, loadConfig, resolveHost } from '../lib/config.mjs';
import { ComemHookError, createHttpClient } from '../lib/http.mjs';
import { runMain } from '../lib/lifecycle.mjs';
import { elideToBudget, escapeInjectionText, estimateTokens, fitContext, stripFrontmatter } from '../lib/injection.mjs';
import { elapsedMs, processStartMs, reportOverhead } from '../lib/telemetry.mjs';

const CONTENT_READ_PATH = '/api/v1/content/read';
const CONTENT_OVERVIEW_PATH = '/api/v1/content/overview';
const SKILLS_PATH = '/api/v1/skills';

/** 目录不存在 / 不可读时服务端返回的状态：还没写过偏好，不是错误。 */
const MISSING_NODE_STATUSES = new Set([403, 404]);

/** 注入块标签。 */
const PROFILE_OPEN = '<comem-profile>';
const PREFERENCES_OPEN = '<comem-preferences>';
const SKILLS_OPEN = '<available-skills>';

/**
 * 宿主对一次 hook 输出的字节上限。三个块的标签、空行与 JSON 信封约 100 字节，
 * 取 128 留余量。
 *
 * 逐宿主的值在 `hosts/*.mjs` 的 `MAX_CONTEXT_BYTES`（Claude Code 9,500、
 * DSH 20,000）。**调用方不传时用最严的那个**：拿不准宿主是谁，就按会静默转存
 * 文件的那个来，不能赌。
 */
const DEFAULT_MAX_CONTEXT_BYTES = 9500;
const CONTEXT_ENVELOPE_BYTES = 128;

/**
 * 偏好概览的预算 = 画像预算的 1/4。
 *
 * 偏好是目录的 L1 索引（一行一条摘要），默认 500 token 约 15–30 条，够模型判断
 * 「哪些偏好与这一轮相关」；完整正文走 `find` / `content/overview` 按需取。
 * 不单开配置项：它是画像预算的派生值，单独配只会多一处要解释的默认值。
 */
const PREFERENCES_BUDGET_DIVISOR = 4;

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

/** `GET /content/read` 的结果可能是 `{text}`，也可能直接是字符串。 */
function readText(result) {
  if (typeof result === 'string') {
    return result === '' ? null : result;
  }
  if (typeof result === 'object' && result !== null) {
    const text = result.text;
    if (typeof text === 'string' && text !== '') {
      return text;
    }
  }
  return null;
}

/** `GET /content/overview` 的结果是 `{overview: string | null, degraded, source}`。 */
function readOverview(result) {
  if (typeof result === 'object' && result !== null) {
    const overview = result.overview;
    if (typeof overview === 'string' && overview.trim() !== '') {
      return overview;
    }
  }
  return null;
}

/**
 * 诊断出口：stderr 一行 JSON。
 *
 * 为什么不写 stdout：那是注入协议的通道，混进一行 warn 会被宿主当成上下文。
 * 格式与 `mcp-proxy.mjs` 的 `log()` 一致，便于统一采集。
 */
function warnToStderr(message, data) {
  try {
    process.stderr.write(
      `${JSON.stringify({ level: 'warn', component: 'session-start', message, ...data })}\n`,
    );
  } catch {
    // 写不了 stderr 就只能放弃诊断。
  }
}

/** 目录还没建 / 不可读 = 「没有偏好」。其余错误不是。 */
function isMissingNode(error) {
  return error instanceof ComemHookError && MISSING_NODE_STATUSES.has(error.status);
}

/**
 * 读偏好目录的 L1 概览。
 *
 * 三种结果：字符串（有偏好）、`null`（目录不存在，静默跳过）、`null` + 一条 warn
 * （读取失败）。**不能把失败静默成「没有偏好」**——那正是这个块从上线起就没出现过
 * 的原因。
 */
async function readPreferences(preferencesUri, deps) {
  try {
    return readOverview(await deps.http.get(CONTENT_OVERVIEW_PATH, { uri: preferencesUri }));
  } catch (error) {
    if (!isMissingNode(error)) {
      (deps.warn ?? warnToStderr)('读取偏好概览失败，本次不注入 <comem-preferences>。', {
        uri: preferencesUri,
        code: error instanceof ComemHookError ? error.code : 'UNKNOWN',
        status: error instanceof ComemHookError ? (error.status ?? null) : null,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return null;
  }
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
 * }} deps `maxContextBytes` 来自宿主适配器（`hosts/*.mjs` 的 `MAX_CONTEXT_BYTES`）
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
  const [profile, preferences, skills] = await Promise.all([
    deps.http
      .get(CONTENT_READ_PATH, { uri: profileUri })
      .then(readText)
      .catch(() => null),
    readPreferences(preferencesUri, deps),
    deps.http
      .get(SKILLS_PATH)
      .then(readSkills)
      .catch(() => []),
  ]);
  const recallMs = elapsedMs(recallStartedAt);

  const serializeStartedAt = process.hrtime.bigint();
  // 画像预算不得超过宿主字节上限：最坏 4 字节/token（英文 1 字符 1 字节、4 字符
  // 1 token），所以 `maxBytes / 4` 个 token 一定放得下。配置调大时以宿主为准。
  const profileBudgetTokens = Math.min(
    deps.config.profileBudgetTokens ?? DEFAULT_PROFILE_BUDGET_TOKENS,
    Math.floor((maxContextBytes - CONTEXT_ENVELOPE_BYTES) / 4),
  );

  const blocks = [];
  if (profile !== null) {
    // frontmatter 里的 `memory_type` / `created_at` / `uri` 对模型是噪声，`summary`
    // 又是正文前 256 字的副本（§9.1 的 L0 预算按正文首行截断）。只注入正文。
    // 正文是记忆，可能含 `<comem-recall>`：转义发生在拼块之前（§15.10）。
    const body = escapeInjectionText(
      elideToBudget(stripFrontmatter(profile), profileBudgetTokens, profileUri).trim(),
    );
    if (body !== '') {
      blocks.push({ id: 'profile', text: `${PROFILE_OPEN}\n${body}\n</comem-profile>` });
    }
  }
  if (preferences !== null) {
    // 偏好与画像一样是正文：超预算时同样按「前 N 行 + 尾部 + 省略标记」截断。
    const budget = Math.floor(profileBudgetTokens / PREFERENCES_BUDGET_DIVISOR);
    const body = escapeInjectionText(elideToBudget(preferences.trim(), budget, preferencesUri).trim());
    if (body !== '') {
      blocks.push({ id: 'preferences', text: `${PREFERENCES_OPEN}\n${body}\n</comem-preferences>` });
    }
  }
  const catalog = renderSkillCatalog(skills, deps.config.skillBudgetTokens);
  if (catalog !== undefined) {
    blocks.push({ id: 'skills', text: catalog });
  }

  // 三个块各自的预算都放不下时，按「画像 > 技能目录 > 偏好」丢：画像不可恢复，
  // 偏好能用 find / content/overview 按需取回，技能目录丢了模型不知道有能力存在。
  const { context: rendered, dropped } = fitContext(blocks, maxContextBytes);
  if (dropped.length > 0) {
    (deps.warn ?? warnToStderr)('注入上下文超过宿主字节上限，已按优先级丢弃块。', {
      maxContextBytes,
      dropped,
    });
  }
  const context = rendered === '' ? undefined : rendered;
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
