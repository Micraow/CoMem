/**
 * MCP 工具注册表（架构文档 §13.2）。
 *
 * 16 个工具是**硬约束**：多一个少一个都不行（AGENTS.md）。`validate()` 是这条
 * 约束的唯一执行点，启动时调用——等到演示时才发现多注册了一个工具，代价比启动
 * 时崩掉大得多。
 *
 * ## 为什么返回值是文本
 *
 * MCP 的返回值直接进模型上下文。文本格式的信息密度更高，模型也更容易读；JSON
 * 适合程序消费，不适合模型消费（§13.2）。二进制只用于 `read` 命中的图片/音频。
 *
 * ## 为什么输入是 `unknown`
 *
 * 工具边界是协议边界：调用方是模型，参数可能缺字段、类型不对、多传键。每个工具
 * 用本文件的 helper 逐项校验并抛 `INVALID_ARGUMENT`，不把未校验的值传进服务层。
 */

import { parsePrincipal } from '../../domain/acl.js';
import { ComemError } from '../../domain/errors.js';
import { LEVELS, type Level } from '../../domain/level.js';
import type { ContextType } from '../../domain/node.js';
import { Uri } from '../../domain/uri.js';
import type { AclAction } from '../../services/authorizer.js';
import type { ScoredHit } from '../../services/search.js';

import type { McpToolContext } from './context.js';

/** §12.1：read = 1。 */
const READ: AclAction = 1;

/** §13.2 的 16 个工具名，顺序与表格一致。测试用 `toEqual` 对比硬编码数组。 */
export type McpToolName =
  | 'find'
  | 'search'
  | 'rule_search'
  | 'read'
  | 'list'
  | 'tree'
  | 'grep'
  | 'glob'
  | 'download'
  | 'health'
  | 'write'
  | 'edit'
  | 'remember'
  | 'forget'
  | 'add_resource'
  | 'add_skill';

export const MCP_TOOL_NAMES: readonly McpToolName[] = Object.freeze([
  'find',
  'search',
  'rule_search',
  'read',
  'list',
  'tree',
  'grep',
  'glob',
  'download',
  'health',
  'write',
  'edit',
  'remember',
  'forget',
  'add_resource',
  'add_skill',
]);

/** 16 个，不多不少。 */
const MCP_TOOL_COUNT = 16;

/** §13.2 的 `contextType` 取值（§8.1 的 `context_type`）。 */
const CONTEXT_TYPES: readonly ContextType[] = ['memory', 'resource', 'skill', 'session'];

export type McpToolResult =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'binary'; readonly mimeType: string; readonly base64: string };

export interface McpToolDefinition {
  readonly name: McpToolName;
  /** 给模型看的使用说明（§13.1 的三个问题） */
  readonly description: string;
  /** JSON Schema（MCP 协议要求） */
  readonly inputSchema: Record<string, unknown>;
  /** 只读工具不需要 principals 校验之外的额外要求 */
  readonly kind: 'read' | 'write' | 'ingest';
  execute(input: unknown, context: McpToolContext): Promise<McpToolResult>;
}

/** 启动自检失败：不是调用方的问题，是装配错误。 */
function invalidRegistry(message: string, details: Record<string, unknown>): ComemError {
  return new ComemError('INTERNAL', `MCP 工具注册失败：${message}`, details);
}

/**
 * 输入里可以带 `~` 别名的字段（§13.2 的 URI 参数）。
 *
 * 只认 URI 字段，不扫全部字符串：`content` 里的 `~/notes` 是正文，重写成 URI 会
 * 静默改坏文件内容。
 */
const URI_INPUT_FIELDS: readonly string[] = ['uri', 'uris', 'parentUri', 'targetUri'];

const PATH_SEPARATOR = '/';

/**
 * `~` 别名展开（§6.1）。
 *
 * `Uri.parse` 的 `currentUserId` 只表达用户根，表达不了组主体；工具调用之间也没有
 * 状态，Agent 只能靠 `health.subject` 拼绝对 URI。所以在注册表这一层展开：
 * `~` / `~/x` 展开成绑定主体的根（`comem://user/{uid}` 或 `comem://group/{gid}`）。
 *
 * 没有主体时抛 `INVALID_URI`，**不兜底到 `user:local`**——那是猜，空库上猜错的
 * 根会让所有写入落进别人的空间。
 */
