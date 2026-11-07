/**
 * 检索接口（架构文档 §8.3）。
 *
 * 这是 brief 里唯一明确要求预留的扩展点（「查找要做成接口，后续可能要做成向量库」）。
 * 接口只描述「给一个查询，返回命中」，实现放在 `adapters/sqlite/retrieval-index.ts`。
 *
 * 权限过滤在索引侧完成：`principals` 由 `Authorizer` 统一算好传进来，FTS5 实现与
 * 未来的向量实现共用同一套过滤条件（§8.3）。
 */

import type { Level } from './level.js';
import type { ContextType, NodeKind, NodeStatus } from './node.js';
import { ComemError } from './errors.js';

/** 索引里的一行 `node`（架构文档 §8.1）。 */
export interface IndexRecord {
  readonly uri: string;
  readonly parentUri: string;
  readonly scope: 'user' | 'group';
  readonly kind: NodeKind;
  readonly contextType: ContextType;
  readonly memoryType: string | null;
  readonly level: Level;
  readonly abstract: string | null;
  readonly content: string;
  readonly bodyDigest: string;
  readonly size: number;
  readonly updatedAt: string;
  readonly status: NodeStatus;
}

export interface SearchQuery {
  readonly text: string;
  /** 路径前缀 */
  readonly scopes: readonly string[];
  /** 调用方权限主体，如 `user:alice`、`group:eng`、`user:*` */
  readonly principals: readonly string[];
  readonly contextTypes?: readonly ContextType[];
  readonly levels?: readonly Level[];
  readonly limit: number;
  readonly scoreThreshold?: number;
}

export interface SearchHit {
  readonly uri: string;
  readonly level: Level;
  readonly abstract: string | null;
  readonly score: number;
  readonly contextType: ContextType;
}

export interface GrepQuery {
  readonly pattern: string;
  readonly scopes: readonly string[];
  readonly principals: readonly string[];
  readonly limit: number;
  readonly contextLines: number;
}

export interface GrepHit {
  readonly uri: string;
  readonly line: number;
  readonly text: string;
  readonly before: readonly string[];
  readonly after: readonly string[];
}

export interface GlobQuery {
  readonly pattern: string;
  readonly scopes: readonly string[];
  readonly principals: readonly string[];
  readonly limit: number;
}

export interface NodeStat {
  readonly uri: string;
  readonly kind: NodeKind;
  readonly contextType: ContextType;
  readonly memoryType: string | null;
  readonly size: number;
  readonly updatedAt: string;
  readonly status: NodeStatus;
  readonly abstract: string | null;
}

export interface RetrievalIndex {
  upsert(records: readonly IndexRecord[]): Promise<void>;
  deleteByUri(uri: string, options?: { readonly recursive?: boolean }): Promise<void>;
  search(query: SearchQuery): Promise<SearchHit[]>;
  grep(query: GrepQuery): Promise<GrepHit[]>;
  glob(query: GlobQuery): Promise<string[]>;
  stat(uri: string): Promise<NodeStat | null>;
}

function invalidArgument(message: string, details: Record<string, unknown>): ComemError {
  return new ComemError('INVALID_ARGUMENT', message, details);
}

/** 查询的公共部分：`limit > 0`、`scopes` 与 `principals` 非空。 */
function validateQueryEnvelope(query: {
  readonly limit: number;
  readonly scopes: readonly string[];
  readonly principals: readonly string[];
}): void {
  if (!Number.isInteger(query.limit) || query.limit <= 0) {
    throw invalidArgument('limit 必须是正整数。', { limit: query.limit });
  }
  if (query.scopes.length === 0) {
    throw invalidArgument('scopes 不能为空：没有路径范围就等于全库扫描。', {});
  }
  if (query.scopes.some((scope) => scope === '')) {
    throw invalidArgument('scopes 里不能有空字符串。', { scopes: query.scopes });
  }
  if (query.principals.length === 0) {
    throw invalidArgument('principals 不能为空：没有权限主体就查不到任何节点。', {});
  }
  if (query.principals.some((principal) => principal === '')) {
    throw invalidArgument('principals 里不能有空字符串。', { principals: query.principals });
  }
}

function validateText(text: string, field: string): void {
  if (text === '') {
    throw invalidArgument(`${field} 不能为空。`, { field });
  }
}

/**
 * 校验检索查询。合法返回 `undefined`，非法抛 `INVALID_ARGUMENT`。
 *
 * 在进索引实现之前挡掉不可能成立的查询：空 `scopes` 会退化成全库扫描，
 * 空 `principals` 只会得到空结果，`limit <= 0` 在 SQL 里的语义依实现而异。
 */
export function validateSearchQuery(query: SearchQuery): void {
  validateQueryEnvelope(query);
  validateText(query.text, 'text');
}

/** 校验 `grep` 查询；正则本身也要能编译。 */
export function validateGrepQuery(query: GrepQuery): void {
  validateQueryEnvelope(query);
  validateText(query.pattern, 'pattern');
  if (!Number.isInteger(query.contextLines) || query.contextLines < 0) {
    throw invalidArgument('contextLines 必须是非负整数。', { contextLines: query.contextLines });
  }
  try {
    new RegExp(query.pattern);
  } catch {
    throw invalidArgument('pattern 不是合法的正则表达式。', { pattern: query.pattern });
  }
}

/** 校验 `glob` 查询。 */
export function validateGlobQuery(query: GlobQuery): void {
  validateQueryEnvelope(query);
  validateText(query.pattern, 'pattern');
}
