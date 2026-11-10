/**
 * URI 值对象与规范化（架构文档 §6.1、§6.2）。
 *
 * 格式：`comem://{scope}/{rootId}/{segments...}`，scope 是 `user` 或 `group`。
 * 规范化必须唯一：权限按路径记录，同一文件有两个路径就有两套权限，其中一套一定是错的。
 * 因此 `parse` 是唯一的构造入口，构造出的 `Uri` 一定处于规范化形态。
 */

import { ComemError } from './errors.js';

export type UriScope = 'user' | 'group';

export interface UriParseOptions {
  /** `~` 展开的目标用户 ID。不提供时 `~` 视为非法 */
  currentUserId?: string;
}

const SCHEME_PREFIX = 'comem://';
const PATH_SEPARATOR = '/';

/**
 * 根标识（uid / gid）的合法字符集：`[A-Za-z0-9._@-]+`。
 * 取这个集合是因为 uid 可能是邮箱（含 `@` `.` `_` `-`），而斜杠、空白、
 * 控制字符、Windows 保留字符都不能出现在磁盘目录名里。
 */
const ROOT_ID_PATTERN = /^[A-Za-z0-9._@-]+$/;

/**
 * 保留名（架构文档 §6.2 规则 6）：元数据文件名，作为普通路径段写入会和它们抢地址。
 * `adapters/fs/path.ts` 与 `domain/identity.ts` 引用同一份。`.history` 不在其中：
 * 版本快照本身就是 URI 段，系统自己也要写；它只拦用户可选的标识。
 */
export const RESERVED_SEGMENT_NAMES: ReadonlySet<string> = new Set([
  '.abstract.md', '.overview.md', '.acl.json', '.meta.json', '.done',
  'memory_diff.json', 'memory_operations.json',
]);

/** 单段 UTF-8 字节数上限（架构文档 §6.2 规则 5）。 */
const MAX_SEGMENT_BYTES = 255;

/** 控制字符 `\u0000`–`\u001f` 与反斜杠（架构文档 §6.2 规则 4）。 */
const CONTROL_CHAR_UPPER_BOUND = 0x20;

function containsForbiddenChar(segment: string): boolean {
  if (segment.includes('\\')) {
    return true;
  }
  return [...segment].some((char) => char.charCodeAt(0) < CONTROL_CHAR_UPPER_BOUND);
}

function invalidUri(input: string, reason: string): ComemError {
  return new ComemError('INVALID_URI', `URI 不合法：${reason}`, { input, reason });
}

/** 规范化并校验单个路径段。返回 NFC 形态。 */
function normalizeSegment(raw: string, input: string): string {
  const segment = raw.normalize('NFC');
  if (segment === '') {
    throw invalidUri(input, '路径段不能为空');
  }
  if (segment === '.' || segment === '..') {
    throw invalidUri(input, `路径段不能是 ${segment}`);
  }
  if (segment.includes(PATH_SEPARATOR)) {
    throw invalidUri(input, '路径段不能包含斜杠');
  }
  if (containsForbiddenChar(segment)) {
    throw invalidUri(input, '路径段不能包含控制字符或反斜杠');
  }
  if (RESERVED_SEGMENT_NAMES.has(segment)) {
    throw invalidUri(input, `${segment} 是保留名，不能作为普通路径段`);
  }
  if (Buffer.byteLength(segment, 'utf8') > MAX_SEGMENT_BYTES) {
    throw invalidUri(input, `单个路径段不能超过 ${MAX_SEGMENT_BYTES} 字节`);
  }
  return segment;
}

function normalizeRootId(raw: string, input: string): string {
  const rootId = normalizeSegment(raw, input);
  if (!ROOT_ID_PATTERN.test(rootId)) {
    throw invalidUri(input, '根标识只能包含字母、数字、点、下划线、@ 和连字符');
  }
  return rootId;
}

export class Uri {
  readonly scope: UriScope;
  readonly rootId: string;
  /** 规范化后的段，不含 rootId，不含空段 */
  readonly segments: readonly string[];

  private constructor(scope: UriScope, rootId: string, segments: readonly string[]) {
    this.scope = scope;
    this.rootId = rootId;
    this.segments = Object.freeze([...segments]);
  }

