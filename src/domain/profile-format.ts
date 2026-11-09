/**
 * 用户画像正文的格式契约校验（架构文档 §11.1）。
 *
 * `memory-types/profile.ts` 的 `description` 把格式契约写给了模型，但提示词不是
 * 执行层：模型写 H2 标题、散文段、200 字技术细节、漏日期后缀时，写入路径照样
 * 接受。这个函数把**能由字面结构判定**的条目变成服务端可执行的规则。
 *
 * ## 只校验字面形态，不做语义判断
 *
 * 空正文**不报违规**：它没有可判定的行，而且「画像还没有事实」与「画像写坏了」
 * 是两件事。把它算违规会让每一份只有 `name` 的画像都报一次 warn，运维会学会
 * 忽略这条告警——真正的不合规反而看不见。
 *
 * `profile.ts` 的格式契约里还有两条没有在这里实现：
 *
 * - 「同一个可变状态只保留最新值」：判断两条 bullet 是否在说同一个状态需要语义
 *   理解（「住在上海」与「base 在上海」算不算同一件事），正则做不到；
 * - 「陈述事实，不写评价与推断」：同样是语义问题。「他是后端工程师」是事实还是
 *   评价，取决于上下文与说话人，正则硬做会把正常事实条目标成违规。
 *
 * 这两条只靠提示词。**误报比漏报更糟**：服务端一旦把合规画像标成违规，运维会
 * 学会忽略这条 warn，真正的不合规反而看不见。
 *
 * ## 结构行不重复报「非 bullet」
 *
 * 标题行也是「非 bullet」、代码围栏也是「非 bullet」。如果一行同时报两类，
 * 计数会把一次缺陷算成两次，日志里的 `rules` 也会失真。所以标题与围栏按各自的
 * 类型报一次后直接跳过，不再落到 `not-bullet`。bullet 的「缺日期」与「超长」
 * 是两个独立的缺陷，允许同一条 bullet 各报一次。
 */

import { PROFILE_ENTRY_MAX_CHARS } from './memory-types/profile.js';

/** 违规种类。与 `profile.ts` 的格式契约逐条对应，只包含能做字面判定的那些。 */
export type ProfileViolationKind =
  /** 出现 Markdown 标题行（`#` 开头）。契约要求「不带小标题」 */
  | 'heading'
  /** 出现代码块围栏（行首 ``` ）。契约要求一条一个事实，不要代码块 */
  | 'code-fence'
  /** 非空行不是 bullet（不以 `- ` 或 `* ` 开头） */
  | 'not-bullet'
  /** bullet 结尾没有 `(as of YYYY-MM-DD)` */
  | 'missing-date-suffix'
  /** 日期后缀存在，但不是一个能解析、在合理年份区间内的归档日期 */
  | 'invalid-date-suffix'
  /** 单条正文超过 `PROFILE_ENTRY_MAX_CHARS` 个字符（日期后缀不算） */
  | 'entry-too-long';

export interface ProfileViolation {
  readonly kind: ProfileViolationKind;
  /** 1-based 行号，方便在文件里定位；不含正文内容 */
  readonly line: number;
}

/** 契约里的 bullet 前缀。只认这两种，`1.` / `> ` 都不是。 */
const BULLET_PREFIXES: readonly string[] = ['- ', '* '];

/** 标题行：任何 `#` 开头的行。`profile.ts` 写的是「不带小标题」，不限定层级。 */
const HEADING_PREFIX = '#';

/** 代码块围栏。只认反引号；波浪线围栏（`~~~`）不在 Markdown 规范的主流写法里。 */
const CODE_FENCE_PREFIX = '```';

/**
 * 日期后缀：必须以它结尾，括号里是日期文本。
 *
 * **全角括号也接受。** 契约里的例子写的是 ASCII `(as of 2026-11-09)`，但中文输入法
 * 与中文写作的模型会给出 `（as of 2026-11-09）`，这在中文语境下是同一个后缀而不是
 * 格式错误。把最常见的一种真实写法判成违规，等于训练运维忽略这条 warn，而
 * `missing-date-suffix` 恰好是画像里最该被看见的一条。
 */
const DATE_SUFFIX_PATTERN = /[(（]as of ([^)）]*)[)）]$/u;

/** 契约写的日期形状是 `YYYY-MM-DD`，不接受 `2026-1-5` 这种缩写。 */
const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/u;

