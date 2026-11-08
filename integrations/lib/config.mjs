/**
 * Hook 插件的配置（架构文档 §8.9 的 bypass 开关、§15.8 的宿主适配、§18 的配置项）。
 *
 * ## 为什么不引入 YAML 库
 *
 * 插件是装进宿主的独立交付物（`integrations/package.json` 不声明任何依赖）。为了
 * 读一行 `baseUrl: ...` 引入一个 YAML 解析器，等于让每个宿主的 `node_modules` 里
 * 多一份解析器——收益与成本不成比例。
 *
 * 代价是**只支持扁平结构**：`key: value` 与顶层序列（`- item`）。服务端配置里的
 * 嵌套段（`server:`、`retrieval:` 等）在这里被整段跳过，hook 读不到。
 * 需要嵌套配置时去服务端配，hook 只认下面这几个键。
 *
 * ## 宿主解析为什么也在这里
 *
 * `servers/*.mjs` 不允许判断宿主（否则加第三个宿主就要改六个文件）。宿主名由
 * `co-mem install` 写进 hook 命令的 `--host` 参数（或 `COMEM_HOST` 环境变量），
 * 本模块按名字动态 import `hosts/<name>.mjs`。**加第三个宿主只加一个文件。**
 */

import { readFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

import { ComemHookError } from './http.mjs';

/**
 * 默认查询过滤规则（架构文档 §8.8 的五条）。
 *
 * 放在 hook 侧而不是只依赖服务端：空查询在服务端会命中「摘要非空」的节点，返回的
 * 结果看起来像真的，还会被写进召回账本（§8.8 最后一段）。hook 必须先判断「这条
 * prompt 有没有检索价值」，再决定发不发请求。
 *
 * 分隔符是 `|`，所以规则里的选择分支必须写成 `\|`（§8.8 的转义说明）。
 */
export const DEFAULT_QUERY_FILTERS = Object.freeze([
  's|^/\\w+.*$||',
  's|@[\\w/\\.\\-]+||g',
  's|```[\\s\\S]*?```||g',
  's|https?://\\S+||g',
  's|^(ok\\|yes\\|继续\\|好\\|嗯)$||i',
]);

/**
 * 技能目录的独立 token 预算（架构文档 §15.2）。
 *
 * 400 是经验值，架构文档只规定「技能目录有独立预算」，没给数。取值依据：一次
 * 注入里 profile 与偏好占几百 token，技能目录不该再挤，400 token 约等于 30 条
 * 短描述；放不下时按三档降级（见 `servers/session-start.mjs`）。
 */
export const DEFAULT_SKILL_BUDGET_TOKENS = 400;

/**
 * 用户画像的注入 token 预算（`<comem-profile>`）。
 *
 * 2000 的来源是**宿主字节上限的倒推**，不是拍的：最严的宿主对 hook 输出只给
 * 9,500 字节（见 `hosts/claude-code.mjs` 的 `MAX_CONTEXT_BYTES`），按最坏情况
 * 4 字节/token（英文：1 字符 1 字节、4 字符/token）是 2,375 token；再留 400 token
 * 给技能目录、留出块标签与空行的余量，取 2,000。中文 2,000 字约 6 KB（3 字节/字、
 * 1 token/字），与同一个上限相容。
 *
 * 量级上：画像正文按 157 字/归档的实测速度增长（4 个会话 8 次归档 1,259 字），
 * 2,000 token 约等于 12 次归档；超过之后按「前 8 行 + 尾部 + 省略标记」截断。
 * 写盘侧把画像压短是另一件事（抽取提示词的职责），这个值只管注入。
 */
export const DEFAULT_PROFILE_BUDGET_TOKENS = 2000;

/** 默认配置（与 §18 的默认值一致）。 */
export const DEFAULT_CONFIG = Object.freeze({
  baseUrl: 'http://127.0.0.1:1933',
  /** 当前用户 ID；召回与采集都要它，缺失时 `co-mem doctor` 报失败 */
  userId: '',
  /** 可选的 Bearer token */
  token: '',
  timeoutMs: 5000,
  /** `PreCompact` 等提交的超时：§17.2 的单步 LLM 上限 30000ms（`rewriteTimeoutMs`） */
  commitTimeoutMs: 30000,
  /**
   * stdio 代理等 MCP 工具响应的超时（`servers/mcp-proxy.mjs`）。
   *
   * **不能复用 `timeoutMs`。** 那个 5 秒是 hook 的阻塞预算（§15.9），而 MCP 工具
   * 是模型主动调用的、不占用户输入延迟：`find` 开了重排时 p95 就有 9.35 秒
   * （`config.example.yaml` 的 `retrieval.rerank.timeoutSeconds` 一节），
   * `add_resource` 还要同步跑一次摘要重算。30000 与提交超时取同一个数，因为
   * 它们是同一条「单步可能很慢」的上限（§17.2）。
   */
  mcpTimeoutMs: 30000,
  recallLimit: 10,
  /**
   * 相对阈值：只保留分数不低于**本次最高分 × 该值**的命中（§15.9 的「三条前提」
   * 之二）。不是绝对分数下限——`fts5` / `vector` / `hybrid` 三种引擎的分数量纲
   * 不同，`hybrid` 的 RRF 融合分只有 `0.016–0.033`，绝对阈值会把全部命中丢掉。
   * 默认 `0.5` 表示「只保留与最佳命中差距不到一半的」。
   */
  recallScoreThreshold: 0.5,
  skillBudgetTokens: DEFAULT_SKILL_BUDGET_TOKENS,
  profileBudgetTokens: DEFAULT_PROFILE_BUDGET_TOKENS,
  queryFilters: DEFAULT_QUERY_FILTERS,
});

/** 环境变量 → 配置键。 */
const ENV_OVERRIDES = Object.freeze({
  COMEM_BASE_URL: 'baseUrl',
  COMEM_USER_ID: 'userId',
  COMEM_TOKEN: 'token',
  COMEM_TIMEOUT_MS: 'timeoutMs',
  COMEM_COMMIT_TIMEOUT_MS: 'commitTimeoutMs',
  COMEM_MCP_TIMEOUT_MS: 'mcpTimeoutMs',
  COMEM_RECALL_LIMIT: 'recallLimit',
  COMEM_RECALL_SCORE_THRESHOLD: 'recallScoreThreshold',
  COMEM_SKILL_BUDGET_TOKENS: 'skillBudgetTokens',
  COMEM_PROFILE_BUDGET_TOKENS: 'profileBudgetTokens',
  COMEM_QUERY_FILTERS: 'queryFilters',
});

const NUMERIC_KEYS = new Set([
  'timeoutMs',
  'commitTimeoutMs',
  'mcpTimeoutMs',
  'recallLimit',
  'recallScoreThreshold',
  'skillBudgetTokens',
  'profileBudgetTokens',
]);

function invalidConfig(message) {
  return new ComemHookError(message, { code: 'HOOK_INVALID_CONFIG' });
}

function parseScalar(raw) {
  const value = raw.trim();
  if (value === '') {
    return '';
  }
  if (value.length >= 2) {
    const first = value.charAt(0);
    const last = value.charAt(value.length - 1);
    if ((first === "'" && last === "'") || (first === '"' && last === '"')) {
      return value.slice(1, -1);
    }
  }
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }
  if (value === 'null' || value === '~') {
    return null;
  }
  if (/^-?\d+(?:\.\d+)?$/.test(value)) {
    return Number(value);
  }
  return value;
}

