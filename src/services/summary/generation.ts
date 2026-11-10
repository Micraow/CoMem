/**
 * 生成一个目录的 L0 + L1（§9.2）。
 *
 * 自底向上：叶子目录 → 父目录 → … → `rootUri`。一个目录的 L1 输入是「直接子文件的
 * 摘要」+「直接子目录的 L0 正文」。**L0 从 L1 提取**（`extractAbstract`），不让模型
 * 分别生成两层——两层各写一遍必然互相矛盾。
 *
 * 本文件只生成、不落盘：慢操作（`generator.generate`，一次 7–9 秒的模型调用）必须
 * 待在目录锁外（§10.6）。落盘在 `persist.ts`，两段锁的编排在 `invalidate.ts`。
 */

import type { ContentStore } from '../../adapters/fs/content-store.js';
import type { MetadataFileStore } from '../../adapters/fs/metadata-file.js';
import type { NodeRepository } from '../../adapters/sqlite/node-repository.js';
import type { NodeKind } from '../../domain/node.js';
import {
  extractAbstract,
  truncateToChars,
  type DirectorySummary,
  type SummaryChild,
  type SummaryGenerator,
} from '../../domain/summary.js';
import type { Uri } from '../../domain/uri.js';

import type { SummaryServiceConfig } from './ports.js';

/** 生成一个目录概览所需的端口。 */
export interface SummaryGenerationPorts {
  readonly store: ContentStore;
  readonly metadata: MetadataFileStore;
  readonly nodes: Pick<NodeRepository, 'get'>;
  readonly generator: SummaryGenerator;
  readonly config: SummaryServiceConfig;
}

/** 列一个目录的直接子项所需的端口。 */
type SummaryChildPorts = Pick<SummaryGenerationPorts, 'store' | 'metadata' | 'nodes'>;

/**
 * 生成一个目录的 L0 + L1（**只生成，不落盘**，§9.2）。
 *
 * 拆成「生成」与「落盘」两步是为了让慢操作（`generator.generate`）待在锁外：
 * `invalidate.ts` 的 `invalidateDirectory` 在锁外调本函数，拿到结果后再进锁调
 * `persistSummary`。显式全量重建读目录列表本身在锁外，本函数后直接落盘即可。
 *
 * 预算在服务这一层执行：换任何生成器实现都不会超。
 */
export async function summarize(
  ports: SummaryGenerationPorts,
  directoryUri: Uri,
): Promise<DirectorySummary> {
  const children = await summaryChildren(ports, directoryUri);
  const generated = await ports.generator.generate({ uri: directoryUri, children });

  const overview = truncateToChars(generated.overview, ports.config.overviewMaxChars);
  // L0 从 L1 提取（§9.1）：两层各生成一遍必然互相矛盾。
  const abstract = truncateToChars(
    extractAbstract(overview),
    ports.config.abstractMaxChars,
  );
  return { abstract, overview, degraded: generated.degraded };
}

/**
 * L1 的输入：直接子文件的摘要 + 直接子目录的 L0 正文（§9.2）。
 *
 * 子项从磁盘列，不从索引列：磁盘是真相，索引可能落后（§7）。文件摘要取索引里的
 * `abstract`（§9.1 明确它作为父目录 L1 的输入），目录摘要取 `.abstract.md` 正文。
 */
async function summaryChildren(
  ports: SummaryChildPorts,
  directoryUri: Uri,
): Promise<readonly SummaryChild[]> {
  const entries = await ports.store.list(directoryUri);
  const children: SummaryChild[] = [];
  for (const entry of entries) {
    const kind: NodeKind = entry.kind === 'directory' ? 'directory' : 'document';
    const abstract =
      kind === 'directory'
        ? (await ports.metadata.readSummary(entry.uri)).abstract
        : (ports.nodes.get(entry.uri.toString())?.abstract ?? '');
    children.push({ uri: entry.uri, name: entry.uri.name, kind, abstract });
  }
  return children;
}
