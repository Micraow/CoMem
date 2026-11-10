/**
 * 记忆之间的关联边（架构文档 §11.10）。
 *
 * **这不是多跳检索。** `links` 不参与 `find`、不进入 FTS / 向量索引、检索时不展开
 * 邻居。它是一份**关联数据 / 溯源**：谁引用了谁、一条结论从哪条资源推出来。
 * 检索与图视图都不在本文件范围内——这里只有「怎么表示一条边」。
 *
 * 方向语义：一条边从 `fromUri` 指向 `toUri`。`backlinks(of X)` 就是所有 `toUri === X`
 * 的边，即「谁指向 X」。反向不自动生成对称边：A → B 不等于 B → A，需要的话显式写两条。
 */

import type { Uri } from './uri.js';

/**
 * 内置的三种边类型。
 *
 * 这份清单**不是**闭集（见 `MemoryLinkType`），它只用来消除「同一个字面量抄三遍」：
 * 产生端的 `DERIVED_FROM` 与控制台的展示映射都以它为准（后者由
 * `tests/unit/web/link-type-labels.test.ts` 对拍）。
 */
export const BUILTIN_MEMORY_LINK_TYPES = ['references', 'derived_from', 'related'] as const;

/**
 * 边的语义标签。
 *
 * 只做收敛，不做穷举：`link_type` 是开放字符串，这里给三个常见取值作为文档参考，
 * 不校验——收紧成枚举会让「资源 → 记忆」以外的产生端每次想加一种关系都要改领域层。
 * 所以 `MemoryLinkType` 在类型上是开放的（`string & ` 分支），消费方必须显式处理
 * 「未知类型」：`services/memory-link.ts` 原样存储，控制台显示原值。
 */
export type MemoryLinkType =
  | (typeof BUILTIN_MEMORY_LINK_TYPES)[number]
  | (string & {});

/** 一条关联边：起点、终点、语义标签、权重、原文出处、说明。 */
export interface MemoryLink {
  /** 边的起点 URI。 */
  readonly fromUri: Uri;
  /** 边的终点 URI。 */
  readonly toUri: Uri;
  /** 语义标签，如 `references` / `derived_from` / `related`。 */
  readonly linkType: string;
  /** 关联强度。重复写入时取 max，不累加（见 `mergeWeight`）。 */
  readonly weight: number;
  /** 触发链接的原文片段；空串表示没有具体出处。 */
  readonly matchText: string;
  /** 一句话说明；空串表示没有。 */
  readonly description: string;
}

/** 写入一条边时的入参：`from` 由调用点决定，其余可省略用默认值。 */
export interface MemoryLinkInput {
  readonly toUri: Uri;
  readonly linkType: string;
  readonly weight?: number;
  readonly matchText?: string;
  readonly description?: string;
}

/**
 * 权重合并策略：**取 max，不累加**。
 *
 * 同一条边被写两次（例如两个产生端都看到「A 引用了 B」），`weight` 代表的是这条
 * 关联的**强度判断**，不是「被看见的次数」。累加会让反复跑同一批抽取的边无限变重，
 * 把「跑了几次」混进「有多相关」；max 保留产生方给出的最强判断，重复写不改变它。
 * 唯一键是 `(from_uri, to_uri, match_text)`：三条都相同算同一条边，撞键时
 * `weight` 取 max，`link_type` / `description` 以最新一次写入为准。
 */
export function mergeWeight(existing: number, next: number): number {
  return next > existing ? next : existing;
}