/**
 * 解析扁平 YAML 子集。
 *
 * 支持：
 * - `key: value`（值可以是引号串、数字、布尔、`null`）
 * - `key:` 后跟缩进的 `- item` 序列；`key: []` 是空数组
 * - 整行 `#` 注释
 *
 * 不支持：行内注释、嵌套映射、多行字符串、锚点。缩进的非序列行（服务端配置的
 * 嵌套段）整段丢掉，连键都不留——那是服务端的字段，hook 不解析也不该报错。
 *
 * @param {string} text
 * @returns {Record<string, unknown>}
 */
export function parseFlatYaml(text) {
  const result = {};
  let currentKey = null;

  for (const [index, rawLine] of text.split(/\r?\n/).entries()) {
    const line = rawLine.trimEnd();
    if (line.trim() === '' || line.trimStart().startsWith('#')) {
      continue;
    }

    const sequence = /^\s+-\s*(.*)$/.exec(line);
    if (sequence !== null) {
      if (currentKey === null) {
        throw invalidConfig(`配置第 ${index + 1} 行的序列没有对应的键。`);
      }
      const item = parseScalar(sequence[1] ?? '');
      if (Array.isArray(result[currentKey])) {
        result[currentKey].push(item);
      } else {
        result[currentKey] = [item];
      }
      continue;
    }

    if (/^\s/.test(line)) {
      // 嵌套映射（服务端配置的 `server:` / `retrieval:` 等）：整段丢掉，连键都不留。
      if (currentKey !== null && result[currentKey] === null) {
        delete result[currentKey];
      }
      continue;
    }

    const entry = /^([A-Za-z0-9_.-]+):\s*(.*)$/.exec(line);
    if (entry === null) {
      throw invalidConfig(`配置第 ${index + 1} 行不是 key: value 形式：${line.trim()}`);
    }
    const key = entry[1] ?? '';
    const value = (entry[2] ?? '').trim();
    currentKey = key;
    if (value === '' || value === '[]') {
      // 空值先记 `null`（后面跟序列时会变成数组），`[]` 原样读成空数组——服务端
      // 示例配置里的 `queryFilters: []` 要能读进来。
      result[key] = value === '[]' ? [] : null;
      continue;
    }
    result[key] = parseScalar(value);
  }

  return result;
}

