/**
 * 记忆文档的格式与模型：frontmatter ↔ 结构、保留键、正文边界、identity → URI 渲染
 * （架构文档 §6.6、§11.1）。
 *
 * 一条记忆是 `memories/` 下的一个 Markdown 文件：YAML frontmatter 存
 * `memory_type` / `status` / 时间戳 / 各字段，正文存 `content` 字段（§6.6 的示例）。
 * `content` 之外的字段都是短值，放 frontmatter 才能被索引与检索解析；`content` 可能
 * 很长，放正文才不会把 frontmatter 撑成第二份原文。
 *
 * 读写必须**往返稳定**：`read` 出来的 `fields` 再 `upsertMemory` 写回去，文件正文
 * 逐字节相同。否则摘要 digest 对不上，每次写都会触发一次假失效（§9.3）。
 */

import { isNodeStatus, type NodeStatus } from '../../domain/node.js';
import {
  assertMemoryIdentity,
  renderPath,
  type MemoryTypeSchema,
} from '../../domain/memory-type.js';
import { parseValidityInstant } from '../../domain/retrieval.js';
import { ABSTRACT_MAX_CHARS, truncateToChars } from '../../domain/summary.js';
import type { Uri } from '../../domain/uri.js';
import { invalidArgument } from './errors.js';
import { formatField, formatScalar, parseFrontmatterLines } from './yaml.js';

/**
 * 记忆的状态。
 *
 * 与索引里的 `NodeStatus`（`domain/node.ts`）是同一个集合：两者都来自记忆文件
 * frontmatter 的 `status` 键，索引观察者与这里读的是同一份字段。曾经各写一份字面量
 * 联合，加第三个状态时只改一处会让「文件里写得出、索引里认不出」。
 */
export type MemoryStatus = NodeStatus;

export interface MemoryDocument {
  readonly memoryType: string;
  readonly status: MemoryStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly fields: Readonly<Record<string, unknown>>;
  /** 溯源（保留键 `sources`），最旧在前；缺键时为空数组。 */
  readonly sources: readonly string[];
  /** 正文（`## content` 及之后），与 `memory_diff.json` 的 before / after 同一形态 */
  readonly body: string;
  /** 有效区间的起点（保留键 `valid_from`）；缺键或解析不出来时是 `null` */
  readonly validFrom: string | null;
  /** 有效区间的终点（保留键 `valid_until`）；`null` = 仍然有效 */
  readonly validUntil: string | null;
  /** 被这条记忆顶替掉的版本文件 URI（保留键 `supersedes`）；缺键时是 `null` */
  readonly supersedes: string | null;
}

/** `content` 之外还有一个 camelCase vs snake_case 的映射：frontmatter 用 `updated_at`。 */
export const CONTENT_FIELD = 'content';
export const UPDATED_AT_FIELD = 'updatedAt';

const MEMORY_TYPE_KEY = 'memory_type';
const STATUS_KEY = 'status';
const CREATED_AT_KEY = 'created_at';
const UPDATED_AT_KEY = 'updated_at';
const URI_KEY = 'uri';
/**
 * L0 摘要（`DocumentFrontmatter.summary`）。
 *
 * 写记忆时同步写入，检索侧重排直接读它，不需要为了重排再打开文件。它是派生数据
 * 而非记忆字段，所以进 `RESERVED_KEYS`：`read` 出来的 `fields` 里不该多一列
 * 模型没给过的东西。
 */
const SUMMARY_KEY = 'summary';
/**
 * 溯源：这条记忆由哪几次归档产生（W97）。
 *
 * **必须是保留键。** `serializeMemoryDocument` 只写 `schema.fields` 与
 * `RESERVED_KEYS`（下面的循环），其它键在下一次重写时静默消失——`read` 读出来是
 * 对的、写回去就没了。它也不是记忆字段：模型不产出它，`edit` 也不该能改它。
 *
 * 旧文件没有这个键 → 读作空数组，且不写这个键（输出与改动前一致）。
 */
const SOURCES_KEY = 'sources';
/**
 * 有效区间（W98）：`valid_from` / `valid_until`，ISO 8601，缺键或为 NULL 都是无界。
 *
 * **必须是保留键**，理由同 `sources`：不在 `RESERVED_KEYS` 里的键会被
 * `parseMemoryDocument` 收进 `fields`，而 `serializeMemoryDocument` 只写
 * `schema.fields` 与保留键，下一次重写就把它丢掉了。它也不是记忆字段——有效期由
 * 服务端按写入时刻算，模型不该能通过一次 `replace` 改自己的有效期。
 */
