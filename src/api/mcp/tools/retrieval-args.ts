/**
 * `find` 与 `search` 共用的检索入参。
 *
 * 两个工具的过滤维度完全相同（查询、范围、条数、层级、上下文类型、记忆类型、
 * 更新时间窗口），差别只在检索方式；schema 与解析只该有一份。
 */

import { LEVELS, type Level } from '../../../domain/level.js';
import { CONTEXT_TYPES, type ContextType } from '../../../domain/node.js';
import { DEFAULT_SEARCH_LIMIT } from '../../../services/retrieval/budget.js';
import type { McpToolContext } from '../context.js';
import {
  formatDegradations,
  optionalContextType,
  optionalLevel,
  optionalString,
  optionalStringArray,
  nonEmptyString,
  positiveInteger,
  readScopes,
  type McpToolName,
} from '../registry.js';

export const RETRIEVAL_FILTER_PROPERTIES = {
  query: { type: 'string', description: '自然语言查询；会被 queryFilters 清洗' },
  targetUri: {
    type: 'string',
    description: '可选的目录 URI，用来收窄范围',
  },
  limit: { type: 'integer', minimum: 1, default: DEFAULT_SEARCH_LIMIT, description: '最多返回条数' },
  level: { type: 'string', enum: LEVELS, description: '只看某一层级' },
  contextType: { type: 'string', enum: CONTEXT_TYPES, description: '只看某类上下文' },
  memoryTypes: {
    type: 'array',
    items: { type: 'string' },
    description: '只看这些记忆类型（如 rules / preferences / entities）；省略表示不限',
  },
  updatedAfter: {
    type: 'string',
    format: 'date-time',
    description: '只返回该时刻之后（含）更新的节点，ISO 8601',
  },
  updatedBefore: {
    type: 'string',
    format: 'date-time',
    description: '只返回该时刻之前（含）更新的节点，ISO 8601',
  },
} as const satisfies Record<string, unknown>;

export interface RetrievalArgs {
  readonly query: string;
  readonly targetUri: string | undefined;
  readonly limit: number;
  readonly level: Level | undefined;
  readonly contextType: ContextType | undefined;
  readonly memoryTypes: readonly string[] | undefined;
  readonly updatedAfter: string | undefined;
  readonly updatedBefore: string | undefined;
  readonly scopes: readonly string[];
}

/** 解析公共过滤参数，并完成 `targetUri` 的 ACL 校验（`readScopes` 内）。 */
export async function collectRetrievalArgs(
  args: Record<string, unknown>,
  tool: McpToolName,
  context: McpToolContext,
): Promise<RetrievalArgs> {
  const targetUri = optionalString(args, 'targetUri', tool);
  return {
    query: nonEmptyString(args, 'query', tool),
    targetUri,
    limit: positiveInteger(args, 'limit', DEFAULT_SEARCH_LIMIT, tool),
    level: optionalLevel(args, 'level', tool),
    contextType: optionalContextType(args, 'contextType', tool),
    memoryTypes: optionalStringArray(args, 'memoryTypes', tool),
    updatedAfter: optionalString(args, 'updatedAfter', tool),
    updatedBefore: optionalString(args, 'updatedBefore', tool),
    scopes: await readScopes(context, targetUri),
  };
}

/** 单值过滤维度在检索接口里是单元素数组；`undefined` 表示不过滤。 */
export function singleOrUndefined<T>(value: T | undefined): readonly T[] | undefined {
  return value === undefined ? undefined : [value];
}

type RetrievalDiagnostics = Parameters<typeof formatDegradations>[1];

/**
 * 正文 + 降级说明。
 *
 * 降级必须写进结果：`Found 0` 不说明原因时，调用方会把它读成「记忆里没有」。
 */
export function withDegradations(
  engine: 'fts5' | 'vector' | 'hybrid',
  diagnostics: RetrievalDiagnostics,
  body: string,
): string {
  return [body, ...formatDegradations(engine, diagnostics)].join('\n');
}
