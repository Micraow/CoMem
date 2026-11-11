/**
 * 配置层的叶子与合并工具（架构文档 §18）。
 *
 * 从 `index.ts` 搬出来：配置加载器要同时处理 `config.yaml`、覆盖文件、环境变量与
 * 默认值四层，合并规则只能有一份实现。`check-config.ts` 也用这里的叶子口径，
 * 否则「脚本认为的叶子」与「加载器认为的叶子」会各写一套。
 */

import { isRecord } from '../domain/guards.js';

export type ConfigRecord = Record<string, unknown>;

export type LeafKind = 'string' | 'number' | 'boolean' | 'array';

export interface LeafPath {
  readonly path: readonly string[];
  readonly kind: LeafKind;
}

function leafKindOf(value: unknown): LeafKind {
  if (Array.isArray(value)) {
    return 'array';
  }
  switch (typeof value) {
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    default:
      return 'string';
  }
}

export function collectLeaves(
  value: Readonly<ConfigRecord>,
  prefix: readonly string[] = [],
): LeafPath[] {
  const leaves: LeafPath[] = [];
  for (const [key, child] of Object.entries(value)) {
    const path = [...prefix, key];
    if (isRecord(child)) {
      leaves.push(...collectLeaves(child, path));
    } else {
      leaves.push({ path, kind: leafKindOf(child) });
    }
  }
  return leaves;
}

/** `retrieval.assembly.maxTokens` → `COMEM_RETRIEVAL_ASSEMBLY_MAX_TOKENS` */
export function envNameFor(path: readonly string[]): string {
  const joined = path.map((segment) =>
    segment.replaceAll(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase(),
  );
  return `COMEM_${joined.join('_')}`;
}

/** 深合并：对象逐字段合并，其余值直接覆盖（不是替换整段）。 */
export function mergeConfig(base: ConfigRecord, override: Readonly<ConfigRecord>): ConfigRecord {
  const result: ConfigRecord = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const current = result[key];
    result[key] =
      isRecord(current) && isRecord(value) ? mergeConfig(current, value) : value;
  }
  return result;
}

export function setPath(
  target: ConfigRecord,
  path: readonly string[],
  value: unknown,
): ConfigRecord {
  const [head, ...rest] = path;
  if (head === undefined) {
    return target;
  }
  if (rest.length === 0) {
    return { ...target, [head]: value };
  }
  const current = target[head];
  return { ...target, [head]: setPath(isRecord(current) ? current : {}, rest, value) };
}

/** 按点分路径取叶子；任一段不存在返回 `undefined`。 */
export function getPath(value: unknown, path: readonly string[]): unknown {
  let current: unknown = value;
  for (const segment of path) {
    if (!isRecord(current) || !Object.hasOwn(current, segment)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

export function hasPath(value: unknown, path: readonly string[]): boolean {
  let current: unknown = value;
  for (const segment of path) {
    if (!isRecord(current) || !Object.hasOwn(current, segment)) {
      return false;
    }
    current = current[segment];
  }
  return true;
}

/** `{'providers.llm.default.baseUrl': 'x'}` → `{providers: {llm: {default: {baseUrl: 'x'}}}}`。 */
export function nestedFromFlat(values: Readonly<ConfigRecord>): ConfigRecord {
  let result: ConfigRecord = {};
  for (const [path, value] of Object.entries(values)) {
    result = setPath(result, path.split('.'), value);
  }
  return result;
}