const VALID_FROM_KEY = 'valid_from';
const VALID_UNTIL_KEY = 'valid_until';
/**
 * 被这条记忆顶替掉的版本（W98）：版本文件的 URI。
 *
 * 同样是保留键，同样不是记忆字段：它由写入点算出来（被快照的那份旧文档的路径），
 * 模型看不到也不需要看到。`reject` 靠它回到写入前——拒绝一次错误写入时，把
 * `supersedes` 指向的版本写回规范 URI。
 *
 * **继承规则**：这次覆盖写没有产生新快照（`pending` 旧值、正文没变、或旧文档已被
 * 归档）时沿用磁盘上的值，不丢上一条有效版本的指向。
 */
const SUPERSEDES_KEY = 'supersedes';

/**
 * `sources` 的条数上限。
 *
 * 来源：经验假设。一条记忆通常由少数几次归档产生（新建一次、之后几次覆盖各一次），
 * 20 是**防病态增长**的界：每次覆盖写都追加一个 URI，一条被频繁改写的记忆会无限
 * 加长 frontmatter。一条 URI 约 90 字节，20 条约 1.8 KB，与一条记忆正文同量级。
 * 超过时保留最近的 20 条（最早的先丢），顺序稳定为「最旧在前」。
 */
const MAX_SOURCES = 20;

/** 这些键是文件元数据，不属于 `fields`。 */
const RESERVED_KEYS: ReadonlySet<string> = new Set([
  MEMORY_TYPE_KEY,
  STATUS_KEY,
  CREATED_AT_KEY,
  UPDATED_AT_KEY,
  URI_KEY,
  SUMMARY_KEY,
  SOURCES_KEY,
  VALID_FROM_KEY,
  VALID_UNTIL_KEY,
  SUPERSEDES_KEY,
]);

const FRONTMATTER_DELIMITER = '---';
const CONTENT_HEADING = '## content';
/** 文件名里的 identity 占位符，如 `{topic}`。与 `domain/memory-type.ts` 同一形状。 */
const PLACEHOLDER_PATTERN = /\{([A-Za-z][A-Za-z0-9_]*)\}/g;

function filenamePlaceholders(filename: string): string[] {
  return [...filename.matchAll(PLACEHOLDER_PATTERN)].map((match) => match[1] ?? '');
}

export function renderBody(content: unknown): string {
  return typeof content === 'string' ? `${CONTENT_HEADING}\n\n${content}` : '';
}

/** `renderBody` 的逆运算；没有 `## content` 段时返回 `null`（字段不存在）。 */
function extractContent(body: string): string | null {
  if (body === '') {
    return null;
  }
  const prefix = `${CONTENT_HEADING}\n`;
  if (!body.startsWith(prefix)) {
    return null;
  }
  const rest = body.slice(prefix.length);
  return rest.startsWith('\n') ? rest.slice(1) : rest;
}

/**
 * frontmatter 的 `status` → 记忆状态。
 *
 * 入参是手改文件后的任意 YAML 标量，所以「不是合法状态」按 `active` 处理（旧文件
 * 没有这个键时也是 `active`）。合法集合取自 `domain/node.ts` 的 `isNodeStatus`：
 * 手抄 `value === 'pending' || value === 'archived'` 时，加一个状态会让它被静默读成
 * `active`。
 */
function parseStatus(value: unknown): MemoryStatus {
  return typeof value === 'string' && isNodeStatus(value) ? value : 'active';
}

/**
 * frontmatter 的 `supersedes` → 版本文件 URI。
 *
 * 不可信输入（手改文件）按「没有指向」处理：非字符串、空串都读作 `null`。解析不
 * 出合法 URI 的值留到 `reject` 里判断——那时才需要决定「删掉」还是「恢复」，
 * 在这里抛错会让整条记忆读不出来。
 */
function parseSupersedes(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * frontmatter 的 `sources` → 字符串数组。
 *
 * 缺键、写成标量、块里混进非字符串项都读作「没有可信的溯源」：一个解析不出来的
 * URI 写进输出没有用，而抛错会让整个记忆读不出来（溯源是辅助信息，不是正文的
 * 前置条件）。
 */
function parseSources(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === 'string' && item !== '');
}

