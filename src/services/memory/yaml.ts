/**
 * 记忆文件 frontmatter 用到的 YAML 子集：标量要不要加引号、标量与块序列的写出，
 * 以及对应的行解析。只覆盖记忆字段的四种值（string / number / boolean / string[]），
 * 不支持锚点、块标量、多文档——记忆文件由本服务写出，不支持比「悄悄解析错」更好。
 *
 * ## 为什么不用 `adapters/fs/frontmatter.ts`
 *
 * `adapters/fs/frontmatter.ts` 是通用的 YAML frontmatter 编解码，但 `services/`
 * 只允许 `import type` 引用适配层（§4.2 的 type-only 例外）。`MemoryService` 需要
 * **值**（序列化 / 解析），不能值导入适配器，所以这里维护一份只覆盖记忆文件格式的
 * 最小实现。重复的代价是两份 YAML 子集：记忆文件的字段只有 string / number /
 * boolean / string[] 四种（`domain/memory-type.ts` 的 `FieldType`），不需要完整的
 * YAML 解析器，也不需要锚点、标签、多文档这些能力。
 */

import { invalidArgument } from './errors.js';

const SEQUENCE_ITEM_PREFIX = '  - ';
/**
 * 普通标量（不加引号）的形态。
 *
 * `_` 数字分隔符故意不收进解析：YAML 1.1 的 `1_000` 在 YAML 1.2 里是字符串，
 * 记忆字段里没有这种写法，当作字符串读回来更安全（写了引号的字符串不会被它命中）。
 */
const PLAIN_NUMBER = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/;
/** 会被 YAML 当成非字符串的关键字。 */
const YAML_RESERVED_WORDS: ReadonlySet<string> = new Set([
  'true',
  'false',
  'null',
  '~',
  'yes',
  'no',
  'on',
  'off',
  'True',
  'False',
  'Null',
  'Yes',
  'No',
  'On',
  'Off',
  'TRUE',
  'FALSE',
  'NULL',
  'YES',
  'NO',
  'ON',
  'OFF',
]);

/**
 * 行首这些字符会让 YAML 换一种解析方式（序列项、映射键、注释、锚点、流式集合……）。
 *
 * 命中就加引号，比「记住 YAML 的上下文相关规则」便宜且不会漏。
 */
const YAML_LEADING_INDICATORS: ReadonlySet<string> = new Set([
  '-',
  '?',
  ':',
  ',',
  '[',
  ']',
  '{',
  '}',
  '#',
  '&',
  '*',
  '!',
  '|',
  '>',
  "'",
  '"',
  '%',
  '@',
  '`',
]);

/**
 * 一个值是否需要加引号。
 *
 * 判定按 YAML 普通标量的上下文规则：首字符是结构指示符、含 `: ` 或 ` #`、以 `:`
 * 结尾、含流式指示符（`[ ] { }`）、是保留字或看起来像数字。都命中不了才原样写。
 * 数字与日期的判断只能靠形态：`2026-11-05` 在 YAML 1.2 里是字符串，但很多解析器
 * 按 YAML 1.1 的 timestamp 处理，统一加引号能消除歧义。
 */
function needsQuoting(value: string): boolean {
  if (value === '' || value !== value.trim()) {
    return true;
  }
  if (/[\n\r\t]/.test(value)) {
    return true;
  }
  const first = value[0] ?? '';
  if (YAML_LEADING_INDICATORS.has(first)) {
    return true;
  }
  if (value.includes(': ') || value.includes(' #') || value.endsWith(':')) {
    return true;
  }
  if (/[[\]{}]/.test(value)) {
    return true;
  }
  if (YAML_RESERVED_WORDS.has(value) || PLAIN_NUMBER.test(value)) {
    return true;
  }
  return /^\d{4}-\d{1,2}-\d{1,2}/.test(value);
}

/**
 * 把单个标量写成 YAML。
 *
 * 需要引号时用双引号 + JSON 转义：JSON 字符串是合法的 YAML 双引号标量，`\n` /
 * `\"` / `\\` 的语义一致，不需要自己再维护一套转义表。
 */
export function formatScalar(value: unknown): string {
  if (typeof value === 'string') {
    return needsQuoting(value) ? JSON.stringify(value) : value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      // `NaN` / `Infinity` 写进去就再也读不出来（JSON 会变成 null），按类型不合法拒绝。
      throw invalidArgument('记忆字段不能是 NaN 或 Infinity。', { value: String(value) });
    }
    return String(value);
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  throw invalidArgument('记忆字段只能是字符串、数字、布尔值或字符串数组。', {
    valueType: typeof value,
  });
}

/** 一个字段一行；`string[]` 用 YAML 块序列（每条一行 `  - item`）。 */
export function formatField(name: string, value: unknown): string {
  if (!Array.isArray(value)) {
    return `${name}: ${formatScalar(value)}`;
  }
  if (value.length === 0) {
    return `${name}: []`;
  }
  return [`${name}:`, ...value.map((item) => `${SEQUENCE_ITEM_PREFIX}${formatScalar(item)}`)].join(
    '\n',
  );
}

function parseScalar(text: string): unknown {
  if (text.startsWith('"')) {
    try {
      return JSON.parse(text);
    } catch {
      throw invalidArgument('记忆文件的 frontmatter 里有不合法的双引号字符串。', { text });
    }
  }
  if (text === '[]') {
    return [];
  }
  if (text === 'true') {
    return true;
  }
  if (text === 'false') {
    return false;
  }
  if (PLAIN_NUMBER.test(text)) {
    return Number(text);
  }
  return text;
}

/**
 * 解析 frontmatter 行。
 *
 * 只支持本服务写出的子集：`key: scalar`、`key:` 加缩进块序列、空行与整行注释。
 * 手工写的块标量（`|` / `>`）、锚点、多文档不在支持范围内——记忆文件由服务写入，
 * 不支持比「悄悄解析错」更好。
 */
export function parseFrontmatterLines(lines: readonly string[]): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? '';
    if (line === '' || line.startsWith('#')) {
      index += 1;
      continue;
    }

    const colon = line.indexOf(':');
    if (colon <= 0) {
      throw invalidArgument('记忆文件的 frontmatter 行不是「键: 值」形式。', { line });
    }

    const key = line.slice(0, colon).trim();
    const rest = line.slice(colon + 1).trim();
    if (rest !== '') {
      data[key] = parseScalar(rest);
      index += 1;
      continue;
    }

    const items: unknown[] = [];
    index += 1;
    while (index < lines.length) {
      const item = lines[index] ?? '';
      if (!item.startsWith(SEQUENCE_ITEM_PREFIX)) {
        break;
      }
      items.push(parseScalar(item.slice(SEQUENCE_ITEM_PREFIX.length)));
      index += 1;
    }
    data[key] = items;
  }

  return data;
}