export function expandUriAlias(raw: string, subject: string): string {
  if (raw !== '~' && !raw.startsWith(`~${PATH_SEPARATOR}`)) {
    return raw;
  }
  let principal;
  try {
    principal = parsePrincipal(subject);
  } catch {
    throw new ComemError('INVALID_URI', `~ 需要当前请求身份才能展开：${raw}`, {
      input: raw,
      subject,
    });
  }
  return `comem://${principal.kind}/${principal.id}${raw.slice(1)}`;
}

/** 复制输入并展开 URI 字段里的 `~`；没有命中时原样返回同一个对象。 */
function expandInputAliases(input: unknown, subject: string): unknown {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return input;
  }
  const record = input as Record<string, unknown>;
  let expanded: Record<string, unknown> | null = null;

  for (const field of URI_INPUT_FIELDS) {
    const value = record[field];
    if (typeof value === 'string') {
      const next = expandUriAlias(value, subject);
      if (next !== value) {
        expanded = { ...(expanded ?? record), [field]: next };
      }
      continue;
    }
    if (!Array.isArray(value)) {
      continue;
    }
    let changed = false;
    const items = value.map((item) => {
      if (typeof item !== 'string') {
        return item;
      }
      const next = expandUriAlias(item, subject);
      if (next !== item) {
        changed = true;
      }
      return next;
    });
    if (changed) {
      expanded = { ...(expanded ?? record), [field]: items };
    }
  }
  return expanded ?? input;
}

function bindSubjectAliases(tool: McpToolDefinition): McpToolDefinition {
  return {
    ...tool,
    execute: (input, context) => tool.execute(expandInputAliases(input, context.subject), context),
  };
}

export class ToolRegistry {
  readonly #tools: readonly McpToolDefinition[];
  readonly #byName: ReadonlyMap<string, McpToolDefinition>;

  constructor(tools: readonly McpToolDefinition[]) {
    // `~` 展开需要请求身份，而身份只在 `execute` 的 `context` 里（§6.1、§13.2）。
    // 在这里统一包装，16 个工具不必各写一遍——漏一个就是「有的工具能用别名、
    // 有的不能」。
    this.#tools = tools.map(bindSubjectAliases);
    this.#byName = new Map(this.#tools.map((tool) => [tool.name, tool]));
  }

  get(name: string): McpToolDefinition | undefined {
    return this.#byName.get(name);
  }

  list(): readonly McpToolDefinition[] {
    return this.#tools;
  }

  /** 启动自检：重名 / 数量不是 16 / 名字不在白名单 → 抛 INTERNAL。 */
  validate(): void {
    if (this.#tools.length !== MCP_TOOL_COUNT) {
      throw invalidRegistry(`必须注册 ${MCP_TOOL_COUNT} 个工具，实际 ${this.#tools.length} 个。`, {
        expected: MCP_TOOL_COUNT,
        actual: this.#tools.length,
      });
    }
    if (this.#byName.size !== this.#tools.length) {
      const names = this.#tools.map((tool) => tool.name);
      const duplicates = names.filter((name, index) => names.indexOf(name) !== index);
      throw invalidRegistry('工具名重复。', { duplicates });
    }
    const allowed = new Set<string>(MCP_TOOL_NAMES);
    for (const tool of this.#tools) {
      if (!allowed.has(tool.name)) {
        throw invalidRegistry(`工具名不在白名单里：${tool.name}`, { name: tool.name });
      }
    }
  }
}

// ── 结果 ──

export function textResult(text: string): McpToolResult {
  return { type: 'text', text };
}

/**
 * `- [类型] uri` + 缩进摘要（§13.2）。
 *
 * **不打分数。** 四种引擎的分数量纲互不相同（`search.ts` 的 `find` 注释里有完整
 * 表格：FTS5 是无界的 `bm25` 取负、向量是 `[-1, 1]` 的余弦、`hybrid` 是
 * `1/(60+rank)` 量级的 RRF 融合分、重排是 `0..1` 的概率），同一个
 * `toFixed(2)` 会让 hybrid 的 0.0328 全部渲成 `0.00`——那不是「没有分数」，而是
 * 一个**错误的**分数，调用方会据此把相关结果当成不相关丢掉。
 *
 * 换精度救不了：`toFixed(4)` 只是让 0.0328 显示成 0.0328，跨引擎仍然不可比。
 * 唯一跨引擎成立的不变量是**顺序**（返回前已按分数降序排好），所以只输出顺序。
 * 需要原始分数做归因的调用方走 HTTP `/search/find` 的 `score` 字段，那里由调用方
 * 自己知道当前引擎。
 */