/**
 * 追加去重 + 截断到 `MAX_SOURCES`。
 *
 * 顺序 = 最旧在前：已有条目保持原顺序，新条目按传入顺序追加到尾部（同一个 URI
 * 第二次出现不移动位置），超出上限时从头部丢。去重按 URI 字符串精确比较——归档
 * URI 由服务自己渲染，不存在「同一个归档两种写法」。
 *
 * 导出给 `consolidation`：它要把被删除记忆的来源并进保留者，必须先按同一套规则
 * 去重，否则两处各写一份就会一边留 20 条、一边留全部。
 */
export function appendSources(
  current: readonly string[],
  incoming: readonly string[],
): readonly string[] {
  const merged = [...current];
  for (const uri of incoming) {
    if (uri !== '' && !merged.includes(uri)) {
      merged.push(uri);
    }
  }
  return merged.length > MAX_SOURCES ? merged.slice(merged.length - MAX_SOURCES) : merged;
}

/**
 * 记忆文件的 L0 摘要：正文第一个非空行，按 L0 预算截断。
 *
 * 记忆的 `content` 按 §11.1 就是「一句话说清」，第一行已经是摘要量级；不调模型、
 * 不额外读盘。按 `ABSTRACT_MAX_CHARS`（256，§9.1 的 L0 预算）截断，与目录摘要
 * 同一套口径——否则同一条文本在「记忆摘要」与「目录摘要」里会得到两个长度。
 *
 * 没有正文（例如只有 identity 字段的类型）时返回 `null`：写一个空的 `summary`
 * 会让检索侧误以为「摘要可用但为空」，而它应该走「摘要为空 → 正文兜底」。
 */
function abstractOfContent(content: unknown): string | null {
  if (typeof content !== 'string') {
    return null;
  }
  const firstLine = content.split(/\r?\n/).find((line) => line.trim() !== '');
  return firstLine === undefined
    ? null
    : truncateToChars(firstLine.trim(), ABSTRACT_MAX_CHARS);
}

export function serializeMemoryDocument(input: {
  readonly uri: Uri;
  readonly memoryType: string;
  readonly status: MemoryStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly schema: MemoryTypeSchema;
  readonly fields: Readonly<Record<string, unknown>>;
  /** 空数组不写这个键：没有溯源的文件与 W97 之前的文件逐字节相同。 */
  readonly sources: readonly string[];
  /**
   * 有效区间：写进 frontmatter 的 `valid_from` / `valid_until`。
   *
   * 来自 `MemoryDocument` 的**元数据**，不从 `fields` 读：进 `fields` 就等于让模型
   * 用一条 `replace` 改自己的有效期。`valid_until` 为 `null` 时不写这个键（与空
   * `sources` 不写键同一约定），所以当前有效的记忆输出与改动前只差一行 `valid_from`。
   */
  readonly validFrom: string | null;
  readonly validUntil: string | null;
  /** 被顶替的版本文件 URI；`null` 时不写这个键。 */
  readonly supersedes: string | null;
}): string {
  const header = [
    FRONTMATTER_DELIMITER,
    `${MEMORY_TYPE_KEY}: ${formatScalar(input.memoryType)}`,
    `${STATUS_KEY}: ${formatScalar(input.status)}`,
    `${CREATED_AT_KEY}: ${formatScalar(input.createdAt)}`,
    `${UPDATED_AT_KEY}: ${formatScalar(input.updatedAt)}`,
    `${URI_KEY}: ${formatScalar(input.uri.toString())}`,
  ];

  // 有效期与被顶替版本放在同一段元数据里（`status` / `created_at` 那一列），
  // **不放 `fields`**：模型的一次 `replace` 不该能改自己的有效期，而 `fields` 是
  // 模型可写的。
  if (input.validFrom !== null) {
    header.push(`${VALID_FROM_KEY}: ${formatScalar(input.validFrom)}`);
  }
  if (input.validUntil !== null) {
    header.push(`${VALID_UNTIL_KEY}: ${formatScalar(input.validUntil)}`);
  }
  if (input.supersedes !== null) {
    header.push(`${SUPERSEDES_KEY}: ${formatScalar(input.supersedes)}`);
  }

  if (input.sources.length > 0) {
    header.push(formatField(SOURCES_KEY, input.sources));
  }

  // L0 摘要写进 frontmatter：`IndexObserver` 把它当 `abstract` 索引，检索侧的
  // 重排直接读它，不需要为了重排再打开文件（§8.5 的重排语义）。
  const summary = abstractOfContent(input.fields[CONTENT_FIELD]);
  if (summary !== null) {
    header.push(`${SUMMARY_KEY}: ${formatScalar(summary)}`);
  }

  for (const field of input.schema.fields) {
    if (field.name === CONTENT_FIELD || field.name === UPDATED_AT_FIELD) {
      continue;
    }
    const value = input.fields[field.name];
    if (value !== undefined) {
      header.push(formatField(field.name, value));
    }
  }
  header.push(FRONTMATTER_DELIMITER);

  return `${header.join('\n')}\n\n${renderBody(input.fields[CONTENT_FIELD])}`;
}

