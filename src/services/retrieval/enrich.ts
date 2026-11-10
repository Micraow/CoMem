/**
 * 负责：向量命中补全成 `SearchHit`——补 node 表的列，并做 `contextTypes` / `levels` 后置过滤。
 * 不负责：产生候选集（`glob` 侧的类型 / 时间 / 有效期下推在 `arms.ts` 的候选查询里）。
 */

import type { NodeRepository } from '../../adapters/sqlite/node-repository.js';
import type { VectorHit } from '../../adapters/sqlite/vector-index.js';
import type { SearchHit } from '../../domain/retrieval.js';

import type { FindOptions } from './types.js';

/**
 * 向量命中补全成 `SearchHit`。
 *
 * 向量索引只返回 URI + 分数；`node` 表的 `level` / `abstract` / `context_type` /
 * `memory_type` 必须补上，否则 §8.6 的分层投放拿不到层级、事件类记忆
 * 会退化成一句话摘要。`node` 行已不存在（索引与磁盘短暂不一致）时跳过——留一条
 * 打不开的命中比少一条更难查。
 *
 * `contextTypes` / `levels` 在这里过滤：FTS5 在 SQL 里做，向量后端没有这些列，
 * 过滤必须落在补全之后。`status` 不在这里：候选集来自 `#readableUris` 的
 * `index.glob`，SQL 已经按 `ACTIVE_STATUS_PREDICATE` 滤掉非 `active` 的行。
 *
 * **层级取的是节点自身那一行（`NodeRepository.get` 的口径）**：向量按 URI 一条，
 * 没有「这一条命中的是概览行还是摘要行」这回事——目录本来就不产生向量，所以
 * `levels: ['L1']` 在向量臂上恒为空，与 §8.1 的「概览行只在 FTS 臂上」一致。
 * `vector` 引擎下这是预期行为，不是降级。
 */
export function enrichVectorHits(
  hits: readonly VectorHit[],
  options: FindOptions,
  nodes: Pick<NodeRepository, 'get'>,
): SearchHit[] {
  const enriched: SearchHit[] = [];
  for (const hit of hits) {
    const node = nodes.get(hit.uri);
    if (node === null) {
      continue;
    }
    if (
      options.contextTypes !== undefined &&
      options.contextTypes.length > 0 &&
      !options.contextTypes.includes(node.contextType)
    ) {
      continue;
    }
    if (
      options.levels !== undefined &&
      options.levels.length > 0 &&
      !options.levels.includes(node.level)
    ) {
      continue;
    }
    enriched.push({
      uri: hit.uri,
      level: node.level,
      abstract: node.abstract,
      score: hit.score,
      contextType: node.contextType,
      memoryType: node.memoryType,
    });
  }
  return enriched;
}
