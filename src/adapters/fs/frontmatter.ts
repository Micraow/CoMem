/**
 * YAML frontmatter 读写（架构文档 §6.6、§6.7）。
 *
 * 统一格式是「YAML frontmatter + Markdown 正文」，frontmatter 用 `---` 行包起来。
 * 这一层是纯函数：不碰文件系统，也不认识 `DocumentFrontmatter` 的字段含义——
 * 字段映射（snake_case ↔ camelCase）在 `content-store.ts` 做。
 *
 * 两条硬要求决定了实现细节：
 *
 * 1. **往返稳定**：`parseDocument(serializeDocument(body, data))` 的正文必须与原
 *    正文逐字节相同，`data` 深度相等。否则「正文没变」的判断失效，摘要 digest
 *    会永远对不上，每次写都触发一次重算。
 * 2. **未知键原样保留**：`write` 只替换正文，frontmatter 里别的键（`freshness`、
 *    `uri`、`generated_by`）不能丢也不能改类型（§10.6 元数据写保护）。
 */

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import { ComemError } from '../../domain/errors.js';
import { isRecord } from '../../domain/guards.js';

/** frontmatter 分隔符：行首的 `---`。 */
const DELIMITER = '---';

/**
 * UTF-8 BOM。编辑器（尤其是 Windows 记事本）会在文件开头写一个，它不属于正文，
 * 留着会让「第一行是不是 `---`」的判定失效，也会进正文 digest。
 */
const BYTE_ORDER_MARK = '\uFEFF';

/** 行结束符：只按 `\n` 切行，`\r` 留在行尾由调用处处理，不跨行归一化。 */
const LINE_BREAK = '\n';

/** 去掉行尾一个 `\r`（CRLF 文件）。不碰行内其它字符。 */
const TRAILING_CARRIAGE_RETURN = /\r$/;

/**
 * 开分隔符占掉第 1 行，所以 YAML 解析器报的第 1 行是文件的第 2 行。
 * 两种编号都是 1-based，偏移量是 1。
 */
const YAML_LINE_OFFSET = 1;

export interface ParsedDocument {
  /** 正文，不含 frontmatter 块与分隔符，保留原始换行 */
  readonly body: string;
  /** 解析出的键值；没有 frontmatter 时为空对象 */
  readonly data: Readonly<Record<string, unknown>>;
  /** 是否真的存在 frontmatter 块 */
  readonly hasFrontmatter: boolean;
}

/**
 * 从 YAML 解析错误里取行号。
 *
 * `yaml` 抛的 `YAMLParseError` 带 `linePos`，但它的类型不在公开导出里，所以按
 * 形状逐层收窄，不用类型断言。
 */
function yamlErrorLine(error: unknown): number | null {
  if (typeof error !== 'object' || error === null || !('linePos' in error)) {
    return null;
  }
  const linePos: unknown = error.linePos;
  if (!Array.isArray(linePos)) {
    return null;
  }
  const first: unknown = linePos[0];
  if (typeof first !== 'object' || first === null || !('line' in first)) {
    return null;
  }
  const line: unknown = first.line;
  return typeof line === 'number' ? line : null;
}

function yamlErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 解析 frontmatter 块。空块（`{}`）返回空对象。 */
function parseFrontmatterBlock(yamlText: string): Readonly<Record<string, unknown>> {
  let value: unknown;
  try {
    value = parseYaml(yamlText);
  } catch (error) {
    const line = yamlErrorLine(error);
    const where = line === null ? '' : `第 ${line + YAML_LINE_OFFSET} 行`;
    throw new ComemError(
      'INVALID_ARGUMENT',
      `frontmatter ${where} YAML 语法错误：${yamlErrorMessage(error)}`,
      { line: line === null ? null : line + YAML_LINE_OFFSET },
    );
  }

  // 空 frontmatter 是合法的：`---\n---\n正文` 的 YAML 文档是 `null`。
  if (value === null || value === undefined) {
    return {};
  }
  if (!isRecord(value)) {
    throw new ComemError(
      'INVALID_ARGUMENT',
      `frontmatter 必须是键值对（第 ${1 + YAML_LINE_OFFSET} 行）`,
      { line: 1 + YAML_LINE_OFFSET },
    );
  }
  return value;
}