/**
 * 解析一条记忆文件。
 *
 * 没有 frontmatter 或没有 `memory_type` 时返回 `null`：`memories/` 下可能有用户手工
 * 放的普通 Markdown，它不是记忆，按「不存在」处理比抛错更适合列表遍历。
 */
export function parseMemoryDocument(text: string): MemoryDocument | null {
  const lines = text.split('\n');
  if (lines[0] !== FRONTMATTER_DELIMITER) {
    return null;
  }
  const closingIndex = lines.findIndex(
    (line, index) => index > 0 && line === FRONTMATTER_DELIMITER,
  );
  if (closingIndex < 0) {
    return null;
  }

  const data = parseFrontmatterLines(lines.slice(1, closingIndex));
  const memoryType = data[MEMORY_TYPE_KEY];
  if (typeof memoryType !== 'string') {
    return null;
  }

  // 写盘时固定写一个空行再进正文；这里对称地只吃掉一个。
  const body = lines.slice(closingIndex + 1).join('\n').replace(/^\n/, '');
  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (!RESERVED_KEYS.has(key)) {
      fields[key] = value;
    }
  }
  const content = extractContent(body);
  if (content !== null) {
    fields[CONTENT_FIELD] = content;
  }

  // `updated_at` 是 `updatedAt` 字段在磁盘上的写法（§6.6 的 frontmatter 用 snake_case）。
  // 只认 `memory_type` 就够：`read` 不该因为一个自定义类型没注册进内置表而返回「不存在」，
  // 那会让「写进去了但读不出来」看起来像「没有这条记忆」。
  const createdAt = typeof data[CREATED_AT_KEY] === 'string' ? data[CREATED_AT_KEY] : '';
  const updatedAt = typeof data[UPDATED_AT_KEY] === 'string' ? data[UPDATED_AT_KEY] : createdAt;
  fields[UPDATED_AT_FIELD] = updatedAt;

  return {
    memoryType,
    status: parseStatus(data[STATUS_KEY]),
    createdAt,
    updatedAt,
    fields,
    // 只有在 `RESERVED_KEYS` 里，`sources` 才是「溯源」而不是一列普通 frontmatter
    // 字段。不在保留键集合里时它会被上面的循环收进 `fields`，重写时又按 schema
    // 丢掉——这正是「新键必须做成保留键」的失败形态，不要把它读成溯源。
    sources: RESERVED_KEYS.has(SOURCES_KEY) ? parseSources(data[SOURCES_KEY]) : [],
    // 有效期由写入点给出（W98）：缺键 / 不可解析都是无界，归一化成
    // `toISOString()` 形态以便与索引列按 TEXT 比较。
    validFrom: parseValidityInstant(data[VALID_FROM_KEY]),
    validUntil: parseValidityInstant(data[VALID_UNTIL_KEY]),
    supersedes: parseSupersedes(data[SUPERSEDES_KEY]),
    body,
  };
}

/**
 * 只校验占位符（`renderPath` 的入参），不要求 identity 字段全部出现。
 *
 * 导出给抽取步骤：它要判断「模型引用的 `page_id` 与 identity 推出的路径是不是同一个」，
 * 那份路径推导必须与写入侧完全一致（多一个分支就会一边写 `a/b.md`、一边找 `a-b.md`）。
 */
export function renderMemoryUri(
  scopeUri: Uri,
  schema: MemoryTypeSchema,
  values: Readonly<Record<string, unknown>>,
): Uri {
  const placeholders: Record<string, string> = {};
  for (const name of filenamePlaceholders(schema.filename)) {
    const value = values[name];
    if (typeof value !== 'string') {
      throw invalidArgument(`记忆类型 ${schema.type} 的 identity 字段 ${name} 必须是字符串。`, {
        memoryType: schema.type,
        field: name,
      });
    }
    placeholders[name] = value;
  }
  return scopeUri.child(...renderPath(schema, placeholders).split('/'));
}

/**
 * identity 校验的实现定义在 `domain/memory-type.ts`（合并的计划阶段与这里的锁内
 * 校验共用同一份）。转出是为了不改抽取步骤既有的 import 路径。
 */
export { assertMemoryIdentity };

