/**
 * 目录在索引里的两行（§8.1 的 `node` 行、§8.5 的层级）。
 *
 * 两行在同一个事务里写（`persist.ts` 的 `persistSummary`），所以概览与摘要不会
 * 各自漂移；`node` 与 `node_fts` 两张表也在这个事务里，中途失败整批回滚。
 */

import type { NodeRepository, NodeRow } from '../../adapters/sqlite/node-repository.js';
import { contextTypeOf, stableDigest } from '../../domain/node.js';
import type { IndexRecord } from '../../domain/retrieval.js';
import type { DirectorySummary } from '../../domain/summary.js';
import type { Uri } from '../../domain/uri.js';

import { DIRECTORY_LEVEL, OVERVIEW_LEVEL } from './levels.js';

/**
 * 目录自身那一行（L0）要写进索引的内容（§8.1 的 `node` 行）。
 *
 * 目录没有 L2 正文，这一行可检索的文本就是 L0 摘要：`abstract` 存 L0 原文，
 * `content` 留空（`node_fts` 的 `content` 列留给 L1 行，同一段文本写两列只会让
 * bm25 把同一处匹配算两遍）。`body_digest` 是 L0 正文的摘要——失效传播靠它判断
 * 「L0 变了没有」（§9.3）。
 *
 * 已有行里的 `context_type` / `memory_type` / `level` / `status` 原样保留：这些字段
 * 是索引重建时由内容决定的，摘要生成不该改写它们。
 */
export function indexRecord(
  nodes: Pick<NodeRepository, 'get'>,
  directoryUri: Uri,
  summary: DirectorySummary,
  entries: number,
  baseline: string,
): IndexRecord {
  const uri = directoryUri.toString();
  const existing: NodeRow | null = nodes.get(uri);
  return {
    uri,
    parentUri: directoryUri.parent()?.toString() ?? '',
    scope: directoryUri.scope,
    kind: 'directory',
    contextType: existing?.contextType ?? contextTypeOf(directoryUri),
    memoryType: existing?.memoryType ?? null,
    level: existing?.level ?? DIRECTORY_LEVEL,
    abstract: summary.abstract,
    content: '',
    bodyDigest: baseline,
    size: entries,
    updatedAt: new Date().toISOString(),
    status: existing?.status ?? 'active',
  };
}

/**
 * 目录的概览行（L1）要写进索引的内容（§8.5、§8.6）。
 *
 * 与 L0 行的差别只有两列：`level` 是 `L1`，`content` 是概览正文（L0 行的 `content`
 * 留空）。`abstract` 与 L0 行相同——检索结果里展示的就是这条命中对应的 L0 摘要，
 * 而「同一目录的 L0 行与 L1 行同时命中时只留高分那条」要靠它比较（§8.6 第 3 步
 * 按渲染后正文去重，`services/search.ts` 的 `#rank` 按 `(uri, abstract)` 去重）。
 *
 * `body_digest` 是概览正文的摘要，不是节点正文的摘要。它只有一个读者
 * （`#bodyChanged` 比的是节点自身那一行），把概览的 digest 写在这里是让这一行
 * 描述自己检索的是什么文本，而不是冒充节点。
 */
export function overviewRecord(
  nodes: Pick<NodeRepository, 'get'>,
  directoryUri: Uri,
  summary: DirectorySummary,
  entries: number,
): IndexRecord {
  const uri = directoryUri.toString();
  const existing: NodeRow | null = nodes.get(uri);
  return {
    uri,
    parentUri: directoryUri.parent()?.toString() ?? '',
    scope: directoryUri.scope,
    kind: 'directory',
    contextType: existing?.contextType ?? contextTypeOf(directoryUri),
    memoryType: existing?.memoryType ?? null,
    level: OVERVIEW_LEVEL,
    abstract: summary.abstract,
    content: summary.overview,
    bodyDigest: stableDigest(summary.overview),
    size: entries,
    updatedAt: new Date().toISOString(),
    status: existing?.status ?? 'active',
  };
}