/**
 * 去掉正文前的那一个空行。
 *
 * `serializeDocument` 在闭合 `---` 之后固定写一个空行（与 §6.6 的示例一致），
 * 这里对称地只吃掉一个空行：手写文件不写空行也能读，正文本身以 `\n` 开头也不会
 * 被多吃——所以 `serializeDocument` → `parseDocument` 的正文逐字节稳定。
 */
function stripSeparatorBlankLine(afterDelimiter: string): string {
  if (afterDelimiter.startsWith('\r\n')) {
    return afterDelimiter.slice('\r\n'.length);
  }
  if (afterDelimiter.startsWith(LINE_BREAK)) {
    return afterDelimiter.slice(LINE_BREAK.length);
  }
  return afterDelimiter;
}

/**
 * 拆出正文与 frontmatter。
 *
 * 只认**第一行**的 `---`：正文中间的 `---` 是 Markdown 水平线，不是 frontmatter
 * 的开头。开分隔符之后找第一个 `---` 行作为闭合；找不到闭合（只有一行 `---`）
 * 时按「没有 frontmatter」处理，整段都是正文——半截 frontmatter 没有可解释的语义。
 *
 * BOM 会被剥掉；`\r\n` 原样保留在正文里，不归一化成 `\n`——归一化会让「正文没变」
 * 的判断失效。
 */
export function parseDocument(raw: string): ParsedDocument {
  const text = raw.startsWith(BYTE_ORDER_MARK) ? raw.slice(BYTE_ORDER_MARK.length) : raw;

  const firstLineBreak = text.indexOf(LINE_BREAK);
  const firstLine = (firstLineBreak < 0 ? text : text.slice(0, firstLineBreak)).replace(
    TRAILING_CARRIAGE_RETURN,
    '',
  );
  if (firstLine !== DELIMITER || firstLineBreak < 0) {
    return { body: text, data: {}, hasFrontmatter: false };
  }

  const lines = text.slice(firstLineBreak + 1).split(LINE_BREAK);
  const closingIndex = lines.findIndex(
    (line) => line.replace(TRAILING_CARRIAGE_RETURN, '') === DELIMITER,
  );
  if (closingIndex < 0) {
    return { body: text, data: {}, hasFrontmatter: false };
  }

  // 逐行 `split('\n')` 之后，CRLF 文件的最后一行会拖一个 `\r`；YAML 把它当行结束符，
  // 先摘掉，解析结果才与 LF 文件一致。
  const yamlText = lines.slice(0, closingIndex).join(LINE_BREAK).replace(TRAILING_CARRIAGE_RETURN, '');
  const afterDelimiter = lines.slice(closingIndex + 1).join(LINE_BREAK);

  return {
    body: stripSeparatorBlankLine(afterDelimiter),
    data: parseFrontmatterBlock(yamlText),
    hasFrontmatter: true,
  };
}

/**
 * 拼回「YAML frontmatter + Markdown 正文」。
 *
 * 键顺序保持 `Object.keys` 顺序，不排序：重排会让同一份 frontmatter 产生不同
 * 字节，正文摘要（digest）会永远对不上，每次写都触发一次假失效。
 *
 * 没有键时不写空块——纯文本文件不需要两行没内容的分隔符。
 */
export function serializeDocument(body: string, data: Readonly<Record<string, unknown>>): string {
  if (Object.keys(data).length === 0) {
    return body;
  }
  // `lineWidth: 0` 关掉折行：长 URI、长摘要被折断后，读回来是另一个字符串。
  const yamlText = stringifyYaml(data, { lineWidth: 0 });
  return `${DELIMITER}${LINE_BREAK}${yamlText}${DELIMITER}${LINE_BREAK}${LINE_BREAK}${body}`;
}