export function formatHits(hits: readonly ScoredHit[]): string {
  const lines = [`Found ${hits.length} item(s):`];
  for (const hit of hits) {
    const type = hit.memoryType ?? hit.contextType;
    lines.push(`- [${type}] ${hit.uri}`);
    const abstract = hit.abstract?.trim() ?? '';
    if (abstract !== '') {
      lines.push(`  ${abstract.replaceAll('\n', '\n  ')}`);
    }
  }
  return lines.join('\n');
}

/**
 * 写操作之后的索引状态（§13.2「操作结果 + 索引状态」）。
 *
 * 索引由 `NodeWriteObserver` 在文件落盘后更新（§7：文件是真相，索引是派生）。
 * 工具层不自己写索引，只读回状态——「写成功但检索不到」必须在返回值里可见。
 */
export async function indexStatus(
  context: McpToolContext,
  uri: Uri,
  expected: 'indexed' | 'removed',
): Promise<string> {
  const stat = await context.index.stat(uri.toString());
  if (stat !== null) {
    return 'indexed';
  }
  return expected === 'removed' ? 'removed' : 'pending';
}

// ── 权限与范围 ──

/** 当前身份的个人根：`user:alice` → `comem://user/alice`。 */
export function subjectScope(context: McpToolContext): Uri {
  const principal = parsePrincipal(context.subject);
  if (principal.kind !== 'user') {
    throw new ComemError(
      'INVALID_ARGUMENT',
      `MCP 请求身份必须是 user 主体：${context.subject}`,
      { subject: context.subject },
    );
  }
  return Uri.parse(`comem://user/${principal.id}`);
}

/** 对个人根求权。`remember` / `health` 这类没有 URI 参数的工具用它。 */
export async function assertSubjectScope(
  context: McpToolContext,
  action: AclAction,
): Promise<Uri> {
  const scope = subjectScope(context);
  await context.acl.assert(scope, action, context.principals);
  return scope;
}

/**
 * 检索范围。
 *
 * 传了 `targetUri` 就只查那一个 URI（传文件只会命中它自己，描述里已提醒）；没有
 * 就查「当前身份能看到的全部根」：个人根 + 所属组根。`user:*` 不是可寻址的根。
 *
 * 每个范围都过 `Authorizer`（§12.4）：检索服务依赖索引侧过滤，但出口清单是按
 * 出口数的，工具层不能假设索引实现一定过滤了。
 */
export async function readScopes(
  context: McpToolContext,
  targetUri?: string,
): Promise<readonly string[]> {
  if (targetUri !== undefined) {
    const uri = Uri.parse(targetUri);
    await context.acl.assert(uri, READ, context.principals);
    return [uri.toString()];
  }

  // 个人根必须可读：读不到自己的空间是身份或装配错误，不是「范围为空」。
  const personal = subjectScope(context);
  await context.acl.assert(personal, READ, context.principals);

  // 组根按可读性过滤：退组后 `principals` 里没有这个组；组根尚未预置 ACL 时
  // 也不该让整次查询失败——那只是「这个组没有可查的内容」。
  const scopes = new Set<string>([personal.toString()]);
  for (const principal of context.principals) {
    const parsed = parsePrincipal(principal);
    if (parsed.kind !== 'group') {
      continue;
    }
    const uri = Uri.parse(`comem://group/${parsed.id}`);
    if (await context.acl.check(uri, READ, context.principals)) {
      scopes.add(uri.toString());
    }
  }
  return [...scopes];
}

// ── 输入校验 ──

function invalidArgument(message: string, details: Record<string, unknown>): ComemError {
  return new ComemError('INVALID_ARGUMENT', message, details);
}

export function asRecord(input: unknown, tool: McpToolName): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw invalidArgument(`${tool} 的参数必须是对象。`, { tool });
  }
  return input as Record<string, unknown>;
}

/** 字符串字段（允许空串：写空文件是合法操作）。 */
export function requiredString(
  input: Record<string, unknown>,
  field: string,
  tool: McpToolName,
): string {
  const value = input[field];
  if (typeof value !== 'string') {
    throw invalidArgument(`${tool} 的 ${field} 必须是字符串。`, { tool, field });
  }
  return value;
}

/** 非空字符串字段（查询、正则、路径）。 */
export function nonEmptyString(
  input: Record<string, unknown>,
  field: string,
  tool: McpToolName,
): string {
  const value = requiredString(input, field, tool);
  if (value === '') {
    throw invalidArgument(`${tool} 的 ${field} 不能为空。`, { tool, field });
  }
  return value;
}

