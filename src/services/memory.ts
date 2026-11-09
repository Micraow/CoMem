/**
 * 记忆读写与复核（架构文档 §6.6、§11.1、§11.3、§11.6）。
 *
 * 一条记忆是 `memories/` 下的一个 Markdown 文件：YAML frontmatter 存
 * `memory_type` / `status` / 时间戳 / 各字段，正文存 `content` 字段（§6.6 的示例）。
 * `content` 之外的字段都是短值，放 frontmatter 才能被索引与检索解析；`content` 可能
 * 很长，放正文才不会把 frontmatter 撑成第二份原文。
 *
 * ## 为什么 frontmatter 的编解码写在这里
 *
 * `adapters/fs/frontmatter.ts` 是通用的 YAML frontmatter 编解码，但 `services/`
 * 只允许 `import type` 引用适配层（§4.2 的 type-only 例外）。`MemoryService` 需要
 * **值**（序列化 / 解析），不能值导入适配器，所以这里维护一份只覆盖记忆文件格式的
 * 最小实现。重复的代价是两份 YAML 子集：记忆文件的字段只有 string / number /
 * boolean / string[] 四种（`domain/memory-type.ts` 的 `FieldType`），不需要完整的
 * YAML 解析器，也不需要锚点、标签、多文档这些能力。
 *
 * 读写必须**往返稳定**：`read` 出来的 `fields` 再 `upsertMemory` 写回去，文件正文
 * 逐字节相同。否则摘要 digest 对不上，每次写都会触发一次假失效（§9.3）。
 *
 * ## 溯源（W97）
 *
 * frontmatter 的 `sources` 记「这条记忆由哪几次归档产生」，值是归档 URI，由服务端
 * 在写入点确定（`MemoryUpdateInput.provenance`），**不由模型输出**。它进
 * `RESERVED_KEYS`：不在 schema 字段里的键会在下一次重写时被 `serializeMemoryDocument`
 * 丢掉，而 `upsertMemory` / `approve` 都是整份重写。旧文件没有这个键 → 读作空数组，
 * 且不写这个键（输出与改动前一致）。
 *
 * ## 端口为什么是「原样文档」
 *
 * `filesystem.read` 的 `text` 必须是**磁盘上的原始内容**（含 frontmatter），
 * `filesystem.write` 收到的也必须是原始内容。`FileSystemService` 的 `read` 返回的是
 * 去掉 frontmatter 的正文、`write` 又会用适配层自己的 frontmatter 机制重新序列化，
 * 两者都不能直接接进来——见 `MemoryServicePorts.read` 的说明与本 wave 的报告。
 *
 * ## 复核闸门（§11.6）
 *
 * `experiences` / `rules` 写入时 `status = 'pending'`，检索侧按 `status = 'active'`
 * 过滤，所以它们在被 `approve` 之前**不进检索结果**。其余类型直接 `active`。
 * 更新一条已复核的记录会把它重新打回 `pending`：正文变了就该重新看一遍。
 *
 * ## 并发：一条记忆一个 `exact` 锁（§18「并发控制」）
 *
 * 记忆写入是**读-改-写**：`#readDocument` 拿 `createdAt` / `created` / `addOnly`
 * 判据，再整份覆盖。读在锁外时，两个写者各读一份旧正文、各写一份新的，后写者会
 * 把先写者的字段整段抹掉（并发合并同一个 `preferences` URI 就是这样丢字段的）。
 *
 * 所以锁归本服务：`upsertMemory` / `approve` / `reject` / `remove` 都在
 * `exact(uri)` 里完成「读 → 序列化 → 写」。粒度是**单文件**，不是 `memories/`
 * 子树——`tree` 会把同目录下无关的写入全部挡住。
 *
 * **`upsertMemory` 是字段级合并，不是整份替换。** 传进来的字段覆盖同名字段，
 * 没传的字段保留磁盘上的值。这一条是丢字段缺陷的另一半：调用方的读在锁外，
 * "读 → 改 → 写" 里的"改"只对自己动过的字段负责，保留其它字段才让两个并发写者
 * 的结果可以合并。整份替换时后写者会用它那份陈旧的字段值盖掉先写者的新值。
 *
 * **字段级合并只保护「不同字段」。** `profile` 只有一个 `content` 字段，两个并发
 * 写者各带一份基于旧正文算出的 `content` 时仍然是后写者赢。所以补丁形态的写入
 * 走 `{ uri, update }`：`update` 在锁内拿到磁盘上的最新字段，SEARCH/REPLACE 在
 * 最新正文上应用（`memory_merge` 用它，§18）。
 *
 * 锁**不可重入**（`adapters/fs/lock.ts` 是文件锁，同一进程内按锁路径排队）：任何
 * 调用方都不能在持有 `exact(uri)` 的同时再调这里的方法，否则等 5 秒后拿 `CONFLICT`。
 */

