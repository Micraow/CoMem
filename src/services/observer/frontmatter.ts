/**
 * 记忆文件 frontmatter 的字段解析（`memory_type` / `status` / `valid_from` / `valid_until`）。
 *
 * 导出给 `services/reconcile.ts`：对账重放从磁盘重建索引行时也必须带 `valid_*`，
 * 否则一次重放会把已失效的历史版本写成「无界」（NULL）——历史版本重新变成有效。
 * 重放不能再写第四份解析器：同一份文件在写路径、`read`、`reindex` 与重放之间必须
 * 给出同一组有效期。
 *
 * `ContentStore.readText` 只把摘要三列映射成 `DocumentFrontmatter`，`memory_type` /
 * `status` 读不出来。而 `services/` 只能 `import type` 引用适配层（§4.2），值导入
 * `parseDocument` 会越界，所以这里按记忆文件的格式（`key: scalar` 一行一个）维护
 * 一份最小解析——与 `services/memory.ts` 的 `parseFrontmatterLines` 同一取舍。
 */

import { parseStatusField, type StatusField } from '../../domain/node.js';
import { parseValidityInstant } from '../../domain/retrieval.js';

/** frontmatter 分隔符与 BOM，与 `adapters/fs/frontmatter.ts` 同一套字面量。 */
const FRONTMATTER_DELIMITER = '---';
const BYTE_ORDER_MARK = '\uFEFF';

/** 记忆文件的 frontmatter 键（§6.6、`services/memory.ts` 的序列化格式）。 */
const MEMORY_TYPE_KEY = 'memory_type';
const STATUS_KEY = 'status';
/** 有效区间（W98）：只读，交给 `node.valid_from` / `node.valid_until`。 */
const VALID_FROM_KEY = 'valid_from';
const VALID_UNTIL_KEY = 'valid_until';

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

/**
 * 手改的数值标量（`valid_from: 123`）不是时间串。
 *
 * 与 `services/memory.ts` 的 `PLAIN_NUMBER` 同一形态：那边把普通标量解析成
 * number / boolean，这边只有原始字符串，必须自己认出「这一行不是字符串」。不认的
 * 话 `valid_from: 2026` 在这里是字符串 `"2026"`、在 `memory.ts` 是数字 2026（读作
 * 无界）、在 `reindex` 是 YAML 整数 2026（同样无界）——同一份文件出现两个有效期，
 * 而 `reindex` 会把整列覆盖成后者。三处的一致由
 * `tests/integration/services/frontmatter-validity-consistency.test.ts` 对拍。
 */
const PLAIN_NUMBER = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/;

/** frontmatter 的原始标量 → 有效区间。带引号的数字是字符串，不加引号的不是。 */
function parseValidityField(raw: string | undefined): string | null {
  if (raw === undefined) {
    return null;
  }
  if (!raw.startsWith('"') && PLAIN_NUMBER.test(raw)) {
    return null;
  }
  return parseValidityInstant(unquoteScalar(raw));
}

/** 去掉成对的双引号（`services/memory.ts` 只在需要时加双引号 + JSON 转义）。 */
function unquoteScalar(value: string): string {
  if (value.length < 2 || !value.startsWith('"') || !value.endsWith('"')) {
    return value;
  }
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === 'string' ? parsed : value;
  } catch {
    return value;
  }
}

/**
 * 从原始文件内容里取记忆文件的 frontmatter 字段。
 *
 * 只取四个键（`memory_type` / `status` / `valid_from` / `valid_until`），不追求完整
 * YAML：记忆文件由服务写入，块标量、锚点、多文档都不在支持范围内。解析不出来时
 * 返回 `null`，由调用方决定兜底。
 */
export function parseFrontmatterFields(raw: string): FrontmatterFields {
  const text = raw.startsWith(BYTE_ORDER_MARK) ? raw.slice(BYTE_ORDER_MARK.length) : raw;
  const firstLineBreak = text.indexOf('\n');
  const firstLine = (firstLineBreak < 0 ? text : text.slice(0, firstLineBreak)).replace(/\r$/, '');
  if (firstLine !== FRONTMATTER_DELIMITER || firstLineBreak < 0) {
    return EMPTY_FRONTMATTER_FIELDS;
  }

  const lines = text.slice(firstLineBreak + 1).split('\n');
  const closingIndex = lines.findIndex(
    (line) => line.replace(/\r$/, '') === FRONTMATTER_DELIMITER,
  );
  if (closingIndex < 0) {
    return EMPTY_FRONTMATTER_FIELDS;
  }

  // 存**原始标量**而不是去引号后的值：有效期要区分「`"123"`（字符串）」
  // 与「`123`（数字）」，去引号之后就分不出来了。
  const fields = new Map<string, string>();
  for (const line of lines.slice(0, closingIndex)) {
    const separator = line.indexOf(':');
    if (separator <= 0) {
      continue;
    }
    fields.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
  }

  const scalar = (key: string): string | undefined => {
    const raw = fields.get(key);
    return raw === undefined ? undefined : unquoteScalar(raw);
  };

  const memoryType = scalar(MEMORY_TYPE_KEY);
  return {
    memoryType: memoryType === undefined || memoryType === '' ? null : memoryType,
    // `undefined` 是缺键；空值（`status:`）在这里是 `''`，与另外两个解析器的
    // `[]` / `null` 一样落在 `invalid`——键存在却没有可用的值。
    status: parseStatusField(scalar(STATUS_KEY)),
    validFrom: parseValidityField(fields.get(VALID_FROM_KEY)),
    validUntil: parseValidityField(fields.get(VALID_UNTIL_KEY)),
  };
}
