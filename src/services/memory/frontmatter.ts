/**
 * 记忆文件 frontmatter 的解析（架构文档 §6.6、§11.1）。
 *
 * 这是「记忆文件的文本 → 原始记录」的**唯一实现**：`memory/document.ts` 的
 * `parseMemoryDocument`、`observer/frontmatter.ts` 的 `parseFrontmatterFields` 与
 * `commands/reindex/records.ts` 的记录构造都从这里取记录与字段。三处以前各写一份
 * 「按行切 `---` + 认标量」，同一份文件在 `read` / 索引 / 重建之间能给出不同的
 * `status`——复核闸门（§11.6）就看不出「文件里写的是 pending」。
 *
 * ## 为什么不是 `adapters/fs/frontmatter.ts`
 *
 * 那一份是**通用** YAML frontmatter 编解码（`.abstract.md` 的 `summary` 等），
 * `services/` 只能 `import type` 引用适配层（§4.2），值导入会越界。记忆文件的字段
 * 只有 string / number / boolean / string[] 四种（`domain/memory-type.ts` 的
 * `FieldType`），不需要锚点、块标量、多文档，所以这里维护只覆盖记忆格式的子集。
 * 分工：适配层解析非记忆文件，本模块解析记忆文件；同一条记忆字段的判定
 * （`parseStatusField` / `parseValidityInstant`）由 `domain/` 提供，只有一份。
 *
 * ## 为什么返回原始记录而不是领域对象
 *
 * 三个消费方要的字段不同：`MemoryDocument` 要全部保留键，观察者只要四个，
 * `reindex` 还要 `summary` 与正文。底层只负责「文本 → 原始记录」，字段投影各自做。
 * 把三种投影塞进一个带 `if` 的函数，会让「观察者少读一个键」变成「另一个消费方
 * 也读不到」。
 */

import { parseStatusField, type StatusField } from '../../domain/node.js';
import { parseValidityInstant } from '../../domain/retrieval.js';
import { parseFrontmatterLines } from './yaml.js';

/** 记忆文件的 frontmatter 分隔符。 */
const FRONTMATTER_DELIMITER = '---';

/** UTF-8 BOM：编辑器写在文件开头，不属于 frontmatter 也不属于正文。 */
const BYTE_ORDER_MARK = '\uFEFF';

/** 行结束符。先归一化成 `\n`，再交给按行解析的子集解析器。 */
const LINE_BREAK = '\n';
const CARRIAGE_RETURN_LINE_BREAK = '\r\n';

/** 记忆文件的 frontmatter 键（§6.6、`serializeMemoryDocument` 的序列化格式）。 */
const MEMORY_TYPE_KEY = 'memory_type';
const STATUS_KEY = 'status';
/** 有效区间（W98）：只读，交给 `node.valid_from` / `node.valid_until`。 */
const VALID_FROM_KEY = 'valid_from';
const VALID_UNTIL_KEY = 'valid_until';

/** 观察者与 `reindex` 要的最小字段集。 */
export interface FrontmatterFields {
  readonly memoryType: string | null;
  /** `status` 的三档结果：缺键 / 合法 / 键存在但非法（见 `domain/node.ts`）。 */
  readonly status: StatusField;
  /** 有效区间的起点（`valid_from`），UTC 形态；缺键/不可解析时是 `null` = 无界。 */
  readonly validFrom: string | null;
  /** 有效区间的终点（`valid_until`）；`null` = 仍然有效。 */
  readonly validUntil: string | null;
}

/** 没有 frontmatter、或不是记忆文件时的空结果。 */
export const EMPTY_FRONTMATTER_FIELDS: FrontmatterFields = {
  memoryType: null,
  status: { kind: 'absent' },
  validFrom: null,
  validUntil: null,
};

/** 文本拆成「frontmatter 原始记录 + 正文」。 */
export interface SplitFrontmatter {
  /** 是否真的存在 frontmatter 块（第一行是 `---` 且有闭合）。 */
  readonly hasFrontmatter: boolean;
  /** 解析出的键值；没有 frontmatter 时是空对象。 */
  readonly data: Readonly<Record<string, unknown>>;
  /** 正文，不含 frontmatter 块与分隔符。 */
  readonly body: string;
}

/**
 * 去掉闭合 `---` 之后的那个空行。
 *
 * 写盘时固定写一个空行再进正文；这里对称地只吃掉一个。手写文件不写空行也能读，
 * 正文本身以 `\n` 开头也不会被多吃。
 */