import type { PathLockManager } from '../adapters/fs/lock.js';
import { ComemError } from '../domain/errors.js';
import type { Logger } from '../domain/log.js';
import {
  assertFieldTypes,
  assertMemoryIdentity,
  renderPath,
  type MemoryTypeSchema,
} from '../domain/memory-type.js';
import { getMemoryType, profileMemoryType } from '../domain/memory-types/index.js';
import { validateProfileBody } from '../domain/profile-format.js';
import { ABSTRACT_MAX_CHARS, truncateToChars } from '../domain/summary.js';
import { Uri } from '../domain/uri.js';

export type MemoryStatus = 'active' | 'pending' | 'archived';

export interface MemoryRecord {
  readonly uri: Uri;
  readonly memoryType: string;
  /** 字段 → 值。identity 字段必填 */
  readonly fields: Readonly<Record<string, unknown>>;
  readonly status: MemoryStatus;
  readonly updatedAt: string;
  /**
   * 这条记忆由哪几次归档产生（frontmatter 的保留键 `sources`），最旧在前。
   *
   * 由服务端在写入点确定（`provenance` 入参），**不由模型输出**：抽取模型没有可
   * 引用的材料 URI，让它给只能得到幻觉。旧文件缺这个键时读作空数组。
   */
  readonly sources: readonly string[];
}

export interface MemoryWriteResult {
  readonly uri: Uri;
  readonly memoryType: string;
  readonly created: boolean;
  /**
   * 是否真的落了盘。转换函数返回 `null`（没有可写的字段）时为 `false`，此时
   * `before` 与 `after` 相同、`created` 为 `false`。
   */
  readonly written: boolean;
  /** 应用前的正文，用于 `memory_diff.json` 的 `before` */
  readonly before: string | null;
  readonly after: string;
}

/** 记忆的字段集（字段名 → 值）。 */
export type MemoryFields = Readonly<Record<string, unknown>>;

/**
 * 在 `exact(uri)` 锁内执行的字段计算：拿到磁盘上的**最新**字段，返回要写的字段。
 *
 * 返回 `null` 表示「没有可写的字段」（例如补丁一条都没命中）：不落盘。覆盖写会
 * 白白推后 `updated_at`，还会把已复核的记忆打回 `pending`。
 */
export type MemoryUpdate = (current: MemoryFields) => MemoryFields | null;

/**
 * 需要读盘才能算出的写入。`update` 的输入是磁盘上的最新字段，返回值按字段级合并
 * 写回（没返回的字段保留磁盘上的值）。
 *
 * **为什么不只是 `(current) => values` 一个函数。** `upsertMemory` 的锁键是记忆
 * 文件的 URI，而 URI 由 identity 字段渲染（`renderMemoryUri`）。转换函数的输入依赖
 * 磁盘内容，渲染只能发生在读之后，而读必须在锁内——两者互相依赖。所以 URI 由调用方
 * 给出（它本来就有：补丁是按 URI 分组的），写盘前再用 identity 字段重渲染一次并
 * 比对，补丁改掉 identity 时直接拒绝，不做隐式 move。
 */
export interface MemoryUpdateInput {
  readonly uri: Uri;
  readonly update: MemoryUpdate;
  /**
   * 本次写入追加到 `sources` 的溯源（`Uri` 是产生这条记忆的归档，`archive_NNN`）。
   *
   * 缺省 = 不改 `sources`（保留磁盘上的值）。值与写入点绑定：写入方知道自己在为哪次
   * 归档写记忆，模型看不到原始材料 URI，让它输出只会得到幻觉。所以它不从抽取提示词
   * 里来，也不进 `MemoryFields`。
   *
   * 只放在「先读后写」这一形态上：直接传字段的调用方（`remember`、`consolidation`
   * 的写回）不掌握归档 URI，它们应当一个字段都不丢地保留旧值。
   */
  readonly provenance?: { readonly sources: readonly Uri[] };
}

