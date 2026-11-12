/**
 * 记忆类型（架构文档 §11.1）。
 *
 * 用 TypeScript 常量描述，不用 YAML：YAML 会让 `domain/` 需要一个解析器，
 * 而领域层不许碰任何 IO 或第三方运行时依赖（§4.2）。
 *
 * 一个类型决定三件事：记忆写到哪个目录、文件名怎么由 identity 值拼出来、
 * 各字段在合并时用哪种策略（§11.2）。
 */

import { invalidArgument } from './errors.js';
import { isReservedIdentifier } from './identity.js';
import type { MergeStrategy } from './merge-op.js';

export type FieldType = 'string' | 'number' | 'boolean' | 'string[]';

export interface MemoryTypeField {
  readonly name: string;
  readonly type: FieldType;
  /** 唯一标识这条记忆的字段。一个类型有且只有一个 */
  readonly identity?: boolean;
  readonly merge?: MergeStrategy;
  /** 这个字段存什么 */
  readonly description: string;
  readonly required?: boolean;
}

export interface MemoryTypeSchema {
  readonly type: string;
  readonly description: string;
  /** 相对 scope 根，如 `memories/preferences` */
  readonly directory: string;
  /**
   * 文件名模板，可以带多段。如 `{topic}.md`、`{scenario}/{rule}.md`。
   *
   * 模板里的每个占位符都必须是 identity 字段，但 identity 字段不必都出现在模板里
   * （`profile` 的 `name` 只作为记录标识，文件名固定）。
   */
  readonly filename: string;
  readonly operationMode: 'upsert' | 'addOnly';
  readonly fields: readonly MemoryTypeField[];
}

/** 文件名里的占位符，如 `{topic}`。 */
const PLACEHOLDER_PATTERN = /\{([A-Za-z][A-Za-z0-9_]*)\}/g;

/**
 * 控制字符 `\u0000`–`\u001f`（架构文档 §6.2 规则 4：这类字符不能出现在路径段里）。
 */
const CONTROL_CHAR_UPPER_BOUND = 0x20;

function containsControlChar(text: string): boolean {
  return [...text].some((char) => char.charCodeAt(0) < CONTROL_CHAR_UPPER_BOUND);
}

function validateIdentityValue(value: string, fieldName: string): void {
  if (value === '') {
    throw invalidArgument('identity 值不能为空。', { field: fieldName });
  }
  if (value.includes('/') || value.includes('..')) {
    throw invalidArgument('identity 值不能包含斜杠或 ..，否则会拼出目录外的路径。', {
      field: fieldName,
      value,
    });
  }
  if (value.includes('\\') || containsControlChar(value)) {
    throw invalidArgument('identity 值不能包含反斜杠或控制字符。', { field: fieldName, value });
  }
}

/**
 * 取全部 identity 字段；一个都没有时抛 `INVALID_ARGUMENT`。
 *
 * 允许一个类型有多个 identity（`rules` 是「场景 + 规则」两级），因为文件名模板
 * 可以带多段。要求至少有一个：没有 identity 的记忆无法判定「这是同一条还是新的」。
 */
export function identityFields(schema: MemoryTypeSchema): readonly MemoryTypeField[] {
  const identities = schema.fields.filter((field) => field.identity === true);
  if (identities.length === 0) {
    throw invalidArgument(`记忆类型 ${schema.type} 至少要有一个 identity 字段。`, {
      type: schema.type,
    });
  }
  return identities;
}

/**
 * identity 字段全部必填（§11.1：没有 identity 就判定不了「这是同一条还是新的」）。
 *
 * 两个调用方共用这一份：`MemoryService.upsertMemory` 在**锁内**校验（计划与写入
 * 之间文件可能被别的写者改过，这是最后一道保证），`ConsolidationService.#plan` 在
 * **任何写入之前**校验（否则写入循环里的第一次失败会发生在删除已经应用之后）。
 *
 * 导出给抽取步骤：它要在调 `upsertMemory` 之前就知道 identity 是否齐全，缺字段的
 * 操作应当进 `skipped`，而不是让整步在写盘时抛错。
 */
export function assertMemoryIdentity(
  schema: MemoryTypeSchema,
  values: Readonly<Record<string, unknown>>,
): void {
  for (const field of identityFields(schema)) {
    const value = values[field.name];
    if (typeof value !== 'string' || value === '') {
      throw invalidArgument(`记忆类型 ${schema.type} 的 identity 字段 ${field.name} 不能为空。`, {
        memoryType: schema.type,
        field: field.name,
      });
    }
  }
}