/** 配置文件位置（§6.5 的桌面默认值；容器里由 `COMEM_CONFIG_FILE` 钉死）。 */
export function resolveConfigPath(env = process.env) {
  const explicit = env['COMEM_CONFIG_FILE'];
  if (typeof explicit === 'string' && explicit !== '') {
    return isAbsolute(explicit) ? explicit : resolve(explicit);
  }
  const xdg = env['XDG_CONFIG_HOME'];
  const base = typeof xdg === 'string' && xdg !== '' ? xdg : join(homedir(), '.config');
  return join(base, 'comem', 'config.yaml');
}

/** 锁、游标、事件去重的落盘目录。`COMEM_HOOK_TMPDIR` 供测试与 `doctor` 隔离。 */
export function resolveTempDir(env = process.env) {
  const explicit = env['COMEM_HOOK_TMPDIR'];
  return typeof explicit === 'string' && explicit !== '' ? resolve(explicit) : tmpdir();
}

function coerce(key, value) {
  if (!NUMERIC_KEYS.has(key)) {
    return value;
  }
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    throw invalidConfig(`配置项 ${key} 必须是数字：${String(value)}`);
  }
  return parsed;
}

/**
 * 读配置：默认值 → 配置文件 → 环境变量。
 *
 * 文件不存在不是错误：全部走默认值与环境变量。只有**存在但解析失败**才抛
 * `HOOK_INVALID_CONFIG`——静默吞掉一个拼错的配置，比报错更难查。
 *
 * `recallScoreThreshold` 是**相对阈值**（`score >= topScore × 该值`），不是绝对
 * 分数下限：三种检索引擎的分数量纲不同，`hybrid` 的 RRF 融合分只有 `0.016–0.033`，
 * 绝对阈值在默认引擎下会把全部命中丢掉（§15.9）。
 *
 * @param {{ env?: NodeJS.ProcessEnv }} [options]
 * @returns {Promise<{
 *   baseUrl: string, userId: string, token: string, timeoutMs: number,
 *   commitTimeoutMs: number, mcpTimeoutMs: number, recallLimit: number,
 *   recallScoreThreshold: number,
 *   skillBudgetTokens: number, profileBudgetTokens: number, queryFilters: readonly string[],
 *   configFile: string, tmpDir: string,
 * }>}
 */
