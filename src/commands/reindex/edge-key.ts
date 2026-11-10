/**
 * `derived_from` 边的去重键：与 `memory_link_unique(from_uri, to_uri, match_text)`
 * 三列逐一对应。
 */

import type { Uri } from '../../domain/uri.js';

/**
 * `derived_from` 边的匹配文本。
 *
 * `sources` 只给归档 URI，写路径也固定写空串（`MemoryLinkService.rebuildDerived`），
 * 所以重建出来的边没有匹配文本。它仍然占去重键的一维：唯一索引是三列。
 */
export const DERIVED_MATCH_TEXT = '';

/** 一条待写入的 `derived_from` 边。 */
export interface DerivedEdge {
  readonly from: Uri;
  readonly to: Uri;
  readonly matchText: string;
}

/**
 * `derived_from` 边的去重键：三列逐一对应
 * `memory_link_unique(from_uri, to_uri, match_text)`（`0003_memory_link.sql`）。
 *
 * 重建直接 INSERT（`replaceByLinkType` 刚把这一类边删空），重复的三元组会撞唯一键
 * 让整批回滚，所以去重口径必须与索引一致。按 `(from, to)` 两列去重时，表说三列唯一、
 * 重建说两列唯一：一旦某个产生端填了匹配文本，同一个 `from → to` 的两条边就会被静默
 * 吞掉一条，而表允许它们共存。
 *
 * 导出是给用例钉住这个口径的（`tests/integration/commands/reindex.test.ts`）。
 */
export function derivedEdgeKey(edge: DerivedEdge): string {
  return `${edge.from.toString()}\n${edge.to.toString()}\n${edge.matchText}`;
}