/**
 * 写入内容。两种形态共用同一条实现：锁、字段级合并、`addOnly` 判据、复核闸门
 * （`status = pending`）都只写一遍。
 *
 * - 直接传字段：调用方已经知道自己要写什么。
 * - `{ uri, update }`：字段依赖磁盘上的最新正文（SEARCH/REPLACE 补丁）。
 */
export type MemoryWrite = MemoryFields | MemoryUpdateInput;

function isMemoryUpdateInput(input: MemoryWrite): input is MemoryUpdateInput {
  // 记忆字段的值只有 string / number / boolean / string[]（`FieldType`），
  // 只有转换形态的 `update` 是函数。
  return typeof (input as MemoryUpdateInput).update === 'function';
}

/**
 * 记忆服务的端口。
 *
 * `filesystem.read` / `filesystem.write` 的文本是**整份文档**（frontmatter + 正文），
 * 不是 `FileSystemService` 那种去掉 frontmatter 的正文：记忆的元数据必须能原样读回，
 * 否则 `fields` 只能靠猜。
 *
 * `remove` / `list` 不在最初的端口草图里，是「拒绝即删除」（§11.6）与「待复核列表」
 * 两个用例的必需能力。`FileSystemService` 结构上同时满足这四个方法。
 */
export interface MemoryServicePorts {
  /**
   * 记忆文件的路径锁（§18「并发控制」）。
   *
   * 记忆写入的「读 → 序列化 → 写」必须被同一把 `exact` 锁覆盖，而这把锁不能由
   * 调用方代持：`memory_merge` 步骤、记忆合并、HTTP 复核三条路径都会写同一个 URI，
   * 让每个调用方自己加锁等于把「忘记加锁」变成静默丢字段。
   */
  readonly locks: Pick<PathLockManager, 'withLock'>;
  /**
   * 需要复核（写入时 `status = 'pending'`）的记忆类型。
   *
   * 缺省时用 `DEFAULT_REVIEW_REQUIRED`。生产装配必须传 `config.memory.reviewRequired`——
   * 不传就是「配置项存在但不生效」。
   */
  readonly reviewRequired?: readonly string[];
  readonly filesystem: {
    /** 原样返回文件内容（含 frontmatter）。文件不存在时抛 `NOT_FOUND`。 */
    read(uri: Uri): Promise<{ readonly text: string }>;
    write(uri: Uri, text: string, options?: unknown): Promise<unknown>;
    /** 不存在返回 `null`；目录返回非 `null`（`read` 会以 `INVALID_ARGUMENT` 拒绝）。 */
    stat(uri: Uri): Promise<unknown>;
    /** `rm -f` 语义：不存在不是错误。 */
    remove(uri: Uri): Promise<unknown>;
    /** 直接子项，带 `kind` 供 `listPending` 递归。 */
    list(uri: Uri): Promise<readonly { readonly uri: Uri; readonly kind: 'file' | 'directory' }[]>;
  };
  /**
   * 检索端口（§11.3 的预取）。
   *
   * `options` 是 `unknown`：`SearchService.find` 的 `FindOptions` 要求调用方身份与
   * 展开后的 principals，而预取跑在后台任务里没有请求身份。装配方负责把它绑成
   * 「某个 scope 下已授权的检索」。
   */
  readonly search: {
    find(
      query: string,
      options: unknown,
    ): Promise<
      readonly { readonly uri: string; readonly abstract: string | null; readonly score: number }[]
    >;
  };
  readonly logger: Logger;
}

/** `content` 之外还有一个 camelCase vs snake_case 的映射：frontmatter 用 `updated_at`。 */
const CONTENT_FIELD = 'content';
const UPDATED_AT_FIELD = 'updatedAt';

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
 */
const SOURCES_KEY = 'sources';

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
]);

