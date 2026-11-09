/**
 * 节点抽象（Composite 模式，架构文档 §4.1、§6.6、§6.7）。
 *
 * `Directory` 与 `Document` 共享 `uri` / `status` / `updatedAt`，但「正文」的
 * 含义不同：文件的正文是内容，目录的正文是它的 L0 摘要。`digest()` 统一暴露
 * 「这个节点当前正文的摘要」，失效传播只比较摘要，不读内容（§9.3）。
 */

import type { DirectorySummary, SummaryFreshness } from './summary.js';
import type { Uri } from './uri.js';
import { ComemError } from './errors.js';

export type NodeKind = 'directory' | 'document';

/** 索引里的 `context_type`（架构文档 §8.1）。 */
export type ContextType = 'memory' | 'resource' | 'skill' | 'session';

/** 索引里的 `status`（架构文档 §8.1）。`pending` 是复核闸门未通过的记忆（§11.6）。 */
export type NodeStatus = 'active' | 'pending' | 'archived';

/** §6.5 的四个上下文目录名（复数）→ §8.1 的 `context_type`（单数）。 */
const CONTEXT_TYPE_BY_DIRECTORY: Readonly<Record<string, ContextType>> = {
  memories: 'memory',
  resources: 'resource',
  skills: 'skill',
  sessions: 'session',
};

/**
 * 认不出的路径（包括 scope 根与 `projects/{pid}` 自身）按 `resource` 处理。
 *
 * 为什么不是 `memory`：`memory` 会进复核闸门与记忆合并的输入（§11.6），普通目录
 * 被当成记忆比被当成资料更危险；`memory` 还是 `memory.ttl.*` 的唯一作用对象
 * （§11.7），误归会顺带改变过期语义。
 */
const DEFAULT_CONTEXT_TYPE: ContextType = 'resource';

/**
 * URI → 索引里的 `context_type`（架构文档 §6.3、§6.5、§8.1）。
 *
 * 只看路径的第一段：§6.5 把上下文固定在根下的 `memories/` `resources/` `skills/`
 * `sessions/`，项目作用域在最前面多一段 `projects/{pid}/`，所以先剥掉这一段再看
 * 下一段。更深的段名不参与判断（`memories/archive/resources/x` 仍是记忆）。
 *
 * 纯函数：只读 `uri.segments` 与上表，不碰磁盘、不看环境。索引观察者、摘要服务与
 * `reindex` 共用这一份——三处各写一份时，`reindex` 会按自己的规则重写整张
 * `context_type` 列，漂移要等到有人跑重建才会暴露。
 */
export function contextTypeOf(uri: Uri): ContextType {
  const segments = uri.segments[0] === 'projects' ? uri.segments.slice(2) : uri.segments;
  const head = segments[0];
  if (head === undefined) {
    return DEFAULT_CONTEXT_TYPE;
  }
  return CONTEXT_TYPE_BY_DIRECTORY[head] ?? DEFAULT_CONTEXT_TYPE;
}

/**
 * FNV-1a 64 位。
 *
 * 不用 sha256 是因为 domain 层不能碰 `node:crypto`（lint 规则禁止全部 `node:*`），
 * 而失效传播只需要「碰撞概率足够低的变更检测」，不需要密码学强度：两个不同正文
 * 撞同一个 64 位摘要的概率是 2^-64 量级，远低于磁盘损坏的概率。
 *
 * 输入按 Unicode 码点逐位混入（`for...of` 按码点迭代，不会把代理对拆成两半）。
 * 返回 16 位十六进制串，定长，可直接比较。
 */
const FNV_OFFSET_BASIS = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const UINT64_MASK = 0xffffffffffffffffn;

export function stableDigest(input: string): string {
  let hash = FNV_OFFSET_BASIS;
  for (const char of input) {
    const codePoint = char.codePointAt(0) ?? 0;
    hash = ((hash ^ BigInt(codePoint)) * FNV_PRIME) & UINT64_MASK;
  }
  return hash.toString(16).padStart(16, '0');
}

/**
 * 正文的 UTF-8 字节数。
 *
 * 手写而不是用 `TextEncoder`：后者虽然可用，但 domain 层保持零全局依赖更省心，
 * 而且这里只需要长度，不需要编码结果。
 */
function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (const char of text) {
    const codePoint = char.codePointAt(0) ?? 0;
    // UTF-8 的四个编码区间：1 字节 < 0x80，2 字节 < 0x800，3 字节 < 0x10000，其余 4 字节。
    if (codePoint < 0x80) {
      bytes += 1;
    } else if (codePoint < 0x800) {
      bytes += 2;
    } else if (codePoint < 0x10000) {
      bytes += 3;
    } else {
      bytes += 4;
    }
  }
  return bytes;
}

export interface NodeInit {
  readonly uri: Uri;
  readonly status?: NodeStatus;
  /** ISO 8601 时间串 */
  readonly updatedAt: string;
}