export async function loadConfig(options = {}) {
  const env = options.env ?? process.env;
  const configFile = resolveConfigPath(env);
  let fileValues = {};

  try {
    fileValues = parseFlatYaml(await readFile(configFile, 'utf8'));
  } catch (error) {
    if (error instanceof ComemHookError) {
      throw error;
    }
    if (error.code !== 'ENOENT') {
      throw invalidConfig(`读取配置文件失败：${configFile}`);
    }
  }

  const merged = { ...DEFAULT_CONFIG, ...fileValues };
  for (const [variable, key] of Object.entries(ENV_OVERRIDES)) {
    const value = env[variable];
    if (value === undefined || value === '') {
      continue;
    }
    merged[key] =
      key === 'queryFilters' ? value.split('\n').filter((rule) => rule !== '') : coerce(key, value);
  }

  for (const key of NUMERIC_KEYS) {
    merged[key] = coerce(key, merged[key]);
  }
  merged.queryFilters = Array.isArray(merged.queryFilters)
    ? merged.queryFilters.map((rule) => String(rule))
    : DEFAULT_QUERY_FILTERS;

  return { ...merged, configFile, tmpDir: resolveTempDir(env) };
}

function hostArgument(argv) {
  const index = argv.indexOf('--host');
  if (index < 0) {
    return undefined;
  }
  const value = argv[index + 1];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * 按名字加载宿主适配器。名字只允许小写字母、数字与 `-`——它会被拼进文件路径，
 * 放过 `../` 等于让环境变量读写任意模块。
 *
 * @param {{ env?: NodeJS.ProcessEnv, argv?: readonly string[] }} [options]
 */
export async function resolveHost(options = {}) {
  const env = options.env ?? process.env;
  const argv = options.argv ?? process.argv;
  const name = hostArgument(argv) ?? env['COMEM_HOST'] ?? 'claude-code';

  if (!/^[a-z][a-z0-9-]*$/.test(name)) {
    throw new ComemHookError(`宿主名不合法：${name}`, { code: 'HOOK_INVALID_CONFIG' });
  }

  try {
    return await import(new URL(`../hosts/${name}.mjs`, import.meta.url).href);
  } catch (error) {
    throw new ComemHookError(
      `找不到宿主适配器 hosts/${name}.mjs。用 co-mem install --host ${name} 安装，或检查 --host 参数。`,
      { code: 'HOOK_INVALID_CONFIG', cause: error },
    );
  }
}

/**
 * glob → 正则。只支持 `*`、`**`、`?`，三者都跨 `/`。
 *
 * 与 shell 的路径展开不同：§8.9 的示例是星号 + `/scratch/` + 星号，它必须能匹配
 * `/home/alice/scratch/exp`。按「`*` 不跨 `/`」实现的话，那个示例一条都匹配不
 * 上——用户配了 bypass 却没生效，比不提供这个开关更糟。
 */
function globToRegExp(pattern) {
  let source = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern.charAt(index);
    if (char === '*') {
      source += '.*';
      if (pattern.charAt(index + 1) === '*') {
        index += 1;
      }
      continue;
    }
    if (char === '?') {
      source += '.';
      continue;
    }
    source += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`);
}

function isTruthyFlag(value) {
  if (value === undefined || value === '') {
    return false;
  }
  return value !== '0' && value.toLowerCase() !== 'false' && value.toLowerCase() !== 'no';
}

/**
 * Bypass 开关（架构文档 §8.9）。
 *
 * 生效位置就在这一层：注入与采集都先问这里，命中就整段跳过。服务端不知道有
 * 这回事——它只是没收到请求。
 *
 * `path` 优先于 `cwd`：`PreToolUse` 关心的是「这个文件在不在 scratch 目录」，
 * 而不是「进程跑在哪」。
 *
 * @param {{ cwd?: string, path?: string }} target
 * @param {NodeJS.ProcessEnv} [env]
 */
export function isBypassed(target, env = process.env) {
  if (isTruthyFlag(env['COMEM_BYPASS_SESSION'])) {
    return true;
  }
  const raw = env['COMEM_BYPASS_SESSION_PATTERNS'];
  if (raw === undefined || raw.trim() === '') {
    return false;
  }
  const candidate = target.path ?? target.cwd;
  if (candidate === undefined || candidate === '') {
    return false;
  }
  return raw
    .split(',')
    .map((pattern) => pattern.trim())
    .filter((pattern) => pattern !== '')
    .some((pattern) => globToRegExp(pattern).test(candidate));
}
