/**
 * 关联边重建：从每份记忆文件的 `sources` 收集 `derived_from` 边（§11.10）。
 *
 * `sources`（frontmatter）是真相，`memory_link` 是它的派生读模型。
 */

import { contextTypeOf, isVersionFile } from '../../domain/node.js';
import type { Logger } from '../../domain/log.js';
import { Uri } from '../../domain/uri.js';

import { DERIVED_MATCH_TEXT, derivedEdgeKey, type DerivedEdge } from './edge-key.js';

/**
 * 从一份记忆文件的 `sources` 收集 `derived_from` 边（`from` = 记忆自身，`to` = 来源）。
 *
 * 语义与写路径一致（§11.10）：`sources` 里的每一条归档 URI 对应一条边，
 * `link_type = 'derived_from'`、`weight = 1.0`、`match_text` / `description` 为空
 * ——产生端（`MemoryMergeStep` / `ExperienceDistillStep`）从不给这三个字段填内容。
 *
 * **只收记忆文件。** `sources` 是记忆的保留键（§6.6）；资源 / 技能文件的 frontmatter
 * 里出现同名键不是溯源，给它建边会让 `backlinks` 混进无关节点。
 *
 * **跳过 `.history` 下的版本文件。** 写路径只在归档时给当时的规范文件写边；版本
 * 快照是覆盖写留下的旧值，从不产生边。把它们算进来，重建会造出写路径永远不会写出
 * 的边（同一个 identity 的每一份历史都会多一条）。
 *
 * **不检查终点是否存在。** `sources` 是真相：归档被清理之后那条溯源仍然成立，反查
 * 「哪些记忆来自这次归档」也仍然有意义。查存在性还会让同一份 `sources` 因为磁盘
 * 现状不同而得到不同的边，重建不再幂等（§11.10「悬空边写时不拦、读时容忍」）。
 *
 * 不合法的来源值跳过并记 `warn`：反查时终点用 `Uri.parse` 还原，一个非法值会让整次
 * 反查抛错。手改 `sources` 撞出重复值时按 `derivedEdgeKey()` 去重——那是唯一索引的
 * 三列，少一列就会让一次插入撞键、整批回滚。
 */
export function collectDerivedEdges(
  uri: Uri,
  rawSources: unknown,
  target: DerivedEdge[],
  seen: Set<string>,
  logger: Logger,
): void {
  if (contextTypeOf(uri) !== 'memory' || isVersionFile(uri)) {
    return;
  }
  if (!Array.isArray(rawSources)) {
    return;
  }
  for (const value of rawSources) {
    if (typeof value !== 'string' || value === '') {
      continue;
    }
    const to = Uri.tryParse(value);
    if (to === null) {
      logger.warn('记忆来源不是合法 URI，重建关联边时跳过。', {
        uri: uri.toString(),
        source: value,
      });
      continue;
    }
    const edge: DerivedEdge = { from: uri, to, matchText: DERIVED_MATCH_TEXT };
    const key = derivedEdgeKey(edge);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    target.push(edge);
  }
}