/**
 * 合理年份区间：2000–2100。
 *
 * 日期后缀是**归档当天**，不是出生日期。2000 年之前不存在这套归档格式；2100 是
 * 远未来上界，用来挡住 `20261-11-09` 这类明显写错的年份（它们仍能被
 * `Date.parse` 解析成某个时刻）。**不与当前时间比较**：校验器保持纯函数、可穷举，
 * 而且历史画像的日期不应该随着时间推移变成违规。
 */
const MIN_ARCHIVE_YEAR = 2000;
const MAX_ARCHIVE_YEAR = 2100;

/**
 * 单条正文是否超过上限。
 *
 * **按 Unicode 码点数（字符数）而不是显示宽度。** 理由：
 *
 * 1. 契约与成本都是「字符」——画像整份注入，成本按 token/字符算，列宽不参与；
 * 2. 显示宽度（东亚宽字符算 2）会让 15 个汉字就撞线，等于把中文画像的上限砍半，
 *    而 `profile.ts` 的契约对中英文是同一个 30；
 * 3. `String.length` 数的是 UTF-16 码元，emoji 算 2。用 `Array.from` 数码点，
 *    至少让「字符」与用户看到的一致。组合字符（如国旗 emoji）仍可能算多个码点，
 *    这是可接受的边界。
 */
function characterCount(text: string): number {
  return Array.from(text).length;
}

/**
 * 日期后缀是否是一个合理的归档日期。
 *
 * 只做正则形状检查不够：`Date.parse` 会把 `2026-02-30` 归一化成 3 月 2 日，把
 * `2026-13-01` 变成 `NaN`。所以要求解析成功、年份在区间内，并且回写后与原文
 * 逐字相同（拒绝被归一化的日期）。
 */
function isReasonableArchiveDate(text: string): boolean {
  const match = ISO_DATE_PATTERN.exec(text);
  if (match === null) {
    return false;
  }
  const year = Number(match[1]);
  if (year < MIN_ARCHIVE_YEAR || year > MAX_ARCHIVE_YEAR) {
    return false;
  }
  const timestamp = Date.parse(text);
  if (Number.isNaN(timestamp)) {
    return false;
  }
  return new Date(timestamp).toISOString().slice(0, 10) === text;
}

/**
 * 校验一份画像正文，返回违规项；合规时返回空数组。
 *
 * 纯函数：不读盘、不看时钟、不调模型，可以用任意字符串穷举测试。
 */
export function validateProfileBody(body: string): readonly ProfileViolation[] {
  const violations: ProfileViolation[] = [];

  // CRLF 与 LF 都接受：模型与手写编辑器都可能给出 CRLF。
  const lines = body.split(/\r?\n/u);

  for (const [index, raw] of lines.entries()) {
    const line = raw.trim();
    if (line === '') {
      continue;
    }
    const lineNumber = index + 1;

    if (line.startsWith(HEADING_PREFIX)) {
      violations.push({ kind: 'heading', line: lineNumber });
      continue;
    }
    if (line.startsWith(CODE_FENCE_PREFIX)) {
      violations.push({ kind: 'code-fence', line: lineNumber });
      continue;
    }

    // 允许 bullet 前有缩进：缩进不改变「这是一条 bullet」，而契约只禁止标题、
    // 散文与代码块。嵌套本身没有对应的违规类型，这里也不臆造一个。
    const prefix = BULLET_PREFIXES.find((candidate) => line.startsWith(candidate));
    if (prefix === undefined) {
      violations.push({ kind: 'not-bullet', line: lineNumber });
      continue;
    }

    const bullet = line.slice(prefix.length).trim();
    const suffix = DATE_SUFFIX_PATTERN.exec(bullet);
    if (suffix === null) {
      violations.push({ kind: 'missing-date-suffix', line: lineNumber });
      // 没有后缀时只能按整条正文算长度：多报一条「超长」不是误报，那个 bullet
      // 确实同时缺了日期后缀与超长（如果有）。
      if (characterCount(bullet) > PROFILE_ENTRY_MAX_CHARS) {
        violations.push({ kind: 'entry-too-long', line: lineNumber });
      }
      continue;
    }

    if (!isReasonableArchiveDate(suffix[1] ?? '')) {
      violations.push({ kind: 'invalid-date-suffix', line: lineNumber });
    }

    const entry = bullet.slice(0, suffix.index).trim();
    if (characterCount(entry) > PROFILE_ENTRY_MAX_CHARS) {
      violations.push({ kind: 'entry-too-long', line: lineNumber });
    }
  }

  return violations;
}
