/**
 * 记忆类型（架构文档 §11.1）。
 *
 * 用 TypeScript 常量描述，不用 YAML：YAML 会让 `domain/` 需要一个解析器，
 * 而领域层不许碰任何 IO 或第三方运行时依赖（§4.2）。
 *
 * 一个类型决定三件事：记忆写到哪个目录、文件名怎么由 identity 值拼出来、
 * 各字段在合并时用哪种策略（§11.2）。
 */

import { ComemError } from './errors.js';
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

/** 类型名直接进 frontmatter 与配置，只允许小写短横线。 */
const TYPE_PATTERN = /^[a-z][a-z0-9-]*$/;

/** 字段名进 Markdown 的键，必须是合法的标识符形状。 */
const FIELD_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/;

/** 文件名里的占位符，如 `{topic}`。 */
const PLACEHOLDER_PATTERN = /\{([A-Za-z][A-Za-z0-9_]*)\}/g;

/**
 * 控制字符 `\u0000`–`\u001f`（架构文档 §6.2 规则 4：这类字符不能出现在路径段里）。
 */
const CONTROL_CHAR_UPPER_BOUND = 0x20;

function containsControlChar(text: string): boolean {
  return [...text].some((char) => char.charCodeAt(0) < CONTROL_CHAR_UPPER_BOUND);
}

function invalidArgument(message: string, details: Record<string, unknown>): ComemError {
  return new ComemError('INVALID_ARGUMENT', message, details);
}

function validateDirectory(directory: string, type: string): void {
  if (directory === '') {
    throw invalidArgument(`记忆类型 ${type} 的 directory 不能为空。`, { type });
  }
  if (directory.startsWith('/') || directory.endsWith('/')) {
    throw invalidArgument(`记忆类型 ${type} 的 directory 必须是相对路径，且不带末尾斜杠。`, {
      type,
      directory,
    });
  }
  if (directory.includes('\\') || containsControlChar(directory)) {
    throw invalidArgument(`记忆类型 ${type} 的 directory 不能包含反斜杠或控制字符。`, {
      type,
      directory,
    });
  }
  for (const segment of directory.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') {
      throw invalidArgument(`记忆类型 ${type} 的 directory 不能包含空段、. 或 ..。`, {
        type,
        directory,
      });
    }
    if (segment.includes('{') || segment.includes('}')) {
      throw invalidArgument(`记忆类型 ${type} 的 directory 不支持占位符。`, { type, directory });
    }
  }
}

/**
 * 校验文件名模板。
 *
 * 模板可以带多段（`{scenario}/{rule}.md`），但每一段都必须是普通段：不能为空、
 * 不能是 `.` 或 `..`、不能含反斜杠或控制字符。占位符之外的 `{` `}` 视为笔误。
 */
function validateFilename(filename: string, type: string): void {
  if (filename === '') {
    throw invalidArgument(`记忆类型 ${type} 的 filename 不能为空。`, { type });
  }
  if (filename.includes('\\') || containsControlChar(filename)) {
    throw invalidArgument(`记忆类型 ${type} 的 filename 不能包含反斜杠或控制字符。`, {
      type,
      filename,
    });
  }
  for (const segment of filename.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') {
      throw invalidArgument(`记忆类型 ${type} 的 filename 不能包含空段、. 或 ..。`, {
        type,
        filename,
      });
    }
  }
  const literal = filename.replace(PLACEHOLDER_PATTERN, '');
  if (literal.includes('{') || literal.includes('}')) {
    throw invalidArgument(`记忆类型 ${type} 的 filename 存在不完整的占位符。`, {
      type,
      filename,
    });
  }
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

export function fieldByName(schema: MemoryTypeSchema, name: string): MemoryTypeField | undefined {
  return schema.fields.find((field) => field.name === name);
}

/**
 * 校验一个记忆类型定义。合法返回 `undefined`，非法抛 `INVALID_ARGUMENT`。
 *
 * 除了 identity 唯一性与占位符归属，这里还要求 **filename 里的每个占位符都是
 * identity 字段**：`renderPath` 只拿得到 identity 值，普通字段的占位符永远填不上，
 * 校验放行等于把「拼出带 `{x}` 的路径」留到运行时。
 */
export function validateMemoryType(schema: MemoryTypeSchema): void {
  if (!TYPE_PATTERN.test(schema.type)) {
    throw invalidArgument('记忆类型的 type 只能是小写字母、数字与短横线，且以字母开头。', {
      type: schema.type,
    });
  }
  if (schema.description.trim() === '') {
    throw invalidArgument(`记忆类型 ${schema.type} 必须有 description。`, { type: schema.type });
  }
  validateDirectory(schema.directory, schema.type);
  validateFilename(schema.filename, schema.type);

  if (schema.fields.length === 0) {
    throw invalidArgument(`记忆类型 ${schema.type} 至少要有一个字段。`, { type: schema.type });
  }

  const names = new Set<string>();
  for (const field of schema.fields) {
    if (!FIELD_NAME_PATTERN.test(field.name)) {
      throw invalidArgument(`记忆类型 ${schema.type} 的字段名不合法。`, {
        type: schema.type,
        field: field.name,
      });
    }
    if (names.has(field.name)) {
      throw invalidArgument(`记忆类型 ${schema.type} 的字段名重复。`, {
        type: schema.type,
        field: field.name,
      });
    }
    if (field.description.trim() === '') {
      throw invalidArgument(`记忆类型 ${schema.type} 的字段 ${field.name} 必须有 description。`, {
        type: schema.type,
        field: field.name,
      });
    }
    names.add(field.name);
  }

  const identities = new Set(identityFields(schema).map((field) => field.name));
  const placeholders = [...schema.filename.matchAll(PLACEHOLDER_PATTERN)].map((match) => match[1]);
  for (const placeholder of placeholders) {
    if (placeholder === undefined || !names.has(placeholder)) {
      throw invalidArgument(`记忆类型 ${schema.type} 的 filename 占位符不在 fields 里。`, {
        type: schema.type,
        placeholder,
      });
    }
    if (!identities.has(placeholder)) {
      throw invalidArgument(`记忆类型 ${schema.type} 的 filename 只能引用 identity 字段。`, {
        type: schema.type,
        placeholder,
        identities: [...identities],
      });
    }
  }
  const literal = schema.filename.replace(PLACEHOLDER_PATTERN, '');
  if (literal.includes('{') || literal.includes('}')) {
    throw invalidArgument(`记忆类型 ${schema.type} 的 filename 存在不完整的占位符。`, {
      type: schema.type,
      filename: schema.filename,
    });
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
  return `${schema.directory}/${rendered}`;
}
