/**
 * 记忆合并的操作词汇与校验（架构文档 §11.8）。
 *
 * ## 为什么不是「相似度超阈值就合并」
 *
 * 相似度只能回答「这两条像不像」，回答不了「这两条里是不是有一条已经被取代」。
 * 两条互相矛盾的约定同样相似，按阈值合并的两种结果都不对：都留下（矛盾），或者
 * 不分青红地删一条（丢掉可能仍然有效的那条）。判断需要读正文、需要说明理由，
 * 所以决策交给模型，这一层只负责把模型的输出收敛成**要么全做、要么全不做**的
 * 操作列表。
 *
 * 领域层只放纯函数：校验（`validateOperations`）与「URI → 记忆类型 + identity」
 * 的还原（`resolveMemoryTarget`）。模型调用、加锁、写盘在
 * `services/consolidation.ts`。
 */

import type { MemoryTypeSchema } from './memory-type.js';
import { BUILTIN_MEMORY_TYPES } from './memory-types/index.js';
import { Uri } from './uri.js';

/** 模型可以产出的三类操作。 */
export type ConsolidationOperationKind = 'add' | 'update' | 'delete';

export interface ConsolidationOperation {
  readonly kind: ConsolidationOperationKind;
  /** 目标 URI。`add` 时是建议路径，`update` / `delete` 时是已存在的路径。 */
  readonly uri: string;
  /** 操作后的完整正文（`delete` 时为 `null`）。 */
  readonly content: string | null;
  /** 模型给出的理由。**必填**——没有理由的删除不可接受。 */
  readonly reason: string;
}

/** `validateOperations` 的输入。 */
export interface ValidateOperationsOptions {
  /** scope 下**已经存在**的记忆 URI（规范化后的字符串）。 */
  readonly existing: ReadonlySet<string>;
  /**
   * 允许写入的路径前缀，如 `comem://user/alice/memories/`。
   *
   * 用前缀而不是 `Uri.isAncestorOf`：调用方给的是「记忆目录」，不是某个节点。
   * 末尾斜杠是边界的一部分（`.../memoriesX` 不能算在 `.../memories/` 里），
   * 缺了会补。
   */
  readonly allowedScopes: readonly string[];
}

/** 批量校验的结果：要么整批合法，要么给出**第一条**不满足的原因。 */
export type ValidateOperationsResult =
  | { readonly valid: readonly ConsolidationOperation[] }
  | { readonly error: string };

/** 文件名模板里的占位符，如 `{topic}`。与 `memory-type.ts` 同一形状。 */
const PLACEHOLDER_SOURCE = String.raw`\{([A-Za-z][A-Za-z0-9_]*)\}`;

/** 正则元字符。`escapeRegExp` 与 `matchSegment` 共用。 */
const REGEXP_SPECIAL = /[.*+?^${}()|[\]\\]/gu;

function escapeRegExp(text: string): string {
  return text.replace(REGEXP_SPECIAL, '\\$&');
}

function normalizeScope(scope: string): string {
  return scope.endsWith('/') ? scope : `${scope}/`;
}

/**
 * 校验模型产出的操作列表。
 *
 * 拒绝整批的条件（**任意一条不满足就整批失败**，不逐条丢弃）：
 * - `delete` / `update` 的 URI 不在 `existing` 里（模型幻觉出不存在的路径）
 * - `add` 的 URI 已存在（应该用 `update`）
 * - URI 不在允许的 scope 内
 * - `content` 为空而 `kind !== 'delete'`
 * - `reason` 为空
 * - 同一个 URI 出现两次（同一批里 update 又 delete 是自相矛盾的，且写盘阶段会对同一条
 *   记忆重复加锁——同一进程内的同一把锁会等自己）
 *
 * **为什么整批失败而不是逐条丢弃**：模型产出的一半操作被执行、一半被丢弃，得到的
 * 是一份自相矛盾的记忆库——比如「这条被那条取代了」的删除被丢掉，两条就都留下了。
 * 要么全做，要么全不做。
 *
 * 返回的操作里 URI 已规范化为 `Uri.toString()` 的形态：调用方不必再解析一次，也
 * 不会因为模型多写一个末尾斜杠而把同一条记忆当成两条。
 */
