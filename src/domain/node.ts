/**
 * 节点相关的领域规则（架构文档 §4.1、§6.6、§6.7、§9.3）。
 *
 * **没有内存里的节点对象。** 节点的状态存在两处：`node` 表的行（`kind`、
 * `context_type`、`status`、摘要基线三列，见 `migrations/0001_init.sql`）与文件本身
 * （正文 + frontmatter）。这里只放不依赖 IO 的规则：类别与状态的枚举和守卫、
 * URI → `context_type` 的推导、正文摘要 `stableDigest`。失效传播比较摘要，不读文件。
 */

import type { Uri } from './uri.js';

export type NodeKind = 'directory' | 'document';

/**
 * §8.1 的 `context_type` 取值。
 *
 * 数组是唯一来源，类型从它派生：MCP 的 `inputSchema.enum`、HTTP 的 `contextTypes`
 * 参数、按类别分的预算表都要跟着它走。加一个类别时这些消费点必须逐个显示决定。
 */
export const CONTEXT_TYPES = ['memory', 'resource', 'skill', 'session'] as const;

/** 索引里的 `context_type`（架构文档 §8.1）。 */
export type ContextType = (typeof CONTEXT_TYPES)[number];

/** 类别守卫。写成 `.some()` 而不是 `includes(value as ContextType)`：不打断言。 */
export function isContextType(value: string): value is ContextType {
  return CONTEXT_TYPES.some((candidate) => candidate === value);
}

/** 索引里的 `status`（架构文档 §8.1）。`pending` 是复核闸门未通过的记忆（§11.6）。 */
export type NodeStatus = 'active' | 'pending' | 'archived';

/**
 * 状态清单。
 *
 * 这里不用数组而用 `Record<NodeStatus, true>`：状态没有需要遍历的消费点（只有
 * 「这个字符串是不是合法状态」这一个查询），而类型才是这份清单的来源。写成
 * `Record` 后，往 `NodeStatus` 加成员会在这里编译失败，逼你把校验跟上；反过来
 * （先写数组、再从数组派生类型）漏抄一个成员是静默的。
 */
const NODE_STATUSES: Readonly<Record<NodeStatus, true>> = {
  active: true,
  pending: true,
  archived: true,
};

/**
 * 状态守卫。
 *
 * 用 `Object.hasOwn` 而不是 `status in NODE_STATUSES`：后者会命中原型链，
 * `'toString'` 这样的键会被判成合法状态。
 */
export function isNodeStatus(value: unknown): value is NodeStatus {
  return typeof value === 'string' && Object.hasOwn(NODE_STATUSES, value);
}

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
 * 文件级摘要字段（架构文档 §6.7）。
 *
 * 摘要跟着文件走，存在文件自己的 frontmatter 里，不另存档：移动、复制、备份
 * 都不用额外维护，重建索引时扫一遍文件头就够，零 LLM 调用。
 *
 * 失效**不在这里**：`summary_state` / `summary_digest` 是旧机制，生产从不写，
 * 已删除。真实的失效传播走 `SummaryService.markStale()` 与 `node` 表的
 * `summary_baseline` / `summary_pending` / `summary_entries` 三列
 * （`migrations/0001_init.sql`）——那套是索引侧的状态，不落在文件头上。
 */
export interface DocumentFrontmatter {
  /** 一句话摘要 */
  readonly summary?: string;
}
