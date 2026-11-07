/**
 * 查询过滤（架构文档 §8.8 的 sed 风格规则）。
 *
 * 与 `src/domain/query-filter.ts` 是**同一套语义的两份实现**：服务端在
 * `SearchService.find` 里过滤，hook 在发请求前过滤。不能只留一边——
 *
 * - 服务端不做：控制台与 MCP 工具直接传 query，噪音照样进索引；
 * - hook 不做：`find` 收到空串会返回「摘要非空」的一批节点，看起来像真的，
 *   还会被写进召回账本（§8.8 最后一段）。
 *
 * `integrations/` 是纯 JavaScript 的独立包，不能 import 服务端的 TypeScript 源码，
 * 所以这份实现是复制的。行为由 `integrations/tests/filter.test.mjs` 逐条钉住。
 *
 * ## 语法
 *
 * `s<分隔符>pattern<分隔符>replacement<分隔符>flags`。
 *
 * - 分隔符可以是任意非字母数字字符（`|` `/` `#` `~` 都常见）；
 * - pattern 里出现分隔符必须转义（`\|`），转义只保护分隔符本身——`|` 在 JS 正则
 *   里是选择分支，字面量竖线写成 `[|]`（§8.8 的转义说明）；
 * - 支持的标志：`g` `i` `m` `u`。`y`（sticky）没有对应语义——这里是独立地对
 *   prompt 做一次替换，没有「上一次匹配位置」。
 *
 * 过滤**前后各做一次** NFC 规范化：URI 与摘要都按 NFC 存储（§6.2 规则 1），
 * macOS 与部分输入法给的是分解形态。
 */

import { ComemHookError } from './http.mjs';

/** 只支持 `s` 命令；`d` / `y` 没有对应需求。 */
const SUBSTITUTE_COMMAND = 's';

/** 分隔符不能是字母数字：`sxfooxbarx` 里哪个 `x` 是分隔符无法确定。 */
const ALPHANUMERIC = /[0-9A-Za-z]/;

const BACKSLASH = '\\';

const SUPPORTED_FLAGS = new Set(['g', 'i', 'm', 'u']);

/** 一条规则固定两个分隔符：pattern 之后、replacement 之后。 */
const REQUIRED_DELIMITERS = 2;

function invalidRule(rule, reason) {
  return new ComemHookError(`查询过滤规则不合法：${reason}（规则：${rule}）`, {
    code: 'HOOK_INVALID_ARGUMENT',
  });
}

/**
 * 编译一条 sed 替换规则。非法输入抛 `HOOK_INVALID_ARGUMENT`，消息带规则原文——
 * 配置有十几条时，只说「第 3 条错了」不够定位。
 *
 * @param {string} rule
 * @returns {{ source: string, pattern: RegExp, replacement: string }}
 */
export function compileQueryFilter(rule) {
  if (typeof rule !== 'string' || rule === '') {
    throw invalidRule(String(rule), '规则不能为空');
  }
  if (!rule.startsWith(SUBSTITUTE_COMMAND)) {
    throw invalidRule(rule, '规则必须以 s 开头');
  }

  const delimiter = rule.charAt(SUBSTITUTE_COMMAND.length);
  if (delimiter === '') {
    throw invalidRule(rule, '规则缺少分隔符');
  }
  if (ALPHANUMERIC.test(delimiter) || delimiter === BACKSLASH) {
    throw invalidRule(rule, `分隔符不能是字母数字或反斜杠：${delimiter}`);
  }

  const sections = [];
  let current = '';
  let found = 0;
  let index = SUBSTITUTE_COMMAND.length + 1;

  while (index < rule.length && found < REQUIRED_DELIMITERS) {
    const char = rule.charAt(index);
    if (char === BACKSLASH && index + 1 < rule.length) {
      const next = rule.charAt(index + 1);
      // 转义只保护分隔符本身；`\d` / `\s` / `\.` 是正则语法，反斜杠必须留着。
      current += next === delimiter ? next : `${char}${next}`;
      index += 2;
      continue;
    }
    if (char === delimiter) {
      sections.push(current);
      current = '';
      found += 1;
      index += 1;
      continue;
    }
    current += char;
    index += 1;
  }

  if (found < REQUIRED_DELIMITERS) {
    throw invalidRule(
      rule,
      `需要 s${delimiter}pattern${delimiter}replacement${delimiter}flags 的形式，` +
        `实际只有 ${found + 1} 个分隔符`,
    );
  }

  const [patternSource = '', replacement = ''] = sections;
  const rawFlags = rule.slice(index);
  for (const flag of rawFlags) {
    if (!SUPPORTED_FLAGS.has(flag)) {
      throw invalidRule(rule, `不支持的标志：${flag}`);
    }
  }

  try {
    return {
      source: rule,
      pattern: new RegExp(patternSource, [...new Set(rawFlags)].join('')),
      replacement,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw invalidRule(rule, `正则无法编译：${reason}`);
  }
}

/**
 * 批量编译。任意一条失败整体失败——配置错误应该在安装期暴露，不是首次查询时。
 *
 * @param {readonly string[]} rules
 */
export function compileQueryFilters(rules) {
  return rules.map(compileQueryFilter);
}

/**
 * 按顺序作用在 prompt 上，返回查询文本；**过滤后为空串**。
 *
 * 调用方看到空串必须**不检索**（§8.8 最后一段）：空查询没有「相关」可比，任何
 * 实现给出的结果都是随机的，而这些随机结果会被当成「用户这句话对应的记忆」写进
 * 召回账本，污染下一轮去重。
 *
 * @param {string} prompt
 * @param {readonly (string | { pattern: RegExp, replacement: string })[]} rules
 * @returns {string}
 */
export function applyQueryFilters(prompt, rules) {
  let text = prompt.normalize('NFC');
  for (const rule of rules) {
    const filter = typeof rule === 'string' ? compileQueryFilter(rule) : rule;
    text = text.replace(filter.pattern, filter.replacement);
  }
  const normalized = text.normalize('NFC');
  // 规则可能把 prompt 削成纯空白（`s|@[\w/\.\-]+||g` 作用在只有文件提及的输入上）。
  // 纯空白与空串一样没有检索价值。
  return normalized.trim() === '' ? '' : normalized;
}