export function validateOperations(
  operations: readonly ConsolidationOperation[],
  options: ValidateOperationsOptions,
): ValidateOperationsResult {
  const scopes = options.allowedScopes.map(normalizeScope);
  const valid: ConsolidationOperation[] = [];
  const seen = new Set<string>();

  for (const [index, operation] of operations.entries()) {
    const label = `第 ${index + 1} 条操作（${operation.kind}）`;

    const parsed = Uri.tryParse(operation.uri);
    if (parsed === null) {
      return { error: `${label}的 URI 不合法：${operation.uri}。` };
    }
    const uri = parsed.toString();

    if (!scopes.some((scope) => uri.startsWith(scope))) {
      return { error: `${label}的 URI 不在允许的 scope 内：${uri}。` };
    }

    if (seen.has(uri)) {
      return { error: `${label}与前面的操作指向同一条记忆：${uri}；一条记忆一次只能出现一次。` };
    }
    seen.add(uri);

    if (operation.kind === 'add') {
      if (options.existing.has(uri)) {
        return { error: `${label}是 add，但 ${uri} 已存在；修改已有记忆要用 update。` };
      }
    } else if (!options.existing.has(uri)) {
      return { error: `${label}指向的记忆不存在：${uri}。` };
    }

    if (operation.kind !== 'delete' && (operation.content ?? '').trim() === '') {
      return { error: `${label}的 content 不能为空。` };
    }

    if (operation.reason.trim() === '') {
      return { error: `${label}没有 reason：没有理由的${operation.kind}不可接受。` };
    }

    valid.push({ ...operation, uri });
  }

  return { valid };
}

/** 一个 URI 对应的记忆类型，以及从路径段里读出的 identity 值。 */
export interface MemoryTarget {
  readonly schema: MemoryTypeSchema;
  /** filename 模板里的占位符 → URI 段里的实际值；固定文件名的类型是空对象。 */
  readonly identity: Readonly<Record<string, string>>;
}

/**
 * 把文件名模板的一段与 URI 的一段对齐，取回占位符的值。
 *
 * 模板里的占位符换成 `([^/]+)`：URI 段本身不含 `/`（`Uri` 已经保证），所以不需要
 * 处理贪婪切分之外的边界。字面量部分整体转义，`profile.md` 里的 `.` 不会被当成
 * 任意字符。
 */
function matchSegment(template: string, actual: string): Record<string, string> | null {
  const names: string[] = [];
  let source = '';
  let last = 0;

  for (const match of template.matchAll(new RegExp(PLACEHOLDER_SOURCE, 'gu'))) {
    const index = match.index ?? 0;
    source += escapeRegExp(template.slice(last, index));
    names.push(match[1] ?? '');
    source += '([^/]+)';
    last = index + match[0].length;
  }
  source += escapeRegExp(template.slice(last));

  const matched = new RegExp(`^${source}$`, 'u').exec(actual);
  if (matched === null) {
    return null;
  }

  const values: Record<string, string> = {};
  for (const [position, name] of names.entries()) {
    const value = matched[position + 1];
    if (value !== undefined) {
      values[name] = value;
    }
  }
  return values;
}

/**
 * 把 `schema.filename` 模板与 URI 末尾的路径段对齐。
 *
 * 段数不同或字面量不匹配时返回 `null`。`profile.md` 这种固定文件名没有任何
 * 占位符，对齐成功时 identity 是空对象。
 */
function matchFilename(
  template: string,
  segments: readonly string[],
): Readonly<Record<string, string>> | null {
  const templateSegments = template.split('/');
  if (templateSegments.length !== segments.length) {
    return null;
  }

  const values: Record<string, string> = {};
  for (const [index, templateSegment] of templateSegments.entries()) {
    const matched = matchSegment(templateSegment, segments[index] ?? '');
    if (matched === null) {
      return null;
    }
    Object.assign(values, matched);
  }
  return values;
}

/**
 * 还原一个 URI 对应的记忆类型与 identity 值。
 *
 * `renderPath` 的逆运算。合并的操作只带 URI（模型是照着「清单」里的路径说的），
 * 而 `MemoryService.upsertMemory` 要的是「记忆类型 + identity 值」，中间这一步
 * 不能靠切字符串：目录与文件名模板都是记忆类型定义的，自己切一份必然与
 * `renderPath` 漂移（§11.1）。
 *
 * 不在任何记忆类型目录下、或文件名不符合任何模板时返回 `null`，由调用方决定
 * 报错还是跳过。
 */
export function resolveMemoryTarget(scope: Uri, uri: Uri): MemoryTarget | null {
  if (!scope.isAncestorOf(uri)) {
    return null;
  }
  const relative = uri.segments.slice(scope.depth);

  for (const schema of Object.values(BUILTIN_MEMORY_TYPES)) {
    const directory = schema.directory.split('/');
    if (relative.length <= directory.length) {
      continue;
    }
    if (!directory.every((segment, index) => relative[index] === segment)) {
      continue;
    }
    const identity = matchFilename(schema.filename, relative.slice(directory.length));
    if (identity !== null) {
      return { schema, identity };
    }
  }

  return null;
}