/** 走复核闸门的记忆类型（§11.6）。 */
/**
 * 默认需要复核的记忆类型（§11.6）。
 *
 * **可以被 `memory.reviewRequired` 覆盖。** 曾经把它写死在这里，配置项存在但不生效——
 * 运维把 `rules` 从复核列表里去掉，写入仍然是 `pending`，然后控制台显示「待复核 1 条」
 * 而没有任何地方能解释它从哪来。
 *
 * 这份常量只是配置的默认值，不要直接用它判断。
 */
const DEFAULT_REVIEW_REQUIRED: readonly string[] = ['experiences', 'rules'];

/** scope 下放记忆的目录（§6.5）。 */
const MEMORIES_DIRECTORY = 'memories';

/**
 * 预取的最小条数。
 *
 * 来源：架构文档 §11.3 的 `limit = max(5, prefetchTopN)`。5 是「够模型判断
 * 『这是新增还是更新』」的经验下界，没有实测数据。
 */
const PREFETCH_MIN_LIMIT = 5;

const FRONTMATTER_DELIMITER = '---';
const SEQUENCE_ITEM_PREFIX = '  - ';
const CONTENT_HEADING = '## content';

/** 文件名里的 identity 占位符，如 `{topic}`。与 `domain/memory-type.ts` 同一形状。 */
const PLACEHOLDER_PATTERN = /\{([A-Za-z][A-Za-z0-9_]*)\}/g;

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

interface MemoryDocument {
  readonly memoryType: string;
  readonly status: MemoryStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly fields: Readonly<Record<string, unknown>>;
  /** 溯源（保留键 `sources`），最旧在前；缺键时为空数组。 */
  readonly sources: readonly string[];
  /** 正文（`## content` 及之后），与 `memory_diff.json` 的 before / after 同一形态 */
  readonly body: string;
}

function invalidArgument(message: string, details: Record<string, unknown>): ComemError {
  return new ComemError('INVALID_ARGUMENT', message, details);
}

