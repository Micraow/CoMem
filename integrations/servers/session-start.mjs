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
 * ## 读哪些文件
 *
 * - `comem://user/{uid}/memories/profile.md`（§6.5 的个人档案）
 * - `comem://user/{uid}/memories/preferences/.overview.md`（L1 概览，§9.1 的 4000 字符预算）
 *
 * 文件不存在不是错误：用户可能刚装好插件，还没写过 profile。静默跳过该块。
 */

import { pathToFileURL } from 'node:url';

import { isBypassed, loadConfig, resolveHost } from '../lib/config.mjs';
import { createHttpClient } from '../lib/http.mjs';
import { elapsedMs, processStartMs, reportOverhead } from '../lib/telemetry.mjs';

const CONTENT_READ_PATH = '/api/v1/content/read';
const SKILLS_PATH = '/api/v1/skills';

/** 注入块标签。 */
const PROFILE_OPEN = '<comem-profile>';
const PREFERENCES_OPEN = '<comem-preferences>';
const SKILLS_OPEN = '<available-skills>';

/**
 * 粗估 token 数（§10.2.1 的公式）。
 *
 * `ceil(CJK 码点数 × 1 + 其余码点数 × 0.25)`。只用于「放不放得下」这种量级
 * 判断，不用于计费。
 *
 * @param {string} text
 * @returns {number}
 */
export function estimateTokens(text) {
  let cjk = 0;
  let other = 0;
  for (const char of text) {
    const codePoint = char.codePointAt(0) ?? 0;
    const isCjk =
      (codePoint >= 0x4e00 && codePoint <= 0x9fff) ||
      (codePoint >= 0x3400 && codePoint <= 0x4dbf) ||
      (codePoint >= 0x3000 && codePoint <= 0x303f) ||
      (codePoint >= 0xff00 && codePoint <= 0xffef);
    if (isCjk) {
      cjk += 1;
    } else {
      other += 1;
    }
  }
  return Math.ceil(cjk + other / 4);
}

/**
 * 按预算渲染技能目录，三档降级（见文件头）。没有技能时返回 `undefined`——
 * 空的 `<available-skills>` 块只会让模型困惑。
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
        ? `- ${skill.name}`
        : `- ${skill.name}: ${skill.description}`,
    )
    .join('\n');
  if (estimateTokens(detailed) <= budgetTokens) {
    return `${SKILLS_OPEN}\n${detailed}\n</available-skills>`;
  }

  const namesOnly = skills.map((skill) => `- ${skill.name}`).join('\n');
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
 * @param {{ sessionId: string, cwd: string, source: string | null }} event
 * @param {{ config: Awaited<ReturnType<typeof loadConfig>>, http: ReturnType<typeof createHttpClient>, env?: NodeJS.ProcessEnv }} deps
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
  const [profile, preferences, skills] = await Promise.all([
    deps.http
      .get(CONTENT_READ_PATH, { uri: `${memoriesRoot}/profile.md` })
      .then(readText)
      .catch(() => null),
    deps.http
      .get(CONTENT_READ_PATH, { uri: `${memoriesRoot}/preferences/.overview.md` })
      .then(readText)
      .catch(() => null),
    deps.http
      .get(SKILLS_PATH)
      .then(readSkills)
      .catch(() => []),
  ]);
  const recallMs = elapsedMs(recallStartedAt);

  const serializeStartedAt = process.hrtime.bigint();
  const blocks = [];
  if (profile !== null) {
    blocks.push(`${PROFILE_OPEN}\n${profile.trim()}\n</comem-profile>`);
  }
  if (preferences !== null) {
    blocks.push(`${PREFERENCES_OPEN}\n${preferences.trim()}\n</comem-preferences>`);
  }
  const catalog = renderSkillCatalog(skills, deps.config.skillBudgetTokens);
  if (catalog !== undefined) {
    blocks.push(catalog);
  }
  const context = blocks.length === 0 ? undefined : blocks.join('\n\n');
  const serializeMs = elapsedMs(serializeStartedAt);

  await reportOverhead(
    {
      event: 'SessionStart',
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
  await host.runHook(async (event) => handleSessionStart(event, { config, http }));
}