export function optionalString(
  input: Record<string, unknown>,
  field: string,
  tool: McpToolName,
): string | undefined {
  const value = input[field];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw invalidArgument(`${tool} 的 ${field} 必须是字符串。`, { tool, field });
  }
  return value;
}

export function optionalBoolean(
  input: Record<string, unknown>,
  field: string,
  fallback: boolean,
  tool: McpToolName,
): boolean {
  const value = input[field];
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== 'boolean') {
    throw invalidArgument(`${tool} 的 ${field} 必须是布尔值。`, { tool, field });
  }
  return value;
}

/** 正整数（`limit` / `nodeLimit` 一类）。 */
export function positiveInteger(
  input: Record<string, unknown>,
  field: string,
  fallback: number,
  tool: McpToolName,
): number {
  const value = input[field];
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw invalidArgument(`${tool} 的 ${field} 必须是正整数。`, { tool, field });
  }
  return value;
}

/** 非负整数（`offset`）。 */
export function nonNegativeInteger(
  input: Record<string, unknown>,
  field: string,
  fallback: number,
  tool: McpToolName,
): number {
  const value = input[field];
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw invalidArgument(`${tool} 的 ${field} 必须是非负整数。`, { tool, field });
  }
  return value;
}

/** `read` 的 `limit`：`-1` 表示读到末尾，其余必须是正整数。 */
export function readLimit(
  input: Record<string, unknown>,
  field: string,
  fallback: number,
  tool: McpToolName,
): number {
  const value = input[field];
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || (value <= 0 && value !== -1)) {
    throw invalidArgument(`${tool} 的 ${field} 必须是正整数或 -1。`, { tool, field });
  }
  return value;
}

/** `[0, 1]` 区间的数（`rule_search` 的 `threshold`）。 */
export function unitInterval(
  input: Record<string, unknown>,
  field: string,
  fallback: number,
  tool: McpToolName,
): number {
  const value = input[field];
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw invalidArgument(`${tool} 的 ${field} 必须是 0 到 1 之间的数。`, { tool, field });
  }
  return value;
}

export function optionalEnum<T extends string>(
  input: Record<string, unknown>,
  field: string,
  allowed: readonly T[],
  fallback: T,
  tool: McpToolName,
): T {
  const value = input[field];
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw invalidArgument(`${tool} 的 ${field} 只能是 ${allowed.join(' / ')}。`, {
      tool,
      field,
      allowed,
    });
  }
  return value as T;
}

export function optionalLevel(
  input: Record<string, unknown>,
  field: string,
  tool: McpToolName,
): Level | undefined {
  const value = input[field];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string' || !LEVELS.includes(value as Level)) {
    throw invalidArgument(`${tool} 的 ${field} 只能是 L0 / L1 / L2。`, { tool, field });
  }
  return value as Level;
}

export function optionalContextType(
  input: Record<string, unknown>,
  field: string,
  tool: McpToolName,
): ContextType | undefined {
  const value = input[field];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string' || !CONTEXT_TYPES.includes(value as ContextType)) {
    throw invalidArgument(
      `${tool} 的 ${field} 只能是 ${CONTEXT_TYPES.join(' / ')}。`,
      { tool, field },
    );
  }
  return value as ContextType;
}

/** 对象数组（`uris` / `files` / `messages`）。 */
export function recordArray(
  input: Record<string, unknown>,
  field: string,
  tool: McpToolName,
): readonly Record<string, unknown>[] {
  const value = input[field];
  if (!Array.isArray(value) || value.length === 0) {
    throw invalidArgument(`${tool} 的 ${field} 必须是非空数组。`, { tool, field });
  }
  return value.map((item, index) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw invalidArgument(`${tool} 的 ${field}[${index}] 必须是对象。`, { tool, field, index });
    }
    return item as Record<string, unknown>;
  });
}

/** 字符串数组（`read` 的 `uris`）。 */
export function stringArray(
  input: Record<string, unknown>,
  field: string,
  tool: McpToolName,
): readonly string[] {
  const value = input[field];
  if (!Array.isArray(value) || value.length === 0) {
    throw invalidArgument(`${tool} 的 ${field} 必须是非空数组。`, { tool, field });
  }
  return value.map((item, index) => {
    if (typeof item !== 'string') {
      throw invalidArgument(`${tool} 的 ${field}[${index}] 必须是字符串。`, {
        tool,
        field,
        index,
      });
    }
    return item;
  });
}