export abstract class Node {
  readonly uri: Uri;
  readonly status: NodeStatus;
  readonly updatedAt: string;

  protected constructor(init: NodeInit) {
    this.uri = init.uri;
    this.status = init.status ?? 'active';
    this.updatedAt = init.updatedAt;
  }

  abstract readonly kind: NodeKind;

  /** 正文摘要，用于失效传播（架构文档 §9.3）。相同正文必须得到相同结果。 */
  abstract digest(): string;

  /** 字节数。目录返回直接子节点数，见 `Directory.size`。 */
  abstract size(): number;

  /** 最后一段路径；根节点是空串。 */
  get name(): string {
    return this.uri.name;
  }

  get isDirectory(): boolean {
    return this.kind === 'directory';
  }
}

/**
 * 文件级摘要字段（架构文档 §6.7）。
 *
 * 摘要跟着文件走，存在文件自己的 frontmatter 里，不另存档：移动、复制、备份
 * 都不用额外维护，重建索引时扫一遍文件头就够，零 LLM 调用。
 */
export type SummaryState = 'fresh' | 'stale';

export interface DocumentFrontmatter {
  /** 一句话摘要 */
  readonly summary?: string;
  /** 摘要对应的正文摘要；对不上说明正文被改过 */
  readonly summaryDigest?: string;
  readonly summaryState?: SummaryState;
}

export interface DocumentInit extends NodeInit {
  readonly content: string;
  readonly frontmatter?: DocumentFrontmatter;
  /** 记忆类型（架构文档 §11.1）；非记忆文件为 `null` */
  readonly memoryType?: string | null;
}

export class Document extends Node {
  override readonly kind: NodeKind = 'document';
  readonly content: string;
  readonly frontmatter: DocumentFrontmatter;
  readonly memoryType: string | null;

  constructor(init: DocumentInit) {
    super(init);
    this.content = init.content;
    this.frontmatter = init.frontmatter ?? {};
    this.memoryType = init.memoryType ?? null;
  }

  override digest(): string {
    return stableDigest(this.content);
  }

  override size(): number {
    return utf8ByteLength(this.content);
  }
}

export interface DirectoryInit extends NodeInit {
  readonly children?: Iterable<Node>;
  readonly summary?: DirectorySummary;
  readonly freshness?: SummaryFreshness;
}

const EMPTY_SUMMARY: DirectorySummary = Object.freeze({
  abstract: '',
  overview: '',
  degraded: false,
});

const EMPTY_FRESHNESS: SummaryFreshness = Object.freeze({
  baseline: null,
  pendingChanges: 0,
  totalEntries: 0,
});

export class Directory extends Node {
  override readonly kind: NodeKind = 'directory';

  readonly #children = new Map<string, Node>();
  summary: DirectorySummary;
  freshness: SummaryFreshness;

  constructor(init: DirectoryInit) {
    super(init);
    this.summary = init.summary ?? EMPTY_SUMMARY;
    this.freshness = init.freshness ?? EMPTY_FRESHNESS;
    for (const child of init.children ?? []) {
      this.addChild(child);
    }
  }

  /** 子节点按最后一段路径索引。返回的视图不可增删，但节点本身不是快照。 */
  get children(): ReadonlyMap<string, Node> {
    return this.#children;
  }

  /**
   * 挂一个直接子节点。
   *
   * 两条不变量在入口处校验，而不是等调用方在别处踩坑：
   * 根节点不能当别人的子节点；子节点的父路径必须就是本目录。
   */
  addChild(node: Node): void {
    if (node.uri.isRoot) {
      throw new ComemError('INVALID_ARGUMENT', '根节点不能作为子节点。', {
        uri: node.uri.toString(),
      });
    }
    const parent = node.uri.parent();
    if (parent === null || !parent.equals(this.uri)) {
      throw new ComemError('INVALID_ARGUMENT', '子节点的父路径与本目录不一致。', {
        directory: this.uri.toString(),
        child: node.uri.toString(),
      });
    }
    this.#children.set(node.uri.name, node);
  }

  removeChild(name: string): boolean {
    return this.#children.delete(name);
  }

  getChild(name: string): Node | undefined {
    return this.#children.get(name);
  }

  /** 按种类过滤直接子节点，保持插入顺序。 */
  childrenOfKind(kind: NodeKind): readonly Node[] {
    return [...this.#children.values()].filter((child) => child.kind === kind);
  }

  /** 目录的正文是它的 L0 摘要（架构文档 §9.3 的「算 N 的 L0 正文 digest」）。 */
  override digest(): string {
    return stableDigest(this.summary.abstract);
  }

  /**
   * 直接子节点数。
   *
   * 不做子树递归：目录的 `size` 只用于展示与索引，递归统计要在每次写时走完整棵
   * 子树，而它并不参与任何判定。
   */
  override size(): number {
    return this.#children.size;
  }
}