function stripSeparatorBlankLine(afterDelimiter: string): string {
  return afterDelimiter.startsWith(LINE_BREAK) ? afterDelimiter.slice(LINE_BREAK.length) : afterDelimiter;
}

/**
 * 拆出正文与 frontmatter 原始记录。
 *
 * 只认**第一行**的 `---`：正文中间的 `---` 是 Markdown 水平线。找不到闭合时按
 * 「没有 frontmatter」处理，整段都是正文——半截 frontmatter 没有可解释的语义。
 *
 * BOM 会被剥掉；`\r\n` 归一化成 `\n` 再解析。记忆文件由本服务写出（固定 `\n`），
 * 归一化只影响手改过的 Windows 文件，而不归一化会让同一份文件在 `read`（按 `\n`
 * 切行，第一行是 `---\r`）与索引（剥 `\r`）之间一个读得出、一个读不出。
 */
export function splitFrontmatter(raw: string): SplitFrontmatter {
  const withoutBom = raw.startsWith(BYTE_ORDER_MARK) ? raw.slice(BYTE_ORDER_MARK.length) : raw;
  const text = withoutBom.replaceAll(CARRIAGE_RETURN_LINE_BREAK, LINE_BREAK);

  const firstLineBreak = text.indexOf(LINE_BREAK);
  const firstLine = firstLineBreak < 0 ? text : text.slice(0, firstLineBreak);
  if (firstLine !== FRONTMATTER_DELIMITER || firstLineBreak < 0) {
    return { hasFrontmatter: false, data: {}, body: text };
  }

  const lines = text.slice(firstLineBreak + 1).split(LINE_BREAK);
  const closingIndex = lines.indexOf(FRONTMATTER_DELIMITER);
  if (closingIndex < 0) {
    return { hasFrontmatter: false, data: {}, body: text };
  }

  return {
    hasFrontmatter: true,
    data: parseFrontmatterLines(lines.slice(0, closingIndex)),
    body: stripSeparatorBlankLine(lines.slice(closingIndex + 1).join(LINE_BREAK)),
  };
}

/**
 * 原始记录 → 观察者 / `reindex` 的四个字段。
 *
 * 判定口径与 `domain/` 的单点一致：`status` 走 `parseStatusField`（三档），有效期走
 * `parseValidityInstant`（`number` / `boolean` / 解析不了的串都读作无界）。`memory_type`
 * 只收非空字符串：空串与数字都不是「记忆类型」，与「不是记忆文件」同义。
 */
export function frontmatterFieldsOf(data: Readonly<Record<string, unknown>>): FrontmatterFields {
  const memoryType = data[MEMORY_TYPE_KEY];
  return {
    memoryType: typeof memoryType === 'string' && memoryType !== '' ? memoryType : null,
    // YAML 的 `null`（`status:` / `status: null`）与数字、布尔、非法字符串一样
    // 都是「键存在但不可用」，不是缺键——缺键才是 `undefined`。
    status: parseStatusField(data[STATUS_KEY]),
    validFrom: parseValidityInstant(data[VALID_FROM_KEY]),
    validUntil: parseValidityInstant(data[VALID_UNTIL_KEY]),
  };
}

/**
 * 从原始文件内容里取记忆文件的四个字段；没有 frontmatter 时返回空结果。
 *
 * 观察者的 `parseFrontmatterFields` 与 `reindex` 的记录构造都走这里，不再各自
 * 按行切分隔符。
 */
export function parseFrontmatterFields(raw: string): FrontmatterFields {
  const document = splitFrontmatter(raw);
  return document.hasFrontmatter ? frontmatterFieldsOf(document.data) : EMPTY_FRONTMATTER_FIELDS;
}

/**
 * frontmatter 的 `sources` → 字符串数组。
 *
 * 缺键、写成标量、块里混进非字符串项都读作「没有可信的溯源」：一个解析不出来的
 * URI 写进输出没有用，而抛错会让整个记忆读不出来（溯源是辅助信息，不是正文的
 * 前置条件）。
 */
export function parseSources(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === 'string' && item !== '');
}

/**
 * frontmatter 的 `supersedes` → 版本文件 URI。
 *
 * 不可信输入（手改文件）按「没有指向」处理：非字符串、空串都读作 `null`。解析不
 * 出合法 URI 的值留到 `reject` 里判断——那时才需要决定「删掉」还是「恢复」，
 * 在这里抛错会让整条记忆读不出来。
 */
export function parseSupersedes(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}