/**
 * 字段类型的判据表。
 *
 * 键必须是 `FieldType` 的每个成员、值必须能判断任意输入：加一种字段类型时这里
 * 编译失败。旧写法是 `field.type === 'string[]' ? ... : typeof value === field.type`，
 * 加 `'date'` 之类的成员时那段表达式不会报错——它会把一个合法值判成类型不符。
 */
const FIELD_TYPE_CHECKS: Readonly<Record<FieldType, (value: unknown) => boolean>> = {
  string: (value) => typeof value === 'string',
  number: (value) => typeof value === 'number',
  boolean: (value) => typeof value === 'boolean',
  'string[]': (value) => Array.isArray(value) && value.every((item) => typeof item === 'string'),
};

/**
 * 字段类型必须与 schema 声明一致，否则写进去再读回来是另一种类型。
 *
 * 与 `assertMemoryIdentity` 同一套共用关系：`upsertMemory` 锁内一次、合并的计划阶段
 * 一次。`undefined` 跳过：字段级合并不要求调用方提供全部字段。
 */
export function assertFieldTypes(
  schema: MemoryTypeSchema,
  values: Readonly<Record<string, unknown>>,
): void {
  for (const field of schema.fields) {
    const value = values[field.name];
    if (value === undefined) {
      continue;
    }
    if (!FIELD_TYPE_CHECKS[field.type](value)) {
      throw invalidArgument(`记忆字段 ${field.name} 的类型必须是 ${field.type}。`, {
        memoryType: schema.type,
        field: field.name,
        expected: field.type,
      });
    }
  }
}

/**
 * 把 filename 模板里的 identity 占位符换成实际值，拼成相对 scope 根的路径。
 *
 * `renderPath(preferences, { topic: 'code-style' })` → `memories/preferences/code-style.md`。
 * `renderPath(rules, { scenario: 'license-review', rule: 'must-locate-license' })`
 * → `memories/rules/license-review/must-locate-license.md`。
 *
 * identity 值来自模型输出，属于不可信输入：含 `/` 或 `..` 会把记忆写到目录外，
 * 直接拒绝而不是清洗——清洗会静默改变模型指定的标识。
 *
 * 占位符缺值或多值都报错：缺值会拼出带 `{x}` 的路径，多值说明调用方搞错了类型。
 */
export function renderPath(
  schema: MemoryTypeSchema,
  values: Readonly<Record<string, string>>,
): string {
  const placeholders = [...schema.filename.matchAll(PLACEHOLDER_PATTERN)].map((match) => match[1]);
  const required = new Set(placeholders.filter((name) => name !== undefined));

  for (const name of Object.keys(values)) {
    if (!required.has(name)) {
      throw invalidArgument(`记忆类型 ${schema.type} 没有 ${name} 这个 filename 占位符。`, {
        type: schema.type,
        field: name,
        placeholders: [...required],
      });
    }
  }

  let rendered = schema.filename;
  for (const name of required) {
    const value = values[name];
    if (value === undefined) {
      throw invalidArgument(`记忆类型 ${schema.type} 缺少 ${name} 的值。`, {
        type: schema.type,
        field: name,
      });
    }
    validateIdentityValue(value, name);
    rendered = rendered.split(`{${name}}`).join(value);
  }
  const path = `${schema.directory}/${rendered}`;
  // 保留名按**渲染后的段**判定，不按原始值：`{topic}` 取 `.history` 时落点是
  // `.history.md`（普通记忆），只有当某段整段等于保留名时才真的占住内部地址。
  const reserved = path.split('/').find((segment) => isReservedIdentifier(segment));
  if (reserved !== undefined) {
    throw invalidArgument('记忆路径不能使用系统保留名。', { type: schema.type, segment: reserved });
  }
  return path;
}

/**
 * 记忆记录的正文：取 `content` 字段，非字符串按空串处理。
 *
 * 每个记忆类型的 schema 都有 `content` 这一栏（§11.1），正文渲染时它单独成节
 * （`## content`），其余字段进 frontmatter。
 *
 * 取**字段值**而不是整份文件正文：合并步骤在 `fields.content` 上应用 SEARCH/REPLACE
 * （§11.2 `merge: 'patch'`），模型看到的若是带 frontmatter 的整段文件，SEARCH 永远
 * 匹配不上。抽取、合并、经验归纳三条路径都从这里取正文——三处各写一遍时，一处改了
 * 取法（比如去掉类型判断或换成正文段），另外两处就与合并步骤的输入悄悄分叉。
 */
export function memoryContentOf(fields: Readonly<Record<string, unknown>>): string {
  const content = fields['content'];
  return typeof content === 'string' ? content : '';
}
