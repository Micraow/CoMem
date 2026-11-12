/**
 * 「标题/主题 → identity 字段」的映射（新建记忆表单，架构文档 §11.1、§16）。
 *
 * 控制台的「新建记忆」只收三个输入：记忆类型、标题/主题、正文。路径必须由服务端算：
 * identity 字段名来自各类型自己的 schema，文件名模板由 `renderPath` 解释，控制台里
 * 没有第二份路径规则。
 *
 * 映射按文件名模板里的占位符数量分三档：
 *
 * | 占位符 | 类型 | 标题怎么用 |
 * |---|---|---|
 * | 0 个 | `profile` / `identity` / `soul` | 填 identity 字段（`name`），路径固定 |
 * | 1 个 | `preferences` / `entities` / `events` / `experiences` | 整份标题填那个占位符 |
 * | 多个 | `rules`（`{scenario}/{rule}.md`） | 标题按 `/` 分段，依次填 |
 *
 * `events` 的 `event` 字段约定是 `YYYY-MM-DD-<slug>`（`events.ts` 的字段描述），
 * 标题里没有日期前缀时补今天的本地日期。日期取本地而不是 UTC：事件是「某天发生的
 * 事」，UTC 在 UTC+8 的 0–8 点会把它记成前一天。
 *
 * 标题是用户输入，不是模型输出，所以非法字符在这里换成一句能照做的错误
 * （「标题不能包含斜杠」），不让 `renderPath` 的「identity 值不能包含斜杠」这种
 * 内部说法出现在对话框里。
 */

import { invalidArgument } from '../errors.js';
import type { MemoryTypeSchema } from '../memory-type.js';

/** 文件名里的占位符，如 `{topic}`。与 `domain/memory-type.ts` 同一形状。 */
const PLACEHOLDER_PATTERN = /\{([A-Za-z][A-Za-z0-9_]*)\}/g;

/** 事件标识的日期前缀，如 `2026-11-12-architecture-decision`。 */
const EVENT_DATE_PREFIX = /^\d{4}-\d{2}-\d{2}(?:-|$)/u;

/** 控制字符的上界（`\u0000`–`\u001f`），与 `validateIdentityValue` 同一口径。 */
const CONTROL_CHAR_UPPER_BOUND = 0x20;

function filenamePlaceholders(schema: MemoryTypeSchema): readonly string[] {
  return [...schema.filename.matchAll(PLACEHOLDER_PATTERN)].map((match) => match[1] ?? '');
}

/** 今天的本地日期，`YYYY-MM-DD`。 */
function localDate(now: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${String(now.getFullYear())}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * 一个标题片段 → 一个路径段。
 *
 * 空白折叠成 `-`：标题是给人写的句子，路径段里的空格会让 URI 到处需要转义。中文
 * 原样保留——URI 段是 UTF-8，用户看得懂的路径比 ASCII 短横线拼出来的更可读。
 */
function slugSegment(raw: string, field: string): string {
  const collapsed = raw.trim().replace(/\s+/gu, '-').normalize('NFC');
  if (collapsed === '') {
    throw invalidArgument('标题不能为空。', { field });
  }
  if (collapsed.includes('/')) {
    throw invalidArgument('标题不能包含斜杠。', { field });
  }
  if (collapsed.includes('..')) {
    throw invalidArgument('标题不能包含两个连续的句点。', { field });
  }
  if (
    collapsed.includes('\\') ||
    [...collapsed].some((char) => char.charCodeAt(0) < CONTROL_CHAR_UPPER_BOUND)
  ) {
    throw invalidArgument('标题不能包含反斜杠或控制字符。', { field });
  }
  return collapsed;
}

/**
 * 把标题映射成这个记忆类型的 identity 字段值。
 *
 * 返回值正好覆盖 schema 的每个 identity 字段：`upsertMemory` 的
 * `assertMemoryIdentity` 要求它们全部非空。调用方再交给 `renderMemoryUri`，
 * 路径规则仍然只来自 `filename` 模板。
 */
export function deriveCreationIdentity(
  schema: MemoryTypeSchema,
  title: string,
  now: Date,
): Readonly<Record<string, string>> {
  const placeholders = filenamePlaceholders(schema);
  const identityNames = schema.fields
    .filter((field) => field.identity === true)
    .map((field) => field.name);
  const values: Record<string, string> = {};

  if (placeholders.length === 0) {
    // 单文件类型：标题是 identity 字段（`name`），不参与路径。
    const value = slugSegment(title, 'title');
    for (const name of identityNames) {
      values[name] = value;
    }
  } else if (placeholders.length === 1) {
    // 一个占位符：整份标题就是 identity 值（`preferences/{topic}.md` 等）。
    values[placeholders[0] ?? ''] = slugSegment(title, 'title');
  } else {
    // 多段路径（`rules` 的 `{scenario}/{rule}.md`）：标题按 / 分段，依次填。
    const parts = title.split('/').map((part) => part.trim());
    if (parts.length !== placeholders.length || parts.some((part) => part === '')) {
      throw invalidArgument(`标题需要分成 ${String(placeholders.length)} 段，用 / 分隔。`, {
        field: 'title',
      });
    }
    placeholders.forEach((name, index) => {
      values[name] = slugSegment(parts[index] ?? '', 'title');
    });
  }

  if (schema.type === 'events') {
    const event = values['event'] ?? '';
    if (!EVENT_DATE_PREFIX.test(event)) {
      values['event'] = `${localDate(now)}-${event}`;
    }
  }

  return values;
}