function filenamePlaceholders(filename: string): string[] {
  return [...filename.matchAll(PLACEHOLDER_PATTERN)].map((match) => match[1] ?? '');
}

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
function formatScalar(value: unknown): string {
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
function formatField(name: string, value: unknown): string {
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
function parseFrontmatterLines(lines: readonly string[]): Record<string, unknown> {
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

function renderBody(content: unknown): string {
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

function parseStatus(value: unknown): MemoryStatus {
  return value === 'pending' || value === 'archived' ? value : 'active';
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

function serializeMemoryDocument(input: {
  readonly uri: Uri;
  readonly memoryType: string;
  readonly status: MemoryStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly schema: MemoryTypeSchema;
  readonly fields: Readonly<Record<string, unknown>>;
  /** 空数组不写这个键：没有溯源的文件与 W97 之前的文件逐字节相同。 */
  readonly sources: readonly string[];
}): string {
  const header = [
    FRONTMATTER_DELIMITER,
    `${MEMORY_TYPE_KEY}: ${formatScalar(input.memoryType)}`,
    `${STATUS_KEY}: ${formatScalar(input.status)}`,
    `${CREATED_AT_KEY}: ${formatScalar(input.createdAt)}`,
    `${UPDATED_AT_KEY}: ${formatScalar(input.updatedAt)}`,
    `${URI_KEY}: ${formatScalar(input.uri.toString())}`,
  ];

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
function parseMemoryDocument(text: string): MemoryDocument | null {
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

export class MemoryService {
  readonly #filesystem: MemoryServicePorts['filesystem'];
  readonly #locks: MemoryServicePorts['locks'];
  readonly #search: MemoryServicePorts['search'];
  readonly #logger: Logger;
  /** 需要复核的记忆类型。来自 `memory.reviewRequired`，不是写死的。 */
  readonly #reviewRequired: ReadonlySet<string>;

  constructor(ports: MemoryServicePorts) {
    this.#filesystem = ports.filesystem;
    this.#locks = ports.locks;
    this.#search = ports.search;
    this.#logger = ports.logger;
    this.#reviewRequired = new Set(ports.reviewRequired ?? DEFAULT_REVIEW_REQUIRED);
  }

  /** 读一条记忆；不存在返回 `null`。 */
  async read(uri: Uri): Promise<MemoryRecord | null> {
    const document = await this.#readDocument(uri);
    if (document === null) {
      return null;
    }
    return {
      uri,
      memoryType: document.memoryType,
      fields: document.fields,
      status: document.status,
      updatedAt: document.updatedAt,
      sources: document.sources,
    };
  }

  /**
   * 按记忆类型渲染路径并写。**字段级合并**：返回的字段覆盖磁盘上的同名字段，
   * 没返回的字段保留（见文件头「并发」）。
   *
   * `addOnly` 类型（`events`）在文件已存在时抛 `ALREADY_EXISTS`：事件是「某时发生了
   * 什么」，发生之后不会改变，覆盖写等于篡改历史（§11.1）。
   */
  async upsertMemory(
    scopeUri: Uri,
    schema: MemoryTypeSchema,
    input: MemoryWrite,
  ): Promise<MemoryWriteResult> {
    let target: MemoryUpdateInput;
    if (isMemoryUpdateInput(input)) {
      target = input;
    } else {
      // 直接传值：先校验 identity，`renderMemoryUri` 对缺失或非字符串的 identity
      // 只会说「必须是字符串」，定位不到「哪个字段不能为空」。
      assertMemoryIdentity(schema, input);
      target = {
        uri: renderMemoryUri(scopeUri, schema, input),
        // 直接传值时字段是静态的；合并仍然发生在锁内。
        update: () => input,
      };
    }

    // 锁覆盖整个读改写：`existing` 决定 `createdAt` / `created` / `addOnly` 判据，
    // 读在锁外时两个写者会各自基于同一份旧正文构造新正文（§18）。
    return this.#locks.withLock(
      target.uri,
      'exact',
      async () => {
        const existing = await this.#readDocument(target.uri);
        const current = existing?.fields ?? {};
        // 补丁必须打在磁盘上的最新正文上：`current` 是锁内的读，不是调用方的快照。
        const next = target.update(current);
        if (next === null) {
          // 没有可写的字段：落盘只会改 `updated_at` 并把 `status` 打回 `pending`。
          return {
            uri: target.uri,
            memoryType: schema.type,
            created: false,
            written: false,
            before: existing?.body ?? null,
            after: existing?.body ?? '',
          };
        }

        // 合并而不是替换：转换函数只对自己返回的字段负责。
        const merged: Record<string, unknown> = { ...current, ...next };
        assertMemoryIdentity(schema, merged);
        assertFieldTypes(schema, merged);
        // 补丁改掉了 identity 字段（如 `name`）时，渲染出的路径与锁键不是同一个
        // 文件：写成功也只会多出一条重复记忆，目标文件里只剩半个结果。
        if (!renderMemoryUri(scopeUri, schema, merged).equals(target.uri)) {
          throw invalidArgument(
            `记忆 ${target.uri.toString()} 的 identity 字段被改写，写回会落到另一个文件。`,
            { uri: target.uri.toString(), memoryType: schema.type },
          );
        }
        if (existing !== null && schema.operationMode === 'addOnly') {
          throw new ComemError(
            'ALREADY_EXISTS',
            `记忆 ${target.uri.toString()} 已存在，${schema.type} 类型只允许新增。`,
            {
              uri: target.uri.toString(),
              memoryType: schema.type,
              // 供调用方区分「同一条事件重放」与「同 URI 的另一条事件」。两个值都
              // 在锁内读到，比较的是同一时刻的内容。
              existingContent: existing.fields[CONTENT_FIELD] ?? null,
              nextContent: merged[CONTENT_FIELD] ?? null,
            },
          );
        }

        const now = new Date().toISOString();
        const fields: Record<string, unknown> = { ...merged };
        if (schema.fields.some((field) => field.name === UPDATED_AT_FIELD)) {
          fields[UPDATED_AT_FIELD] = now;
        }
        const status: MemoryStatus = this.#reviewRequired.has(schema.type) ? 'pending' : 'active';
        // 溯源只在**真的写盘**时追加：合并循环里所有字段操作都失败时（`next === null`）
        // 这条记忆没有因为这次归档改变，给它记上一笔归档来源是错的。
        const sources = appendSources(
          existing?.sources ?? [],
          (target.provenance?.sources ?? []).map((source) => source.toString()),
        );

        const text = serializeMemoryDocument({
          uri: target.uri,
          memoryType: schema.type,
          status,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
          schema,
          fields,
          sources,
        });
        await this.#filesystem.write(target.uri, text);

        this.#logger.info('记忆已写入', {
          uri: target.uri.toString(),
          memoryType: schema.type,
          status,
          created: existing === null,
        });

        // 画像的格式契约（§11.1）能由字面判定的部分在这里执行。**只告警，不拒绝**：
        // 拒绝或丢弃等于把模型抽到的事实直接扔掉，而且用户永远不知道。日志带
        // scope / URI / 违规类型与条数，**不带正文**——画像可能含个人信息。
        if (schema.type === profileMemoryType.type) {
          this.#warnProfileFormat(scopeUri, target.uri, fields[CONTENT_FIELD]);
        }

        return {
          uri: target.uri,
          memoryType: schema.type,
          created: existing === null,
          written: true,
          before: existing?.body ?? null,
          after: renderBody(fields[CONTENT_FIELD]),
        };
      },
      // 新记忆的父目录可能还不存在，此时锁文件也没有地方放——不建目录的话，
      // 两个并发写者会同时通过（见 `LockAcquireOptions.createParentDirectory`）。
      { createParentDirectory: true },
    );
  }

  /** 复核通过：`pending` → `active`（§11.6）。已经是 `active` 时是空操作。 */
  async approve(uri: Uri): Promise<void> {
    await this.#locks.withLock(uri, 'exact', async () => {
      const document = await this.#readDocument(uri);
      if (document === null) {
        throw new ComemError('NOT_FOUND', `记忆不存在：${uri.toString()}`, {
          uri: uri.toString(),
        });
      }
      const schema = getMemoryType(document.memoryType);
      if (schema === undefined) {
        throw invalidArgument(`未知的记忆类型：${document.memoryType}。`, {
          memoryType: document.memoryType,
        });
      }
      if (document.status === 'active') {
        return;
      }

      const now = new Date().toISOString();
      await this.#filesystem.write(
        uri,
        serializeMemoryDocument({
          uri,
          memoryType: document.memoryType,
          status: 'active',
          createdAt: document.createdAt,
          updatedAt: now,
          schema,
          fields: document.fields,
          // 复核也是**一次完整重写**：不把读到的溯源带过来，approve 会在用户
          // 点下「通过」的那一刻把 `sources` 抹掉。
          sources: document.sources,
        }),
      );
      this.#logger.info('记忆复核通过', {
        uri: uri.toString(),
        memoryType: document.memoryType,
      });
    });
  }

  /** 复核拒绝：删除并记录原因（§11.6）。已经不在了是空操作。 */
  async reject(uri: Uri, reason: string): Promise<void> {
    await this.#locks.withLock(uri, 'exact', async () => {
      const document = await this.#readDocument(uri);
      if (document === null) {
        return;
      }
      await this.#filesystem.remove(uri);
      this.#logger.info('记忆复核拒绝，已删除', {
        uri: uri.toString(),
        memoryType: document.memoryType,
        reason,
      });
    });
  }

  /**
   * 删除一条记忆（§11.5 的 `delete` 操作）。
   *
   * `rm -f` 语义：不存在不是错误。删除与覆盖写不同，它没有「部分成功」的形态，
   * 所以不需要读回来判断。**仍然持 `exact` 锁**：并发的 `upsertMemory` 会在
   * 「读完、还没写」之间被它看见，没有锁时删除与覆盖写的先后无法解释。
   */
  async remove(uri: Uri): Promise<void> {
    await this.#locks.withLock(uri, 'exact', async () => {
      await this.#filesystem.remove(uri);
    });
    this.#logger.info('记忆已删除', { uri: uri.toString() });
  }

  /** 待复核列表：scope 下 `memories/` 里 `status = 'pending'` 的记录。 */
  async listPending(
    scopeUri: Uri,
    options: { readonly limit?: number } = {},
  ): Promise<readonly MemoryRecord[]> {
    const limit = options.limit ?? Number.POSITIVE_INFINITY;
    if (limit <= 0) {
      return [];
    }

    const records: MemoryRecord[] = [];
    const visit = async (directory: Uri): Promise<void> => {
      const entries = await this.#listOrEmpty(directory);
      for (const entry of entries) {
        if (records.length >= limit) {
          return;
        }
        if (entry.kind === 'directory') {
          await visit(entry.uri);
          continue;
        }
        const record = await this.read(entry.uri);
        if (record !== null && record.status === 'pending') {
          records.push(record);
        }
      }
    };

    await visit(scopeUri.child(...MEMORIES_DIRECTORY.split('/')));
    return records;
  }

  /**
   * §11.3 的抽取预取：按 schema 目录做一次检索，返回 top-N。
   *
   * 单文件类型（`profile` / `identity` / `soul`，`filename` 里没有占位符）直接读该
   * 文件：它们的目录里可能有别的记忆，检索会把同目录的其它文件也算成「已读」。
   *
   * 只返回 `active`：`pending` 记录还在复核（§11.6），把它当「已有记忆」喂给抽取
   * 会让模型以为结论已经生效。
   */
  async prefetch(
    scopeUri: Uri,
    schema: MemoryTypeSchema,
    query: string,
    topN: number,
  ): Promise<readonly MemoryRecord[]> {
    const limit = Math.max(PREFETCH_MIN_LIMIT, topN);

    if (!schema.filename.includes('{')) {
      const record = await this.read(renderMemoryUri(scopeUri, schema, {}));
      return record !== null && record.status === 'active' ? [record] : [];
    }

    const directory = scopeUri.child(...schema.directory.split('/')).toString();
    const hits = await this.#search.find(query, { scopes: [directory], limit });

    const records: MemoryRecord[] = [];
    for (const hit of hits) {
      if (records.length >= limit) {
        break;
      }
      const uri = Uri.tryParse(hit.uri);
      if (uri === null) {
        this.#logger.warn('预取命中的 URI 不合法，已跳过', { uri: hit.uri, memoryType: schema.type });
        continue;
      }
      const record = await this.read(uri);
      if (record !== null && record.status === 'active') {
        records.push(record);
      }
    }
    return records;
  }

  /**
   * 画像正文不符合格式契约时记一条 warn（§11.1）。
   *
   * 调用点在写入成功之后：告警描述的是**已经落盘**的内容，写入失败时不该出现
   * 「画像不合规」的记录。
   *
   * 字段口径：`scope` 是画像所属的 scope 根（同一个 scope 只有一份画像），
   * `uri` 是具体文件，`rules` 是去重后的违规类型。正文与摘要都不进日志。
   */
  #warnProfileFormat(scopeUri: Uri, uri: Uri, content: unknown): void {
    const violations = validateProfileBody(typeof content === 'string' ? content : '');
    if (violations.length === 0) {
      return;
    }
    this.#logger.warn('画像正文不符合格式契约，已写入（仅告警）。', {
      scope: scopeUri.toString(),
      uri: uri.toString(),
      memoryType: profileMemoryType.type,
      violationCount: violations.length,
      rules: [...new Set(violations.map((violation) => violation.kind))],
    });
  }

  async #readDocument(uri: Uri): Promise<MemoryDocument | null> {
    if ((await this.#filesystem.stat(uri)) === null) {
      return null;
    }
    const { text } = await this.#filesystem.read(uri);
    const document = parseMemoryDocument(text);
    if (document === null) {
      // 端口语义不对（例如注入了返回正文的 `FileSystemService`）时，这里会一路返回
      // null，看起来像「没有记忆」，抽取会重复新增。留一条 warn 让它可查。
      this.#logger.warn('记忆文件缺少可解析的 frontmatter，按不存在处理', {
        uri: uri.toString(),
      });
    }
    return document;
  }

  async #listOrEmpty(
    directory: Uri,
  ): Promise<readonly { readonly uri: Uri; readonly kind: 'file' | 'directory' }[]> {
    try {
      return await this.#filesystem.list(directory);
    } catch (error) {
      if (error instanceof ComemError && error.code === 'NOT_FOUND') {
        return [];
      }
      throw error;
    }
  }
}
