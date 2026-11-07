/**
 * 查询过滤（架构文档 §8.8）。
 *
 * 用户的 prompt 里混着大量不该当查询用的噪音：斜杠命令、`@文件提及`、粘进来的代码块、
 * `继续` / `ok` 这类无实质内容、URL。直接拿整段 prompt 去检索，BM25 分数会被稀释，
 * 召回全是噪音。做法是一组 sed 风格的正则规则，**按顺序**作用在 prompt 上，产物才是
 * 查询。
 *
 * ## 为什么是 sed 语法
 *
 * 用户（和 agent）脑子里想的就是「把这段替换成那段」。正则替换的表达式最直接，写成
 * YAML 也最省事：
 *
 * ```yaml
 * queryFilters:
 *   - 's|^/\w+.*$||'              # 去掉斜杠命令
 *   - 's|@[\w/\.\-]+||g'         # 去掉文件提及
 * ```
 *
 * ## 空结果的语义
 *
 * `applyQueryFilters` 过滤后为空时返回**空串**，调用方看到空串必须**不检索**。
 * 拿空串调 `find` 会命中所有「摘要非空」的节点（FTS5 对空短语返回空集，但换一个
 * 实现、或者把空串切分成空格再查，就会返回随机结果），比不返回更糟——模型会以为
 * 「继续」这句话真的对应某条记忆，还把它写进召回账本。
 *
 * ## NFC 规范化
 *
 * 过滤**前后各做一次** `normalize('NFC')`。URI 与摘要都按 NFC 存储（架构文档
 * §6.2 规则 1），而 macOS 的文件系统、部分输入法给出的是分解形态（`e` + U+0301）。
 * 不规范化的话，一条针对 `é` 的规则匹配不到 `e\u0301`，全角字符与组合字符的正则会
 * 静默漏掉。
 *
 * 注意 NFC 不折叠全角（`Ａ` 与 `A` 是不同码点，那是 NFKC 的事）：全角输入按全角
 * 匹配，规则里写全角字符就能命中。
 */

import { ComemError } from './errors.js';

/** 编译后的单条规则。`source` 只用于错误消息与日志，`pattern` 已可执行。 */
export interface QueryFilter {
  /** 规则原文，错误消息里带出来让用户能定位是哪一行配置 */
  readonly source: string;
  readonly pattern: RegExp;
  /** 替换串，`$1` / `$&` 按 JS 语义透传（`String.prototype.replace`） */
  readonly replacement: string;
}

/** sed 替换命令的前缀。只支持 `s`，其它命令（`d`、`y`）没有对应需求。 */
const SUBSTITUTE_COMMAND = 's';

/**
 * 分隔符不能是字母数字：`sxfooxbarx` 里哪个 `x` 是分隔符、哪个是模式的一部分
 * 无法确定。sed 也是这条规则。
 */
const ALPHANUMERIC = /[0-9A-Za-z]/;

/** 反斜杠不能当分隔符：转义语法会与分隔符自身的转义冲突。 */
const BACKSLASH = '\\';

/**
 * 支持的标志（架构文档 §8.8 未列全，按 JS 正则的常用子集取）。
 *
 * - `g`：全局替换（非 `g` 只替换第一处）
 * - `i`：忽略大小写
 * - `m`：多行（`^` / `$` 匹配每一行）
 * - `u`：Unicode 模式（`\p{...}`、字素相关语义）
 *
 * 不支持 `y`（sticky）：它的语义是「从上一次匹配位置继续」，而这里是独立地对
 * prompt 做一次替换，没有上一次。
 */
const SUPPORTED_FLAGS: ReadonlySet<string> = new Set(['g', 'i', 'm', 'u']);

/**
 * 一条规则固定三段：`pattern` 与 `replacement` 之间、`replacement` 与 `flags` 之间、
 * 以及开头的 `s` 之后各一个分隔符。少一个就无法确定替换串从哪结束。
 */
const REQUIRED_DELIMITERS = 2;

function invalidRule(rule: string, reason: string): ComemError {
  return new ComemError('INVALID_ARGUMENT', `查询过滤规则不合法：${reason}（规则：${rule}）`, {
    rule,
    reason,
  });
}

/**
 * 编译一条 sed 替换规则。
 *
 * 语法是 `s<分隔符>pattern<分隔符>replacement<分隔符>flags`，分隔符可以是任意
 * **非字母数字**字符（`|` `/` `#` `~` 都常见）。pattern 里出现分隔符时必须转义
 * （`\|`），否则无法确定 pattern 从哪结束；转义只保护分隔符本身，还原后按 JS
 * 正则语义解释（`|` 是选择分支，字面量竖线写成 `[|]`）。
 *
 * 非法输入抛 `INVALID_ARGUMENT`，消息里带规则原文——配置有十几条时，只说「第 3 条
 * 错了」不够定位。
 */
export function compileQueryFilter(rule: string): QueryFilter {
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

  const sections: string[] = [];
  let current = '';
  let found = 0;
  let index = SUBSTITUTE_COMMAND.length + 1;

  while (index < rule.length && found < REQUIRED_DELIMITERS) {
    const char = rule.charAt(index);
    if (char === BACKSLASH && index + 1 < rule.length) {
      const next = rule.charAt(index + 1);
      // 转义**只**保护分隔符本身：`\|` 在 `|` 作分隔符时还原成 `|`，在 JS 正则里
      // 是「选择分支」而不是字面量（sed 的 BRE 里 `\|` 才是分支，两套语法不能混）。
      // 其它转义（`\d`、`\s`、`\.`）是正则语法，反斜杠必须留着。
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
  const flags = [...new Set(rawFlags)].join('');

  try {
    return { source: rule, pattern: new RegExp(patternSource, flags), replacement };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw invalidRule(rule, `正则无法编译：${reason}`);
  }
}

/** 批量编译。任意一条失败整体失败——配置错误应该在装配期暴露，不是首次查询时。 */
export function compileQueryFilters(rules: readonly string[]): readonly QueryFilter[] {
  return rules.map(compileQueryFilter);
}

/**
 * 按顺序作用在 prompt 上，返回查询文本；过滤后为空返回空串。
 *
 * **调用方看到空串必须不检索。** 空查询没有「相关」可比，任何实现给出的结果都是
 * 随机的，而这些随机结果会被当成「用户这句话对应的记忆」写进召回账本，污染下一轮
 * 去重。
 */
export function applyQueryFilters(prompt: string, filters: readonly QueryFilter[]): string {
  let text = prompt.normalize('NFC');
  for (const filter of filters) {
    text = text.replace(filter.pattern, filter.replacement);
  }
  const normalized = text.normalize('NFC');
  // 规则可能把 prompt 削成纯空白（`s|@[\w/\.\-]+||g` 作用在只有文件提及的输入上）。
  // 纯空白与空串一样没有检索价值，按空处理。
  return normalized.trim() === '' ? '' : normalized;
}