  /** 失败抛 `ComemError('INVALID_URI')`。 */
  static parse(input: string, options: UriParseOptions = {}): Uri {
    if (typeof input !== 'string' || input === '') {
      throw new ComemError('INVALID_URI', 'URI 不合法：URI 不能为空。', { input });
    }
    if (!input.toLowerCase().startsWith(SCHEME_PREFIX)) {
      throw invalidUri(input, 'URI 必须以 comem:// 开头');
    }

    let rest = input.slice(SCHEME_PREFIX.length);

    // `~` 别名只认第一段（架构文档 §6.1）。
    if (rest === '~' || rest.startsWith(`~${PATH_SEPARATOR}`)) {
      const { currentUserId } = options;
      if (currentUserId === undefined) {
        throw invalidUri(input, '~ 需要当前用户身份才能展开');
      }
      // currentUserId 来自会话身份，不是可信输入：按根标识规则校验，否则它能把路径撑出额外段。
      rest = `user${PATH_SEPARATOR}${normalizeRootId(currentUserId, input)}${rest.slice(1)}`;
    }

    const scopeEnd = rest.indexOf(PATH_SEPARATOR);
    if (scopeEnd < 0) {
      throw invalidUri(input, 'URI 缺少 scope 与根标识');
    }
    const rawScope = rest.slice(0, scopeEnd);
    if (rawScope !== 'user' && rawScope !== 'group') {
      throw invalidUri(input, 'scope 只能是 user 或 group');
    }
    const scope: UriScope = rawScope;

    const pathPart = rest.slice(scopeEnd + 1);
    // 空段拒绝（架构文档 §6.2 规则 10）：根标识位置必须是实段。
    if (pathPart === '' || pathPart.startsWith(PATH_SEPARATOR)) {
      throw invalidUri(input, 'URI 缺少根标识');
    }

    // 合并重复斜杠、丢弃末尾斜杠（架构文档 §6.2 规则 2）。
    const rawSegments = pathPart.split(PATH_SEPARATOR).filter((seg) => seg !== '');
    const [rawRootId, ...rawRest] = rawSegments;
    if (rawRootId === undefined) {
      throw invalidUri(input, 'URI 缺少根标识');
    }

    const rootId = normalizeRootId(rawRootId, input);
    const segments = rawRest.map((seg) => normalizeSegment(seg, input));
    return new Uri(scope, rootId, segments);
  }

  /** 与 `parse` 相同，但非法输入返回 `null`（架构文档 §6.2 的调用方不需要 try/catch）。 */
  static tryParse(input: string, options: UriParseOptions = {}): Uri | null {
    try {
      return Uri.parse(input, options);
    } catch (error) {
      if (error instanceof ComemError && error.code === 'INVALID_URI') {
        return null;
      }
      throw error;
    }
  }

  get depth(): number {
    return this.segments.length;
  }

  /** 最后一段；根节点返回空串。 */
  get name(): string {
    return this.segments.at(-1) ?? '';
  }

  get isRoot(): boolean {
    return this.segments.length === 0;
  }

  /** `.../projects/{pid}` 时返回项目 ID，其余返回 `null`（架构文档 §6.3）。 */
  get projectId(): string | null {
    return this.segments[0] === 'projects' ? (this.segments[1] ?? null) : null;
  }

  get isProject(): boolean {
    return this.segments.length === 2 && this.segments[0] === 'projects';
  }

  /** 根节点返回 `null`。 */
  parent(): Uri | null {
    if (this.isRoot) {
      return null;
    }
    return new Uri(this.scope, this.rootId, this.segments.slice(0, -1));
  }

  /** 逐段校验后追加子段。 */
  child(...names: string[]): Uri {
    if (names.length === 0) {
      return this;
    }
    const input = `${this.toString()}/${names.join(PATH_SEPARATOR)}`;
    const children = names.map((name) => normalizeSegment(name, input));
    return new Uri(this.scope, this.rootId, [...this.segments, ...children]);
  }

  /** 规范化后的字符串相同时为真。末尾斜杠不参与 identity。 */
  equals(other: Uri): boolean {
    return (
      this.scope === other.scope &&
      this.rootId === other.rootId &&
      this.segments.length === other.segments.length &&
      this.segments.every((segment, index) => segment === other.segments[index])
    );
  }

  /** 严格前缀：自身不算自己的祖先。 */
  isAncestorOf(other: Uri): boolean {
    if (this.scope !== other.scope || this.rootId !== other.rootId) {
      return false;
    }
    if (other.segments.length <= this.segments.length) {
      return false;
    }
    return this.segments.every((segment, index) => segment === other.segments[index]);
  }

  /** `comem://user/alice/memories/foo`，根节点是 `comem://user/alice`。 */
  toString(): string {
    const path = [this.scope, this.rootId, ...this.segments].join(PATH_SEPARATOR);
    return `${SCHEME_PREFIX}${path}`;
  }

  /** 末尾补 `/`；根节点是 `comem://user/alice/`。 */
  toStringAsDirectory(): string {
    return `${this.toString()}${PATH_SEPARATOR}`;
  }
}
